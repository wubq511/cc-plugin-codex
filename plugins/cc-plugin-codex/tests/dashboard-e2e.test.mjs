import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveStateDir } from "../scripts/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverPath = path.join(pluginRoot, "scripts", "cc-companion.mjs");
const fakeClaudeSource = path.join(here, "helpers", "fake-claude.mjs");

// ─── Test harness (adapted from mcp-foreground.test.mjs) ─────────────────────

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

async function safeRmDir(dir) {
  const maxRetries = process.platform === "win32" ? 5 : 1;
  for (let i = 0; i < maxRetries; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err.code === "EBUSY" || err.code === "ENOTEMPTY") && i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
  }
}

function installFakeClaude(binDir) {
  const fakeClaude = path.join(binDir, "claude");
  fs.copyFileSync(fakeClaudeSource, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);

  // The production CLI is normally an npm-generated `.cmd` shim on Windows.
  // Add a compatible fake shim so delegation exercises the same resolver as a
  // real installation instead of failing to spawn the extensionless script.
  if (process.platform === "win32") {
    fs.copyFileSync(fakeClaudeSource, path.join(binDir, "claude.js"));
    fs.writeFileSync(
      path.join(binDir, "claude.cmd"),
      `@ECHO off\r\n"${process.execPath}" "%~dp0claude.js" %*\r\n`,
      "utf8",
    );
  }
  return fakeClaude;
}

