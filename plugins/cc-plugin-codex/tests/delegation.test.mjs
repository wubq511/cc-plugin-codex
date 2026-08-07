import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  startDelegation, cancelDelegation, listActiveDelegations,
  settleDelegation, collectExecutionEvidence, TERMINAL_STATUSES,
} from "../scripts/lib/delegation.mjs";
import { generateJobId, upsertJob, listJobs, readResultArtifact } from "../scripts/lib/state.mjs";
import { ROUTE_STATUSES } from "../scripts/lib/route-status.mjs";

// Point model-evidence at an empty config dir so transcript collection always
// returns "unavailable" deterministically instead of scanning the developer's
// real ~/.claude/projects. node --test runs each file in its own process, so
// this assignment is scoped to this suite.
const emptyConfigRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cc-delegation-config-"));
process.env.CLAUDE_CONFIG_DIR = emptyConfigRoot;

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Windows-safe recursive directory removal. On Windows, deleting a directory
 * while a child process still holds it as CWD can fail with EBUSY/ENOTEMPTY;
 * retry with backoff. On POSIX a single attempt is enough.
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

/** Create a fresh workspace and drain state.mjs's one-per-workspace orphan
 * reconciliation while the workspace is still empty (mirrors the server tests:
 * a first listJobs after a live job would wrongly orphan it). */
function makeWorkspace(t) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "cc-delegation-test-"));
  t.after(() => safeRmDir(workspace));
  listJobs(workspace);
  return workspace;
}

/** Build a full in-memory job record the way the entrypoint builds it before
 * startDelegation: taskRef/taskHash only, never raw task text. */
function makeJob(overrides = {}) {
  return {
    id: generateJobId("cc"),
    status: "running",
    phase: "starting",
    taskRef: "task-ref",
    taskHash: "task-hash",
    requestedModel: null,
    requestMode: "inherited",
    selectorKind: null,
    routeSnapshot: null,
    routeStatus: null,
    modelEvidence: {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: [],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
    effort: null,
    write: false,
    dangerouslySkipPermissions: false,
    background: false,
    resume: false,
    resumeSession: null,
    ownerServerId: "test-server",
    claudeSessionId: null,
    claudeSessionUuid: null,
    pid: null,
    logFile: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    result: null,
    resultArtifact: null,
    cost: null,
    duration: null,
    touchedFiles: [],
    workspaceChanges: null,
    errorMessage: null,
    truncation: null,
    autoCompact: null,
    ...overrides,
  };
}

/** Fake run function: records the spawn, returns a controllable execution. */
function makeRun(spawned, execution) {
  return (task, options) => {
    spawned.push({ task, options });
    return execution;
  };
}

/** Build a fake execution whose result promise resolves to `result`. */
function makeExecution(result) {
  let cancelCalls = 0;
  const execution = {
    pid: 4242,
    result: Promise.resolve(result),
    cancel() { cancelCalls++; },
  };
  return { execution, get cancelCalls() { return cancelCalls; } };
}

/** Persist a job so the lifecycle (updateJob, finalizeJob) can observe it. */
function persistJob(workspace, job) {
  upsertJob(workspace, job);
  return job;
}

function findJob(workspace, jobId) {
  return listJobs(workspace).find((candidate) => candidate.id === jobId) || null;
}

// ─── startDelegation ─────────────────────────────────────────────────────────

test("startDelegation registers a live handle but does not persist the job", (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  const { execution } = makeExecution({ ok: true, result: "done" });
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], execution) });

  assert.equal(started.ok, true);
  assert.equal(started.handle.jobId, job.id);
  assert.equal(started.handle.workspaceRoot, workspace);
  assert.ok(listActiveDelegations().some((h) => h.jobId === job.id), "handle should be registered");
  // The entrypoint persists the job AFTER startDelegation returns — startDelegation
  // itself must not write state, or a lease failure could leave a phantom job.
  assert.equal(findJob(workspace, job.id), null, "startDelegation must not persist the job");
});

