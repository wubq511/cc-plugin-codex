import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { validateAutoCompact, computeEffectiveWindow, resolveScope, AUTO_COMPACT_PCT, resolveDelegateAutoCompact, replayStoredAutoCompact, buildInlineSettings } from "../scripts/lib/autocompact.mjs";
import { listJobs } from "../scripts/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverPath = path.join(pluginRoot, "scripts", "cc-companion.mjs");
const fakeClaudeSource = path.join(here, "helpers", "fake-claude.mjs");

// ─── Test helpers (adapted from hardening.test.mjs) ─────────────────────────

function installFakeClaude(binDir) {
  const fakeClaude = path.join(binDir, "claude");
  fs.copyFileSync(fakeClaudeSource, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  return fakeClaude;
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

function startServer(t, opts = {}) {
  const workspace = opts.workspace || fs.mkdtempSync(path.join(os.tmpdir(), "cc-autocompact-test-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  installFakeClaude(binDir);

  // Drain state.mjs's first-access orphan reconciliation while the workspace
  // is still empty. listJobs() runs reconcileOrphans once per process per
  // workspace; if that first access happens after the server created a live
  // job, it wrongly marks the job orphaned ("server restarted") and every
  // later status poll in the test observes the corrupted state.
  listJobs(workspace);

  const child = spawn(process.execPath, [serverPath], {
    cwd: workspace,
    env: {
      ...process.env,
      CC_COMPANION_DASHBOARD_OPEN: "off",
      ...opts.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiters = new Map();
  let stderr = "";
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    } catch { /* ignore non-JSON */ }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  function request(id, method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for response ${id}. stderr: ${stderr}`));
      }, 10000);
      waiters.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message); } });
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
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  return { child, request, send, workspace, getStderr: () => stderr };
}

// ─── Pure function tests: validation & computation ──────────────────────────

test("AUTO_COMPACT_PCT is fixed at 90", () => {
  assert.equal(AUTO_COMPACT_PCT, 90);
});

test("computeEffectiveWindow: 300K target → 333334", () => {
  assert.equal(computeEffectiveWindow(300000), 333334);
});

test("computeEffectiveWindow: 230K target → 255556", () => {
  assert.equal(computeEffectiveWindow(230000), 255556);
});

test("computeEffectiveWindow: 1M target → 1111112", () => {
  assert.equal(computeEffectiveWindow(1_000_000), 1111112);
});

test("validateAutoCompact: accepts valid delegation scope", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230000,
    scope: "delegation",
  });
  assert.equal(result.valid, true);
  assert.equal(result.effectiveWindow, 255556);
  assert.equal(result.scope, "delegation");
  // taskScopeId is undefined when omitted (not null — null means explicit clear)
  assert.equal(result.taskScopeId, undefined);
});

test("validateAutoCompact: accepts valid session scope", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 1_000_000,
    targetTokens: 300000,
    scope: "session",
  });
  assert.equal(result.valid, true);
  assert.equal(result.effectiveWindow, 333334);
  assert.equal(result.scope, "session");
});

test("validateAutoCompact: accepts valid task scope with taskScopeId", () => {
  const taskScopeId = "11111111-2222-4333-8444-555555555555";
  const result = validateAutoCompact({
    contextWindowTokens: 1_000_000,
    targetTokens: 300000,
    scope: "task",
    taskScopeId,
  });
  assert.equal(result.valid, true);
  assert.equal(result.scope, "task");
  assert.equal(result.taskScopeId, taskScopeId);
});

test("validateAutoCompact: accepts task scope without taskScopeId (first generation)", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 1_000_000,
    targetTokens: 300000,
    scope: "task",
  });
  assert.equal(result.valid, true);
  assert.equal(result.scope, "task");
  // taskScopeId is undefined when omitted — the caller generates a new ID.
  // This distinguishes "omitted" (generate) from "explicit null" (clear).
  assert.equal(result.taskScopeId, undefined);
});

test("validateAutoCompact: defaults scope to delegation when omitted", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230000,
  });
  assert.equal(result.valid, true);
  assert.equal(result.scope, "delegation");
});

test("validateAutoCompact: rejects 256K/250K (target > 90% of context)", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 250000,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /90%/i);
});

test("validateAutoCompact: rejects target > context", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 300000,
    targetTokens: 333334,
  });
  assert.equal(result.valid, false);
});

test("validateAutoCompact: rejects non-integer contextWindowTokens", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000.5,
    targetTokens: 230000,
  });
  assert.equal(result.valid, false);
});

test("validateAutoCompact: rejects integers outside JavaScript's safe range", () => {
  const result = validateAutoCompact({
    contextWindowTokens: Number.MAX_SAFE_INTEGER + 1,
    targetTokens: 230000,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /safe integer/i);
});

test("validateAutoCompact: rejects negative targetTokens", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: -100,
  });
  assert.equal(result.valid, false);
});

test("validateAutoCompact: rejects missing contextWindowTokens", () => {
  const result = validateAutoCompact({
    targetTokens: 230000,
  });
  assert.equal(result.valid, false);
});

test("validateAutoCompact: rejects missing targetTokens", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
  });
  assert.equal(result.valid, false);
});

test("validateAutoCompact: rejects zero contextWindowTokens", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 0,
    targetTokens: 0,
  });
  assert.equal(result.valid, false);
});

test("validateAutoCompact: rejects invalid scope value", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230000,
    scope: "global",
  });
  assert.equal(result.valid, false);
});

test("validateAutoCompact: rejects non-string taskScopeId", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230000,
    scope: "task",
    taskScopeId: 12345,
  });
  assert.equal(result.valid, false);
});

test("validateAutoCompact: rejects taskScopeId:null because it cannot identify a task to clear", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230000,
    scope: "task",
    taskScopeId: null,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /taskScopeId.*UUID|omit.*generate/i);
});

test("validateAutoCompact: rejects non-UUID taskScopeId", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230000,
    scope: "task",
    taskScopeId: "abc-123-def",
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /UUID/i);
});

test("validateAutoCompact: accepts explicit task clear directive", () => {
  const taskScopeId = "11111111-2222-4333-8444-555555555555";
  const result = validateAutoCompact({
    scope: "task",
    taskScopeId,
    clear: true,
  });
  assert.equal(result.valid, true);
  assert.equal(result.clearMode, true);
  assert.equal(result.taskScopeId, taskScopeId);
  assert.equal(result.effectiveWindow, null);
});

test("validateAutoCompact: rejects clear mixed with context policy", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230000,
    scope: "task",
    taskScopeId: "11111111-2222-4333-8444-555555555555",
    clear: true,
  });
  assert.equal(result.valid, false);
  assert.match(result.error, /clear.*context|cannot.*context/i);
});

test("validateAutoCompact: rejects non-object autoCompact", () => {
  const result = validateAutoCompact("not an object");
  assert.equal(result.valid, false);
});

test("validateAutoCompact: rejects object with unknown fields", () => {
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230000,
    evilExtra: "malware",
  });
  assert.equal(result.valid, false);
});

test("validateAutoCompact: 256K/230K accepted (boundary case)", () => {
  // floor(256000 * 0.9) = 230400, 230000 <= 230400 → accept
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230000,
  });
  assert.equal(result.valid, true);
  assert.equal(result.effectiveWindow, 255556);
});

test("validateAutoCompact: 256K/230400 accepted (exactly 90%)", () => {
  // floor(256000 * 0.9) = 230400, 230400 <= 230400 → accept
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230400,
  });
  assert.equal(result.valid, true);
});

test("validateAutoCompact: 256K/230401 rejected (just over 90%)", () => {
  // floor(256000 * 0.9) = 230400, 230401 > 230400 → reject
  const result = validateAutoCompact({
    contextWindowTokens: 256000,
    targetTokens: 230401,
  });
  assert.equal(result.valid, false);
});

// ─── Scope resolution tests ─────────────────────────────────────────────────

test("resolveScope: this-call explicit value wins over session and task", () => {
  const result = resolveScope({
    thisCall: { scope: "delegation", contextWindowTokens: 200000, targetTokens: 180000, taskScopeId: null },
    sessionPolicy: { scope: "session", contextWindowTokens: 300000, targetTokens: 270000 },
    taskPolicy: { scope: "task", contextWindowTokens: 400000, targetTokens: 360000, taskScopeId: "task-1" },
  });
  assert.equal(result.scope, "delegation");
  assert.equal(result.contextWindowTokens, 200000);
  assert.equal(result.targetTokens, 180000);
});

test("resolveScope: session wins when no this-call and task exists", () => {
  const result = resolveScope({
    thisCall: null,
    sessionPolicy: { scope: "session", contextWindowTokens: 300000, targetTokens: 270000 },
    taskPolicy: { scope: "task", contextWindowTokens: 400000, targetTokens: 360000, taskScopeId: "task-1" },
  });
  assert.equal(result.scope, "session");
  assert.equal(result.contextWindowTokens, 300000);
});

test("resolveScope: task wins when no this-call and no session", () => {
  const result = resolveScope({
    thisCall: null,
    sessionPolicy: null,
    taskPolicy: { scope: "task", contextWindowTokens: 400000, targetTokens: 360000, taskScopeId: "task-1" },
  });
  assert.equal(result.scope, "task");
  assert.equal(result.taskScopeId, "task-1");
});

test("resolveScope: returns null when no policy at any level", () => {
  const result = resolveScope({
    thisCall: null,
    sessionPolicy: null,
    taskPolicy: null,
  });
  assert.equal(result, null);
});

test("resolveScope: this-call null with task scope clears task policy", () => {
  // Explicit null for thisCall means "no autoCompact for this delegation"
  const result = resolveScope({
    thisCall: null,
    sessionPolicy: null,
    taskPolicy: { scope: "task", contextWindowTokens: 400000, targetTokens: 360000, taskScopeId: "task-1" },
    clearTaskScope: true,
  });
  assert.equal(result, null);
});

// ─── Integration tests: inline --settings injection ─────────────────────────

test("cc_delegate with autoCompact passes --settings with two env keys", async (t) => {
  const server = startServer(t);
  const result = await server.send(1, "cc_delegate", {
    task: "echo-args",
    autoCompact: {
      contextWindowTokens: 256000,
      targetTokens: 230000,
      scope: "delegation",
    },
  });
  const text = result.result.content[0].text;
  // The fake Claude echoes its CLI args as the result
  assert.match(text, /任务完成/);
  // Extract the args portion from the result
  const argsMatch = text.match(/### 结果\n([\s\S]*?)(\n\n|\n---)/);
  assert.ok(argsMatch, "Result section must be present");
  const args = argsMatch[1].trim();
  // --settings must be present
  assert.match(args, /--settings/);
  // Find the --settings value (next arg after --settings)
  const settingsIdx = args.indexOf("--settings");
  const afterSettings = args.slice(settingsIdx + "--settings".length).trim();
  // The settings JSON is the next space-delimited token
  const jsonStr = afterSettings.split(/\s/)[0];
  const parsed = JSON.parse(jsonStr);
  // Must contain only two env keys
  assert.ok(parsed.env, "settings JSON must have env object");
  assert.deepEqual(Object.keys(parsed.env).sort(),
    ["CLAUDE_AUTOCOMPACT_PCT_OVERRIDE", "CLAUDE_CODE_AUTO_COMPACT_WINDOW"].sort(),
    "settings JSON must contain exactly the two compact env keys");
  assert.equal(parsed.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, "90");
  assert.equal(parsed.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "255556");
});

test("cc_delegate with autoCompact does not modify parent process.env", async (t) => {
  const server = startServer(t);
  // Snapshot the parent env before delegation
  const envBefore = { ...process.env };
  await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 1_000_000,
      targetTokens: 300000,
      scope: "delegation",
    },
  });
  // Parent env must be unchanged
  const envAfter = { ...process.env };
  assert.deepEqual(Object.keys(envAfter).sort(), Object.keys(envBefore).sort(),
    "Parent env keys must not change");
  for (const key of Object.keys(envBefore)) {
    assert.equal(envAfter[key], envBefore[key], `Parent env[${key}] must not change`);
  }
  // The compact env keys must NOT be in the parent env
  assert.equal(process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined,
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW must not leak into parent env");
  assert.equal(process.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined,
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE must not leak into parent env");
});

test("cc_delegate with autoCompact does not write to HOME settings", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ac-home-"));
  const fakeHome = path.join(workspace, "fake-home");
  fs.mkdirSync(fakeHome, { recursive: true });
  const claudeDir = path.join(fakeHome, ".claude");
  const server = startServer(t, {
    workspace,
    env: { HOME: fakeHome },
  });
  // Ensure no .claude dir exists before
  assert.ok(!fs.existsSync(claudeDir), "No .claude dir should exist before delegation");
  await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 256000,
      targetTokens: 230000,
      scope: "delegation",
    },
  });
  // No .claude dir should be created by the plugin
  // (The fake Claude might create it, but the plugin itself must not)
  // We verify by checking the settings file doesn't exist
  const settingsFile = path.join(claudeDir, "settings.json");
  assert.ok(!fs.existsSync(settingsFile),
    "Plugin must not write ~/.claude/settings.json");
});

test("cc_delegate rejects autoCompact with target > 90% of context", async (t) => {
  const server = startServer(t);
  const result = await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 256000,
      targetTokens: 250000,
    },
  });
  assert.match(result.result.content[0].text, /Error.*90%/i);
  assert.equal(result.result.isError, true);
});

test("cc_delegate rejects autoCompact with illegal fields", async (t) => {
  const server = startServer(t);
  const result = await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: "not-a-number",
      targetTokens: 230000,
    },
  });
  assert.match(result.result.content[0].text, /Error/i);
  assert.equal(result.result.isError, true);
});

test("cc_delegate with task scope generates and returns taskScopeId", async (t) => {
  const server = startServer(t);
  const result = await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 1_000_000,
      targetTokens: 300000,
      scope: "task",
    },
  });
  const text = result.result.content[0].text;
  assert.match(text, /任务完成/);
  assert.match(text, /taskScopeId=[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
});

test("failed task-scoped delegation still returns its generated taskScopeId", async (t) => {
  const server = startServer(t);
  const result = await server.send(1, "cc_delegate", {
    task: "invalid-json",
    autoCompact: {
      contextWindowTokens: 1_000_000,
      targetTokens: 300000,
      scope: "task",
    },
  });
  const text = result.result.content[0].text;
  assert.equal(result.result.isError, true);
  assert.match(text, /任务失败/i);
  assert.match(text, /自动压缩 taskScopeId：\*\*\s*[0-9a-f-]{36}/i);
});

test("cc_delegate with task scope and explicit taskScopeId carries it forward", async (t) => {
  const server = startServer(t);
  const explicitId = "11111111-2222-3333-4444-555555555555";
  const result = await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 1_000_000,
      targetTokens: 300000,
      scope: "task",
      taskScopeId: explicitId,
    },
  });
  const text = result.result.content[0].text;
  assert.match(text, /任务完成/);
  assert.match(text, new RegExp(`taskScopeId=${explicitId}`));
});

test("cc_delegate without autoCompact works normally (no --settings)", async (t) => {
  const server = startServer(t);
  const result = await server.send(1, "cc_delegate", {
    task: "echo-args",
  });
  const text = result.result.content[0].text;
  assert.match(text, /任务完成/);
  // --settings should NOT be present
  assert.doesNotMatch(text, /--settings/);
  // Auto-compact section should NOT be present
  assert.doesNotMatch(text, /自动压缩/);
});

test("cc_delegate with autoCompact stores audit fields in job state", async (t) => {
  const server = startServer(t);
  await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 256000,
      targetTokens: 230000,
      scope: "session",
    },
  });
  const jobs = listJobs(server.workspace);
  const job = jobs.find((j) => j.status === "completed");
  assert.ok(job, "Completed job must exist");
  assert.ok(job.autoCompact, "Job must have autoCompact audit fields");
  assert.equal(job.autoCompact.scope, "session");
  assert.equal(job.autoCompact.contextWindowTokens, 256000);
  assert.equal(job.autoCompact.targetTokens, 230000);
  assert.equal(job.autoCompact.effectiveWindow, 255556);
  assert.equal(job.autoCompact.settingsInjected, true);
  // No secrets in audit fields — check for actual secret-like patterns,
  // not the substring "token" (which appears in contextWindowTokens legitimately).
  const auditStr = JSON.stringify(job.autoCompact);
  assert.doesNotMatch(auditStr, /api[_-]?key|password|secret|sk-[a-z0-9]/i);
  // Audit fields must be only the known non-sensitive keys.
  // observedBoundary/compactTrigger are null when no transcript boundary is found.
  assert.deepEqual(Object.keys(job.autoCompact).sort(),
    ["cleared", "compactTrigger", "contextWindowTokens", "effectiveWindow", "observedBoundary", "scope", "settingsInjected", "targetTokens", "taskScopeId"].sort());
  assert.equal(job.autoCompact.cleared, false);
  assert.equal(job.autoCompact.observedBoundary, null);
  assert.equal(job.autoCompact.compactTrigger, null);
});

// ─── Scope inheritance integration tests ────────────────────────────────────

test("session scope: replayed on resume without explicit autoCompact", async (t) => {
  const server = startServer(t);

  // First delegation: session-scope autoCompact
  const first = await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 256000,
      targetTokens: 230000,
      scope: "session",
    },
  });
  assert.match(first.result.content[0].text, /任务完成/);

  // Get the claudeSessionId from the completed job
  const jobs = listJobs(server.workspace);
  const completedJob = jobs.find((j) => j.status === "completed");
  assert.ok(completedJob?.claudeSessionId, "Completed job must have claudeSessionId");

  // Resume the session WITHOUT explicit autoCompact — should replay session-scope policy
  const resumed = await server.send(2, "cc_delegate", {
    task: "echo-args",
    resumeSession: completedJob.claudeSessionId,
  });
  const text = resumed.result.content[0].text;
  assert.match(text, /任务完成/);
  // --settings must be present (replayed from session scope)
  assert.match(text, /--settings/);
  // Verify the effectiveWindow matches the original policy
  const argsMatch = text.match(/### 结果\n([\s\S]*?)(\n\n|\n---)/);
  assert.ok(argsMatch);
  const args = argsMatch[1].trim();
  const settingsIdx = args.indexOf("--settings");
  const afterSettings = args.slice(settingsIdx + "--settings".length).trim();
  const jsonStr = afterSettings.split(/\s/)[0];
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "255556");
});

test("resumed autoCompact records only a boundary appended during that delegation", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-ac-boundary-cursor-"));
  const configDir = path.join(workspace, "claude-config");
  const projectDir = path.join(configDir, "projects", "test-project");
  fs.mkdirSync(projectDir, { recursive: true });
  const server = startServer(t, {
    workspace,
    env: { CLAUDE_CONFIG_DIR: configDir },
  });

  await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 256000,
      targetTokens: 230000,
      scope: "session",
    },
  });
  const firstJob = listJobs(workspace).find((job) => job.status === "completed");
  fs.writeFileSync(
    path.join(projectDir, `${firstJob.claudeSessionId}.jsonl`),
    `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 12345, trigger: "auto" },
    })}\n`,
  );

  await server.send(2, "cc_delegate", {
    task: "success",
    resumeSession: firstJob.claudeSessionId,
  });
  const resumedJob = listJobs(workspace).find((job) =>
    job.resumeSession === firstJob.claudeSessionId
  );
  assert.equal(resumedJob.autoCompact.observedBoundary, null,
    "Historical boundary must not be attributed to the resumed delegation");
});

test("task scope: new session inherits same taskScopeId", async (t) => {
  const server = startServer(t);

  // First delegation: task-scope autoCompact (generates taskScopeId)
  const first = await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 1_000_000,
      targetTokens: 300000,
      scope: "task",
    },
  });
  const firstText = first.result.content[0].text;
  assert.match(firstText, /任务完成/);
  // Extract the generated taskScopeId
  const idMatch = firstText.match(/taskScopeId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  assert.ok(idMatch, "First task-scope delegation must generate and return taskScopeId");
  const taskScopeId = idMatch[1];

  // Second delegation: inherit using only taskScopeId (no context/target)
  const second = await server.send(2, "cc_delegate", {
    task: "echo-args",
    autoCompact: { scope: "task", taskScopeId },
  });
  const secondText = second.result.content[0].text;
  assert.match(secondText, /任务完成/);
  // --settings must be present (inherited from task scope)
  assert.match(secondText, /--settings/);
  // Verify the effectiveWindow matches the original policy (300000 → 333334)
  const argsMatch = secondText.match(/### 结果\n([\s\S]*?)(\n\n|\n---)/);
  assert.ok(argsMatch);
  const args = argsMatch[1].trim();
  const settingsIdx = args.indexOf("--settings");
  const afterSettings = args.slice(settingsIdx + "--settings".length).trim();
  const jsonStr = afterSettings.split(/\s/)[0];
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, "333334");
});

test("task scope: unknown taskScopeId inheritance fails closed before spawn", async (t) => {
  const server = startServer(t);

  // First delegation: task-scope autoCompact
  await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 1_000_000,
      targetTokens: 300000,
      scope: "task",
    },
  });

  // Second delegation: unknown taskScopeId — must fail closed rather than
  // silently running without the requested task policy.
  const second = await server.send(2, "cc_delegate", {
    task: "echo-args",
    autoCompact: {
      scope: "task",
      taskScopeId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    },
  });
  const text = second.result.content[0].text;
  assert.equal(second.result.isError, true);
  assert.match(text, /taskScopeId.*not found|no active.*policy/i);
});

test("explicit autoCompact=null means no autoCompact and no inheritance", async (t) => {
  const server = startServer(t);

  // First delegation: session-scope autoCompact
  const first = await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 256000,
      targetTokens: 230000,
      scope: "session",
    },
  });
  assert.match(first.result.content[0].text, /任务完成/);

  const jobs = listJobs(server.workspace);
  const completedJob = jobs.find((j) => j.status === "completed");
  assert.ok(completedJob?.claudeSessionId);

  // Resume with explicit autoCompact=null — should NOT inherit
  const resumed = await server.send(2, "cc_delegate", {
    task: "echo-args",
    resumeSession: completedJob.claudeSessionId,
    autoCompact: null,
  });
  const text = resumed.result.content[0].text;
  assert.match(text, /任务完成/);
  // --settings should NOT be present (explicit null blocks inheritance)
  assert.doesNotMatch(text, /--settings/);
});

test("explicit autoCompact=null persists a session clear tombstone", async (t) => {
  const server = startServer(t);

  await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 256000,
      targetTokens: 230000,
      scope: "session",
    },
  });

  const firstJob = listJobs(server.workspace).find((j) => j.status === "completed");
  await server.send(2, "cc_delegate", {
    task: "success",
    resumeSession: firstJob.claudeSessionId,
    autoCompact: null,
  });

  const clearJob = listJobs(server.workspace).find((j) =>
    j.resumeSession === firstJob.claudeSessionId && j.autoCompact?.cleared === true
  );
  assert.ok(clearJob, "Explicit null resume must persist a clear tombstone");
  assert.equal(clearJob.autoCompact.scope, "session");
  assert.equal(clearJob.autoCompact.settingsInjected, false);

  // Updating the older policy job (cc_compact persists compactResult) must not
  // make mutable updatedAt order resurrect it past the clear tombstone.
  await server.send(3, "cc_compact", { job: firstJob.id });

  const resumedAgain = await server.send(4, "cc_delegate", {
    task: "echo-args",
    resumeSession: firstJob.claudeSessionId,
  });
  assert.match(resumedAgain.result.content[0].text, /任务完成/);
  assert.doesNotMatch(resumedAgain.result.content[0].text, /--settings/,
    "A later resume must not resurrect an older session policy after clear");
});

test("task clear tombstone prevents later inheritance", async (t) => {
  const server = startServer(t);
  const first = await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 1_000_000,
      targetTokens: 300000,
      scope: "task",
    },
  });
  const taskScopeId = first.result.content[0].text.match(
    /taskScopeId=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  )?.[1];
  assert.ok(taskScopeId);
  const firstJob = listJobs(server.workspace).find((job) =>
    job.autoCompact?.taskScopeId === taskScopeId
  );
  assert.ok(firstJob);

  const cleared = await server.send(2, "cc_delegate", {
    task: "success",
    autoCompact: { scope: "task", taskScopeId, clear: true },
  });
  assert.match(cleared.result.content[0].text, /任务完成/);
  assert.doesNotMatch(cleared.result.content[0].text, /--settings/);

  await server.send(3, "cc_compact", { job: firstJob.id });

  const inherited = await server.send(4, "cc_delegate", {
    task: "echo-args",
    autoCompact: { scope: "task", taskScopeId },
  });
  assert.equal(inherited.result.isError, true);
  assert.match(inherited.result.content[0].text, /cleared|not found|no active.*policy/i);
});

test("cc_delegate with taskScopeId:undefined (omitted) generates new ID for task scope", async (t) => {
  const server = startServer(t);
  const result = await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 1_000_000,
      targetTokens: 300000,
      scope: "task",
      // taskScopeId omitted — should generate
    },
  });
  assert.match(result.result.content[0].text, /任务完成/);
  const job = listJobs(server.workspace).find((j) => j.status === "completed");
  assert.ok(job.autoCompact.taskScopeId,
    "Omitted taskScopeId with task scope must generate a new ID");
  assert.match(job.autoCompact.taskScopeId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
});

// ─── Deep module: resolveDelegateAutoCompact unit tests ─────────────────────

const SESSION = "test-session-uuid-0001";
const TASK_SCOPE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Build a minimal policy-bearing job record. */
function policyJob({ id, createdAt, sessionId = SESSION, autoCompact, status = "completed" }) {
  return {
    id,
    createdAt,
    status,
    claudeSessionUuid: sessionId,
    ...(autoCompact === undefined ? {} : { autoCompact }),
  };
}

/** Build a stored autoCompact audit as persisted in job state. */
function storedAudit({ scope, contextWindowTokens = null, targetTokens = null, effectiveWindow = null, taskScopeId = null, cleared = false }) {
  return { scope, contextWindowTokens, targetTokens, effectiveWindow, taskScopeId, settingsInjected: !cleared, cleared };
}

test("resolveDelegateAutoCompact: full policy injects settings and persists audit", () => {
  const decision = resolveDelegateAutoCompact({
    request: { contextWindowTokens: 256000, targetTokens: 230400, scope: "delegation" },
    jobs: [],
  });
  assert.equal(decision.error, null);
  assert.equal(decision.settings, buildInlineSettings(256000));
  assert.deepEqual(decision.audit, {
    scope: "delegation",
    contextWindowTokens: 256000,
    targetTokens: 230400,
    effectiveWindow: 256000,
    taskScopeId: null,
    settingsInjected: true,
    cleared: false,
  });
});

test("resolveDelegateAutoCompact: task scope with omitted id generates a UUID", () => {
  const decision = resolveDelegateAutoCompact({
    request: { contextWindowTokens: 1_000_000, targetTokens: 300000, scope: "task" },
    jobs: [],
  });
  assert.equal(decision.error, null);
  assert.equal(decision.audit.scope, "task");
  assert.match(decision.audit.taskScopeId, UUID_RE);
});

test("resolveDelegateAutoCompact: task scope with explicit id carries it forward", () => {
  const decision = resolveDelegateAutoCompact({
    request: { contextWindowTokens: 1_000_000, targetTokens: 300000, scope: "task", taskScopeId: TASK_SCOPE },
    jobs: [],
  });
  assert.equal(decision.error, null);
  assert.equal(decision.audit.taskScopeId, TASK_SCOPE);
});

test("resolveDelegateAutoCompact: invalid request returns the validation error", () => {
  const decision = resolveDelegateAutoCompact({
    request: { contextWindowTokens: 256000, targetTokens: 300000, scope: "delegation" },
    jobs: [],
  });
  assert.equal(decision.settings, null);
  assert.equal(decision.audit, null);
  assert.match(decision.error, /targetTokens \(300000\) must be <= 90%/);
});

test("resolveDelegateAutoCompact: clear fails closed with no prior task policy", () => {
  const decision = resolveDelegateAutoCompact({
    request: { scope: "task", taskScopeId: TASK_SCOPE, clear: true },
    jobs: [],
  });
  assert.equal(decision.settings, null);
  assert.equal(decision.audit, null);
  assert.match(decision.error, /nothing was cleared/);
});

test("resolveDelegateAutoCompact: clear persists a tombstone when a prior task policy exists", () => {
  const decision = resolveDelegateAutoCompact({
    request: { scope: "task", taskScopeId: TASK_SCOPE, clear: true },
    jobs: [
      policyJob({
        id: "j1",
        createdAt: "2026-01-01T00:00:00.000Z",
        autoCompact: storedAudit({ scope: "task", taskScopeId: TASK_SCOPE, contextWindowTokens: 1_000_000, targetTokens: 300000, effectiveWindow: 333334 }),
      }),
    ],
  });
  assert.equal(decision.error, null);
  assert.deepEqual(decision.audit, {
    scope: "task",
    contextWindowTokens: null,
    targetTokens: null,
    effectiveWindow: null,
    taskScopeId: TASK_SCOPE,
    settingsInjected: false,
    cleared: true,
  });
});

test("resolveDelegateAutoCompact: inherit replays an active prior task policy", () => {
  const decision = resolveDelegateAutoCompact({
    request: { scope: "task", taskScopeId: TASK_SCOPE },
    jobs: [
      policyJob({
        id: "j1",
        createdAt: "2026-01-01T00:00:00.000Z",
        autoCompact: storedAudit({ scope: "task", taskScopeId: TASK_SCOPE, contextWindowTokens: 1_000_000, targetTokens: 300000, effectiveWindow: 333334 }),
      }),
    ],
  });
  assert.equal(decision.error, null);
  assert.equal(decision.settings, buildInlineSettings(333334));
  assert.equal(decision.audit.scope, "task");
  assert.equal(decision.audit.settingsInjected, true);
  assert.equal(decision.audit.cleared, false);
});

test("resolveDelegateAutoCompact: inherit fails closed on a tombstoned prior task policy", () => {
  const decision = resolveDelegateAutoCompact({
    request: { scope: "task", taskScopeId: TASK_SCOPE },
    jobs: [
      policyJob({
        id: "j1",
        createdAt: "2026-01-01T00:00:00.000Z",
        autoCompact: storedAudit({ scope: "task", taskScopeId: TASK_SCOPE, cleared: true }),
      }),
    ],
  });
  assert.equal(decision.settings, null);
  assert.equal(decision.audit, null);
  assert.match(decision.error, /no active autoCompact task policy/);
});

test("resolveDelegateAutoCompact: inherit fails closed on unknown taskScopeId", () => {
  const decision = resolveDelegateAutoCompact({
    request: { scope: "task", taskScopeId: TASK_SCOPE },
    jobs: [],
  });
  assert.match(decision.error, /no active autoCompact task policy/);
});

test("resolveDelegateAutoCompact: explicit null on a resume persists a session clear tombstone", () => {
  const decision = resolveDelegateAutoCompact({
    request: null,
    jobs: [],
    resumeSession: SESSION,
  });
  assert.equal(decision.settings, null);
  assert.equal(decision.error, null);
  assert.deepEqual(decision.audit, {
    scope: "session",
    contextWindowTokens: null,
    targetTokens: null,
    effectiveWindow: null,
    taskScopeId: null,
    settingsInjected: false,
    cleared: true,
  });
});

test("resolveDelegateAutoCompact: explicit null without a resume session yields no policy", () => {
  const decision = resolveDelegateAutoCompact({
    request: null,
    jobs: [],
    resumeSession: null,
  });
  assert.equal(decision.settings, null);
  assert.equal(decision.audit, null);
  assert.equal(decision.error, null);
});

test("resolveDelegateAutoCompact: undefined on a resume replays the stored session policy", () => {
  const decision = resolveDelegateAutoCompact({
    request: undefined,
    jobs: [
      policyJob({
        id: "j1",
        createdAt: "2026-01-01T00:00:00.000Z",
        autoCompact: storedAudit({ scope: "session", contextWindowTokens: 256000, targetTokens: 230400, effectiveWindow: 256000 }),
      }),
    ],
    resumeSession: SESSION,
  });
  assert.equal(decision.error, null);
  assert.equal(decision.settings, buildInlineSettings(256000));
  assert.equal(decision.audit.scope, "session");
  assert.equal(decision.audit.settingsInjected, true);
});

test("resolveDelegateAutoCompact: undefined on a resume — session policy wins over the session's task policy", () => {
  const decision = resolveDelegateAutoCompact({
    request: undefined,
    jobs: [
      policyJob({
        id: "task",
        createdAt: "2026-01-01T00:00:00.000Z",
        autoCompact: storedAudit({ scope: "task", taskScopeId: TASK_SCOPE, contextWindowTokens: 1_000_000, targetTokens: 300000, effectiveWindow: 333334 }),
      }),
      policyJob({
        id: "sess",
        createdAt: "2026-01-02T00:00:00.000Z",
        autoCompact: storedAudit({ scope: "session", contextWindowTokens: 256000, targetTokens: 230400, effectiveWindow: 256000 }),
      }),
    ],
    resumeSession: SESSION,
  });
  assert.equal(decision.settings, buildInlineSettings(256000));
  assert.equal(decision.audit.scope, "session");
});

test("resolveDelegateAutoCompact: undefined on a resume — newer session tombstone blocks older policies", () => {
  const decision = resolveDelegateAutoCompact({
    request: undefined,
    jobs: [
      policyJob({
        id: "older-task",
        createdAt: "2026-01-01T00:00:00.000Z",
        autoCompact: storedAudit({ scope: "task", taskScopeId: TASK_SCOPE, contextWindowTokens: 1_000_000, targetTokens: 300000, effectiveWindow: 333334 }),
      }),
      policyJob({
        id: "newer-session-clear",
        createdAt: "2026-01-03T00:00:00.000Z",
        autoCompact: storedAudit({ scope: "session", cleared: true }),
      }),
    ],
    resumeSession: SESSION,
  });
  assert.equal(decision.settings, null);
  assert.equal(decision.audit, null);
  assert.equal(decision.error, null);
});

test("resolveDelegateAutoCompact: undefined without a resume session yields no policy", () => {
  const decision = resolveDelegateAutoCompact({
    request: undefined,
    jobs: [],
    resumeSession: null,
  });
  assert.equal(decision.settings, null);
  assert.equal(decision.audit, null);
  assert.equal(decision.error, null);
});

// ─── Deep module: replayStoredAutoCompact unit tests ────────────────────────

test("replayStoredAutoCompact: replays session policy and returns its source job", () => {
  const job = policyJob({
    id: "j1",
    createdAt: "2026-01-01T00:00:00.000Z",
    autoCompact: storedAudit({ scope: "session", contextWindowTokens: 256000, targetTokens: 230400, effectiveWindow: 256000 }),
  });
  const replay = replayStoredAutoCompact({ jobs: [job], sessionId: SESSION });
  assert.equal(replay.settings, buildInlineSettings(256000));
  assert.equal(replay.sourceJob, job);
});

test("replayStoredAutoCompact: replays task policy", () => {
  const job = policyJob({
    id: "j1",
    createdAt: "2026-01-01T00:00:00.000Z",
    autoCompact: storedAudit({ scope: "task", taskScopeId: TASK_SCOPE, contextWindowTokens: 1_000_000, targetTokens: 300000, effectiveWindow: 333334 }),
  });
  const replay = replayStoredAutoCompact({ jobs: [job], sessionId: SESSION });
  assert.equal(replay.settings, buildInlineSettings(333334));
  assert.equal(replay.sourceJob, job);
});

test("replayStoredAutoCompact: delegation scope is not replayed", () => {
  const job = policyJob({
    id: "j1",
    createdAt: "2026-01-01T00:00:00.000Z",
    autoCompact: storedAudit({ scope: "delegation", contextWindowTokens: 256000, targetTokens: 230400, effectiveWindow: 256000 }),
  });
  const replay = replayStoredAutoCompact({ jobs: [job], sessionId: SESSION });
  assert.equal(replay.settings, null);
  assert.equal(replay.sourceJob, null);
});

test("replayStoredAutoCompact: clear tombstone yields no settings", () => {
  const job = policyJob({
    id: "j1",
    createdAt: "2026-01-01T00:00:00.000Z",
    autoCompact: storedAudit({ scope: "session", cleared: true }),
  });
  const replay = replayStoredAutoCompact({ jobs: [job], sessionId: SESSION });
  assert.equal(replay.settings, null);
  assert.equal(replay.sourceJob, job);
});

test("replayStoredAutoCompact: no matching session yields null", () => {
  const job = policyJob({
    id: "j1",
    createdAt: "2026-01-01T00:00:00.000Z",
    autoCompact: storedAudit({ scope: "session", contextWindowTokens: 256000, targetTokens: 230400, effectiveWindow: 256000 }),
  });
  const replay = replayStoredAutoCompact({ jobs: [job], sessionId: "other-session" });
  assert.equal(replay.settings, null);
  assert.equal(replay.sourceJob, null);
});
