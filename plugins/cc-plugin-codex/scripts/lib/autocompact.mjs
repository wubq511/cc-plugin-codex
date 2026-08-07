/**
 * Auto-compact policy: validation, computation, and scope resolution.
 *
 * The auto-compact feature injects two env keys via Claude CLI's inline
 * `--settings <json>` flag. It NEVER writes to `~/.claude/**`, project
 * `.claude/`, or the parent `process.env`. The settings JSON contains
 * only the two compact env keys — no secrets, no full configuration.
 *
 * Three layers of evidence are distinguished:
 *   - requestedTarget: the user-supplied targetTokens (nominal, not a guarantee)
 *   - effectiveWindow: the computed ceil(target / 0.9) injected via settings
 *   - observedBoundary: what was actually observed from the transcript (may be null)
 *
 * The plugin never claims precise target hit. Claude may truncate the window,
 * skip a turn, or a managed policy may override — causing early or offset
 * compaction.
 */

import crypto from "node:crypto";
import { jobMatchesClaudeSession } from "./state.mjs";

/** Fixed percentage for auto-compact. */
export const AUTO_COMPACT_PCT = 90;

/** Allowed scope values. */
const VALID_SCOPES = new Set(["delegation", "session", "task"]);

/** Allowed fields in the autoCompact object. */
const ALLOWED_FIELDS = new Set([
  "contextWindowTokens",
  "targetTokens",
  "scope",
  "taskScopeId",
  "clear",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Compute the effective window: ceil(targetTokens / (pct/100)).
 *
 * @param {number} targetTokens - The user-supplied nominal target.
 * @param {number} [pct=AUTO_COMPACT_PCT] - The fixed percentage.
 * @returns {number} The effective window to inject via --settings.
 */
export function computeEffectiveWindow(targetTokens, pct = AUTO_COMPACT_PCT) {
  return Math.ceil(targetTokens / (pct / 100));
}

/**
 * Validate an autoCompact configuration object.
 *
 * Rules (hard constraints):
 *   - contextWindowTokens: positive integer (user-declared, unverified).
 *     Required for full policy; omitted in inheritance-only mode.
 *   - targetTokens: positive integer, must be <= floor(contextWindowTokens * 0.9).
 *     Required for full policy; omitted in inheritance-only mode.
 *   - scope: enum delegation|session|task, default delegation.
 *   - taskScopeId: UUID string | undefined.
 *     - undefined (omitted): for task scope, a new ID is generated.
 *     - string: use this ID for inheritance/continuity.
 *   - clear: only literal true is accepted, and only for
 *     {scope:"task", taskScopeId:<uuid>, clear:true} with no context/target.
 *   - No unknown fields allowed.
 *
 * Inheritance-only mode: when contextWindowTokens AND targetTokens are both
 * omitted but taskScopeId is a string, the policy is inherited from a previous
 * job with the same taskScopeId.
 *
 * @returns {{valid: boolean, error?: string, scope?: string, contextWindowTokens?: number|null, targetTokens?: number|null, effectiveWindow?: number|null, taskScopeId?: string|undefined, inheritanceMode?: boolean, clearMode?: boolean}}
 */
export function validateAutoCompact(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "autoCompact must be an object." };
  }

  // Reject unknown fields
  for (const key of Object.keys(input)) {
    if (!ALLOWED_FIELDS.has(key)) {
      return { valid: false, error: `Unknown autoCompact field "${key}".` };
    }
  }

  const {
    contextWindowTokens,
    targetTokens,
    scope: rawScope,
    taskScopeId,
    clear,
  } = input;

  // Determine if this is an inheritance-only request (taskScopeId without context/target)
  const hasContextTarget = contextWindowTokens !== undefined || targetTokens !== undefined;

  if (clear !== undefined && clear !== true) {
    return { valid: false, error: "autoCompact.clear, when provided, must be true." };
  }

  if (hasContextTarget) {
    // Full policy — validate context/target
    if (contextWindowTokens == null || !Number.isSafeInteger(contextWindowTokens) || contextWindowTokens <= 0) {
      return { valid: false, error: "autoCompact.contextWindowTokens must be a positive safe integer." };
    }
    if (targetTokens == null || !Number.isSafeInteger(targetTokens) || targetTokens <= 0) {
      return { valid: false, error: "autoCompact.targetTokens must be a positive safe integer." };
    }
    const maxTarget = Math.floor(contextWindowTokens * (AUTO_COMPACT_PCT / 100));
    if (targetTokens > maxTarget) {
      return {
        valid: false,
        error: `autoCompact.targetTokens (${targetTokens}) must be <= ${AUTO_COMPACT_PCT}% of contextWindowTokens (${contextWindowTokens}), i.e. <= ${maxTarget}.`,
      };
    }
  }

  // Validate scope
  const scope = rawScope ?? "delegation";
  if (!VALID_SCOPES.has(scope)) {
    return { valid: false, error: `autoCompact.scope must be one of [delegation, session, task], got "${rawScope}".` };
  }

  // A null task ID cannot identify which persisted task policy to clear.
  if (taskScopeId === null) {
    return {
      valid: false,
      error: "autoCompact.taskScopeId must be a UUID; omit it on a full task policy to generate a new ID.",
    };
  }
  if (taskScopeId !== undefined && (typeof taskScopeId !== "string" || !UUID_RE.test(taskScopeId))) {
    return { valid: false, error: "autoCompact.taskScopeId must be a UUID string." };
  }

  if (clear === true) {
    if (hasContextTarget) {
      return {
        valid: false,
        error: "autoCompact.clear cannot be combined with contextWindowTokens or targetTokens.",
      };
    }
    if (scope !== "task" || !taskScopeId) {
      return {
        valid: false,
        error: "autoCompact.clear requires scope=\"task\" and a taskScopeId UUID.",
      };
    }
    return {
      valid: true,
      scope: "task",
      contextWindowTokens: null,
      targetTokens: null,
      effectiveWindow: null,
      taskScopeId,
      inheritanceMode: false,
      clearMode: true,
    };
  }

  if (!hasContextTarget) {
    if (!taskScopeId || (rawScope !== undefined && rawScope !== "task")) {
      return {
        valid: false,
        error: "Task policy inheritance requires scope=\"task\" and a taskScopeId UUID.",
      };
    }
    return {
      valid: true,
      scope: "task",
      contextWindowTokens: null,
      targetTokens: null,
      effectiveWindow: null,
      taskScopeId,
      inheritanceMode: true,
      clearMode: false,
    };
  }

  if (scope !== "task" && taskScopeId !== undefined) {
    return {
      valid: false,
      error: "autoCompact.taskScopeId is only valid when scope is \"task\".",
    };
  }

  const effectiveWindow = computeEffectiveWindow(targetTokens);
  return {
    valid: true,
    scope,
    contextWindowTokens,
    targetTokens,
    effectiveWindow,
    taskScopeId,
    inheritanceMode: false,
    clearMode: false,
  };
}

