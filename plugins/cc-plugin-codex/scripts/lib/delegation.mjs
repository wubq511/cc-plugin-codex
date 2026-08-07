/**
 * Delegation Lifecycle — foreground run → settle → cancel for one delegation.
 *
 * This module owns the state that makes a foreground delegation safe:
 *   - the running-delegation registry (activeForegroundRuns)
 *   - the writer lease (acquired for write-enabled delegations, refreshed by
 *     a heartbeat, released on settle)
 *   - the single terminal-status settlement race lock (finalizingJobs + the
 *     private finalizeJob)
 *
 * Tool handlers (cc_companion) build the job record, spawn the run through the
 * injected `run` function, and format MCP responses — but they never settle a
 * terminal status themselves. They signal cancellation and consume results via
 * the exported functions below.
 *
 * The `run` function is injectable so tests can drive the lifecycle with a fake
 * execution; production passes `runClaude` from claude-runner.mjs.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";

import { upsertJob, listJobs, acquireWriterLease, updateWriterLeaseJobId, refreshWriterLease, releaseWriterLease, writeResultArtifact } from "./state.mjs";
import { appendLogLine, isValidTransition } from "./job-log.mjs";
import { collectModelEvidence } from "./model-evidence.mjs";
import { computeRouteStatus, ROUTE_STATUSES } from "./route-status.mjs";
import { captureWorkspaceFingerprint, diffWorkspaceFingerprints } from "./git.mjs";
import { collectCompactBoundary } from "./compact-boundary.mjs";
import {
  FAILURE_STAGES, redactText, redactDiagnosticValue,
  buildSafeErrorMessage, truncateForPresentation, boundedText,
  MAX_MCP_RESULT_BYTES, MAX_JOB_RESULT_BYTES, MAX_ERROR_MESSAGE_BYTES,
} from "./diagnostics.mjs";

// ─── Constants ───────────────────────────────────────────────────────────────

/** Terminal statuses. A terminal status is written only by finalizeJob. */
export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "rejected", "orphaned"]);

/** Writer-lease heartbeat interval (must stay within the lease TTL). */
const LEASE_HEARTBEAT_MS = 60_000;

/**
 * Process-level writer-lease token. One token per MCP server process; the
 * lease guarantees at most one write-enabled delegation per workspace.
 */
const WRITER_TOKEN = randomBytes(16).toString("hex");

const MAX_TOUCHED_FILES = 500;
const MAX_TOUCHED_FILES_BYTES = 16 * 1024;

// ─── Module State ────────────────────────────────────────────────────────────

/** jobId → live handle. Handles exist from startDelegation until settle. */
const activeForegroundRuns = new Map();

/**
 * jobId → settled terminal job (or null). The terminal-status race lock:
 * a late success/failure/cancel path must never override a status that was
 * already settled. Cleared on settle.
 */
const finalizingJobs = new Map();

// ─── Small Helpers ───────────────────────────────────────────────────────────

function logError(message) {
  try { process.stderr.write(`[delegation] ${message}\n`); } catch { /* best effort */ }
}

/**
 * Persist a job patch with a phase-transition guard. A terminal status is
 * never written here — finalizeJob is the only writer of terminal status.
 */
function updateJob(workspaceRoot, patch) {
  if (patch.phase && patch.id) {
    const jobs = listJobs(workspaceRoot);
    const existing = jobs.find((j) => j.id === patch.id);
    if (existing?.phase && !isValidTransition(existing.phase, patch.phase)) {
      logError(`Invalid phase transition: ${existing.phase} → ${patch.phase} for job ${patch.id}`);
    }
  }
  return upsertJob(workspaceRoot, patch);
}

/** Bound a list of workspace paths for storage and presentation. */
function boundedTouchedFiles(files) {
  const result = [];
  let bytes = 0;
  for (const file of files) {
    const value = String(file);
    const nextBytes = Buffer.byteLength(value, "utf8");
    if (result.length >= MAX_TOUCHED_FILES || bytes + nextBytes > MAX_TOUCHED_FILES_BYTES) break;
    result.push(value);
    bytes += nextBytes;
  }
  return result;
}

