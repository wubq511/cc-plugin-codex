import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";

import {
  createDashboard,
  shouldAutoOpen,
  buildOpenCommand,
} from "../scripts/lib/dashboard.mjs";
import { renderDashboardPage } from "../scripts/lib/dashboard-page.mjs";

// ─── Dashboard page: terminal resume affordance ─────────────────────────────

test("dashboard page renders the panel shell and terminal resume affordance", () => {
  const html = renderDashboardPage();
  // Panel skeleton: status zone, filter chips, back-to-latest affordance.
  assert.match(html, /status-zone/);
  assert.match(html, /data-filter="all"/);
  assert.match(html, /back-latest/);
  // The per-job resume affordance (deterministic channel — does not depend on
  // the Codex model relaying the command from tool output). Rendered as a
  // compact copy button in the status zone, not a standalone card.
  assert.match(html, /在终端继续此会话/);
  assert.match(html, /claude --resume /);
  assert.match(html, /copy-btn/);
  // Session id source: the claudeSessionId field from GET /api/jobs.
  assert.match(html, /claudeSessionId/);
  // Assets are fully inlined into one response: no external requests, and no
  // unreplaced assembly markers left behind.
  assert.doesNotMatch(html, /%%DASHBOARD_(CSS|JS)%%/);
  assert.doesNotMatch(html, /<(script|link)[^>]+(src|href)="https?:/);
});

// ─── buildOpenCommand (platform mapping, pure) ─────────────────────────────

test("buildOpenCommand maps darwin to open", () => {
  const { command, args } = buildOpenCommand("http://127.0.0.1:1234?token=abc", "darwin");
  assert.equal(command, "open");
  assert.deepEqual(args, ["http://127.0.0.1:1234?token=abc"]);
});

test("buildOpenCommand maps win32 to cmd /c start with empty title placeholder", () => {
  const { command, args } = buildOpenCommand("http://127.0.0.1:1234?token=abc", "win32");
  assert.equal(command, "cmd");
  assert.deepEqual(args, ["/c", "start", "", "http://127.0.0.1:1234?token=abc"]);
});

test("buildOpenCommand maps linux to xdg-open", () => {
  const { command, args } = buildOpenCommand("http://127.0.0.1:1234?token=abc", "linux");
  assert.equal(command, "xdg-open");
  assert.deepEqual(args, ["http://127.0.0.1:1234?token=abc"]);
});

// ─── shouldAutoOpen (env/platform guards, pure) ────────────────────────────

test("shouldAutoOpen defaults to true on a desktop platform", () => {
  assert.equal(shouldAutoOpen({}, "darwin"), true);
  assert.equal(shouldAutoOpen({}, "win32"), true);
});

test("shouldAutoOpen honors CC_COMPANION_DASHBOARD_OPEN=off", () => {
  assert.equal(shouldAutoOpen({ CC_COMPANION_DASHBOARD_OPEN: "off" }, "darwin"), false);
});

test("shouldAutoOpen is suppressed on CI", () => {
  assert.equal(shouldAutoOpen({ CI: "true" }, "darwin"), false);
});

test("shouldAutoOpen is suppressed on headless Linux", () => {
  assert.equal(shouldAutoOpen({}, "linux"), false);
  assert.equal(shouldAutoOpen({ DISPLAY: ":0" }, "linux"), true);
  assert.equal(shouldAutoOpen({ WAYLAND_DISPLAY: "wayland-0" }, "linux"), true);
});

// ─── openOnce (integration with injected opener) ───────────────────────────

async function withDashboard(envPatch, fn) {
  const saved = {};
  for (const key of Object.keys(envPatch)) {
    saved[key] = process.env[key];
    if (envPatch[key] === null) delete process.env[key];
    else process.env[key] = envPatch[key];
  }
  const opened = [];
  const dashboard = await createDashboard({ openBrowser: (url) => opened.push(url) });
  try {
    await fn({ dashboard, opened });
  } finally {
    await dashboard.stop();
    for (const key of Object.keys(envPatch)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test("openOnce opens the token URL exactly once", async (t) => {
  await withDashboard({ CC_COMPANION_DASHBOARD_OPEN: null, CI: null, DISPLAY: ":0" }, async ({ dashboard, opened }) => {
    assert.equal(dashboard.openOnce(), true);
    assert.equal(opened.length, 1);
    assert.equal(opened[0], `${dashboard.url}?token=${dashboard.token}`);
    // Second call is a no-op (at most one browser tab per server boot)
    assert.equal(dashboard.openOnce(), false);
    assert.equal(opened.length, 1);
  });
});

test("openOnce does not open when CC_COMPANION_DASHBOARD_OPEN=off", async (t) => {
  await withDashboard({ CC_COMPANION_DASHBOARD_OPEN: "off" }, async ({ dashboard, opened }) => {
    assert.equal(dashboard.openOnce(), false);
    assert.equal(opened.length, 0);
  });
});

test("openOnce does not open on CI", async (t) => {
  await withDashboard({ CC_COMPANION_DASHBOARD_OPEN: null, CI: "true" }, async ({ dashboard, opened }) => {
    assert.equal(dashboard.openOnce(), false);
    assert.equal(opened.length, 0);
  });
});

// ─── ingest: noise subtypes never reach the ring buffer ────────────────────

test("dashboard ingest drops thinking_tokens so it cannot evict real events", async () => {
  const dashboard = await createDashboard({ openBrowser: () => {} });
  try {
    dashboard.ingest("job-1", { type: "system", subtype: "thinking_tokens", estimated_tokens: 7 });
    dashboard.ingest("job-1", { type: "system", subtype: "init" });
    const buf = dashboard.ringBuffers.get("job-1");
    assert.equal(buf.events.length, 1);
    assert.equal(buf.events[0].event.subtype, "init");
  } finally {
    await dashboard.stop();
  }
});

// ─── stop(): force-close half-open sockets (gracefulShutdown hang regression) ─

test("dashboard stop() force-closes a half-open connection", async () => {
  const dashboard = await createDashboard({ openBrowser: () => {} });
  const port = new URL(dashboard.url).port;
  // A raw TCP connection with no HTTP request head yet: the server accepted it
  // but no response object exists, so stop()'s res.end() cannot reach it, and
  // server.close() waits for it to drain. Only closeAllConnections() destroys
  // it — without that call stop() falls through to its 2s bound. This is the
  // mid-flight reconnect/opening socket that hung gracefulShutdown on SIGTERM.
  const sock = net.connect(Number(port), "127.0.0.1");
  let stopped = false;
  try {
    await new Promise((resolve, reject) => {
      sock.once("connect", resolve);
      sock.once("error", reject);
    });

    await Promise.race([
      (async () => { await dashboard.stop(); stopped = true; })(),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error("dashboard.stop() hung with a half-open connection (closeAllConnections regression)")),
        1500,
      )),
    ]);
    assert.equal(stopped, true, "stop() must resolve while a half-open connection is held");
  } finally {
    sock.destroy();
  }
});