/**
 * Build the inline --settings JSON string.
 *
 * Contains ONLY two env keys:
 *   CLAUDE_CODE_AUTO_COMPACT_WINDOW: <effectiveWindow>
 *   CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "90"
 *
 * No secrets, no full configuration, no other settings.
 *
 * @param {number} effectiveWindow - The computed effective window.
 * @returns {string} JSON string suitable for `--settings <json>`.
 */
export function buildInlineSettings(effectiveWindow) {
  return JSON.stringify({
    env: {
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(effectiveWindow),
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(AUTO_COMPACT_PCT),
    },
  });
}

/**
 * Resolve the effective auto-compact policy from multiple scope layers.
 *
 * Priority (high → low): this-call explicit value > session > task > none.
 *
 * @param {object} opts
 * @param {object|null} opts.thisCall - The autoCompact from this cc_delegate call.
 * @param {object|null} opts.sessionPolicy - The persisted session-scope policy.
 * @param {object|null} opts.taskPolicy - The persisted task-scope policy.
 * @param {boolean} [opts.clearTaskScope] - If true, this-call explicitly clears the task scope.
 * @returns {object|null} The resolved policy, or null if no policy applies.
 */
export function resolveScope({ thisCall, sessionPolicy, taskPolicy, clearTaskScope }) {
  // This-call explicit value wins
  if (thisCall) {
    return thisCall;
  }

  // Explicit null with clearTaskScope means "no autoCompact for this delegation"
  if (clearTaskScope) {
    return null;
  }

  // Session policy
  if (sessionPolicy) {
    return sessionPolicy;
  }

  // Task policy
  if (taskPolicy) {
    return taskPolicy;
  }

  return null;
}

/**
 * Generate a new task scope ID (UUID v4).
 *
 * @returns {string}
 */
export function generateTaskScopeId() {
  return crypto.randomUUID();
}