// ─── Finalizer (private) ─────────────────────────────────────────────────────

/**
 * Centralized finalizer — the ONLY writer of terminal job status.
 * Prevents the completed-vs-cancelled race via a synchronous per-job critical
 * section plus an in-memory terminal-decision cache.
 *
 * Rules:
 *   - If the job is already terminal, return the existing state (first writer wins).
 *   - If the job is "cancelling", the terminal status is always "cancelled"
 *     regardless of what the result says.
 *   - Otherwise, write the requested terminal status.
 */
function finalizeJob(workspaceRoot, jobId, requestedStatus, patch = {}) {
  const existing = finalizingJobs.get(jobId);
  if (existing) return existing;

  const result = (() => {
    const jobs = listJobs(workspaceRoot);
    const current = jobs.find((j) => j.id === jobId);
    if (!current) return null;

    // Already terminal — first writer wins, no override.
    if (TERMINAL_STATUSES.has(current.status)) {
      return current;
    }

    // If cancellation was requested, always write cancelled.
    const finalStatus = current.status === "cancelling" ? "cancelled" : requestedStatus;

    const now = new Date().toISOString();
    const finalPatch = { ...patch };
    if (finalStatus === "cancelled") {
      finalPatch.result = null;
      finalPatch.errorMessage = current.errorMessage || "Cancelled.";
      finalPatch.routeStatus = ROUTE_STATUSES.CANCELLED;
    }
    updateJob(workspaceRoot, {
      id: jobId,
      ...finalPatch,
      status: finalStatus,
      phase: finalStatus,
      pid: null,
      completedAt: now,
      updatedAt: now,
    });

    return listJobs(workspaceRoot).find((j) => j.id === jobId) || null;
  })();

  // Cache the result so any concurrent or late finalization attempt (e.g.
  // a cancel arriving after the result path settles) returns the same
  // terminal state without overriding it.
  finalizingJobs.set(jobId, result);
  return result;
}

// ─── Execution Evidence (shared with the liveness probe) ────────────────────

/**
 * Collect best-effort model evidence from the transcript and compute the
 * honest post-execution route status. A configuration claim (routeSnapshot)
 * is never execution proof; a usage key is never an execution model.
 *
 * Shared by the delegation settle path and the cc_setup liveness probe, which
 * must render the same honest evidence→status story.
 *
 * @returns {Promise<{ modelEvidence: object, routeStatus: string }>}
 */
export async function collectExecutionEvidence({ sessionId, usageModelKeys, routeSnapshot, jobOk, cancelled }) {
  const keys = usageModelKeys || [];
  let modelEvidence;
  try {
    modelEvidence = await collectModelEvidence({
      sessionId,
      usageModelKeys: keys,
      deadlineMs: 1000,
    });
  } catch (err) {
    // Collector failure must not change job success status
    modelEvidence = {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: keys,
      usageSource: "claude-result-modelUsage",
      warnings: ["transcript-not-found"],
    };
  }

  const routeStatus = computeRouteStatus({
    routeSnapshot,
    jobOk,
    cancelled,
    executedModels: modelEvidence.executedModels,
    usageModelKeys: modelEvidence.usageModelKeys,
  });

  return { modelEvidence, routeStatus };
}

// ─── Handle ──────────────────────────────────────────────────────────────────

/**
 * Create the live controller for one delegation. The handle is the only object
 * that can release the lease, remove the registry entry, and resolve the
 * completion promise — every terminal path funnels through settle().
 */
