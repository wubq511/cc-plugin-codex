import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { runClaude } from "../scripts/lib/claude-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaudeSource = path.join(here, "helpers", "fake-claude.mjs");
const watchdogPath = path.join(here, "..", "scripts", "lib", "watchdog.mjs");

// Install the fake CLI the same way the sibling suites do: an extensionless
// shim plus, on Windows, the npm-style `.cmd` shim and its Node entrypoint.
// The watchdog spawns `command` through resolveCommandForSpawn, so passing
// the `.cmd` path on win32 exercises the same shim-parse path as production.
function installFakeClaude(binDir) {
  const fakeClaude = path.join(binDir, "claude");
  fs.copyFileSync(fakeClaudeSource, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  if (process.platform === "win32") {
    fs.copyFileSync(fakeClaudeSource, path.join(binDir, "claude.js"));
    fs.writeFileSync(
      path.join(binDir, "claude.cmd"),
      `@ECHO off\r\n"${process.execPath}" "%~dp0claude.js" %*\r\n`,
      "utf8",
    );
    return path.join(binDir, "claude.cmd");
  }
  return fakeClaude;
}

const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-stream-bin-"));
const fakeClaude = installFakeClaude(binDir);
after(() => { fs.rmSync(binDir, { recursive: true, force: true }); });

function runStream(mode, options = {}) {
  return runClaude("stream test", {
    command: fakeClaude,
    env: { ...process.env, FAKE_CLAUDE_MODE: mode },
    ...options,
  });
}

// ─── Stream-json result extraction ─────────────────────────────────────

test("stream-success: result extracted from type:result event (not raw JSON.parse)", async () => {
  const result = await runStream("stream-success").result;
  assert.equal(result.ok, true);
  assert.equal(result.result, "target.json 的 name 字段值是 probe-target。");
  assert.equal(result.sessionId, "fake-stream-session");
  assert.equal(result.cost, 0.01);
  assert.deepEqual(result.usageModelKeys, ["claude-sonnet-4-5"]);
});

test("stream-success: usage tokens extracted from result event", async () => {
  const result = await runStream("stream-success").result;
  assert.equal(result.ok, true);
  assert.ok(result.usage);
  // extractUsageTokens takes the last usage.iterations entry (per-turn, not aggregate billing).
  assert.equal(result.usage.input, 180);
  assert.equal(result.usage.output, 25);
  assert.equal(result.usage.cacheRead, 120);
});

test("stream-success: contextWindow extracted from result event modelUsage", async () => {
  const result = await runStream("stream-success").result;
  assert.equal(result.ok, true);
  assert.equal(result.contextWindow, 200000);
});

// ─── Payload truncation ────────────────────────────────────────────────

test("stream-big-field: oversized event payloads are truncated but result still extracted", async () => {
  const result = await runStream("stream-big-field").result;
  assert.equal(result.ok, true);
  assert.equal(result.result, "big done");
  assert.equal(result.sessionId, "fake-stream-big");
  // The big assistant text should not crash the watchdog or runner
});

// ─── Oversized single line (no newline) ────────────────────────────────

test("stream-huge-line: a newline-free line above the line-buffer cap is dropped, result still extracted", async () => {
  const result = await runStream("stream-huge-line").result;
  assert.equal(result.ok, true);
  assert.equal(result.result, "huge line done");
  assert.equal(result.sessionId, "fake-stream-huge-line");
});

// ─── Line reassembly from split chunks ─────────────────────────────────

test("stream-split: NDJSON lines split across stdout chunks are reassembled", async () => {
  const result = await runStream("stream-split").result;
  assert.equal(result.ok, true);
  assert.equal(result.result, "split done");
  assert.equal(result.sessionId, "fake-stream-split");
});

// ─── No type:result event (truncated stream) ──────────────────────────

test("stream-no-result: missing type:result event produces a parse error result", async () => {
  const result = await runStream("stream-no-result").result;
  assert.equal(result.ok, false);
  // Watchdog should report a json_protocol or provider_response failure
  assert.ok(result.failureStage, "should have a failureStage");
});

// ─── Backward compatibility: existing non-stream modes still work ──────

test("legacy success mode (single JSON) still parses correctly after stream-json changes", async () => {
  const result = await runClaude("runner test", {
    command: fakeClaude,
    env: { ...process.env, FAKE_CLAUDE_MODE: "success" },
  }).result;
  assert.equal(result.ok, true);
  assert.equal(result.result, "fake result");
  assert.equal(result.sessionId, "fake-session");
});

test("legacy invalid-json mode still reports json_protocol failure", async () => {
  const result = await runClaude("runner test", {
    command: fakeClaude,
    env: { ...process.env, FAKE_CLAUDE_MODE: "invalid-json" },
  }).result;
  assert.equal(result.ok, false);
  assert.match(result.error, /^\[json_protocol\]/);
});

// ─── onEvent callback ──────────────────────────────────────────────────

test("onEvent callback receives intermediate stream events before result resolves", async () => {
  const events = [];
  const execution = runClaude("stream test", {
    command: fakeClaude,
    env: { ...process.env, FAKE_CLAUDE_MODE: "stream-success" },
    onEvent: (event) => { events.push(event); },
  });
  const result = await execution.result;
  assert.equal(result.ok, true);
  // Should have received intermediate events (system/init + assistant) before the result
  assert.ok(events.length >= 2, `expected >= 2 events, got ${events.length}`);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("system"), "should include system event");
  assert.ok(types.includes("assistant"), "should include assistant event");
});

