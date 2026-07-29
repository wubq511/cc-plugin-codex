/**
 * Continuation planner — evidence-based three-way continuation choice.
 *
 * Decides between `resume`, `compact_resume`, and `fresh_handoff` using the
 * previous round's in-memory token usage. Plans are random UUIDs with a
 * 15-minute TTL and a bounded capacity; they bind parent job/session, cwd,
 * action, and the next round's model/write so consumption can be enforced.
 *
 * Hard constraints:
 *   - Telemetry and plans live ONLY in the current MCP process. Nothing is
 *     written to state, artifacts, or logs. A restart loses token telemetry
 *     and old plan IDs; persisted jobs may still recover an explicitly
 *     requested canonical session before a new plan is issued.
 *   - Incomplete evidence never guesses Compact.
 *   - Cumulative usage is never misrepresented as current context.
 *   - Plans are single-use for Resume/Fresh; Compact+Resume follows
 *     issued → compacted → consumed, each step exactly once.
 *   - Unknown, expired, or mismatched plans fail closed.
 *
 * No filesystem I/O, no subprocess calls — pure in-memory logic.
 */

import { randomUUID } from "node:crypto";

// Re-export the canonical usage-token extractor (defined in the model-evidence
// collector) so tests and callers can import it from the planner module.
export {
  extractContextWindow,
  extractUsageTokens,
} from "./model-evidence-collector.mjs";

// ─── Named, testable provisional constants ───────────────────────────────────

/** Context-pressure ratio at which compaction is considered. */
export const PRESSURE_THRESHOLD = 0.75;

/** Plan time-to-live in milliseconds (15 minutes). */
export const PLAN_TTL_MS = 15 * 60 * 1000;

/** Maximum plans retained in memory before oldest are evicted. */
export const PLAN_MAX_ENTRIES = 256;

/** Action enum. */
export const ACTIONS = Object.freeze({
  RESUME: "resume",
  COMPACT_RESUME: "compact_resume",
  FRESH_HANDOFF: "fresh_handoff",
});

const RELATIONSHIPS = new Set(["same_attempt", "same_goal", "next_step", "unrelated", "unknown"]);
const CONTEXT_VALUES = new Set(["essential", "useful", "reconstructable"]);
const USER_INTENTS = new Set(["auto", "same_session", "fresh"]);
const EVIDENCE_STATES = new Set(["complete", "partial", "unavailable"]);

/** Known Claude CLI aliases — case-insensitive, normalized to lowercase for comparison. */
const KNOWN_ALIASES = new Set(["opus", "fable", "sonnet", "haiku"]);

/**
 * Normalize a model ID for case-insensitive comparison.
 * Known aliases (Opus/Fable/Sonnet/Haiku) are lowercased; native IDs are
 * compared as-is (they are case-sensitive in the CLI). null/empty → null.
 */
function normalizeModelForComparison(model) {
  if (model == null || typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (KNOWN_ALIASES.has(lower)) return lower;
  return trimmed;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export class PlannerError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PlannerError";
    this.code = code || "planner_error";
  }
}