function createHandle({ jobId, workspaceRoot, write, leaseOwner, run }) {
  let execution = null;
  let cancelRequested = false;
  let settled = false;
  let resolveCompletion;
  const completionPromise = new Promise((resolve) => { resolveCompletion = resolve; });

  let leaseHeartbeat = null;
  if (leaseOwner) {
    leaseHeartbeat = setInterval(() => {
      try { refreshWriterLease(workspaceRoot, leaseOwner); } catch { /* final release handles loss */ }
    }, LEASE_HEARTBEAT_MS);
    leaseHeartbeat.unref?.();
  }

  const handle = {
    jobId,
    workspaceRoot,
    write,
    run,
    get execution() { return execution; },
    get cancelRequested() { return cancelRequested; },
    completionPromise,

    /**
     * Spawn the run through the injected `run` function and record the
     * execution so cancellation and shutdown can reach it.
     */
    spawn(task, options) {
      execution = run(task, options);
      return execution;
    },

    /**
     * Mark the delegation as cancelling (idempotent). Only an intermediate
     * status is written here — the terminal "cancelled" is settled by
     * finalizeJob via the result path.
     */
    requestCancel(reason) {
      if (settled || cancelRequested) return;
      cancelRequested = true;
      appendLogLine(workspaceRoot, jobId, reason);
      updateJob(workspaceRoot, {
        id: jobId,
        status: "cancelling",
        phase: "cancelling",
        errorMessage: reason,
      });
    },

    /** Signal the watchdog once (terminates the Claude process tree). */
    signalCancel() {
      try { execution?.cancel(); } catch { /* best effort */ }
    },

    /** Mark cancelling and signal — used for MCP client cancellation. */
    cancel(reason) {
      this.requestCancel(reason);
      this.signalCancel();
    },

    /** Clear the lease heartbeat and release the writer lease (idempotent). */
    releaseLease() {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      leaseHeartbeat = null;
      if (leaseOwner) {
        try { releaseWriterLease(workspaceRoot, leaseOwner); } catch { /* best effort */ }
      }
    },

    /**
     * Settle the delegation: release the lease, deregister, clear the
     * finalizer lock, and resolve the completion promise so cc_cancel and
     * gracefulShutdown can observe that no live process or lease remains.
     */
    settle(outcome) {
      if (settled) return;
      settled = true;
      handle.releaseLease();
      activeForegroundRuns.delete(jobId);
      finalizingJobs.delete(jobId);
      resolveCompletion(outcome ?? null);
    },
  };

  return handle;
}

// ─── Public Lifecycle API ────────────────────────────────────────────────────

/**
 * Start a delegation: acquire the writer lease (write-enabled delegations),
 * create the live handle, and register it in the running-delegation registry.
 *
 * The caller persists the job record AFTER this returns, so a concurrent
 * cc_cancel can always find a live handle once the job is observable.
 *
 * @param {object} input
 * @param {object} input.job - The in-memory job record (never persisted here).
 * @param {string} input.workspaceRoot - Absolute workspace root.
 * @param {Function} input.run - Injectable spawn function `(task, options) => execution`.
 * @returns {{ ok: true, handle: object } | { ok: false, error: string }}
 */
export function startDelegation({ job, workspaceRoot, run }) {
  // Writer lease for write-enabled delegations. Fails closed before any
  // controller is registered — the caller surfaces the owner error.
  let leaseOwner = null;
  if (job.write) {
    // In-process writer exclusion first: the file lease is cross-process and
    // re-entrant for this process's single WRITER_TOKEN, so a second write
    // delegation in the same server process would otherwise slip through it.
    const activeWriter = [...activeForegroundRuns.values()].find(
      (candidate) => candidate.workspaceRoot === workspaceRoot && candidate.write === true,
    );
    if (activeWriter) {
      return {
        ok: false,
        error: `another write-enabled delegation is already active in this workspace (job: ${activeWriter.jobId}). Wait for it to complete or cancel it first. Read-only delegations (write=false) can run concurrently.`,
      };
    }

    const leaseResult = acquireWriterLease(workspaceRoot, WRITER_TOKEN);
    if (!leaseResult.acquired) {
      return {
        ok: false,
        error: `another write-enabled delegation is already active in this workspace (lease owner: ${leaseResult.owner?.slice(0, 8)}..., job: ${leaseResult.jobId || "unknown"}). Wait for it to complete or cancel it first. Read-only delegations (write=false) can run concurrently.`,
      };
    }
    leaseOwner = WRITER_TOKEN;
  }

  const handle = createHandle({ jobId: job.id, workspaceRoot, write: job.write, leaseOwner, run });
  activeForegroundRuns.set(job.id, handle);

  if (leaseOwner) {
    try { updateWriterLeaseJobId(workspaceRoot, leaseOwner, job.id); } catch { /* best effort — the lease still guards */ }
  }

  return { ok: true, handle };
}

