import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listJobs, resolveStateDir, resolveJobsDir } from "../scripts/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverPath = path.join(pluginRoot, "scripts", "cc-companion.mjs");
const fakeClaudeSource = path.join(here, "helpers", "fake-claude.mjs");

// ─── Test helpers ────────────────────────────────────────────────────────────

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
  }
  return fakeClaude;
}

function startServer(t, opts = {}) {
  const workspace = opts.workspace || fs.mkdtempSync(path.join(os.tmpdir(), "cc-cont-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  installFakeClaude(binDir);

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
      }, 15000);
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

function extractArgs(resultText) {
  const argsMatch = resultText.match(/### 结果\n([\s\S]*?)(\n\n|\n---)/);
  return argsMatch ? argsMatch[1].trim() : "";
}

// ─── tools/list: 9 tools including cc_plan_continuation ─────────────────────

test("tools/list returns nine tools including cc_plan_continuation", async (t) => {
  const server = startServer(t);
  const res = await server.request(1, "tools/list");
  const names = res.result.tools.map((tool) => tool.name);
  assert.equal(names.length, 9);
  assert.ok(names.includes("cc_plan_continuation"), `expected cc_plan_continuation in ${names.join(", ")}`);
  assert.ok(names.includes("cc_delegate"));
  assert.ok(names.includes("cc_compact"));
});

test("cc_plan_continuation is read-only (no write capability) and accepts the contract inputs", async (t) => {
  const server = startServer(t);
  const res = await server.request(1, "tools/list");
  const tool = res.result.tools.find((x) => x.name === "cc_plan_continuation");
  assert.ok(tool);
  const props = tool.inputSchema.properties;
  for (const field of ["cwd", "parentJob", "parentSession", "relationship", "contextValue", "userIntent", "correctionCount", "allowCompact", "model", "write"]) {
    assert.ok(props[field], `cc_plan_continuation must accept ${field}`);
  }
});

// ─── cc_plan_continuation: no evidence → fresh_handoff ───────────────────────

test("cc_plan_continuation with no prior evidence returns fresh_handoff", async (t) => {
  const server = startServer(t);
  const res = await server.send(1, "cc_plan_continuation", {
    parentJob: "cc-missing",
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "auto",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  assert.equal(res.result.isError, undefined);
  const text = res.result.content[0].text;
  assert.match(text, /fresh_handoff/);
  assert.match(text, /unavailable/);
  assert.match(text, /plan_[0-9a-f-]+/);
  assert.equal(res.result.structuredContent.action, "fresh_handoff");
  assert.equal(res.result.structuredContent.evidenceState, "unavailable");
});

test("cc_plan_continuation with explicit fresh returns fresh_handoff with handoff template", async (t) => {
  const server = startServer(t);
  const res = await server.send(1, "cc_plan_continuation", {
    relationship: "same_attempt",
    contextValue: "essential",
    userIntent: "fresh",
    correctionCount: 0,
    allowCompact: false,
    model: null,
    write: true,
  });
  const text = res.result.content[0].text;
  assert.match(text, /fresh_handoff/);
  assert.match(text, /Objective/);
  assert.match(text, /Acceptance checks/);
});

test("cc_plan_continuation with explicit same_session and no evidence returns resume", async (t) => {
  const server = startServer(t);
  const res = await server.send(1, "cc_plan_continuation", {
    parentSession: "sess-explicit-1",
    relationship: "same_attempt",
    contextValue: "essential",
    userIntent: "same_session",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  const text = res.result.content[0].text;
  assert.match(text, /resume/);
  assert.doesNotMatch(text, /fresh_handoff/);
});

test("cc_plan_continuation uses current-turn usage and provider contextWindow", async (t) => {
  const server = startServer(t, { env: { FAKE_USAGE_PROFILE: "high" } });
  await server.send(1, "cc_delegate", { task: "success" });
  const parentJob = listJobs(server.workspace).find((job) => job.status === "completed");
  assert.ok(parentJob);

  const plan = await server.send(2, "cc_plan_continuation", {
    parentJob: parentJob.id,
    relationship: "same_attempt",
    contextValue: "essential",
    userIntent: "auto",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  assert.equal(plan.result.structuredContent.evidenceState, "complete");
  assert.equal(plan.result.structuredContent.action, "compact_resume");
  assert.ok(plan.result.structuredContent.pressure >= 0.75);
});

test("cc_plan_continuation rejects a parentJob/parentSession mismatch", async (t) => {
  const server = startServer(t);
  await server.send(1, "cc_delegate", { task: "success" });
  const parentJob = listJobs(server.workspace).find((job) => job.status === "completed");
  assert.ok(parentJob);
  const plan = await server.send(2, "cc_plan_continuation", {
    parentJob: parentJob.id,
    parentSession: "different-session",
    relationship: "same_attempt",
    contextValue: "essential",
    userIntent: "same_session",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  assert.equal(plan.result.isError, true);
  assert.match(plan.result.content[0].text, /different|identify/i);
});

test("same_session resolves parentJob from persisted state after MCP restart", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cont-restart-"));
  const firstServer = startServer(t, { workspace });
  await firstServer.send(1, "cc_delegate", { task: "success" });
  const parentJob = listJobs(workspace).find((job) => job.status === "completed");
  assert.ok(parentJob?.claudeSessionId);

  firstServer.child.kill("SIGTERM");
  if (firstServer.child.exitCode === null && firstServer.child.signalCode === null) {
    await new Promise((resolve) => firstServer.child.once("exit", resolve));
  }

  const restarted = startServer(t, { workspace });
  const plan = await restarted.send(2, "cc_plan_continuation", {
    parentJob: parentJob.id,
    relationship: "same_attempt",
    contextValue: "essential",
    userIntent: "same_session",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  assert.equal(plan.result.structuredContent.evidenceState, "unavailable");
  assert.equal(plan.result.structuredContent.action, "resume");

  const resumed = await restarted.send(3, "cc_delegate", {
    task: "echo-args",
    continuationPlan: plan.result.structuredContent.planId,
  });
  assert.match(
    extractArgs(resumed.result.content[0].text),
    new RegExp(`--resume ${parentJob.claudeSessionId}`),
  );
});

test("plugin-derived workspace drift pushes auto intent to fresh_handoff", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cont-drift-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: workspace }).status, 0);
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "before\n");
  assert.equal(spawnSync("git", ["add", "tracked.txt"], { cwd: workspace }).status, 0);

  const server = startServer(t, { workspace });
  await server.send(1, "cc_delegate", { task: "success" });
  const parentJob = listJobs(workspace).find((job) => job.status === "completed");
  assert.ok(parentJob);
  fs.writeFileSync(path.join(workspace, "tracked.txt"), "after\n");

  const plan = await server.send(2, "cc_plan_continuation", {
    parentJob: parentJob.id,
    relationship: "same_attempt",
    contextValue: "essential",
    userIntent: "auto",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  assert.equal(plan.result.structuredContent.action, "fresh_handoff");
  assert.ok(plan.result.structuredContent.reasonCodes.includes("drift-detected"));
});

// ─── cc_plan_continuation: invalid inputs fail closed ────────────────────────

test("cc_plan_continuation rejects unknown relationship", async (t) => {
  const server = startServer(t);
  const res = await server.send(1, "cc_plan_continuation", {
    relationship: "cousin",
    contextValue: "useful",
    userIntent: "auto",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  assert.equal(res.result.isError, true);
});

test("cc_plan_continuation rejects unknown userIntent", async (t) => {
  const server = startServer(t);
  const res = await server.send(1, "cc_plan_continuation", {
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "maybe",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  assert.equal(res.result.isError, true);
});

// ─── cc_delegate with continuationPlan (fresh path) ──────────────────────────

test("cc_delegate consumes a fresh continuationPlan and rejects replay", async (t) => {
  const server = startServer(t);
  const plan = await server.send(1, "cc_plan_continuation", {
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "fresh",
    correctionCount: 0,
    allowCompact: false,
    model: null,
    write: true,
  });
  const planText = plan.result.content[0].text;
  const planId = (planText.match(/plan_[0-9a-f-]+/) || [])[0];
  assert.ok(planId);

  const delegated = await server.send(2, "cc_delegate", {
    task: "success",
    continuationPlan: planId,
  });
  assert.match(delegated.result.content[0].text, /任务完成/);

  // Replay must be rejected.
  const replay = await server.send(3, "cc_delegate", {
    task: "success",
    continuationPlan: planId,
  });
  assert.equal(replay.result.isError, true);
  assert.match(replay.result.content[0].text, /plan|consum|expired/i);
});

test("cc_delegate fresh plan forbids resume flags", async (t) => {
  const server = startServer(t);
  const plan = await server.send(1, "cc_plan_continuation", {
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "fresh",
    correctionCount: 0,
    allowCompact: false,
    model: null,
    write: true,
  });
  const planId = (plan.result.content[0].text.match(/plan_[0-9a-f-]+/) || [])[0];

  const res = await server.send(2, "cc_delegate", {
    task: "success",
    continuationPlan: planId,
    resume: true,
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /resume|fresh/i);
});

test("cc_delegate rejects continuationPlan with mismatched model", async (t) => {
  const server = startServer(t);
  const plan = await server.send(1, "cc_plan_continuation", {
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "fresh",
    correctionCount: 0,
    allowCompact: false,
    model: "opus",
    write: true,
  });
  const planId = (plan.result.content[0].text.match(/plan_[0-9a-f-]+/) || [])[0];

  const res = await server.send(2, "cc_delegate", {
    task: "success",
    continuationPlan: planId,
    model: "sonnet",
  });
  assert.equal(res.result.isError, true);
});

test("cc_delegate rejects an expired or unknown continuationPlan", async (t) => {
  const server = startServer(t);
  const res = await server.send(1, "cc_delegate", {
    task: "success",
    continuationPlan: "plan_does_not_exist",
  });
  assert.equal(res.result.isError, true);
});

// ─── cc_delegate with continuationPlan (resume path) ─────────────────────────

test("cc_delegate resume plan resumes the exact parent session", async (t) => {
  const server = startServer(t);
  // First delegation creates a session.
  const first = await server.send(1, "cc_delegate", { task: "success" });
  assert.match(first.result.content[0].text, /任务完成/);
  const jobs = listJobs(server.workspace);
  const firstJob = jobs.find((j) => j.status === "completed");
  assert.ok(firstJob?.claudeSessionId, "first job must have a claudeSessionId");

  // Plan a resume targeting the first job.
  const plan = await server.send(2, "cc_plan_continuation", {
    parentJob: firstJob.id,
    relationship: "same_attempt",
    contextValue: "essential",
    userIntent: "same_session",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  const planText = plan.result.content[0].text;
  const planId = (planText.match(/plan_[0-9a-f-]+/) || [])[0];
  assert.ok(planId);
  assert.match(planText, /resume/);

  // Consume the resume plan — the delegation must resume the parent session.
  const resumed = await server.send(3, "cc_delegate", {
    task: "echo-args",
    continuationPlan: planId,
  });
  assert.match(resumed.result.content[0].text, /任务完成/);
  const args = extractArgs(resumed.result.content[0].text);
  assert.match(args, /--resume/);
  assert.ok(args.includes(firstJob.claudeSessionId), "must resume the exact parent session id");
});

// ─── maxBudgetUsd: budget guard fail-closed and passthrough ──────────────────

test("cc_delegate with maxBudgetUsd fails closed when CLI lacks --max-budget-usd", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_HELP_BUDGET_GUARD: "0" } });
  const res = await server.send(1, "cc_delegate", {
    task: "success",
    maxBudgetUsd: 5,
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /budget|--max-budget-usd|fail-closed|not support/i);
});

test("cc_delegate rejects budget capability text from a failed help invocation", async (t) => {
  const server = startServer(t, {
    env: {
      FAKE_CLAUDE_HELP_BUDGET_GUARD: "1",
      FAKE_CLAUDE_HELP_EXIT_CODE: "7",
    },
  });
  const res = await server.send(1, "cc_delegate", {
    task: "success",
    maxBudgetUsd: 5,
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /budget|--max-budget-usd|fail-closed|not support/i);
});

test("cc_delegate with maxBudgetUsd passes --max-budget-usd through when CLI supports it", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_HELP_BUDGET_GUARD: "1" } });
  const res = await server.send(1, "cc_delegate", {
    task: "echo-args",
    maxBudgetUsd: 5,
  });
  assert.match(res.result.content[0].text, /任务完成/);
  const args = extractArgs(res.result.content[0].text);
  assert.match(args, /--max-budget-usd 5/);
});

test("cc_delegate rejects maxBudgetUsd > 1000", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_HELP_BUDGET_GUARD: "1" } });
  const res = await server.send(1, "cc_delegate", {
    task: "success",
    maxBudgetUsd: 1001,
  });
  assert.equal(res.result.isError, true);
});

test("cc_delegate rejects non-positive maxBudgetUsd", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_HELP_BUDGET_GUARD: "1" } });
  const zero = await server.send(1, "cc_delegate", { task: "success", maxBudgetUsd: 0 });
  assert.equal(zero.result.isError, true);
  const neg = await server.send(2, "cc_delegate", { task: "success", maxBudgetUsd: -3 });
  assert.equal(neg.result.isError, true);
});

test("cc_delegate without maxBudgetUsd is unaffected (no budget guard check)", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_HELP_BUDGET_GUARD: "0" } });
  const res = await server.send(1, "cc_delegate", { task: "success" });
  assert.match(res.result.content[0].text, /任务完成/);
});

