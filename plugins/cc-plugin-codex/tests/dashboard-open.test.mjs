import test from "node:test";
import assert from "node:assert/strict";

import {
  createDashboard,
  shouldAutoOpen,
  buildOpenCommand,
} from "../scripts/lib/dashboard.mjs";
import { renderDashboardPage } from "../scripts/lib/dashboard-page.mjs";

// ─── Dashboard page: terminal resume affordance ─────────────────────────────

test("dashboard page renders the terminal resume command affordance", () => {
  const html = renderDashboardPage();
  // The per-job resume card (deterministic channel — does not depend on the
  // Codex model relaying the command from tool output).
  assert.match(html, /在终端继续此会话/);
  assert.match(html, /claude --resume /);
  assert.match(html, /resume-box/);
  assert.match(html, /copy-btn/);
  // Session id source: the claudeSessionId field from GET /api/jobs.
  assert.match(html, /claudeSessionId/);
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
