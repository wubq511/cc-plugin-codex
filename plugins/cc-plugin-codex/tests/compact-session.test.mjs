import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  captureCompactBoundaryCursor,
  collectCompactBoundary,
} from "../scripts/lib/compact-boundary.mjs";
import { listJobs, upsertJob } from "../scripts/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverPath = path.join(pluginRoot, "scripts", "cc-companion.mjs");
const fakeClaudeSource = path.join(here, "helpers", "fake-claude.mjs");

// ─── Test helpers ────────────────────────────────────────────────────────────

function installFakeClaude(binDir) {
  const fakeClaude = path.join(binDir, "claude");
  fs.copyFileSync(fakeClaudeSource, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  return fakeClaude;
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Condition was not met within ${timeoutMs}ms`);
}

function startServer(t, opts = {}) {
  const workspace = opts.workspace || fs.mkdtempSync(path.join(os.tmpdir(), "cc-compact-test-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  installFakeClaude(binDir);

  const child = spawn(process.execPath, [serverPath], {
    cwd: workspace,
    env: {
      ...process.env,
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

// Helper: extract CLI args from echo-args result
function extractArgs(resultText) {
  const argsMatch = resultText.match(/### Result\n([\s\S]*?)(\n\n|\n---)/);
  return argsMatch ? argsMatch[1].trim() : "";
}

// ─── UUID pre-allocation tests ───────────────────────────────────────────────

test("cc_delegate pre-allocates claudeSessionUuid for new sessions", async (t) => {
  const server = startServer(t);
  const result = await server.send(1, "cc_delegate", { task: "echo-args" });
  const text = result.result.content[0].text;
  assert.match(text, /Task Completed/);

  // The job record must have a claudeSessionUuid before spawn.
  // We verify by checking the args contain --session-id <uuid>.
  const args = extractArgs(text);
  assert.match(args, /--session-id [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    "New delegation must pass --session-id with a pre-allocated UUID");
});

test("cc_delegate does not pass --session-id on resume", async (t) => {
  const server = startServer(t);

  // First delegation: create a session
  const first = await server.send(1, "cc_delegate", { task: "success" });
  assert.match(first.result.content[0].text, /Task Completed/);

  // Get the claudeSessionId from the first job
  const jobs = listJobs(server.workspace);
  const firstJob = jobs.find((j) => j.status === "completed");
  assert.ok(firstJob?.claudeSessionId, "First job must have a claudeSessionId");

  // Second delegation: resume using resumeSession
  const second = await server.send(2, "cc_delegate", {
    task: "echo-args",
    resumeSession: firstJob.claudeSessionId,
  });
  const secondText = second.result.content[0].text;
  assert.match(secondText, /Task Completed/);

  // Resume must use --resume, NOT --session-id
  const args = extractArgs(secondText);
  assert.match(args, new RegExp(`--resume ${firstJob.claudeSessionId}`),
    "Resume must pass --resume <sessionId>");
  assert.doesNotMatch(args, /--session-id/,
    "Resume must NOT pass --session-id (mutually exclusive with --resume)");
});

test("cc_delegate persists claudeSessionUuid in job state before spawn", async (t) => {
  const server = startServer(t);
  const result = await server.send(1, "cc_delegate", { task: "success" });
  assert.match(result.result.content[0].text, /Task Completed/);

  const jobs = listJobs(server.workspace);
  const job = jobs.find((j) => j.status === "completed");
  assert.ok(job, "Job must exist");
  // claudeSessionUuid is set for new sessions; resume sessions have null.
  assert.ok(job.claudeSessionUuid, "Job must have claudeSessionUuid for new sessions");
  assert.match(job.claudeSessionUuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    "claudeSessionUuid must be a valid UUID");
});

test("resume delegation has null claudeSessionUuid", async (t) => {
  const server = startServer(t);

  // First delegation
  await server.send(1, "cc_delegate", { task: "success" });

  const firstJob = listJobs(server.workspace).find((j) => j.status === "completed");

  // Resume delegation
  await server.send(2, "cc_delegate", {
    task: "success",
    resumeSession: firstJob.claudeSessionId,
  });

  const jobs = listJobs(server.workspace);
  // The resume delegation is the second job — find it by resumeSession.
  const resumeJob = jobs.find((j) => j.resumeSession === firstJob.claudeSessionId);
  assert.ok(resumeJob, "Resume job must exist");
  assert.equal(resumeJob.claudeSessionUuid, null,
    "Resume delegation must have null claudeSessionUuid (uses --resume instead)");
});

// ─── cc_compact rejection tests ──────────────────────────────────────────────

test("cc_compact rejects running job", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_MODE: "hang" } });

  // Start a hanging delegation
  const delegatePromise = server.send(1, "cc_delegate", { task: "hang" });
  const runningJob = await waitFor(() => {
    return listJobs(server.workspace).find((j) => j.status === "running");
  }, 5000);

  // cc_compact must reject the running job (by job ID)
  const compactResult = await server.send(2, "cc_compact", { job: runningJob.id });
  assert.match(compactResult.result.content[0].text, /still running/i);
  assert.equal(compactResult.result.isError, true);

  // Cleanup: cancel the hanging job
  await server.send(3, "cc_cancel");
  await delegatePromise;
});

test("cc_compact rejects explicit resumeSession that matches a running job", async (t) => {
  const server = startServer(t);
  const delegatePromise = server.send(1, "cc_delegate", { task: "hang" });
  const runningJob = await waitFor(() =>
    listJobs(server.workspace).find((j) => j.status === "running")
  );
  const sessionId = runningJob.claudeSessionId || runningJob.claudeSessionUuid;
  assert.ok(sessionId);

  const compactResult = await server.send(2, "cc_compact", {
    resumeSession: sessionId,
  });
  assert.equal(compactResult.result.isError, true);
  assert.match(compactResult.result.content[0].text, /still running|active/i);

  await server.send(3, "cc_cancel");
  await delegatePromise;
});

test("cc_compact rejects cancelling job", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_MODE: "hang-slow" } });

  // Start a hanging delegation
  const delegatePromise = server.send(1, "cc_delegate", { task: "hang-slow" });
  const runningJob = await waitFor(() => {
    return listJobs(server.workspace).find((j) => j.status === "running");
  }, 5000);

  // Cancel it — transitions to cancelling
  const cancelPromise = server.send(2, "cc_cancel");
  await waitFor(() => {
    return listJobs(server.workspace).find((j) => j.status === "cancelling");
  }, 5000);

  // cc_compact must reject the cancelling job (by job ID)
  const compactResult = await server.send(3, "cc_compact", { job: runningJob.id });
  assert.match(compactResult.result.content[0].text, /still cancelling/i);
  assert.equal(compactResult.result.isError, true);

  await cancelPromise;
  await delegatePromise.catch(() => {});
});

test("cc_compact returns error when no stopped session exists", async (t) => {
  const server = startServer(t);

  const result = await server.send(1, "cc_compact");
  assert.match(result.result.content[0].text, /No stopped Claude Code session/i);
  assert.equal(result.result.isError, true);
});

test("cc_compact rejects an invalid session identifier from persisted job state", async (t) => {
  const server = startServer(t);
  upsertJob(server.workspace, {
    id: "cc-tampered-session",
    status: "completed",
    phase: "completed",
    claudeSessionId: "--dangerously-skip-permissions",
    completedAt: new Date().toISOString(),
  });

  const result = await server.send(1, "cc_compact", { job: "cc-tampered-session" });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /invalid Claude session identifier/i);
});

test("resume=true rejects an invalid session identifier from persisted job state", async (t) => {
  const server = startServer(t);
  upsertJob(server.workspace, {
    id: "cc-tampered-resume",
    status: "completed",
    phase: "completed",
    claudeSessionId: "--model",
    completedAt: new Date().toISOString(),
  });

  const result = await server.send(1, "cc_delegate", {
    task: "must not spawn",
    resume: true,
  });
  assert.equal(result.result.isError, true);
  assert.match(result.result.content[0].text, /resolved resume session identifier is invalid/i);
});

// ─── cc_compact with stopped session (no transcript → compacted:false) ───────

test("cc_compact on stopped session without transcript returns compacted:false", async (t) => {
  const server = startServer(t);

  // Run a successful delegation
  const delegateResult = await server.send(1, "cc_delegate", { task: "success" });
  assert.match(delegateResult.result.content[0].text, /Task Completed/);

  // Compact the stopped session
  const compactResult = await server.send(2, "cc_compact");
  const compactText = compactResult.result.content[0].text;

  // No transcript in test env → compacted:false + reason
  assert.match(compactText, /Compacted:\*\*\s*false/i);
  assert.match(compactText, /Reason:/i);
  // observedBoundary must be null (not fabricated)
  assert.doesNotMatch(compactText, /Observed boundary:\*\*\s*\d/i,
    "observedBoundary must not be fabricated when no transcript exists");

  const persisted = listJobs(server.workspace).find((j) => j.status === "completed");
  assert.equal(persisted.compactResult.compacted, false);
  assert.equal(typeof persisted.compactResult.reason, "string");
  assert.ok(persisted.compactResult.reason.length > 0);
});

// ─── cc_compact with fake transcript containing boundary ─────────────────────

test("cc_compact does not count a historical boundary as this invocation's success", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compact-boundary-"));
  const configDir = path.join(workspace, "claude-config");
  const projectsDir = path.join(configDir, "projects");
  const projectDir = path.join(projectsDir, "test-project");
  fs.mkdirSync(projectDir, { recursive: true });

  const server = startServer(t, {
    workspace,
    env: { CLAUDE_CONFIG_DIR: configDir },
  });

  // Run a successful delegation to create a job with a claudeSessionId
  const delegateResult = await server.send(1, "cc_delegate", { task: "success" });
  assert.match(delegateResult.result.content[0].text, /Task Completed/);

  const jobs = listJobs(workspace);
  const job = jobs.find((j) => j.status === "completed");
  assert.ok(job?.claudeSessionId, "Job must have claudeSessionId");

  // Create a fake transcript with a real compact_boundary record structure:
  // type:"system" + subtype:"compact_boundary" + compactMetadata.preTokens
  const transcriptPath = path.join(projectDir, `${job.claudeSessionId}.jsonl`);
  const boundaryRecord = JSON.stringify({
    type: "system",
    subtype: "compact_boundary",
    compactMetadata: {
      preTokens: 45000,
      trigger: "manual",
    },
  });
  fs.writeFileSync(transcriptPath, `${boundaryRecord}\n`);

  // Compact the stopped session
  const compactResult = await server.send(2, "cc_compact");
  const compactText = compactResult.result.content[0].text;

  assert.match(compactText, /Compacted:\*\*\s*false/i);
  assert.doesNotMatch(compactText, /Observed boundary:\*\*\s*45000/i);
});

test("cc_compact returns compacted:true only for a boundary appended by this invocation", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compact-new-boundary-"));
  const configDir = path.join(workspace, "claude-config");
  fs.mkdirSync(path.join(configDir, "projects", "test-project"), { recursive: true });

  const server = startServer(t, {
    workspace,
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      FAKE_CLAUDE_APPEND_COMPACT_BOUNDARY: "1",
      FAKE_CLAUDE_COMPACT_PRE_TOKENS: "47000",
    },
  });

  await server.send(1, "cc_delegate", { task: "success" });
  const compactResult = await server.send(2, "cc_compact");
  const compactText = compactResult.result.content[0].text;

  assert.match(compactText, /Compacted:\*\*\s*true/i);
  assert.match(compactText, /Pre-compaction tokens:\*\*\s*47000/i);
  assert.match(compactText, /Trigger:\*\*\s*manual/i);
  assert.match(compactText, /Observed boundary:\*\*\s*47000/i);

  const persisted = listJobs(workspace).find((j) => j.status === "completed");
  assert.equal(persisted.compactResult.compacted, true);
  assert.equal(persisted.compactResult.reason, null);
});

test("cc_compact observedBoundary is null when transcript has no boundary", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compact-no-boundary-"));
  const configDir = path.join(workspace, "claude-config");
  const projectsDir = path.join(configDir, "projects");
  const projectDir = path.join(projectsDir, "test-project");
  fs.mkdirSync(projectDir, { recursive: true });

  const server = startServer(t, {
    workspace,
    env: { CLAUDE_CONFIG_DIR: configDir },
  });

  const delegateResult = await server.send(1, "cc_delegate", { task: "success" });
  assert.match(delegateResult.result.content[0].text, /Task Completed/);

  const job = listJobs(workspace).find((j) => j.status === "completed");

  // Create a transcript WITHOUT a compact_boundary
  const transcriptPath = path.join(projectDir, `${job.claudeSessionId}.jsonl`);
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { role: "user" } }) + "\n");

  const compactResult = await server.send(2, "cc_compact");
  const compactText = compactResult.result.content[0].text;

  assert.match(compactText, /Compacted:\*\*\s*false/i);
  assert.doesNotMatch(compactText, /Observed boundary:\*\*\s*\d/i,
    "observedBoundary must be null when no boundary in transcript");
});

// ─── collectCompactBoundary unit tests ───────────────────────────────────────

test("collectCompactBoundary returns compacted:false for invalid session ID", async () => {
  const result = await collectCompactBoundary({ sessionId: "../etc/passwd" });
  assert.equal(result.compacted, false);
  assert.equal(result.warning, "invalid-session-id");
});

test("collectCompactBoundary returns compacted:false when transcript not found", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-boundary-notfound-"));
  try {
    const result = await collectCompactBoundary({
      sessionId: "fake-session-id",
      claudeConfigDir: tmpDir,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.warning, "transcript-not-found");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectCompactBoundary finds boundary in transcript", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-boundary-find-"));
  try {
    const projectsDir = path.join(tmpDir, "projects", "test-project");
    fs.mkdirSync(projectsDir, { recursive: true });
    const sessionId = "test-session-123";
    const transcriptPath = path.join(projectsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: {
        preTokens: 50000,
        trigger: "auto",
      },
    }) + "\n");

    const result = await collectCompactBoundary({
      sessionId,
      claudeConfigDir: tmpDir,
    });
    assert.equal(result.compacted, true);
    assert.equal(result.preTokens, 50000);
    assert.equal(result.trigger, "auto");
    assert.equal(result.observedBoundary, 50000);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectCompactBoundary ignores isCompactSummary without canonical boundary", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-boundary-summary-only-"));
  try {
    const projectsDir = path.join(tmpDir, "projects", "test-project");
    fs.mkdirSync(projectsDir, { recursive: true });
    const sessionId = "test-session-summary-only";
    fs.writeFileSync(
      path.join(projectsDir, `${sessionId}.jsonl`),
      `${JSON.stringify({ type: "user", isCompactSummary: true })}\n`,
    );

    const result = await collectCompactBoundary({
      sessionId,
      claudeConfigDir: tmpDir,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.observedBoundary, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectCompactBoundary after cursor returns only newly appended boundary", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-boundary-cursor-"));
  try {
    const projectDir = path.join(tmpDir, "projects", "test-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "test-session-cursor";
    const transcriptPath = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 10000, trigger: "auto" },
    })}\n`);

    const cursor = await captureCompactBoundaryCursor({
      sessionId,
      claudeConfigDir: tmpDir,
    });
    const beforeAppend = await collectCompactBoundary({
      sessionId,
      claudeConfigDir: tmpDir,
      afterCursor: cursor,
    });
    assert.equal(beforeAppend.compacted, false);

    fs.appendFileSync(transcriptPath, `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: { preTokens: 20000, trigger: "manual" },
    })}\n`);
    const afterAppend = await collectCompactBoundary({
      sessionId,
      claudeConfigDir: tmpDir,
      afterCursor: cursor,
    });
    assert.equal(afterAppend.compacted, true);
    assert.equal(afterAppend.preTokens, 20000);
    assert.equal(afterAppend.trigger, "manual");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collectCompactBoundary fails closed when pre-invocation cursor scan was uncertain", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-boundary-uncertain-cursor-"));
  try {
    const projectDir = path.join(tmpDir, "projects", "test-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "test-session-uncertain-cursor";
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compactMetadata: { preTokens: 10000, trigger: "auto" },
      })}\n`,
    );

    const result = await collectCompactBoundary({
      sessionId,
      claudeConfigDir: tmpDir,
      afterCursor: {
        sessionId,
        exists: false,
        warning: "scan-deadline",
      },
    });
    assert.equal(result.compacted, false);
    assert.equal(result.observedBoundary, null);
    assert.equal(result.warning, "scan-deadline");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("cc_compact replays stored session autoCompact settings", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-compact-policy-"));
  const argsLog = path.join(workspace, "claude-args.jsonl");
  const server = startServer(t, {
    workspace,
    env: { FAKE_CLAUDE_ARGS_LOG: argsLog },
  });

  await server.send(1, "cc_delegate", {
    task: "success",
    autoCompact: {
      contextWindowTokens: 256000,
      targetTokens: 230000,
      scope: "session",
    },
  });
  await server.send(2, "cc_compact");

  const invocations = fs.readFileSync(argsLog, "utf8").trim().split("\n").map(JSON.parse);
  const compactArgs = invocations.at(-1);
  const settingsIndex = compactArgs.indexOf("--settings");
  assert.ok(settingsIndex >= 0, "cc_compact must replay session policy via --settings");
  assert.equal(
    JSON.parse(compactArgs[settingsIndex + 1]).env.CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    "255556",
  );
});

test("cc_compact replays stored task policy but not delegation policy", async (t) => {
  for (const [scope, expectedSettings] of [["task", true], ["delegation", false]]) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `cc-compact-${scope}-policy-`));
    const argsLog = path.join(workspace, "claude-args.jsonl");
    const server = startServer(t, {
      workspace,
      env: { FAKE_CLAUDE_ARGS_LOG: argsLog },
    });

    await server.send(scope === "task" ? 11 : 21, "cc_delegate", {
      task: "success",
      autoCompact: {
        contextWindowTokens: 1_000_000,
        targetTokens: 300000,
        scope,
      },
    });
    await server.send(scope === "task" ? 12 : 22, "cc_compact");

    const invocations = fs.readFileSync(argsLog, "utf8").trim().split("\n").map(JSON.parse);
    const compactArgs = invocations.at(-1);
    assert.equal(
      compactArgs.includes("--settings"),
      expectedSettings,
      `${scope} policy replay mismatch`,
    );
  }
});

test("collectCompactBoundary returns null for no boundary", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-boundary-none-"));
  try {
    const projectsDir = path.join(tmpDir, "projects", "test-project");
    fs.mkdirSync(projectsDir, { recursive: true });
    const sessionId = "test-session-456";
    const transcriptPath = path.join(projectsDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, JSON.stringify({ type: "user", message: { role: "user" } }) + "\n");

    const result = await collectCompactBoundary({
      sessionId,
      claudeConfigDir: tmpDir,
    });
    assert.equal(result.compacted, false);
    assert.equal(result.observedBoundary, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── tools/list includes cc_compact (8th tool) ───────────────────────────────

test("tools/list returns 8 tools including cc_compact", async (t) => {
  const server = startServer(t);
  const result = await server.request(1, "tools/list", {});
  const tools = result.result.tools;
  assert.equal(tools.length, 8, "Must expose 8 tools");
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("cc_compact"), "cc_compact must be in tools/list");
});

// ─── Cancel preserves claudeSessionId and autoCompact policy ─────────────────

test("cancel preserves claudeSessionId, claudeSessionUuid, and autoCompact policy", async (t) => {
  const server = startServer(t, { env: { FAKE_CLAUDE_MODE: "hang-slow" } });

  // Start a task-scope autoCompact delegation that hangs
  const delegatePromise = server.send(1, "cc_delegate", {
    task: "hang-slow",
    autoCompact: {
      contextWindowTokens: 1_000_000,
      targetTokens: 300000,
      scope: "task",
    },
  });

  // Wait for it to start
  await waitFor(() => {
    return listJobs(server.workspace).find((j) => j.status === "running");
  }, 5000);

  const runningJob = listJobs(server.workspace).find((j) => j.status === "running");
  assert.ok(runningJob?.claudeSessionUuid, "Running job must have claudeSessionUuid");
  assert.ok(runningJob?.autoCompact, "Running job must have autoCompact policy");

  // Cancel it
  await server.send(2, "cc_cancel");

  // After cancel, the cancelled job must preserve the IDs and policy
  const cancelledJob = listJobs(server.workspace).find((j) => j.status === "cancelled");
  assert.ok(cancelledJob, "Job must be cancelled");
  assert.equal(cancelledJob.claudeSessionId, cancelledJob.claudeSessionUuid,
    "Cancelled new job must preserve the pre-allocated canonical session ID");
  assert.ok(cancelledJob.claudeSessionUuid, "Cancelled job must preserve claudeSessionUuid");
  assert.ok(cancelledJob.autoCompact, "Cancelled job must preserve autoCompact policy");
  assert.equal(cancelledJob.autoCompact.scope, "task");
  assert.equal(cancelledJob.autoCompact.targetTokens, 300000);

  const delegateResult = await delegatePromise;
  assert.match(
    delegateResult.result.content[0].text,
    /Auto-compact taskScopeId:\*\*\s*[0-9a-f-]{36}/i,
    "Cancelled delegation must return the generated taskScopeId for later fresh sessions",
  );
});

// ─── cc_compact falls back to claudeSessionUuid for cancelled new sessions ──

test("cc_compact locates cancelled new session via its pre-allocated canonical ID", async (t) => {
  const server = startServer(t);

  // Start a new delegation that hangs (pre-allocates claudeSessionUuid, --session-id).
  // claudeSessionId stays null because the task never completes.
  const delegatePromise = server.send(1, "cc_delegate", { task: "hang" });
  const runningJob = await waitFor(() =>
    listJobs(server.workspace).find((j) => j.status === "running")
  );

  // Cancel before completion — the pre-allocated ID remains canonical.
  await server.send(2, "cc_cancel");

  const cancelledJob = listJobs(server.workspace).find((j) => j.id === runningJob.id);
  assert.equal(cancelledJob.status, "cancelled");
  assert.ok(cancelledJob.claudeSessionUuid, "Cancelled new job must have claudeSessionUuid");
  assert.equal(cancelledJob.claudeSessionId, cancelledJob.claudeSessionUuid);

  // cc_compact(job) must locate the session via claudeSessionUuid fallback,
  // NOT return "No stopped Claude Code session".
  const compactResult = await server.send(3, "cc_compact", { job: runningJob.id });
  const compactText = compactResult.result.content[0].text;
  assert.doesNotMatch(compactText, /No stopped Claude Code session/i,
    "cc_compact must fall back to claudeSessionUuid when claudeSessionId is null");

  await delegatePromise.catch(() => {});
});

// ─── End-to-end: stop → compact → resume same session ───────────────────────

test("end-to-end: cancel → compact → resume the same pre-allocated session", async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-e2e-compact-resume-"));
  const configDir = path.join(workspace, "claude-config");
  const projectsDir = path.join(configDir, "projects");
  const projectDir = path.join(projectsDir, "test-project");
  fs.mkdirSync(projectDir, { recursive: true });

  const server = startServer(t, {
    workspace,
    env: { CLAUDE_CONFIG_DIR: configDir },
  });

  // 1. Start then stop a fresh delegation.
  const firstPromise = server.send(1, "cc_delegate", { task: "hang" });
  const runningJob = await waitFor(() =>
    listJobs(workspace).find((j) => j.status === "running")
  );
  await server.send(2, "cc_cancel", { job: runningJob.id });
  await firstPromise.catch(() => {});

  const firstJob = listJobs(workspace).find((j) => j.id === runningJob.id);
  assert.equal(firstJob.status, "cancelled");
  assert.equal(firstJob.claudeSessionId, firstJob.claudeSessionUuid);

  // 2. Compact the stopped session (no transcript → compacted:false, but no crash)
  const compactResult = await server.send(3, "cc_compact", { job: firstJob.id });
  assert.match(compactResult.result.content[0].text, /Compact Result/i);

  // 3. Resume the same session
  const resumeResult = await server.send(4, "cc_delegate", {
    task: "echo-args",
    resumeSession: firstJob.claudeSessionId,
  });
  const resumeText = resumeResult.result.content[0].text;
  assert.match(resumeText, /Task Completed/);

  // Verify resume used --resume, not --session-id
  const args = extractArgs(resumeText);
  assert.match(args, new RegExp(`--resume ${firstJob.claudeSessionId}`));
  assert.doesNotMatch(args, /--session-id/);
});