// ─── cc_compact with continuationPlan ────────────────────────────────────────

test("cc_compact rejects a non-compact_resume continuationPlan", async (t) => {
  const server = startServer(t);
  // Create a fresh plan (not compact_resume).
  const plan = await server.send(1, "cc_plan_continuation", {
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "fresh",
    correctionCount: 0,
    allowCompact: false,
    model: null,
    write: true,
  });
  const planId = (plan.result.content[0].text.match(/plan_[0-9a-f-]+/) || [])[0];

  // First create a stopped session to compact.
  await server.send(2, "cc_delegate", { task: "success" });

  const res = await server.send(3, "cc_compact", { continuationPlan: planId });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /compact_resume|not.*compact/i);
});

test("cc_compact with maxBudgetUsd fails closed when CLI lacks --max-budget-usd", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_HELP_BUDGET_GUARD: "0" } });
  await server.send(1, "cc_delegate", { task: "success" });
  const res = await server.send(2, "cc_compact", { maxBudgetUsd: 2 });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /budget|--max-budget-usd|fail-closed|not support/i);
});

// ─── delegate/compact without continuationPlan stay backward compatible ───────

test("cc_delegate without continuationPlan preserves existing fresh-default behavior", async (t) => {
  const server = startServer(t);
  const res = await server.send(1, "cc_delegate", { task: "success" });
  assert.match(res.result.content[0].text, /任务完成/);
  // No resume flags by default.
  const args = extractArgs(res.result.content[0].text);
  assert.doesNotMatch(args, /--resume/);
});