function fail(message, code) {
  return new PlannerError(message, code);
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

function finiteOrNull(v) {
  return Number.isFinite(v) ? v : null;
}

function finitePositiveOrNull(v) {
  return Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * Compute context-pressure ratio.
 * pressure = (input + cacheCreation + cacheRead + output) / contextWindow
 *
 * Returns null when contextWindow is missing/invalid (pressure not computable).
 * The caller supplies only a current-turn usage record selected by the
 * canonical extractor. Multi-turn aggregate billing usage is rejected before
 * reaching this function.
 */
export function computePressure(usage, contextWindow) {
  if (!usage || typeof usage !== "object") return null;
  const cw = finitePositiveOrNull(contextWindow);
  if (cw === null) return null;
  const input = Number(usage.input);
  const cacheCreation = Number(usage.cacheCreation);
  const cacheRead = Number(usage.cacheRead);
  const output = Number(usage.output);
  if (![input, cacheCreation, cacheRead, output].every((v) => Number.isFinite(v) && v >= 0)) {
    return null;
  }
  return (input + cacheCreation + cacheRead + output) / cw;
}

/**
 * Classify evidence completeness.
 *   complete    — all four token fields + contextWindow present and finite
 *   partial     — some evidence present but not all fields are finite
 *   unavailable — no evidence record at all
 */
export function classifyEvidenceState(usage, contextWindow, hasEvidence) {
  if (!hasEvidence) return "unavailable";
  if (!usage || typeof usage !== "object") return "partial";
  const fields = [usage.input, usage.cacheCreation, usage.cacheRead, usage.output];
  const allFinite = fields.every((v) => Number.isFinite(v) && v >= 0);
  const cwFinite = Number.isFinite(contextWindow) && contextWindow > 0;
  if (allFinite && cwFinite) return "complete";
  return "partial";
}

// ─── Plan store (in-memory, per MCP process) ─────────────────────────────────

function isExpired(plan, now = Date.now()) {
  return now > plan.expiresAt;
}

function pruneExpiredAndEnforceCap(plans, now = Date.now()) {
  // Drop expired plans.
  for (const [id, plan] of plans) {
    if (isExpired(plan, now)) plans.delete(id);
  }
  // Enforce capacity cap by evicting oldest by issuedAt.
  if (plans.size > PLAN_MAX_ENTRIES) {
    const sorted = [...plans.entries()].sort((a, b) => a[1].issuedAt - b[1].issuedAt);
    const excess = sorted.slice(0, plans.size - PLAN_MAX_ENTRIES);
    for (const [id] of excess) plans.delete(id);
  }
}

// ─── Bounded handoff / compact focus guidance ────────────────────────────────

const HANDOFF_TEMPLATE = [
  "Objective",
  "<current outcome and scope>",
  "",
  "Current findings",
  "<actionable findings or verification failures>",
  "",
  "Constraints",
  "<still-valid decisions and non-negotiable requirements>",
  "",
  "Acceptance checks",
  "<commands or observable results that must pass>",
  "",
  "Inspect the current workspace and git diff as primary evidence before editing.",
  "Do not paste the full prior transcript, full diff, or verbose logs.",
].join("\n");

const COMPACT_FOCUS = [
  "Compact focus — keep only:",
  "- the current objective",
  "- still-valid decisions",
  "- files touched and their purpose",
  "- acceptance checks",
  "- open/undecided items",
  "Drop verbatim transcripts, raw diffs, and verbose logs from the compacted context.",
].join("\n");

const RESUME_GUIDANCE = "Resume the exact parent session. Do not pass resume flags for a different session; do not start a new session.";

// ─── Planner factory ─────────────────────────────────────────────────────────

/**
 * Create an in-memory planner instance. One instance lives per MCP server
 * process. Restart loses all evidence and plans — by design.
 */
export function createPlanner(options = {}) {
  const now = typeof options.now === "function" ? options.now : Date.now;
  const plans = new Map();    // planId → plan record
  const evidence = new Map(); // parentJobId|parentSession → evidence record

  function recordEvidence(entry) {
    if (!entry || typeof entry !== "object") return;
    const jobId = entry.jobId || null;
    const sessionId = entry.sessionId || null;
    if (!jobId && !sessionId) return;
    const key = jobId || sessionId;
    const usage = entry.usage && typeof entry.usage === "object" ? {
      input: finiteOrNull(entry.usage.input),
      cacheCreation: finiteOrNull(entry.usage.cacheCreation),
      cacheRead: finiteOrNull(entry.usage.cacheRead),
      output: finiteOrNull(entry.usage.output),
    } : null;
    evidence.set(key, {
      jobId,
      sessionId,
      cwd: typeof entry.cwd === "string" ? entry.cwd : null,
      model: entry.model != null ? String(entry.model) : null,
      write: typeof entry.write === "boolean" ? entry.write : null,
      usage,
      contextWindow: finitePositiveOrNull(entry.contextWindow),
      autoCompactTarget: finitePositiveOrNull(entry.autoCompactTarget),
      cliVersion: typeof entry.cliVersion === "string" ? entry.cliVersion : null,
      workspaceFingerprint: entry.workspaceFingerprint instanceof Map
        ? new Map(entry.workspaceFingerprint)
        : null,
      recordedAt: now(),
    });
    // Also index by session so a later plan keyed on parentSession finds it.
    if (sessionId && key !== sessionId) {
      evidence.set(sessionId, evidence.get(key));
    }
  }

  function getEvidence(parentJob, parentSession) {
    const byJob = parentJob && evidence.has(parentJob)
      ? evidence.get(parentJob)
      : null;
    const bySession = parentSession && evidence.has(parentSession)
      ? evidence.get(parentSession)
      : null;
    return byJob || bySession || null;
  }

  function validateInput(input) {
    if (!input || typeof input !== "object") {
      throw fail("Planner input must be an object.", "invalid-input");
    }
    if (typeof input.cwd !== "string" || !input.cwd.trim()) {
      throw fail("cwd is required and must be a non-empty string.", "invalid-cwd");
    }
    if (!USER_INTENTS.has(input.userIntent)) {
      throw fail(`userIntent must be one of ${[...USER_INTENTS].join(", ")}, got ${JSON.stringify(input.userIntent)}.`, "invalid-user-intent");
    }
    if (!RELATIONSHIPS.has(input.relationship)) {
      throw fail(`relationship must be one of ${[...RELATIONSHIPS].join(", ")}, got ${JSON.stringify(input.relationship)}.`, "invalid-relationship");
    }
    if (!CONTEXT_VALUES.has(input.contextValue)) {
      throw fail(`contextValue must be one of ${[...CONTEXT_VALUES].join(", ")}, got ${JSON.stringify(input.contextValue)}.`, "invalid-context-value");
    }
    const cc = input.correctionCount;
    if (!Number.isFinite(cc) || !Number.isInteger(cc) || cc < 0) {
      throw fail(`correctionCount must be a non-negative integer, got ${JSON.stringify(cc)}.`, "invalid-correction-count");
    }
    if (typeof input.allowCompact !== "boolean") {
      throw fail("allowCompact must be a boolean.", "invalid-allow-compact");
    }
    if (input.model !== undefined && input.model !== null && typeof input.model !== "string") {
      throw fail("model must be a string or null.", "invalid-model");
    }
    if (typeof input.write !== "boolean") {
      throw fail("write must be a boolean.", "invalid-write");
    }
  }

  function detectModelDrift(input, ev) {
    if (!ev) return false;
    const nextModel = input.model ?? null;
    // Known aliases are case-insensitive, native IDs are case-sensitive, and
    // explicit ↔ inherited is a real execution-mode change.
    return normalizeModelForComparison(nextModel) !== normalizeModelForComparison(ev.model);
  }

  function planContinuation(input) {
    validateInput(input);

    const currentTime = now();
    pruneExpiredAndEnforceCap(plans, currentTime);

    const jobEvidence = input.parentJob && evidence.has(input.parentJob)
      ? evidence.get(input.parentJob)
      : null;
    const sessionEvidence = input.parentSession && evidence.has(input.parentSession)
      ? evidence.get(input.parentSession)
      : null;
    if (input.parentJob && input.parentSession) {
      if (!jobEvidence && sessionEvidence) {
        throw fail("parentJob does not match the supplied parentSession evidence.", "parent-mismatch");
      }
      if (jobEvidence?.sessionId && jobEvidence.sessionId !== input.parentSession) {
        throw fail("parentJob and parentSession identify different sessions.", "parent-mismatch");
      }
      if (jobEvidence && sessionEvidence && jobEvidence !== sessionEvidence) {
        throw fail("parentJob and parentSession resolve to different evidence.", "parent-mismatch");
      }
    }
    const ev = jobEvidence || sessionEvidence || null;
    if (ev?.cwd && ev.cwd !== input.cwd) {
      throw fail("Parent evidence belongs to a different workspace.", "evidence-cwd-mismatch");
    }
    const hasEvidence = ev !== null;
    const pressure = ev ? computePressure(ev.usage, ev.contextWindow) : null;
    const evidenceState = classifyEvidenceState(ev?.usage, ev?.contextWindow, hasEvidence);
    const reliablePressure = evidenceState === "complete" && pressure !== null;

    // A lower existing autoCompact threshold takes precedence over the 0.75
    // provisional constant. The implicit autoCompact ratio is
    // targetTokens / contextWindowTokens; if it is lower, use it instead.
    const autoCompactRatio = (ev?.autoCompactTarget && ev?.contextWindow
      && ev.autoCompactTarget > 0 && ev.contextWindow > 0)
      ? ev.autoCompactTarget / ev.contextWindow
      : null;
    const effectiveThreshold = (autoCompactRatio !== null && autoCompactRatio < PRESSURE_THRESHOLD)
      ? autoCompactRatio
      : PRESSURE_THRESHOLD;
    const highPressure = reliablePressure && pressure >= effectiveThreshold;
    const cacheRead = ev?.usage?.cacheRead;
    const warmCache = Number.isFinite(cacheRead) && cacheRead > 0;

    // Caller-supplied drift signals (workspace/cli/tool) plus auto model drift.
    const drift = input.drift && typeof input.drift === "object" ? input.drift : {};
    const modelDrift = detectModelDrift(input, ev);
    const toolProfileDrift = Boolean(
      ev && typeof ev.write === "boolean" && ev.write !== input.write,
    );
    const anyDrift = Boolean(drift.workspace)
      || Boolean(drift.cli)
      || Boolean(drift.tool)
      || modelDrift
      || toolProfileDrift;
    const sessionPollution = Boolean(input.sessionPollution);

    const reasonCodes = [];
    let action;
    let fallbackAction;

    const nextModel = input.model ?? null;

    // 1. Explicit fresh.
    if (input.userIntent === "fresh") {
      action = ACTIONS.FRESH_HANDOFF;
      fallbackAction = ACTIONS.FRESH_HANDOFF;
      reasonCodes.push("explicit-fresh");
    }
    // 2. Explicit same_session — never Fresh.
    else if (input.userIntent === "same_session") {
      fallbackAction = ACTIONS.RESUME;
      if (reliablePressure && highPressure && warmCache && input.allowCompact) {
        action = ACTIONS.COMPACT_RESUME;
        reasonCodes.push("explicit-same-session", "high-pressure", "warm-cache", "compact-allowed");
      } else {
        action = ACTIONS.RESUME;
        reasonCodes.push("explicit-same-session");
        if (!reliablePressure) reasonCodes.push("pressure-unreliable");
        else if (!highPressure) reasonCodes.push("pressure-not-high");
        else if (!warmCache) reasonCodes.push("cold-cache");
        else if (!input.allowCompact) reasonCodes.push("compact-not-allowed");
      }
    }
    // 3. auto intent.
    else {
      fallbackAction = ACTIONS.FRESH_HANDOFF;

      // Fresh triggers.
      const freshReasons = [];
      if (input.correctionCount >= 2) freshReasons.push("repeated-corrections");
      if (["next_step", "unrelated", "unknown"].includes(input.relationship)) {
        freshReasons.push(`relationship-${input.relationship}`);
      }
      if (input.contextValue === "reconstructable") freshReasons.push("context-reconstructable");
      if (anyDrift) freshReasons.push("drift-detected");
      if (sessionPollution) freshReasons.push("session-pollution");

      // Resume signals.
      const resumeReasons = [];
      if (["same_attempt", "same_goal"].includes(input.relationship)) {
        resumeReasons.push(`relationship-${input.relationship}`);
      }
      if (input.correctionCount <= 1) resumeReasons.push("early-correction");
      if (["essential", "useful"].includes(input.contextValue)) {
        resumeReasons.push(`context-${input.contextValue}`);
      }

      // Process-restart default: no evidence → Fresh.
      if (!hasEvidence) {
        action = ACTIONS.FRESH_HANDOFF;
        reasonCodes.push("no-evidence-restart-default");
      } else if (freshReasons.length > 0) {
        action = ACTIONS.FRESH_HANDOFF;
        reasonCodes.push(...freshReasons);
      } else if (resumeReasons.length > 0) {
        // Within the resume band, consider compaction.
        if (reliablePressure && highPressure && warmCache && input.allowCompact) {
          action = ACTIONS.COMPACT_RESUME;
          reasonCodes.push("high-pressure", "warm-cache", "compact-allowed", ...resumeReasons);
          fallbackAction = ACTIONS.RESUME;
        } else if (reliablePressure && highPressure && !warmCache) {
          // High-pressure cold cache: essential → Resume, else Fresh.
          if (input.contextValue === "essential") {
            action = ACTIONS.RESUME;
            reasonCodes.push("high-pressure-cold-cache", "context-essential", ...resumeReasons);
            fallbackAction = ACTIONS.FRESH_HANDOFF;
          } else {
            action = ACTIONS.FRESH_HANDOFF;
            reasonCodes.push("high-pressure-cold-cache", "context-not-essential", ...resumeReasons);
          }
        } else {
          action = ACTIONS.RESUME;
          reasonCodes.push(...resumeReasons);
          if (reliablePressure && !highPressure) reasonCodes.push("pressure-below-threshold");
        }
      } else {
        // No strong resume signal and no fresh trigger — default Fresh.
        action = ACTIONS.FRESH_HANDOFF;
        reasonCodes.push("default-fresh");
      }
    }

    // Incomplete evidence must never guess Compact.
    if (action === ACTIONS.COMPACT_RESUME && evidenceState !== "complete") {
      action = ACTIONS.RESUME;
      reasonCodes.push("evidence-incomplete-no-compact");
      fallbackAction = ACTIONS.RESUME;
    }

    // Create and store the plan.
    const planId = `plan_${randomUUID()}`;
    const parentSession = ev?.sessionId || input.parentSession || null;
    if ((action === ACTIONS.RESUME || action === ACTIONS.COMPACT_RESUME) && !parentSession) {
      throw fail(
        "The selected action requires a resolvable parent session.",
        "parent-session-required",
      );
    }
    const plan = {
      planId,
      parentJob: ev?.jobId || input.parentJob || null,
      parentSession,
      cwd: input.cwd,
      action,
      model: nextModel,
      write: input.write,
      issuedAt: currentTime,
      expiresAt: currentTime + PLAN_TTL_MS,
      // Resume/Fresh consumption.
      consumed: false,
      // Compact+Resume lifecycle: issued → compacted → consumed (each once).
      compactIssued: false,
      compactCompacted: false,
      compactConsumed: false,
      compactHadBoundary: false,
      compactFailed: false,
    };
    plans.set(planId, plan);
    pruneExpiredAndEnforceCap(plans, currentTime);

    const response = {
      action,
      planId,
      reasonCodes,
      evidenceState,
      fallbackAction,
      pressure: reliablePressure ? Number(pressure.toFixed(6)) : null,
      pressureThreshold: effectiveThreshold,
      planExpiresAt: new Date(plan.expiresAt).toISOString(),
    };
    if (action === ACTIONS.FRESH_HANDOFF) {
      response.handoffTemplate = HANDOFF_TEMPLATE;
    } else if (action === ACTIONS.COMPACT_RESUME) {
      response.compactFocus = COMPACT_FOCUS;
    } else {
      response.resumeGuidance = RESUME_GUIDANCE;
    }
    return response;
  }

  // ── Delegate plan consumption (Resume / Fresh / post-compact Resume) ──

  function consumeDelegatePlan(planId, opts = {}) {
    const plan = plans.get(planId);
    if (!plan) throw fail("Continuation plan not found. Re-run cc_plan_continuation.", "plan-not-found");
    if (isExpired(plan, now())) {
      plans.delete(planId);
      throw fail("Continuation plan has expired. Re-run cc_plan_continuation.", "plan-expired");
    }

    const cwd = opts.cwd || null;
    const model = opts.model ?? null;
    const write = typeof opts.write === "boolean" ? opts.write : null;
    const resume = opts.resume === true;
    const resumeSession = opts.resumeSession || null;

    // Binding checks.
    if (plan.cwd && cwd && plan.cwd !== cwd) {
      throw fail("continuationPlan cwd does not match this delegation.", "cwd-mismatch");
    }
    // Model comparison is case-insensitive for known aliases (Opus == opus)
    // and case-sensitive for native IDs — matching the CLI's own semantics.
    if (normalizeModelForComparison(model) !== normalizeModelForComparison(plan.model)) {
      throw fail("continuationPlan model does not match this delegation.", "model-mismatch");
    }
    if (write !== null && write !== plan.write) {
      throw fail("continuationPlan write does not match this delegation.", "write-mismatch");
    }

    if (plan.action === ACTIONS.FRESH_HANDOFF) {
      if (plan.consumed) throw fail("Fresh plan already consumed.", "plan-already-consumed");
      if (resume || resumeSession) {
        throw fail("Fresh handoff plan forbids resume flags. Start a new session without resume.", "fresh-forbids-resume");
      }
      plan.consumed = true;
      return { action: ACTIONS.FRESH_HANDOFF, parentSession: null };
    }

    if (plan.action === ACTIONS.RESUME) {
      if (plan.consumed) throw fail("Resume plan already consumed.", "plan-already-consumed");
      const expectedSession = plan.parentSession;
      if (!expectedSession) {
        throw fail("Resume plan has no parent session bound.", "plan-no-parent-session");
      }
      // Resume must target the exact parent session.
      if (resumeSession && resumeSession !== expectedSession) {
        throw fail("Resume plan requires the exact parent session.", "resume-session-mismatch");
      }
      plan.consumed = true;
      // If this plan was originally a compact_resume that fell back to resume
      // (compact produced no new boundary), mark compactConsumed for consistency
      // so inspectPlan reflects a coherent terminal state.
      if (plan.compactCompacted && !plan.compactConsumed) {
        plan.compactConsumed = true;
      }
      return { action: ACTIONS.RESUME, parentSession: expectedSession };
    }

    if (plan.action === ACTIONS.COMPACT_RESUME) {
      if (plan.compactConsumed) throw fail("Compact+Resume plan already consumed.", "plan-already-consumed");
      if (plan.compactFailed) {
        throw fail("Compact failed for this plan; re-run cc_plan_continuation to re-plan.", "compact-failed-replan");
      }
      if (!plan.compactCompacted) {
        throw fail("Compact has not completed for this plan. Run cc_compact with this continuationPlan first.", "compact-not-completed");
      }
      const expectedSession = plan.parentSession;
      if (!expectedSession) {
        throw fail("Compact+Resume plan has no parent session bound.", "plan-no-parent-session");
      }
      if (resumeSession && resumeSession !== expectedSession) {
        throw fail("Compact+Resume plan requires the exact parent session.", "resume-session-mismatch");
      }
      plan.compactConsumed = true;
      return { action: ACTIONS.COMPACT_RESUME, parentSession: expectedSession, compactHadBoundary: plan.compactHadBoundary };
    }

    throw fail(`Unknown plan action: ${plan.action}.`, "unknown-action");
  }

  // ── Compact lifecycle: issued → compacted → consumed ──

  function startCompact(planId, opts = {}) {
    const plan = plans.get(planId);
    if (!plan) throw fail("Continuation plan not found.", "plan-not-found");
    if (isExpired(plan, now())) {
      plans.delete(planId);
      throw fail("Continuation plan has expired.", "plan-expired");
    }
    if (plan.action !== ACTIONS.COMPACT_RESUME) {
      throw fail("continuationPlan is not a compact_resume plan.", "plan-not-compact-resume");
    }
    if (plan.compactFailed) {
      throw fail("Compact already failed for this plan; re-plan.", "compact-failed-replan");
    }
    if (plan.compactConsumed) {
      throw fail("Plan already consumed by a resume delegation.", "plan-already-consumed");
    }
    if (plan.compactIssued) {
      throw fail("Compact already issued for this plan.", "compact-already-issued");
    }
    if (opts.cwd !== plan.cwd) {
      throw fail("continuationPlan cwd does not match this compact invocation.", "cwd-mismatch");
    }
    if (opts.parentSession !== plan.parentSession) {
      throw fail("continuationPlan requires compacting the exact parent session.", "resume-session-mismatch");
    }
    plan.compactIssued = true;
    return { planId, parentSession: plan.parentSession };
  }

  function completeCompact(planId, opts = {}) {
    const plan = plans.get(planId);
    if (!plan) throw fail("Continuation plan not found.", "plan-not-found");
    if (isExpired(plan, now())) {
      plans.delete(planId);
      throw fail("Continuation plan has expired.", "plan-expired");
    }
    if (plan.compactFailed) {
      throw fail("Compact already failed for this plan; re-run cc_plan_continuation to re-plan.", "compact-failed-replan");
    }
    if (!plan.compactIssued) {
      throw fail("Compact was not issued for this plan.", "compact-not-issued");
    }
    if (plan.compactCompacted) {
      throw fail("Compact already marked compacted.", "compact-already-compacted");
    }
    const ok = opts.ok === true;
    const hasNewBoundary = opts.hasNewBoundary === true;
    if (ok && hasNewBoundary) {
      plan.compactCompacted = true;
      plan.compactHadBoundary = true;
      return { planId, compacted: true, hadBoundary: true, action: plan.action };
    }
    if (ok && !hasNewBoundary) {
      // Compact ran but produced no new boundary. The plan may continue as a
      // Resume bound to the original session.
      plan.compactCompacted = true;
      plan.compactHadBoundary = false;
      plan.action = ACTIONS.RESUME;
      return { planId, compacted: false, hadBoundary: false, action: ACTIONS.RESUME, fallbackToResume: true };
    }
    // Compact failed — plan is invalid; caller must re-plan.
    plan.compactFailed = true;
    return { planId, compacted: false, hadBoundary: false, action: plan.action, failed: true };
  }

  function inspectPlan(planId) {
    const plan = plans.get(planId);
    if (!plan) return null;
    return {
      planId: plan.planId,
      action: plan.action,
      parentJob: plan.parentJob,
      parentSession: plan.parentSession,
      cwd: plan.cwd,
      model: plan.model,
      write: plan.write,
      consumed: plan.consumed,
      compactIssued: plan.compactIssued,
      compactCompacted: plan.compactCompacted,
      compactConsumed: plan.compactConsumed,
      compactHadBoundary: plan.compactHadBoundary,
      compactFailed: plan.compactFailed,
      issuedAt: plan.issuedAt,
      expiresAt: plan.expiresAt,
      expired: isExpired(plan, now()),
    };
  }

  function clear() {
    plans.clear();
    evidence.clear();
  }

  return {
    recordEvidence,
    planContinuation,
    consumeDelegatePlan,
    startCompact,
    completeCompact,
    inspectPlan,
    getEvidence,
    clear,
    // Test/inspection helpers (no mutation).
    _planCount: () => plans.size,
    _evidenceCount: () => evidence.size,
  };
}