/**
 * Build the non-sensitive audit fields for the job record.
 *
 * No secrets, no full settings JSON, no parent env snapshot.
 *
 * @param {object} validated - The validated autoCompact policy.
 * @param {boolean} settingsInjected - Whether --settings was passed.
 * @returns {object} Audit fields suitable for job state.
 */
export function buildAutoCompactAudit(validated, settingsInjected) {
  return {
    scope: validated.scope,
    contextWindowTokens: validated.contextWindowTokens,
    targetTokens: validated.targetTokens,
    effectiveWindow: validated.effectiveWindow,
    // Normalize undefined → null so the field is always present in persisted state.
    taskScopeId: validated.taskScopeId ?? null,
    settingsInjected,
    cleared: false,
  };
}

/**
 * Build a non-sensitive clear tombstone. Tombstones are stored in job history
 * so a later lookup cannot resurrect an older session/task policy.
 */
export function buildAutoCompactClearAudit({ scope, taskScopeId = null }) {
  return {
    scope,
    contextWindowTokens: null,
    targetTokens: null,
    effectiveWindow: null,
    taskScopeId,
    settingsInjected: false,
    cleared: true,
  };
}

// ─── Cross-Job Policy Resolution ────────────────────────────────────────────

/**
 * Sort policy-bearing job records newest first by creation time.
 *
 * Policy "newness" is creation order (createdAt, falling back to startedAt),
 * tie-broken by job id. Deliberately not state.mjs's sortJobsNewestFirst,
 * which sorts by updatedAt — a job is updated at settlement, which must not
 * reorder policy records.
 */
function sortPolicyRecordsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => {
    const byCreated = String(b.createdAt ?? b.startedAt ?? "")
      .localeCompare(String(a.createdAt ?? a.startedAt ?? ""));
    return byCreated || String(b.id ?? "").localeCompare(String(a.id ?? ""));
  });
}

/**
 * Newest job record carrying a task-scope policy for a taskScopeId.
 */
function latestTaskPolicyRecord(jobs, taskScopeId) {
  if (!taskScopeId) return null;
  return sortPolicyRecordsNewestFirst(jobs).find((job) =>
    job.autoCompact?.scope === "task"
    && job.autoCompact?.taskScopeId === taskScopeId
  ) || null;
}

/**
 * Resolve the stored policy for an exact Claude session. A newer session
 * tombstone blocks older session and task policies. Otherwise session scope
 * wins over the task policy associated with that session.
 *
 * @returns {{policy: object|null, sourceJob: object|null, cleared: boolean}}
 */
function resolveStoredPolicy(jobs, sessionId) {
  const matching = sortPolicyRecordsNewestFirst(jobs).filter((job) =>
    jobMatchesClaudeSession(job, sessionId)
  );
  const sessionRecord = matching.find((job) => job.autoCompact?.scope === "session") || null;
  if (sessionRecord?.autoCompact?.cleared === true) {
    return { policy: null, sourceJob: sessionRecord, cleared: true };
  }

  const sessionPolicy = sessionRecord?.autoCompact || null;
  const taskScopeId = matching.find((job) =>
    job.autoCompact?.scope === "task" && job.autoCompact?.taskScopeId
  )?.autoCompact?.taskScopeId || null;
  const taskRecord = latestTaskPolicyRecord(jobs, taskScopeId);
  const taskPolicy = taskRecord?.autoCompact?.cleared === true
    ? null
    : taskRecord?.autoCompact || null;

  const policy = resolveScope({
    thisCall: null,
    sessionPolicy,
    taskPolicy,
    clearTaskScope: false,
  });
  const sourceJob = policy === sessionPolicy ? sessionRecord : taskRecord;
  return { policy, sourceJob: sourceJob || null, cleared: false };
}

/**
 * Replay a stored audit back into a validated policy, or null when cleared or
 * no longer valid.
 */
function rebuildStoredPolicy(policy) {
  if (!policy || policy.cleared === true) return null;
  const validated = validateAutoCompact({
    contextWindowTokens: policy.contextWindowTokens,
    targetTokens: policy.targetTokens,
    scope: policy.scope,
    ...(policy.scope === "task" && policy.taskScopeId
      ? { taskScopeId: policy.taskScopeId }
      : {}),
  });
  return validated.valid ? validated : null;
}

