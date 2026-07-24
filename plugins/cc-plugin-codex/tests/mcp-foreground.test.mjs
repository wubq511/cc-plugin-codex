import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { resolveStateDir, resolveJobsDir, listJobs, upsertJob, readResultArtifact } from "../scripts/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverPath = path.join(pluginRoot, "scripts", "cc-companion.mjs");
const fakeClaudeSource = path.join(here, "helpers", "fake-claude.mjs");

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

/**
 * Windows-safe recursive directory removal.
 * On Windows, deleting a directory while a child process still holds it as
 * CWD (or descendant handles are briefly lingering) fails with EBUSY/ENOTEMPTY.
 * Retry with backoff on Windows; on POSIX a single attempt is enough.
 */
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

function startServer(t, { env: extraEnv } = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-companion-test-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir);
  const fakeClaude = path.join(binDir, "claude");
  fs.copyFileSync(fakeClaudeSource, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);

  // Isolate CC_PROFILE_SWITCH_HOME and CLAUDE_CONFIG_DIR from the real user
  // environment so tests never read the real ~/.cc-profile-switch or ~/.claude.
  // Tests that need a specific authority can override these via extraEnv.
  const isolatedCcpsHome = path.join(workspace, "ccps-home");
  const isolatedClaudeConfigDir = path.join(workspace, "claude-config");
  fs.mkdirSync(isolatedCcpsHome, { recursive: true });
  fs.mkdirSync(isolatedClaudeConfigDir, { recursive: true });

  const child = spawn(process.execPath, [serverPath], {
    cwd: workspace,
    env: {
      ...process.env,
      CC_PROFILE_SWITCH_HOME: isolatedCcpsHome,
      CLAUDE_CONFIG_DIR: isolatedClaudeConfigDir,
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
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params
    })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for response ${id}. stderr: ${stderr}`));
      }, 10000);
      waiters.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        }
      });
    });
  }

  function send(id, name, args = {}) {
    const stateful = name !== "cc_list_models" && name !== "cc_resolve_route";
    return request(id, "tools/call", {
      name,
      arguments: stateful ? { cwd: workspace, ...args } : args
    });
  }

  t.after(async () => {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
    const maxRetries = process.platform === "win32" ? 5 : 1;
    for (let i = 0; i < maxRetries; i++) {
      try {
        fs.rmSync(workspace, { recursive: true, force: true });
        break;
      } catch (err) {
        if ((err.code === "EBUSY" || err.code === "ENOTEMPTY") && i < maxRetries - 1) {
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
    }
  });

  return { child, messages, request, send, workspace };
}

test("foreground delegate stays pending and returns exactly once without cc_check", async (t) => {
  const server = startServer(t);
  const delegate = server.send(1, "cc_delegate", { task: "delay:180" });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(server.messages.some((message) => message.id === 1), false);

  const ping = server.send(2, "cc_list_models");
  assert.equal((await ping).id, 2, "readline must remain responsive while delegate is pending");

  const completed = await delegate;
  assert.match(completed.result.content[0].text, /Task Completed/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(server.messages.filter((message) => message.id === 1).length, 1);
});

test("cc_cancel terminates a pending foreground delegate and preserves cancelled state", async (t) => {
  const server = startServer(t);
  const delegate = server.send(10, "cc_delegate", { task: "hang" });
  await new Promise((resolve) => setTimeout(resolve, 100));

  const cancelled = await server.send(11, "cc_cancel");
  assert.match(cancelled.result.content[0].text, /cancelled/);

  const delegateResult = await delegate;
  assert.match(delegateResult.result.content[0].text, /Task Cancelled/);

  const status = await server.send(12, "cc_check");
  assert.match(status.result.content[0].text, /\*\*Status:\*\* cancelled/);
  assert.doesNotMatch(status.result.content[0].text, /\*\*Status:\*\* failed/);
  assert.equal(server.messages.filter((message) => message.id === 10).length, 1);
});

test("MCP cancellation notification terminates its pending delegate without a late response", async (t) => {
  const server = startServer(t);
  server.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 15,
    method: "tools/call",
    params: {
      name: "cc_delegate",
      arguments: { cwd: server.workspace, task: "hang" }
    }
  })}\n`);

  const runningJob = await waitFor(() => {
    const jobs = listJobs(server.workspace);
    return jobs.find((job) => job.status === "running" && job.pid) || null;
  });

  server.child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/cancelled",
    params: { requestId: 15, reason: "user stopped the Codex task" }
  })}\n`);

  const cancelledJob = await waitFor(() => {
    const jobs = listJobs(server.workspace);
    return jobs.find((job) => job.id === runningJob.id && job.status === "cancelled") || null;
  });
  assert.equal(cancelledJob.phase, "cancelled");
  assert.match(cancelledJob.errorMessage, /MCP client request/);
  await waitFor(() => {
    try {
      process.kill(runningJob.pid, 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(server.messages.some((message) => message.id === 15), false);
});

test("stateful tool schemas require the user's workspace cwd", async (t) => {
  const server = startServer(t);
  const listed = await server.request(20, "tools/list");
  for (const name of ["cc_delegate", "cc_check", "cc_cancel", "cc_review", "cc_setup"]) {
    const tool = listed.result.tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `${name} must be listed`);
    assert.ok(tool.inputSchema.required.includes("cwd"), `${name} must require cwd`);
    assert.equal(tool.inputSchema.properties.cwd.type, "string");
    assert.doesNotMatch(tool.description, /Without arguments/i);
  }
});

test("public cwd runs Claude in the user workspace rather than the MCP server cache", async (t) => {
  const server = startServer(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "cc-companion-target-"));
  t.after(async () => { await safeRmDir(target); });

  const completed = await server.send(30, "cc_delegate", { cwd: target, task: "cwd" });
  assert.match(completed.result.content[0].text, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.notEqual(target, server.workspace);
});

test("stateful tools reject relative cwd instead of resolving it inside the plugin cache", async (t) => {
  const server = startServer(t);
  const response = await server.send(40, "cc_setup", { cwd: "." });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /Workspace cwd must be absolute/);
});

test("adversarial working-tree review works without a recorded Claude Code job", async (t) => {
  const server = startServer(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "cc-companion-review-"));
  t.after(async () => { await safeRmDir(target); });
  const initialized = spawnSync("git", ["init", "--quiet"], { cwd: target, encoding: "utf8" });
  assert.equal(initialized.status, 0, initialized.stderr);
  fs.writeFileSync(path.join(target, "example.txt"), "review me\n", "utf8");

  const review = await server.send(50, "cc_review", {
    cwd: target,
    scope: "working-tree",
    adversarial: true
  });
  assert.match(review.result.content[0].text, /## Review: Job working-tree/);
  assert.match(review.result.content[0].text, /Review Mode:\*\* Adversarial/);
  assert.match(review.result.content[0].text, /example\.txt/);
});

test("stdin close cancels foreground and detached jobs from every workspace before exit", async (t) => {
  const server = startServer(t);
  const targets = [
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-companion-shutdown-a-")),
    fs.mkdtempSync(path.join(os.tmpdir(), "cc-companion-shutdown-b-"))
  ];
  t.after(async () => {
    for (const target of targets) {
      await safeRmDir(resolveStateDir(target));
      await safeRmDir(target);
    }
  });

  for (const [index, target] of targets.entries()) {
    server.child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 60 + index,
      method: "tools/call",
      params: {
        name: "cc_delegate",
        arguments: { cwd: target, task: "hang" }
      }
    })}\n`);
  }

  const runningJobs = await Promise.all(targets.map((target) => waitFor(() => {
    const jobs = listJobs(target);
    return jobs.find((job) => job.status === "running" && job.pid) || null;
  })));

  const serverExit = new Promise((resolve) => server.child.once("exit", resolve));
  server.child.stdin.end();
  await serverExit;

  for (const [index, target] of targets.entries()) {
    const jobs = listJobs(target);
    const job = jobs.find((candidate) => candidate.id === runningJobs[index].id);
    assert.equal(job.status, "cancelled");
    assert.equal(job.phase, "cancelled");
    assert.equal(job.pid, null);
    assert.match(job.errorMessage, /stdin closed/);
    assert.throws(() => process.kill(runningJobs[index].pid, 0), /ESRCH|not permitted/);
  }
});