test("a second write-enabled delegation in the same workspace fails closed", (t) => {
  const workspace = makeWorkspace(t);
  const first = makeJob({ write: true });
  const firstStarted = startDelegation({ job: first, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "a" }).execution) });
  assert.equal(firstStarted.ok, true);

  const second = makeJob({ write: true });
  const secondStarted = startDelegation({ job: second, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "b" }).execution) });
  assert.equal(secondStarted.ok, false);
  assert.match(secondStarted.error, /another write-enabled delegation/);
  assert.ok(!listActiveDelegations().some((h) => h.jobId === second.id), "failed start must not register a handle");
});

test("read-only delegations run concurrently with a held write lease", (t) => {
  const workspace = makeWorkspace(t);
  const writer = makeJob({ write: true });
  const writerStarted = startDelegation({ job: writer, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "a" }).execution) });
  assert.equal(writerStarted.ok, true);

  const reader = makeJob({ write: false });
  const readerStarted = startDelegation({ job: reader, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "b" }).execution) });
  assert.equal(readerStarted.ok, true, "read-only delegation must not block on the writer lease");
});

test("handle.spawn routes through the injected run and records the execution", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  const spawned = [];
  const { execution } = makeExecution({ ok: true, result: "done" });
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun(spawned, execution) });
  assert.equal(started.ok, true);
  const handle = started.handle;

  assert.equal(handle.cancelRequested, false);
  const result = handle.spawn("fix the bug", { cwd: workspace, write: false });
  assert.equal(result, execution);
  assert.equal(handle.execution, execution);
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].task, "fix the bug");
  assert.equal(spawned[0].options.cwd, workspace);
});

test("cancelDelegation marks the job cancelling, signals the watchdog once, and settles on request", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  persistJob(workspace, job);
  const fake = makeExecution({ ok: true, result: "done" });
  const { execution } = fake;
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], execution) });
  assert.equal(started.ok, true);
  const handle = started.handle;
  handle.spawn("task", { cwd: workspace });

  const found = await cancelDelegation(workspace, job.id);
  assert.equal(found, handle);
  assert.equal(handle.cancelRequested, true);
  assert.equal(fake.cancelCalls, 1, "watchdog must be signalled exactly once");

  const persisted = findJob(workspace, job.id);
  assert.equal(persisted.status, "cancelling", "cancelling is the intermediate status, not cancelled");
  assert.equal(persisted.phase, "cancelling");
  assert.equal(persisted.errorMessage, "Cancelled by user.");

  // Terminal settlement is the result path's job, not cancelDelegation's.
  await settleDelegation({ handle, result: null, direct: {
    status: "cancelled",
    errorMessage: "Cancelled by user.",
    routeStatus: ROUTE_STATUSES.CANCELLED,
  }});
  assert.equal(findJob(workspace, job.id).status, "cancelled");
});

test("cancelDelegation returns null for an unknown job", (t) => {
  const workspace = makeWorkspace(t);
  return cancelDelegation(workspace, "no-such-job").then((handle) => {
    assert.equal(handle, null);
  });
});

test("cancelDelegation is safe after the handle settled (no live controller)", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  persistJob(workspace, job);
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "x" }).execution) });
  assert.equal(started.ok, true);
  await settleDelegation({ handle: started.handle, result: null, direct: {
    status: "cancelled", errorMessage: "Cancelled.", routeStatus: ROUTE_STATUSES.CANCELLED,
  }});

  const handle = await cancelDelegation(workspace, job.id);
  assert.equal(handle, null);
  assert.ok(!listActiveDelegations().some((h) => h.jobId === job.id));
});

// ─── settleDelegation — no-result (direct) mode ───────────────────────────────