function startServer(t, { env: extraEnv } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-dash-test-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir);
  installFakeClaude(binDir);

  const child = spawn(process.execPath, [serverPath], {
    cwd: workspace,
    env: {
      ...process.env,
      CC_COMPANION_DASHBOARD_OPEN: "off",
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      ...extraEnv
    },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const messages = [];
  const waiters = new Map();
  let stderr = "";
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    messages.push(message);
    const waiter = waiters.get(message.id);
    if (waiter) {
      waiters.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  function request(id, method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for response ${id}. stderr: ${stderr}`));
      }, 15000);
      waiters.set(id, {
        resolve: (message) => { clearTimeout(timer); resolve(message); }
      });
    });
  }

  function send(id, name, args = {}) {
    return request(id, "tools/call", { name, arguments: { cwd: workspace, ...args } });
  }

  t.after(async () => {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
    await safeRmDir(workspace);
  });

  return { child, messages, request, send, workspace };
}

// ─── Dashboard helpers ───────────────────────────────────────────────────────

function readDashboardMeta(workspace) {
  const stateDir = resolveStateDir(workspace);
  const file = path.join(stateDir, "dashboard.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.setTimeout(5000, () => { req.destroy(new Error("timeout")); });
  });
}

// Connect to the SSE endpoint and collect events. Returns { events, req }.
// The caller destroys `req` when done collecting.
function connectSse(url) {
  const events = [];
  let buffer = "";
  const req = http.get(url, (res) => {
    res.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        // SSE data lines start with "data: "
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) {
            const payload = line.slice(6);
            try {
              events.push(JSON.parse(payload));
            } catch { /* skip non-JSON (e.g. ": connected" comment) */ }
          }
        }
      }
    });
  });
  req.on("error", () => { /* best effort — caller checks events array */ });
  return { events, req };
}

// Extract dashboard URL + token from a delegate/cc_check response text.
function extractDashboardUrl(text) {
  const m = text.match(/\*\*实时面板：\*\* (http:\/\/127\.0\.0\.1:\d+)\?token=([0-9a-f-]+)/);
  return m ? { url: m[1], token: m[2] } : null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test("dashboard e2e: SSE delivers ≥2 intermediate events before delegate result", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_MODE: "stream-slow" } });

  // Fire the delegate — don't await yet. The dashboard starts at server boot
  // and writes dashboard.json to the workspace state dir on delegate.
  const delegatePromise = server.send(1, "cc_delegate", { task: "stream slow dashboard test" });

  // Poll for dashboard.json so we can connect SSE before the result lands.
  const meta = await waitFor(() => readDashboardMeta(server.workspace), 6000);
  assert.ok(meta, "dashboard.json must be written to the state dir on delegate");
  assert.ok(meta.url, "dashboard.json must contain url");
  assert.ok(meta.token, "dashboard.json must contain token");

  // Connect SSE immediately — before the slow stream's later events arrive.
  // stream-slow emits init at t≈0 (after spawn) then a1/a2/result at 60/120/180ms,
  // so connecting here (before spawn completes) gives an empty replay and all
  // events arrive via real-time broadcast.
  const sse = connectSse(`${meta.url}/events?token=${meta.token}`);

  // Await the delegate result.
  const delegate = await delegatePromise;
  const text = delegate.result.content[0].text;
  assert.match(text, /## 任务完成/);
  assert.match(text, /\*\*实时面板：\*\*/);

  // Allow the final SSE events to flush.
  await new Promise((r) => setTimeout(r, 200));

  // The core assertion: ≥2 intermediate events arrived via SSE before the
  // delegate result was returned to the caller.
  assert.ok(
    sse.events.length >= 2,
    `expected ≥2 SSE events before delegate result, got ${sse.events.length}`
  );

  // Verify event types include system + assistant (intermediate, non-result).
  const types = sse.events.map((e) => e?.event?.type).filter(Boolean);
  assert.ok(types.includes("system"), "SSE events should include a system event");
  assert.ok(types.includes("assistant"), "SSE events should include an assistant event");

  sse.req.destroy();
});

test("dashboard e2e: /api/jobs returns the delegate job", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_MODE: "stream-slow" } });
  const delegate = await server.send(1, "cc_delegate", { task: "stream slow jobs test" });
  const text = delegate.result.content[0].text;

  const dash = extractDashboardUrl(text);
  assert.ok(dash, "delegate response must contain a dashboard URL line");

  const res = await httpGet(`${dash.url}/api/jobs?token=${dash.token}`);
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body);
  assert.ok(Array.isArray(body.jobs), "/api/jobs must return a jobs array");
  assert.ok(body.jobs.length > 0, "/api/jobs must return at least one job");
  assert.ok(
    body.jobs.some((j) => j.status === "completed"),
    "/api/jobs should include the completed delegate job"
  );
  // Every delegated job must carry a session id so the dashboard can render
  // the terminal resume command (claude --resume <id>).
  for (const job of body.jobs) {
    assert.ok(job.claudeSessionId, "/api/jobs must expose claudeSessionId for the resume command");
  }
  // Jobs must not expose task content or error detail (privacy contract).
  for (const job of body.jobs) {
    assert.equal(job.task, undefined, "/api/jobs must not expose task content");
    assert.equal(job.errorMessage, undefined, "/api/jobs must not expose error messages");
  }
});

test("dashboard e2e: no-token requests are rejected with 403", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_MODE: "stream-slow" } });
  const delegate = await server.send(1, "cc_delegate", { task: "stream slow auth test" });
  const text = delegate.result.content[0].text;

  const dash = extractDashboardUrl(text);
  assert.ok(dash, "delegate response must contain a dashboard URL line");

  // No token on /api/jobs → 403
  const jobsRes = await httpGet(`${dash.url}/api/jobs`);
  assert.equal(jobsRes.status, 403, "/api/jobs without token must return 403");

  // No token on / (page) → 403
  const pageRes = await httpGet(`${dash.url}/`);
  assert.equal(pageRes.status, 403, "/ without token must return 403");

  // No token on /events (SSE) → 403
  const sseRes = await httpGet(`${dash.url}/events`);
  assert.equal(sseRes.status, 403, "/events without token must return 403");

  // Wrong token → 403
  const wrongRes = await httpGet(`${dash.url}/api/jobs?token=deadbeef`);
  assert.equal(wrongRes.status, 403, "/api/jobs with wrong token must return 403");
});

test("dashboard e2e: cc_check surfaces the dashboard URL after a delegate", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_MODE: "stream-slow" } });
  const delegate = await server.send(1, "cc_delegate", { task: "stream slow cc_check test" });
  const delegateText = delegate.result.content[0].text;
  assert.match(delegateText, /\*\*实时面板：\*\*/);

  // cc_check for the same job should also surface the dashboard URL.
  const jobIdMatch = delegateText.match(/任务 ID：\*\* ([^\n]+)/);
  assert.ok(jobIdMatch, "delegate response should contain a job ID");
  const jobId = jobIdMatch[1];

  const check = await server.send(2, "cc_check", { job: jobId });
  const checkText = check.result.content[0].text;
  assert.match(checkText, /\*\*实时面板：\*\*/);
});