test("shutdown never cancels a running job owned by another MCP server session", async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "cc-companion-foreign-job-"));
  t.after(async () => {
    await safeRmDir(resolveStateDir(target));
    await safeRmDir(target);
  });
  upsertJob(target, {
    id: "cc-foreign-session",
    status: "running",
    phase: "executing",
    ownerServerId: "session-from-another-server",
    sessionId: "session-from-another-server",
    pid: null,
    task: "must remain untouched"
  });

  const server = startServer(t);
  await server.send(70, "cc_setup", { cwd: target });

  // The foreign job should be orphaned (server reconcileOrphans marks non-owned running jobs)
  const jobs = listJobs(target);
  const job = jobs.find((candidate) => candidate.id === "cc-foreign-session");
  // After orphan reconciliation, the job is marked orphaned (not cancelled by this server)
  assert.equal(job.status, "orphaned");
  assert.equal(job.phase, "orphaned");
  assert.notEqual(job.ownerServerId, server.sessionId);
});

// ─── Provider-agnostic model tests ─────────────────────────────────────────

test("delegate accepts an arbitrary custom model identifier and passes it through", async (t) => {
  const server = startServer(t);
  const completed = await server.send(80, "cc_delegate", {
    task: "success",
    model: "mimo-v2.5-pro"
  });
  assert.match(completed.result.content[0].text, /Task Completed/);
  // The job should record the requested model
  const jobs = listJobs(server.workspace);
  const job = jobs.find((j) => j.requestedModel === "mimo-v2.5-pro");
  assert.ok(job, "job must record the requested model");
  assert.equal(job.requestedModel, "mimo-v2.5-pro");
});

