/**
 * Live dashboard — read-only HTTP/SSE observer for Claude Code delegations.
 *
 * Binds 127.0.0.1 on a random port with a random token. Renders a real-time
 * timeline of Claude's intermediate actions (assistant text, tool_use,
 * tool_result) fed from the watchdog stream-json IPC channel.
 *
 * Privacy contract:
 *   - Events live ONLY in an in-memory per-job ring buffer. They are NEVER
 *     written to disk. The only persisted artifact is dashboard.json, which
 *     contains only connection metadata {url, token, pid, startedAt}.
 *   - Binds 127.0.0.1 only (never 0.0.0.0). No token → 403.
 *
 * The dashboard is a read-only observer: it does not cancel, lease, or alter
 * the foreground/cancel/lease contracts.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

import { renderDashboardPage } from "./dashboard-page.mjs";

const MAX_RING_EVENTS = 500;
const MAX_RING_BYTES = 1 * 1024 * 1024; // 1 MiB per job

/**
 * Decide whether the dashboard may auto-open the user's browser.
 * Pure function for deterministic tests.
 *
 * Auto-open is the only channel that reaches the user DURING the
 * foreground-blocking delegation (the MCP response can only arrive after
 * completion), so it defaults to ON. Disabled by CC_COMPANION_DASHBOARD_OPEN=off,
 * on CI, or on headless Linux (no DISPLAY/WAYLAND_DISPLAY).
 */
export function shouldAutoOpen(env = process.env, platform = process.platform) {
  if (env.CC_COMPANION_DASHBOARD_OPEN === "off") return false;
  if (env.CI) return false;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false;
  return true;
}

/**
 * Platform-specific browser opener command. Pure function for deterministic
 * tests. Windows `start` is a cmd builtin, so it must go through cmd /c; the
 * empty-string argument is the window title placeholder that prevents the URL
 * from being parsed as the title.
 */
export function buildOpenCommand(url, platform = process.platform) {
  if (platform === "darwin") return { command: "open", args: [url] };
  if (platform === "win32") return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

// Default browser opener: detached, fire-and-forget, never throws.
function defaultOpenBrowser(url) {
  try {
    const { command, args } = buildOpenCommand(url);
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      shell: false,
      windowsHide: true
    });
    child.on("error", () => { /* best effort */ });
    child.unref();
  } catch { /* best effort */ }
}

/**
 * Create and start a dashboard server.
 *
 * @param {object} opts
 * @param {function(): Promise<object[]>|object[]} [opts.getJobs]
 *   Provider that returns job metadata for GET /api/jobs. Decouples the
 *   dashboard from the state module's file layout.
 * @param {function(string): void} [opts.openBrowser]
 *   Injectable browser opener (tests substitute a spy). Defaults to the
 *   platform opener above.
 * @returns {Promise<object>} dashboard handle with {url, token, pid,
 *   startedAt, ingest, announceStateDir, openOnce, stop, server}
 */
