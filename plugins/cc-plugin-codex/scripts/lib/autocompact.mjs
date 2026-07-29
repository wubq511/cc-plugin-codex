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