test("delegate without model omits --model and records inherited requestMode", async (t) => {
  const server = startServer(t);
  const completed = await server.send(81, "cc_delegate", { task: "success" });
  assert.match(completed.result.content[0].text, /Task Completed/);
  const jobs = listJobs(server.workspace);
  const job = jobs.find((j) => j.id);
  assert.ok(job);
  assert.equal(job.requestedModel, null);
  assert.equal(job.requestMode, "inherited");
  assert.ok(job.modelEvidence, "job must have modelEvidence");
  assert.ok(job.modelEvidence.usageModelKeys.includes("mimo-v2.5"), "usageModelKeys must include mimo-v2.5");
});

test("delegate rejects whitespace-only model override", async (t) => {
  const server = startServer(t);
  const response = await server.send(82, "cc_delegate", {
    task: "success",
    model: "   "
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /non-empty string/);
});

test("delegate rejects empty string model override", async (t) => {
  const server = startServer(t);
  const response = await server.send(83, "cc_delegate", {
    task: "success",
    model: ""
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /non-empty string/);
});

test("cc_list_models contains no hard-coded official catalogue", async (t) => {
  const server = startServer(t);
  const response = await server.send(84, "cc_list_models");
  const text = response.result.content[0].text;
  // Must not contain the old catalogue table
  assert.doesNotMatch(text, /Alias.*Full Model ID.*Best For/);
  assert.doesNotMatch(text, /fable.*claude-fable-5/);
  assert.doesNotMatch(text, /Selection Guide/);
  // Must describe inherited configuration
  assert.match(text, /inherited|Provider/i);
  // Must mention optional override
  assert.match(text, /override|free-form/i);
});

test("cc_list_models does not recommend specific models for task types", async (t) => {
  const server = startServer(t);
  const response = await server.send(85, "cc_list_models");
  const text = response.result.content[0].text;
  assert.doesNotMatch(text, /Simple bug fix.*haiku/);
  assert.doesNotMatch(text, /Feature implementation.*sonnet/);
  assert.doesNotMatch(text, /Complex refactor.*opus/);
});

// ─── timeoutSeconds validation tests ───────────────────────────────────────

test("delegate rejects zero timeoutSeconds", async (t) => {
  const server = startServer(t);
  const response = await server.send(90, "cc_delegate", {
    task: "success",
    timeoutSeconds: 0
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /timeoutSeconds must be a positive integer/);
});

test("delegate rejects negative timeoutSeconds", async (t) => {
  const server = startServer(t);
  const response = await server.send(91, "cc_delegate", {
    task: "success",
    timeoutSeconds: -5
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /timeoutSeconds must be a positive integer/);
});

test("delegate rejects fractional timeoutSeconds", async (t) => {
  const server = startServer(t);
  const response = await server.send(92, "cc_delegate", {
    task: "success",
    timeoutSeconds: 1.5
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /timeoutSeconds must be an integer/);
});

test("delegate accepts a valid positive integer timeoutSeconds", async (t) => {
  const server = startServer(t);
  const completed = await server.send(93, "cc_delegate", {
    task: "success",
    timeoutSeconds: 60
  });
  assert.match(completed.result.content[0].text, /Task Completed/);
});

// ─── No default timeout — delayed task completes ───────────────────────────

test("foreground delegate with no timeoutSeconds completes a delayed task", async (t) => {
  const server = startServer(t);
  const completed = await server.send(94, "cc_delegate", { task: "delay:200" });
  assert.match(completed.result.content[0].text, /Task Completed/);
  assert.match(completed.result.content[0].text, /delayed result/);
});

test("foreground delegate with explicit short timeoutSeconds terminates a hanging task", async (t) => {
  const server = startServer(t);
  const completed = await server.send(95, "cc_delegate", {
    task: "hang",
    timeoutSeconds: 1
  });
  assert.match(completed.result.content[0].text, /Task Failed/);
  assert.match(completed.result.content[0].text, /timed out/);
});

// ─── requestedModel vs modelEvidence ───────────────────────────────────────

test("job state distinguishes requestedModel from modelEvidence", async (t) => {
  const server = startServer(t);
  await server.send(96, "cc_delegate", {
    task: "success",
    model: "custom-model-v1"
  });
  const jobs = listJobs(server.workspace);
  const job = jobs.find((j) => j.requestedModel === "custom-model-v1");
  assert.ok(job, "job must have requestedModel");
  assert.equal(job.requestedModel, "custom-model-v1");
  assert.equal(job.requestMode, "explicit");
  // v5: selectorKind is stored for route routing
  assert.equal(job.selectorKind, "native");
  assert.ok(job.routeSnapshot, "job must have routeSnapshot in v5");
  // modelEvidence.usageModelKeys comes from the fake claude's modelUsage
  assert.ok(job.modelEvidence, "job must have modelEvidence");
  assert.ok(job.modelEvidence.usageModelKeys.includes("mimo-v2.5"), "usageModelKeys must include mimo-v2.5 from fake claude");
  // No observedModel field in v4+
  assert.equal(job.observedModel, undefined);
});

test("cc_check shows requested model and usage key with new terminology", async (t) => {
  const server = startServer(t);
  await server.send(97, "cc_delegate", {
    task: "success",
    model: "custom-model-v1"
  });
  const status = await server.send(98, "cc_check");
  const text = status.result.content[0].text;
  assert.match(text, /Requested model.*custom-model-v1/);
  assert.match(text, /Provider usage key.*mimo-v2\.5/);
  // Must NOT use old "Observed Model" terminology
  assert.doesNotMatch(text, /Observed Model/);
});

// ─── Model pass-through observation ────────────────────────────────────────

test("delegate passes model identifier to claude CLI exactly unchanged", async (t) => {
  const server = startServer(t);
  const completed = await server.send(100, "cc_delegate", {
    task: "args",
    model: "mimo-v2.5-pro"
  });
  assert.match(completed.result.content[0].text, /Task Completed/);
  // The "args" mode echoes back the CLI args as a space-joined string.
  // Verify --model was passed with the exact value, no trimming or rewriting.
  const text = completed.result.content[0].text;
  assert.match(text, /--model mimo-v2\.5-pro/);
  // Also verify the model wasn't trimmed (if it had been, the surrounding
  // args context would show it differently). Check exact arg boundary:
  // P0 fix: print-mode JSON protocol is now `--print --input-format text --output-format json`.
  assert.match(text, /--print --input-format text --output-format json --model mimo-v2\.5-pro/);
});

// ─── timeoutSeconds upper bound ────────────────────────────────────────────

test("delegate rejects timeoutSeconds exceeding 604800", async (t) => {
  const server = startServer(t);
  const response = await server.send(101, "cc_delegate", {
    task: "success",
    timeoutSeconds: 604801
  });
  assert.equal(response.result.isError, true);
  assert.match(response.result.content[0].text, /must not exceed 604800/);
});

test("delegate accepts timeoutSeconds at the 604800 boundary", async (t) => {
  const server = startServer(t);
  const completed = await server.send(102, "cc_delegate", {
    task: "success",
    timeoutSeconds: 604800
  });
  assert.match(completed.result.content[0].text, /Task Completed/);
});

// ─── cc_list_models optional cwd ───────────────────────────────────────────

test("cc_list_models without cwd reports from session workspaces (generic no-cwd behavior)", async (t) => {
  const server = startServer(t);
  // First run a delegate to populate the workspace.
  // Use a native ID (must contain a digit to pass the native-ID heuristic).
  await server.send(103, "cc_delegate", { task: "success", model: "test-model-v1" });
  // Now call cc_list_models without cwd — should find the job from the session workspace
  const response = await server.send(104, "cc_list_models");
  const text = response.result.content[0].text;
  assert.match(text, /Latest Completed Job/);
  assert.match(text, /test-model-v1/);
});

test("cc_list_models with cwd loads history from that workspace directly", async (t) => {
  const server = startServer(t);
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "cc-companion-list-models-"));
  t.after(async () => {
    await safeRmDir(resolveStateDir(target));
    await safeRmDir(target);
  });

  // Create a completed job in the target workspace's state
  upsertJob(target, {
    id: "cc-list-models-test",
    status: "completed",
    phase: "completed",
    task: "test task",
    taskPreview: "test task",
    requestedModel: "workspace-model-xyz",
    requestMode: "explicit",
    modelEvidence: {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: ["workspace-model-xyz"],
      usageSource: "claude-result-modelUsage",
      warnings: []
    },
    ownerServerId: "foreign-session",
    sessionId: "foreign-session",
    pid: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString()
  });

  // Call cc_list_models with explicit cwd
  const response = await server.send(105, "cc_list_models", { cwd: target });
  const text = response.result.content[0].text;
  assert.match(text, /Latest Completed Job/);
  assert.match(text, /cc-list-models-test/);
  assert.match(text, /workspace-model-xyz/);
});

test("cc_list_models rejects a relative optional cwd", async (t) => {
  const server = startServer(t);
  const result = await server.request(125, "tools/call", {
    name: "cc_list_models",
    arguments: { cwd: "relative/workspace" },
  });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /cwd must be absolute/);
});

// ─── MCP Chain Regression: terminology across all display surfaces ──────────

test("REGRESSION: cc_delegate output uses new model evidence terminology", async (t) => {
  const server = startServer(t);
  const result = await server.send(110, "cc_delegate", {
    task: "success",
    model: "mimo-v2.5-pro"
  });
  const text = result.result.content[0].text;
  // Must use new terminology
  assert.match(text, /Requested model.*mimo-v2\.5-pro/);
  assert.match(text, /Provider usage key.*mimo-v2\.5/);
  // Must NOT use old terminology
  assert.doesNotMatch(text, /Observed Model/);
  assert.doesNotMatch(text, /\*\*Model:\*\* mimo-v2\.5$/m);
});

test("REGRESSION: cc_check single job uses new model evidence terminology", async (t) => {
  const server = startServer(t);
  await server.send(111, "cc_delegate", {
    task: "success"
  });
  const status = await server.send(112, "cc_check");
  const text = status.result.content[0].text;
  // Must use new terminology
  assert.match(text, /Model request.*inherited/);
  assert.match(text, /Provider usage key.*mimo-v2\.5/);
  // Must NOT use old terminology
  assert.doesNotMatch(text, /Observed Model/);
  assert.doesNotMatch(text, /\*\*Model:\*\*/);
});

test("REGRESSION: cc_check all=true table uses Model Evidence header", async (t) => {
  const server = startServer(t);
  await server.send(113, "cc_delegate", {
    task: "success"
  });
  const status = await server.send(114, "cc_check", { all: true });
  const text = status.result.content[0].text;
  // Table header must say "Model Evidence", not "Model"
  assert.match(text, /\| Model Evidence \|/);
  assert.doesNotMatch(text, /\| Model \|/);
});

test("REGRESSION: cc_review uses Model Evidence label", async (t) => {
  const server = startServer(t);
  // Initialize git repo so cc_review can collect context
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: server.workspace, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: server.workspace, stdio: "pipe" });
  execSync("git config user.name test", { cwd: server.workspace, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: server.workspace, stdio: "pipe" });
  await server.send(115, "cc_delegate", {
    task: "success"
  });
  const review = await server.send(116, "cc_review");
  const text = review.result.content[0].text;
  // Must use "Model Evidence" label, not "Model"
  assert.match(text, /\*\*Model Evidence:\*\*/);
  assert.doesNotMatch(text, /\*\*Model:\*\*/);
});