test("onEvent callback is optional — no onEvent does not crash", async () => {
  const result = await runStream("stream-success").result;
  assert.equal(result.ok, true);
});

test("watchdog without IPC channel does not crash and still returns result", async () => {
  // Spawn watchdog directly with stdio that has NO ipc channel. The watchdog
  // must still parse stream-json, extract the result event, and write the
  // final JSON to stdout without crashing when process.send is unavailable.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-noipc-"));
  try {
    const config = {
      task: "stream test",
      cwd: tmp,
      write: false,
      command: fakeClaude,
      childEnv: { ...process.env, FAKE_CLAUDE_MODE: "stream-success" },
    };
    const child = spawn(process.execPath, [watchdogPath], {
      cwd: tmp,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"], // deliberately NO ipc channel
    });
    child.stdin.write(JSON.stringify(config));
    child.stdin.end();
    let stdout = "";
    child.stdout.on("data", (c) => { stdout += c.toString(); });
    await new Promise((resolve) => child.once("close", resolve));
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.sessionId, "fake-stream-session");
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ─── IPC event forwarding from watchdog to runner ─────────────────────

test("child.on('message') forwards watchdog IPC events to onEvent callback", async () => {
  const events = [];
  const execution = runClaude("stream test", {
    command: fakeClaude,
    env: { ...process.env, FAKE_CLAUDE_MODE: "stream-success" },
    onEvent: (event) => { events.push(event); },
  });
  await execution.result;
  assert.ok(events.length > 0, "should receive at least one forwarded event");
  // Verify that events came through the IPC channel (watchdog process.send → child.on("message"))
  // All events should have a type field
  for (const e of events) {
    assert.ok(typeof e.type === "string", `event should have string type, got ${typeof e.type}`);
  }
});

// ─── Event payload bounding ────────────────────────────────────────────

test("stream events have bounded payload size", async () => {
  const events = [];
  const execution = runClaude("stream test", {
    command: fakeClaude,
    env: { ...process.env, FAKE_CLAUDE_MODE: "stream-big-field" },
    onEvent: (event) => { events.push(event); },
  });
  await execution.result;
  assert.ok(events.length > 0, "should receive the oversized assistant event");
  // All forwarded events should be bounded (no single event string > 8 KB)
  for (const e of events) {
    const size = JSON.stringify(e).length;
    assert.ok(size <= 8192, `event payload ${size} bytes exceeds 8 KB bound`);
  }
});