test("direct settlement writes the terminal status and releases the handle", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  persistJob(workspace, job);
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "x" }).execution) });
  assert.equal(started.ok, true);
  const handle = started.handle;

  const { finalizedJob } = await settleDelegation({ handle, result: null, direct: {
    status: "cancelled",
    errorMessage: "Cancelled before Claude Code was started.",
    routeStatus: ROUTE_STATUSES.CANCELLED,
  }});

  assert.equal(finalizedJob.status, "cancelled");
  assert.equal(finalizedJob.phase, "cancelled");
  assert.equal(finalizedJob.routeStatus, ROUTE_STATUSES.CANCELLED);
  // finalizeJob's cancelled branch persists the current job's errorMessage
  // (the callers pass one, but the persisted cancelling reason wins when set).
  assert.equal(finalizedJob.errorMessage, "Cancelled.");
  assert.ok(finalizedJob.completedAt, "terminal status must carry a completion time");

  const persisted = findJob(workspace, job.id);
  assert.equal(persisted.status, "cancelled");

  // Handle is settled: deregistered and completionPromise resolved with null.
  assert.ok(!listActiveDelegations().some((h) => h.jobId === job.id), "settled handle must be deregistered");
  assert.equal(await handle.completionPromise, null);
});

test("a persisted cancelling status forces cancelled even when direct.status differs", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob({ status: "cancelling", phase: "cancelling", errorMessage: "Cancelled by user." });
  persistJob(workspace, job);
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "x" }).execution) });
  assert.equal(started.ok, true);

  // A spawn-failure settle arrives after the user cancelled: finalizeJob must
  // write cancelled (cancelling wins), never failed.
  const { finalizedJob } = await settleDelegation({ handle: started.handle, result: null, direct: {
    status: "failed",
    errorMessage: "Spawn failed.",
    routeStatus: ROUTE_STATUSES.REJECTED,
  }});
  assert.equal(finalizedJob.status, "cancelled");
  assert.equal(finalizedJob.routeStatus, ROUTE_STATUSES.CANCELLED);
  assert.equal(finalizedJob.errorMessage, "Cancelled by user.");
});

test("terminal first-writer-wins: a second settle cannot override", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  persistJob(workspace, job);
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "x" }).execution) });
  assert.equal(started.ok, true);
  const handle = started.handle;

  const first = await settleDelegation({ handle, result: null, direct: {
    status: "cancelled", errorMessage: "Cancelled.", routeStatus: ROUTE_STATUSES.CANCELLED,
  }});
  assert.equal(first.finalizedJob.status, "cancelled");

  // A late settle (e.g. the result path finishing after cancellation) must not
  // flip the terminal status. settle is idempotent — no throw.
  const second = await settleDelegation({ handle, result: { ok: true, result: "late" }, task: "x", routeContext: {}, preRunFingerprint: new Map() });
  assert.equal(second.finalizedJob.status, "cancelled", "terminal status must not be overridden");
  assert.equal(findJob(workspace, job.id).status, "cancelled");
});

// ─── settleDelegation — success path ─────────────────────────────────────────

test("success settlement writes completed job + private artifact + evidence", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  persistJob(workspace, job);
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "all done" }).execution) });
  assert.equal(started.ok, true);
  const handle = started.handle;

  const result = {
    ok: true,
    result: "all done",
    sessionId: "test-session-123",
    cost: 0.42,
    duration: 1.5,
    usageModelKeys: ["usage-key-1"],
    exitCode: 0,
    usage: { inputTokens: 10, outputTokens: 20 },
  };
  const settlement = await settleDelegation({
    handle,
    result,
    task: "do the thing",
    routeContext: {
      requestedModel: null,
      requestMode: "inherited",
      selectorKind: null,
      routeSnapshot: { selectorKind: "inherited", cliArg: null, cliVersion: "test" },
      cliVersion: "test",
    },
    provisionalClaudeSessionId: "test-session-123",
    preRunFingerprint: new Map(),
  });

  const { finalizedJob } = settlement;
  assert.equal(finalizedJob.status, "completed");
  assert.equal(finalizedJob.phase, "completed");
  assert.equal(finalizedJob.claudeSessionId, "test-session-123");
  assert.equal(finalizedJob.cost, 0.42);
  assert.equal(finalizedJob.duration, 1.5);
  assert.equal(finalizedJob.routeStatus, ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED);
  assert.ok(finalizedJob.resultArtifact, "success must write a private artifact");

  // The artifact holds the full redacted result.
  const artifact = readResultArtifact(workspace, job.id);
  assert.equal(artifact.result, "all done");
  assert.equal(artifact.sessionId, "test-session-123");
  assert.equal(artifact.requestedModel, null);

  // Settlement exposes the presentation/evidence for the entrypoint's response.
  assert.equal(settlement.presentation.text, "all done");
  assert.equal(settlement.presentation.truncated, false);
  assert.equal(settlement.safeResult, "all done");
  assert.equal(settlement.modelEvidence.status, "unavailable");
  assert.deepEqual(settlement.workspaceChanges, { added: [], modified: [], removed: [], totalChanges: 0, summary: "0 added, 0 modified, 0 removed" });
  assert.equal(await handle.completionPromise, result, "completionPromise resolves with the settled result");
});