/**
 * Resolve the auto-compact decision for a cc_delegate invocation.
 *
 * Handles every request shape:
 *   - object: explicit policy — clear (task), inheritance (task), or full policy
 *   - null with a resumeSession: session clear tombstone
 *   - undefined with a resumeSession: replay the stored session/task policy
 *   - undefined without a resumeSession: no policy
 *
 * @param {object} opts
 * @param {object|null|undefined} opts.request - The cc_delegate autoCompact parameter.
 * @param {object[]} opts.jobs - All job records (listJobs result).
 * @param {string|null} [opts.resumeSession] - The resolved resume session, if any.
 * @returns {{settings: string|null, audit: object|null, error: string|null}}
 *   - settings: inline --settings JSON to inject (or null).
 *   - audit: non-sensitive fields to persist (or null).
 *   - error: fail-closed message body; the caller prefixes "Error: ".
 */
export function resolveDelegateAutoCompact({ request, jobs, resumeSession = null }) {
  if (request !== undefined && request !== null) {
    const acValidation = validateAutoCompact(request);
    if (!acValidation.valid) {
      return { settings: null, audit: null, error: acValidation.error };
    }

    if (acValidation.clearMode) {
      const previous = latestTaskPolicyRecord(jobs, acValidation.taskScopeId);
      if (!previous?.autoCompact) {
        return {
          settings: null,
          audit: null,
          error: `no autoCompact task policy was found for taskScopeId ${acValidation.taskScopeId}; nothing was cleared.`,
        };
      }
      return {
        settings: null,
        audit: buildAutoCompactClearAudit({
          scope: "task",
          taskScopeId: acValidation.taskScopeId,
        }),
        error: null,
      };
    }

    if (acValidation.inheritanceMode) {
      const previous = latestTaskPolicyRecord(jobs, acValidation.taskScopeId);
      if (!previous?.autoCompact || previous.autoCompact.cleared === true) {
        return {
          settings: null,
          audit: null,
          error: `no active autoCompact task policy was found for taskScopeId ${acValidation.taskScopeId}. Supply a full task policy to create or reactivate it.`,
        };
      }
      const inherited = rebuildStoredPolicy(previous.autoCompact);
      if (!inherited) {
        return {
          settings: null,
          audit: null,
          error: `the stored autoCompact task policy for taskScopeId ${acValidation.taskScopeId} is invalid and cannot be replayed.`,
        };
      }
      return {
        settings: buildInlineSettings(inherited.effectiveWindow),
        audit: buildAutoCompactAudit(inherited, true),
        error: null,
      };
    }

    // Full policy. A task-scope policy without an explicit id gets a fresh one.
    let policy = acValidation;
    if (policy.scope === "task" && policy.taskScopeId === undefined) {
      policy = { ...policy, taskScopeId: generateTaskScopeId() };
    }
    return {
      settings: buildInlineSettings(policy.effectiveWindow),
      audit: buildAutoCompactAudit(policy, true),
      error: null,
    };
  }

  // No explicit autoCompact request.
  if (!resumeSession) {
    return { settings: null, audit: null, error: null };
  }

  if (request === null) {
    // Explicit null on a resume clears the session policy.
    return {
      settings: null,
      audit: buildAutoCompactClearAudit({ scope: "session" }),
      error: null,
    };
  }

  // Undefined on a resume replays the stored session/task policy.
  const stored = resolveStoredPolicy(jobs, resumeSession);
  const replay = rebuildStoredPolicy(stored.policy);
  if (!replay) {
    return { settings: null, audit: null, error: null };
  }
  return {
    settings: buildInlineSettings(replay.effectiveWindow),
    audit: buildAutoCompactAudit(replay, true),
    error: null,
  };
}

/**
 * Resolve the auto-compact replay for a read-only cc_compact invocation.
 *
 * Replays the stored session/task policy (delegation scope and clear
 * tombstones are not replayed). A missing or cleared policy silently yields
 * no settings — compaction proceeds without auto-compact.
 *
 * @param {object} opts
 * @param {object[]} opts.jobs - All job records (listJobs result).
 * @param {string} opts.sessionId - The exact Claude session to compact.
 * @returns {{settings: string|null, sourceJob: object|null, policy: object|null}}
 *   - settings: inline --settings JSON to inject (or null).
 *   - sourceJob: the job record carrying the replayed policy (or null).
 *   - policy: the replayed, re-validated policy (or null) — e.g. its
 *     targetTokens/effectiveWindow feed the compact result evidence.
 */
export function replayStoredAutoCompact({ jobs, sessionId }) {
  const stored = resolveStoredPolicy(jobs, sessionId);
  const replay = rebuildStoredPolicy(stored.policy);
  return {
    settings: replay ? buildInlineSettings(replay.effectiveWindow) : null,
    sourceJob: stored.sourceJob,
    policy: replay,
  };
}