export function createDashboard({ getJobs, openBrowser = defaultOpenBrowser } = {}) {
  const token = randomUUID();
  const startedAt = new Date().toISOString();
  const pid = process.pid;
  // Declared in the outer scope so announceStateDir (defined below) can
  // reference it. Assigned inside the server.listen callback once the port
  // is known.
  let url = "";

  // jobId -> { events: Array<{event, size}>, bytes }
  const ringBuffers = new Map();
  // SSE clients: Set<{ jobId|null, res }>
  const sseClients = new Set();
  // state dirs that have a dashboard.json written
  const announcedDirs = new Set();

  function ringBufferFor(jobId) {
    let buf = ringBuffers.get(jobId);
    if (!buf) {
      buf = { events: [], bytes: 0 };
      ringBuffers.set(jobId, buf);
    }
    return buf;
  }

  // Add an intermediate event to a job's ring buffer and broadcast to SSE.
  function ingest(jobId, event) {
    if (!jobId || !event || typeof event !== "object") return;
    const buf = ringBufferFor(jobId);
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    buf.events.push({ event, size });
    buf.bytes += size;
    while (buf.events.length > MAX_RING_EVENTS || buf.bytes > MAX_RING_BYTES) {
      const dropped = buf.events.shift();
      if (dropped) buf.bytes -= dropped.size;
    }
    broadcast(jobId, event);
  }

  function broadcast(jobId, event) {
    if (sseClients.size === 0) return;
    const data = `data: ${JSON.stringify({ jobId, event })}\n\n`;
    for (const client of sseClients) {
      if (client.jobId === null || client.jobId === jobId) {
        try { client.res.write(data); } catch { /* client gone */ }
      }
    }
  }

  function hasValidToken(reqUrl) {
    try {
      const u = new URL(reqUrl, "http://127.0.0.1");
      return u.searchParams.get("token") === token;
    } catch {
      return false;
    }
  }

  function parseUrl(reqUrl) {
    return new URL(reqUrl, "http://127.0.0.1");
  }

  const server = createServer((req, res) => {
    if (!hasValidToken(req.url)) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("403 Forbidden");
      return;
    }
    const u = parseUrl(req.url);
    if (u.pathname === "/" || u.pathname === "/index.html") {
      handlePage(res);
    } else if (u.pathname === "/events") {
      handleSse(req, res, u);
    } else if (u.pathname === "/api/jobs") {
      handleJobs(res);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
    }
  });

  function handlePage(res) {
    const html = renderDashboardPage();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(html);
  }

  function handleSse(req, res, u) {
    const jobParam = u.searchParams.get("job");
    const jobId = jobParam || null;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    // Flush headers with a comment so the client knows the stream is open.
    res.write(": connected\n\n");
    const client = { jobId, res };
    sseClients.add(client);
    // Replay currently-buffered events for the subscribed job (so a client
    // opening mid-run sees the full timeline so far).
    if (jobId) {
      const buf = ringBuffers.get(jobId);
      if (buf) {
        for (const entry of buf.events) {
          try {
            res.write(`data: ${JSON.stringify({ jobId, event: entry.event })}\n\n`);
          } catch { /* client gone */ }
        }
      }
    } else {
      // Replay all jobs' buffered events.
      for (const [jid, buf] of ringBuffers) {
        for (const entry of buf.events) {
          try {
            res.write(`data: ${JSON.stringify({ jobId: jid, event: entry.event })}\n\n`);
          } catch { /* client gone */ }
        }
      }
    }
    req.on("close", () => { sseClients.delete(client); });
  }

  async function handleJobs(res) {
    let jobs = [];
    try {
      const result = typeof getJobs === "function" ? await getJobs() : [];
      jobs = Array.isArray(result) ? result : [];
    } catch {
      jobs = [];
    }
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ jobs }));
  }

  // Persist connection metadata to a workspace state dir (atomic tmp+rename).
  // Allows external tools to discover the running dashboard URL. Contains no
  // event content and no task content. The file carries the auth token, so it
  // is written 0o600 (mode is a no-op on Windows) into a 0o700 dir — matching
  // the state.mjs DIR_MODE/FILE_MODE contract.
  async function announceStateDir(dir) {
    if (!dir || announcedDirs.has(dir)) return;
    const meta = { url, token, pid, startedAt };
    const file = path.join(dir, "dashboard.json");
    const tmp = path.join(dir, ".dashboard.json.tmp");
    try {
      // The state dir may not exist yet (first delegation in a fresh
      // workspace) — create it like state.mjs does.
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await writeFile(tmp, JSON.stringify(meta, null, 2), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, file);
      // Mark announced only after the write landed — a failed write must not
      // permanently skip the dir; the next call retries.
      announcedDirs.add(dir);
    } catch {
      // best effort — the dir stays un-announced so a later call retries
    }
  }

  // Open the dashboard in the user's default browser at most once per server
  // boot. Called by the companion right before Claude spawns, so the panel is
  // on screen before the task starts. Honors shouldAutoOpen(); never throws.
  let openAttempted = false;
  function openOnce() {
    if (openAttempted) return false;
    openAttempted = true;
    if (!shouldAutoOpen()) return false;
    openBrowser(`${url}?token=${token}`);
    return true;
  }

  async function stop() {
    // Deregister the exit cleanup so repeated create/stop cycles (tests) do
    // not accumulate process listeners.
    process.removeListener("exit", onExitCleanup);
    // Close SSE clients
    for (const client of sseClients) {
      try { client.res.end(); } catch { /* */ }
    }
    sseClients.clear();
    // Delete dashboard.json metadata files
    for (const dir of announcedDirs) {
      try { await unlink(path.join(dir, "dashboard.json")); } catch { /* already gone */ }
    }
    announcedDirs.clear();
    // Close HTTP server
    return new Promise((resolve) => {
      server.close(() => resolve());
    });
  }

  // Best-effort synchronous cleanup if the process is killed without a
  // graceful async shutdown (SIGKILL / crash). Async unlink cannot run in an
  // exit handler, so use unlinkSync. stop() removes this listener.
  function onExitCleanup() {
    for (const dir of announcedDirs) {
      try { unlinkSync(path.join(dir, "dashboard.json")); } catch { /* best effort */ }
    }
  }
  process.on("exit", onExitCleanup);

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      url = `http://127.0.0.1:${port}`;
      // Unref the server so it does not keep the MCP process alive on its own.
      // The server lifecycle is owned by gracefulShutdown (stdin close), not by
      // the HTTP handle. This is essential for test isolation: a dashboard
      // started during a unit test must not block the test process from exit.
      server.unref();
      resolve({
        url,
        token,
        pid,
        startedAt,
        server,
        ingest,
        announceStateDir,
        openOnce,
        stop,
        ringBuffers,
      });
    });
  });
}