test("success settlement redacts secrets before persisting the artifact", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  persistJob(workspace, job);
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "deployed with sk-ant-abc123456789" }).execution) });
  assert.equal(started.ok, true);

  await settleDelegation({
    handle: started.handle,
    result: { ok: true, result: "deployed with sk-ant-abc123456789", sessionId: "test-session-456", usageModelKeys: [], exitCode: 0 },
    task: "deploy using token sk-ant-abc123456789",
    routeContext: { requestedModel: null, requestMode: "inherited", selectorKind: null, routeSnapshot: null, cliVersion: null },
    provisionalClaudeSessionId: "test-session-456",
    preRunFingerprint: new Map(),
  });

  const artifact = readResultArtifact(workspace, job.id);
  assert.doesNotMatch(artifact.result, /sk-ant-abc123456789/);
  assert.match(artifact.result, /\[REDACTED\]/);
});

test("success settlement records the auto-compact audit on the final job", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  persistJob(workspace, job);
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: true, result: "ok", sessionId: "test-session-789", usageModelKeys: [], exitCode: 0 }).execution) });
  assert.equal(started.ok, true);

  const audit = { scope: "session", targetTokens: 120000, effectiveWindow: 100000, settingsInjected: false };
  const { finalizedJob } = await settleDelegation({
    handle: started.handle,
    result: { ok: true, result: "ok", sessionId: "test-session-789", usageModelKeys: [], exitCode: 0 },
    task: "task",
    routeContext: { requestedModel: null, requestMode: "inherited", selectorKind: null, routeSnapshot: null, cliVersion: null },
    autoCompactAudit: audit,
    provisionalClaudeSessionId: "test-session-789",
    preRunFingerprint: new Map(),
  });

  assert.equal(finalizedJob.autoCompact.scope, "session");
  assert.equal(finalizedJob.autoCompact.targetTokens, 120000);
  // settingsInjected=false means no boundary collection — observed stays null,
  // never fabricated.
  assert.equal(finalizedJob.autoCompact.observedBoundary, null);
  assert.equal(finalizedJob.autoCompact.compactTrigger, null);
});

// ─── settleDelegation — failure path ─────────────────────────────────────────