test("cc_compact without continuationPlan preserves existing behavior", async (t) => {
  const server = startServer(t);
  await server.send(1, "cc_delegate", { task: "success" });
  const res = await server.send(2, "cc_compact", {});
  // Either compacts or reports no boundary — both are non-error outcomes.
  assert.equal(res.result.isError, undefined);
  assert.equal(typeof res.result.structuredContent.compacted, "boolean");
  assert.equal(typeof res.result.structuredContent.costUsd, "number");
  assert.equal(typeof res.result.structuredContent.durationSeconds, "number");
});

// ─── Fix: telemetry/plan never persisted to state/artifact/log ───────────────

test("continuation plan and telemetry are never persisted to job state files", async (t) => {
  const server = startServer(t);
  // Run a plan + delegate cycle to generate evidence and a consumed plan.
  await server.send(1, "cc_delegate", { task: "success" });
  const parentJob = listJobs(server.workspace).find((job) => job.status === "completed");
  assert.ok(parentJob);
  const plan = await server.send(2, "cc_plan_continuation", {
    parentJob: parentJob.id,
    relationship: "same_attempt",
    contextValue: "essential",
    userIntent: "same_session",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  const planId = (plan.result.content[0].text.match(/plan_[0-9a-f-]+/) || [])[0];
  assert.ok(planId);

  // Read all job state files and assert no planner data leaked.
  const jobsDir = resolveJobsDir(server.workspace);
  if (fs.existsSync(jobsDir)) {
    const files = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json"));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(jobsDir, file), "utf8");
      // planId, plan_, autoCompactTarget, and usage token fields must NOT appear in state.
      assert.doesNotMatch(raw, /plan_[0-9a-f-]+/, `job state file ${file} must not contain planId`);
      assert.doesNotMatch(raw, /autoCompactTarget/, `job state file ${file} must not contain autoCompactTarget`);
      assert.doesNotMatch(raw, /cacheCreation.*cacheRead/, `job state file ${file} must not contain usage token fields`);
    }
  }

  // Also check the state directory for any stray plan/evidence files.
  const stateDir = resolveStateDir(server.workspace);
  if (fs.existsSync(stateDir)) {
    const allFiles = fs.readdirSync(stateDir);
    for (const f of allFiles) {
      assert.doesNotMatch(f, /^plan_/, `state dir must not contain plan files: ${f}`);
      assert.doesNotMatch(f, /evidence/, `state dir must not contain evidence files: ${f}`);
    }
  }
});

// ─── Fix: cwd in git subdirectory — plan→delegate must not fail ──────────────

test("cc_plan_continuation from a git subdirectory binds to workspace root for delegate", async (t) => {
  // Create a workspace with a .git directory and a subdirectory.
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-git-"));
  fs.mkdirSync(path.join(workspace, ".git"), { recursive: true });
  const subdir = path.join(workspace, "src");
  fs.mkdirSync(subdir, { recursive: true });
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  installFakeClaude(binDir);

  const child = spawn(process.execPath, [serverPath], {
    cwd: workspace,
    env: {
      ...process.env,
      CC_COMPANION_DASHBOARD_OPEN: "off",
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
      }, 15000);
      waiters.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  }

  function send(id, name, args = {}) {
    return request(id, "tools/call", { name, arguments: args });
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

  // Plan from the subdirectory — plan binds to git root (workspace), not subdir.
  const plan = await send(1, "cc_plan_continuation", {
    cwd: subdir,
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "fresh",
    correctionCount: 0,
    allowCompact: false,
    model: null,
    write: true,
  });
  assert.equal(plan.result.isError, undefined);
  const planId = (plan.result.content[0].text.match(/plan_[0-9a-f-]+/) || [])[0];
  assert.ok(planId);

  // Delegate from the same subdirectory — consumption must succeed (cwd matches workspace root).
  const delegated = await send(2, "cc_delegate", {
    cwd: subdir,
    task: "success",
    continuationPlan: planId,
  });
  assert.match(delegated.result.content[0].text, /任务完成/);
});

// ─── Fix: drift parameter type validation ────────────────────────────────────

test("cc_plan_continuation rejects non-object drift (string)", async (t) => {
  const server = startServer(t);
  const res = await server.send(1, "cc_plan_continuation", {
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "auto",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
    drift: "workspace",
  });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /drift.*object/i);
});

test("cc_plan_continuation accepts object drift with boolean fields", async (t) => {
  const server = startServer(t);
  // First delegation creates evidence so drift can be detected.
  const first = await server.send(1, "cc_delegate", { task: "success" });
  assert.match(first.result.content[0].text, /任务完成/);
  const jobs = listJobs(server.workspace);
  const firstJob = jobs.find((j) => j.status === "completed");
  assert.ok(firstJob, "first delegation must complete to create evidence");

  const res = await server.send(2, "cc_plan_continuation", {
    parentJob: firstJob.id,
    relationship: "same_attempt",
    contextValue: "essential",
    userIntent: "auto",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
    drift: { workspace: true, cli: false, tool: false },
  });
  assert.equal(res.result.isError, undefined);
  assert.match(res.result.content[0].text, /fresh_handoff/);
  assert.match(res.result.content[0].text, /drift-detected/);
});