/**
 * Request cancellation of a live delegation and signal the watchdog once the
 * cancelling status is observable. Awaits the bounded yield that flushes the
 * intermediate status to disk before the process tree dies.
 *
 * @returns {Promise<object|null>} The handle, or null when no live delegation
 *   matches (caller reports the error).
 */
export async function cancelDelegation(workspaceRoot, jobId) {
  const handle = activeForegroundRuns.get(jobId);
  if (!handle) return null;

  handle.requestCancel("Cancelled by user.");

  // Yield briefly so the cancelling status is flushed to disk and observable
  // by external state pollers before we signal the watchdog. Without this,
  // the process tree can die within the same event-loop turn, overwriting
  // cancelling→cancelled before any observer sees the intermediate state.
  // The default delay is bounded (20ms) and negligible compared to
  // process-tree shutdown time in production.
  //
  // Test hook: when CC_TEST_CANCEL_HOLD_FILE is set, replace the fixed yield
  // with a deterministic rendezvous — hold the cancelling status until that
  // file exists (bounded 30s fallback). Timing-based windows are unreliable
  // under CI load: the observer's event loop can be starved for seconds, and
  // on Windows taskkill /T /F delivers no signal the child could trap to
  // widen the window itself.
  const cancelHoldFile = process.env.CC_TEST_CANCEL_HOLD_FILE;
  if (cancelHoldFile) {
    const holdDeadline = Date.now() + 30000;
    while (Date.now() < holdDeadline) {
      try { if (fs.existsSync(cancelHoldFile)) break; } catch { /* keep waiting */ }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } else {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  // Signal the watchdog once. The watchdog terminates the Claude process tree.
  handle.signalCancel();
  return handle;
}

/**
 * Snapshot of all live delegations, for gracefulShutdown and idempotent
 * cancel lookups. Read-only — never mutate the registry through this.
 */
export function listActiveDelegations() {
  return [...activeForegroundRuns.values()];
}

/**
 * Settle a delegation's terminal status. The single funnel for every terminal
 * path: success, failure, and no-result settlement (pre-spawn cancel, spawn
 * failure, cancellation observed after the run, server shutdown).
 *
 * The caller passes the raw run result plus the entry-computed context
 * (route snapshot, auto-compact audit, provisional session id). This function
 * performs the verify→finalize phase transitions, workspace fingerprint diff,
 * model-evidence collection, redaction, private artifact write, and the
 * terminal finalize — then settles the handle (lease release, deregistration,
 * completion resolution) in a finally block so cleanup always runs.
 *
 * @param {object} input
 * @param {object} input.handle - The handle from startDelegation.
 * @param {object|null} input.result - Raw run result; null for no-result settlement.
 * @param {{ status: string, errorMessage: string, routeStatus: string }|null} input.direct
 *   Required when result is null: the terminal spec for no-result settlement.
 * @param {string} input.task - Delegated task text (redaction markers).
 * @param {object} input.routeContext - { requestedModel, requestMode, selectorKind, routeSnapshot, cliVersion }.
 * @param {object|null} input.autoCompactAudit - Entry-computed auto-compact audit.
 * @param {string|null} input.autoCompactBoundaryCursor - Cursor from before spawn.
 * @param {string|null} input.provisionalClaudeSessionId - Authoritative session id.
 * @param {object|null} input.preRunFingerprint - Pre-spawn workspace fingerprint.
 * @returns {Promise<object>} Settlement data; the caller branches on
 *   `finalizedJob?.status === "cancelled"` for the cancelled presentation.
 */
export async function settleDelegation({
  handle,
  result,
  direct = null,
  task,
  routeContext,
  autoCompactAudit = null,
  autoCompactBoundaryCursor = null,
  provisionalClaudeSessionId = null,
  preRunFingerprint = null,
}) {
  const { workspaceRoot, jobId } = handle;
  try {
    if (result === null) {
      // No-result terminal settlement (pre-spawn cancel, spawn failure, or
      // shutdown): no run result exists, so no artifact is written. finalizeJob
      // applies the cancelling→cancelled override when applicable.
      const finalizedJob = finalizeJob(workspaceRoot, jobId, direct.status, {
        errorMessage: direct.errorMessage,
        routeStatus: direct.routeStatus,
      });
      return { finalizedJob, resultArtifactPath: null };
    }

    if (result.ok) {
      return await settleSuccess({
        handle, result, task, routeContext,
        autoCompactAudit, autoCompactBoundaryCursor,
        provisionalClaudeSessionId, preRunFingerprint,
      });
    }

    return await settleFailure({ handle, result, task, routeContext });
  } finally {
    handle.settle(result ?? null);
  }
}

// ─── Settle Paths (private) ──────────────────────────────────────────────────

async function settleSuccess({
  handle, result, task, routeContext,
  autoCompactAudit, autoCompactBoundaryCursor,
  provisionalClaudeSessionId, preRunFingerprint,
}) {
  const { workspaceRoot, jobId } = handle;

  updateJob(workspaceRoot, { id: jobId, phase: "verifying" });
  appendLogLine(workspaceRoot, jobId, "Execution complete, verifying output.");

  // P0: Post-run workspace fingerprint comparison
  const postRunFingerprint = captureWorkspaceFingerprint(workspaceRoot);
  const workspaceChanges = diffWorkspaceFingerprints(preRunFingerprint, postRunFingerprint);

  updateJob(workspaceRoot, { id: jobId, phase: "finalizing" });
  appendLogLine(workspaceRoot, jobId, `Workspace changes observed: ${workspaceChanges.summary}`);

  // Collect model evidence from transcript (best-effort, non-blocking)
  const usageModelKeys = result.usageModelKeys || [];
  const { modelEvidence, routeStatus } = await collectExecutionEvidence({
    sessionId: result.sessionId,
    usageModelKeys,
    routeSnapshot: routeContext.routeSnapshot,
    jobOk: true,
    cancelled: false,
  });

  // Auto-compact deviation recording (spec 4.4): if auto-compact was
  // configured, collect the observed boundary from the transcript and
  // record the deviation. NEVER fabricate — null if not observed.
  let observedBoundary = null;
  let compactTrigger = null;
  if (autoCompactAudit?.settingsInjected === true
    && result.sessionId
    && autoCompactBoundaryCursor) {
    try {
      const boundary = await collectCompactBoundary({
        sessionId: result.sessionId,
        deadlineMs: 500,
        afterCursor: autoCompactBoundaryCursor,
      });
      if (boundary.compacted) {
        observedBoundary = boundary.observedBoundary;
        compactTrigger = boundary.trigger;
      }
    } catch {
      // Best-effort — deviation recording must not affect job success
    }
  }

  // Store full result as separate artifact
  // A successful Provider result can quote or repeat the delegated task.
  // Apply the same task-aware, fail-safe redaction before *any* persistence
  // or MCP presentation, not only on the failure-diagnostics path.
  const taskSafeResult = redactText(
    result.result,
    Number.POSITIVE_INFINITY,
    [task],
    { failSafeShortMarkers: false },
  );
  // Task text may legitimately be short in a successful response, but an
  // opaque credential must always prefer fail-safe redaction. Keep the two
  // marker classes separate so a chunked short credential cannot evade
  // the task-friendly success-path policy above.
  const safeResult = redactText(
    taskSafeResult,
    Number.POSITIVE_INFINITY,
    [task],
  );
  const resultArtifactPath = writeResultArtifact(workspaceRoot, jobId, {
    result: safeResult,
    sessionId: result.sessionId,
    cost: result.cost,
    duration: result.duration,
    usageModelKeys,
    exitCode: result.exitCode,
    requestedModel: routeContext.requestedModel,
    requestMode: routeContext.requestMode,
    selectorKind: routeContext.selectorKind,
    routeSnapshot: routeContext.routeSnapshot,
    routeStatus,
    modelEvidence,
  });

  // Build truncation metadata
  const presentation = truncateForPresentation(safeResult);
  const metadataPresentation = truncateForPresentation(safeResult, MAX_JOB_RESULT_BYTES);
  const truncation = presentation.truncated
    ? { originalSize: presentation.originalSize, presentationLimit: MAX_MCP_RESULT_BYTES }
    : null;

  // Route all terminal status writes through finalizeJob so the per-job
  // lock prevents the completed-vs-cancelled race. If a cancel arrived
  // while we were collecting evidence, finalizeJob writes "cancelled"
  // instead of "completed" (cancelling status takes priority).
  const finalizedJob = finalizeJob(workspaceRoot, jobId, "completed", {
    result: metadataPresentation.text,
    resultArtifact: resultArtifactPath,
    cost: result.cost,
    duration: result.duration,
    modelEvidence,
    routeStatus,
    // The requested --session-id/--resume target is authoritative. Preserve
    // it even if a Provider omits or misreports session_id in its result.
    claudeSessionId: provisionalClaudeSessionId,
    touchedFiles: workspaceChanges.totalChanges > 0
      ? boundedTouchedFiles([...workspaceChanges.added, ...workspaceChanges.modified, ...workspaceChanges.removed])
      : [],
    workspaceChanges: workspaceChanges.totalChanges > 0 ? workspaceChanges.summary : null,
    errorMessage: null,
    truncation,
    autoCompact: autoCompactAudit ? {
      ...autoCompactAudit,
      observedBoundary,
      compactTrigger,
    } : null,
  });

  return {
    finalizedJob,
    workspaceChanges,
    presentation,
    truncation,
    modelEvidence,
    routeStatus,
    safeResult,
    postRunFingerprint,
    observedBoundary,
    compactTrigger,
    resultArtifactPath,
  };
}

async function settleFailure({ handle, result, task, routeContext }) {
  const { workspaceRoot, jobId } = handle;

  // Failure path: compute route status (rejected for non-cancelled failures)
  // and store diagnostics in the private job artifact only.
  const failureStage = result.failureStage || FAILURE_STAGES.PROVIDER_RESPONSE;
  const failedRouteStatus = computeRouteStatus({
    routeSnapshot: routeContext.routeSnapshot,
    jobOk: false,
    cancelled: result.cancelled === true,
    executedModels: [],
    usageModelKeys: result.usageModelKeys || [],
  });
  const safeError = result.cancelled === true
    ? buildSafeErrorMessage(FAILURE_STAGES.CANCELLED, result.error || "Claude task was cancelled.")
    : buildSafeErrorMessage(failureStage, result.error || "Claude task failed.");

  // Store diagnostics in the private result artifact (redacted, bounded)
  const failureArtifactPath = writeResultArtifact(workspaceRoot, jobId, {
    result: null,
    sessionId: result.sessionId || null,
    cost: result.cost ?? null,
    duration: result.duration ?? null,
    usageModelKeys: result.usageModelKeys || [],
    exitCode: result.exitCode,
    requestedModel: routeContext.requestedModel,
    requestMode: routeContext.requestMode,
    selectorKind: routeContext.selectorKind,
    routeSnapshot: routeContext.routeSnapshot,
    routeStatus: failedRouteStatus,
    modelEvidence: {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: result.usageModelKeys || [],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
    diagnostics: redactDiagnosticValue(result.diagnostics, [task]),
    failureStage,
  });

  // Route through finalizeJob for the same race protection as the success
  // path. If a cancel arrived during failure handling, write "cancelled".
  const finalizedJob = finalizeJob(workspaceRoot, jobId, "failed", {
    errorMessage: boundedText(safeError, MAX_ERROR_MESSAGE_BYTES),
    routeStatus: failedRouteStatus,
    resultArtifact: failureArtifactPath,
    truncation: null,
  });

  return { finalizedJob, failureStage, safeError, resultArtifactPath: failureArtifactPath };
}