test("failure settlement writes failed job + redacted diagnostics artifact", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  persistJob(workspace, job);
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: false, error: "boom" }).execution) });
  assert.equal(started.ok, true);

  const failureResult = {
    ok: false,
    error: "Claude task failed: boom",
    failureStage: "provider_response",
    sessionId: "test-session-fail",
    cost: 0.1,
    duration: 0.5,
    usageModelKeys: [],
    exitCode: 1,
    diagnostics: { errorDetail: "runtime secret sk-ant-abc987654321 leaked" },
  };
  const settlement = await settleDelegation({
    handle: started.handle,
    result: failureResult,
    task: "task that fails",
    routeContext: {
      requestedModel: null,
      requestMode: "inherited",
      selectorKind: null,
      routeSnapshot: { selectorKind: "inherited", cliArg: null, cliVersion: "test" },
      cliVersion: "test",
    },
  });

  const { finalizedJob } = settlement;
  assert.equal(finalizedJob.status, "failed");
  assert.equal(finalizedJob.phase, "failed");
  assert.equal(finalizedJob.routeStatus, ROUTE_STATUSES.REJECTED);
  assert.match(finalizedJob.errorMessage, /^\[provider_response\]/);
  // The safe boundary never leaks the raw provider error text.
  assert.doesNotMatch(finalizedJob.errorMessage, /boom/);
  assert.ok(finalizedJob.resultArtifact, "failure must write a private artifact");

  const artifact = readResultArtifact(workspace, job.id);
  assert.equal(artifact.failureStage, "provider_response");
  assert.equal(artifact.routeStatus, ROUTE_STATUSES.REJECTED);
  assert.match(artifact.diagnostics.errorDetail, /runtime secret/);
  assert.doesNotMatch(artifact.diagnostics.errorDetail, /sk-ant-abc987654321/, "diagnostics must be redacted before persistence");
});

test("a cancelled failure settles as failed with the CANCELLED stage", async (t) => {
  const workspace = makeWorkspace(t);
  const job = makeJob();
  persistJob(workspace, job);
  const started = startDelegation({ job, workspaceRoot: workspace, run: makeRun([], makeExecution({ ok: false, cancelled: true, error: "Cancelled." }).execution) });
  assert.equal(started.ok, true);

  const { finalizedJob } = await settleDelegation({
    handle: started.handle,
    result: { ok: false, cancelled: true, error: "Cancelled." },
    task: "task",
    routeContext: { requestedModel: null, requestMode: "inherited", selectorKind: null, routeSnapshot: { selectorKind: "inherited", cliArg: null, cliVersion: "test" }, cliVersion: "test" },
  });
  assert.equal(finalizedJob.status, "failed");
  assert.equal(finalizedJob.routeStatus, ROUTE_STATUSES.CANCELLED);
  assert.match(finalizedJob.errorMessage, /\[cancelled\]/);
});

// ─── collectExecutionEvidence (shared with the liveness probe) ───────────────

test("collectExecutionEvidence returns unavailable evidence and an honest route status without a transcript", async (t) => {
  const { modelEvidence, routeStatus } = await collectExecutionEvidence({
    sessionId: "test-session-evidence",
    usageModelKeys: ["usage-key-1"],
    routeSnapshot: { selectorKind: "inherited", cliArg: null, cliVersion: "test" },
    jobOk: true,
    cancelled: false,
  });

  assert.equal(modelEvidence.status, "unavailable");
  assert.deepEqual(modelEvidence.usageModelKeys, ["usage-key-1"], "usage keys must survive collection");
  // No transcript evidence and no native claim → accepted but unverified.
  assert.equal(routeStatus, ROUTE_STATUSES.ACCEPTED_BUT_UNVERIFIED);
});

test("collectExecutionEvidence reports cancelled without ever guessing a route", async (t) => {
  const { modelEvidence, routeStatus } = await collectExecutionEvidence({
    sessionId: "test-session-evidence",
    usageModelKeys: [],
    routeSnapshot: null,
    jobOk: false,
    cancelled: true,
  });
  assert.equal(modelEvidence.status, "unavailable");
  assert.equal(routeStatus, ROUTE_STATUSES.CANCELLED);
});

// ─── Registry invariants ─────────────────────────────────────────────────────

test("TERMINAL_STATUSES lists exactly the finalizer-owned statuses", (t) => {
  assert.deepEqual([...TERMINAL_STATUSES].sort(), ["cancelled", "completed", "failed", "orphaned", "rejected"]);
  assert.ok(!TERMINAL_STATUSES.has("running"));
  assert.ok(!TERMINAL_STATUSES.has("cancelling"), "cancelling is intermediate, never terminal");
});
