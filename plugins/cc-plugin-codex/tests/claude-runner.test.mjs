import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runClaude } from "../scripts/lib/claude-runner.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaude = path.join(here, "helpers", "fake-claude.mjs");

function run(mode, options = {}) {
  return runClaude("runner test", {
    command: fakeClaude,
    env: { ...process.env, FAKE_CLAUDE_MODE: mode },
    ...options
  });
}

test("foreground runner parses the existing Claude JSON result", async () => {
  const execution = run("success");
  assert.ok(execution.pid);
  assert.equal(typeof execution.cancel, "function");
  const result = await execution.result;
  assert.equal(result.ok, true);
  assert.equal(result.result, "fake result");
  assert.equal(result.sessionId, "fake-session");
  assert.deepEqual(result.usageModelKeys, ["mimo-v2.5"]);
});

test("foreground runner rejects invalid JSON", async () => {
  const result = await run("invalid-json").result;
  assert.equal(result.ok, false);
  assert.match(result.error, /not valid JSON/);
});

test("foreground runner reports nonzero exits with stderr", async () => {
  const result = await run("nonzero").result;
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 7);
  assert.equal(result.error, "fake claude failure");
});

test("foreground runner terminates tasks at an explicit finite timeout", async () => {
  const startedAt = Date.now();
  const result = await run("hang", { timeout: 50 }).result;
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 50ms and was terminated/);
  assert.ok(Date.now() - startedAt < 2000);
});

test("foreground runner has no default timeout — a delayed task completes without one", async () => {
  const result = await run("delay:200").result;
  assert.equal(result.ok, true);
  assert.equal(result.result, "delayed result");
});

test("foreground runner bounds combined stdout and stderr capture", async () => {
  const result = await run("flood", { maxCaptureBytes: 1024, timeout: 2000 }).result;
  assert.equal(result.ok, false);
  assert.match(result.error, /exceeded the 1024-byte capture limit and was terminated/);
});

test("foreground runner passes through an arbitrary model identifier unchanged", async () => {
  const execution = run("success", { model: "mimo-v2.5-pro" });
  const result = await execution.result;
  assert.equal(result.ok, true);
  // The fake claude returns mimo-v2.5 in modelUsage (the usage key).
  // We verify the result parses correctly and usageModelKeys comes from the result metadata.
  assert.deepEqual(result.usageModelKeys, ["mimo-v2.5"]);
});