// ─── MCP Transcript-Piercing Regression ──────────────────────────────────────

test("REGRESSION: full transcript→executedModels chain across all display surfaces", async (t) => {
  // Create a fake CLAUDE_CONFIG_DIR with a real transcript
  const claudeConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-transcript-regression-"));
  const projectsDir = path.join(claudeConfigDir, "projects");
  const projectDir = path.join(projectsDir, "test-project");
  fs.mkdirSync(projectDir, { recursive: true });

  // Write transcript with mimo-v2.5-pro as execution model
  const sessionId = "fake-session";
  const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
  const transcriptLines = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", model: "mimo-v2.5-pro", id: "msg-1" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", model: "mimo-v2.5-pro", id: "msg-2" } }),
  ];
  fs.writeFileSync(transcriptFile, transcriptLines.join("\n") + "\n");

  // Start server with CLAUDE_CONFIG_DIR pointing to our fake config
  const server = startServer(t, { env: { CLAUDE_CONFIG_DIR: claudeConfigDir } });

  // Initialize git repo for cc_review
  const { execSync } = await import("node:child_process");
  execSync("git init", { cwd: server.workspace, stdio: "pipe" });
  execSync("git config user.email test@test.com", { cwd: server.workspace, stdio: "pipe" });
  execSync("git config user.name test", { cwd: server.workspace, stdio: "pipe" });
  execSync("git commit --allow-empty -m init", { cwd: server.workspace, stdio: "pipe" });

  try {
    // 1. cc_delegate — fake-claude returns modelUsage: {"mimo-v2.5": {}} with session_id: "fake-session"
    const delegateResult = await server.send(120, "cc_delegate", { task: "success" });
    const delegateText = delegateResult.result.content[0].text;
    // Must show execution model from transcript (mimo-v2.5-pro)
    assert.match(delegateText, /mimo-v2\.5-pro/);
    // Must show usage key from modelUsage (mimo-v2.5)
    assert.match(delegateText, /Provider usage key.*mimo-v2\.5/);

    // 2. Job v4 state
    const jobs = listJobs(server.workspace);
    const job = jobs.find((j) => j.status === "completed");
    assert.ok(job, "completed job must exist");
    assert.ok(job.modelEvidence, "job must have modelEvidence");
    // executedModels from transcript
    assert.ok(job.modelEvidence.executedModels.find((m) => m.id === "mimo-v2.5-pro"),
      "executedModels must include mimo-v2.5-pro from transcript");
    // usageModelKeys from final JSON
    assert.ok(job.modelEvidence.usageModelKeys.includes("mimo-v2.5"),
      "usageModelKeys must include mimo-v2.5 from modelUsage");
    // They are DIFFERENT — the core regression
    assert.notEqual(job.modelEvidence.executedModels[0].id, job.modelEvidence.usageModelKeys[0]);

    // 3. Result artifact — exact assertions
    const artifact = readResultArtifact(server.workspace, job.id);
    assert.ok(artifact, "result artifact must exist");
    assert.equal(artifact.requestedModel, null);
    assert.equal(artifact.requestMode, "inherited");
    assert.ok(artifact.modelEvidence, "artifact must have modelEvidence");
    assert.ok(artifact.modelEvidence.executedModels.length > 0, "artifact modelEvidence must have executedModels");
    assert.equal(artifact.modelEvidence.executedModels[0].id, "mimo-v2.5-pro",
      "artifact executedModels[0].id must be mimo-v2.5-pro (from transcript)");
    assert.ok(artifact.modelEvidence.usageModelKeys.includes("mimo-v2.5"),
      "artifact usageModelKeys must include mimo-v2.5 (from modelUsage)");
    assert.notEqual(artifact.modelEvidence.executedModels[0].id, artifact.modelEvidence.usageModelKeys[0],
      "executedModels and usageModelKeys must differ (core regression)");

    // 4. cc_check single job
    const checkResult = await server.send(121, "cc_check");
    const checkText = checkResult.result.content[0].text;
    assert.match(checkText, /Claude-recorded execution model.*mimo-v2\.5-pro/);
    assert.match(checkText, /Provider usage key.*mimo-v2\.5/);

    // 5. cc_check all=true
    const allResult = await server.send(122, "cc_check", { all: true });
    const allText = allResult.result.content[0].text;
    assert.match(allText, /\| Model Evidence \|/);
    assert.match(allText, /mimo-v2\.5-pro/);

    // 6. cc_list_models
    const modelsResult = await server.send(123, "cc_list_models", { cwd: server.workspace });
    const modelsText = modelsResult.result.content[0].text;
    assert.match(modelsText, /mimo-v2\.5-pro/);

    // 7. cc_review
    const reviewResult = await server.send(124, "cc_review");
    const reviewText = reviewResult.result.content[0].text;
    assert.match(reviewText, /\*\*Model Evidence:\*\*[\s\S]*mimo-v2\.5-pro/);
    assert.match(reviewText, /Provider usage key.*mimo-v2\.5/);
  } finally {
    // Cleanup
    fs.rmSync(claudeConfigDir, { recursive: true, force: true });
  }
});
