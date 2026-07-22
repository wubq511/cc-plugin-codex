/**
 * Model evidence formatter — unified display for delegate/check/list/review.
 *
 * Provides consistent terminology across all display surfaces:
 *   - "Requested model" (explicit override) or "Model request: inherited"
 *   - "Claude-recorded execution model" (from transcript)
 *   - "Provider usage key" (from final JSON modelUsage)
 *
 * All model IDs are re-sanitized at the output boundary:
 *   - normalizeModelIdForStorage: strip control chars, truncate
 *   - escapeModelIdForMarkdown: escape pipe/backtick for safe display
 *   - Never fall back to unsanitized original; invalid → "(invalid)"
 *
 * Untrusted persisted data (scopes, status, warnings) is validated
 * against known enums; unknown values are replaced with safe placeholders.
 */

import {
  WARNINGS,
  KNOWN_SCOPES,
  KNOWN_STATUSES,
} from "./model-evidence-shared.mjs";

import {
  normalizeModelIdForStorage,
  escapeModelIdForMarkdown,
} from "./model-evidence-shared.mjs";

// ─── Output-boundary sanitization ────────────────────────────────────────────

/**
 * Sanitize a model ID for safe Markdown output.
 * Two-step: normalize (strip control chars, truncate) then escape (Markdown).
 * Never returns the unsanitized original.
 */
function safeModelIdForDisplay(modelId) {
  const normalized = normalizeModelIdForStorage(modelId);
  if (!normalized) return "(invalid)";
  return escapeModelIdForMarkdown(normalized);
}

/**
 * Validate a scope against known values.
 * Unknown scopes are replaced with "unknown-scope".
 */
function safeScope(scope) {
  if (KNOWN_SCOPES.has(scope)) return scope;
  return "unknown-scope";
}

/**
 * Validate status against known values.
 */
function safeStatus(status) {
  if (KNOWN_STATUSES.has(status)) return status;
  return "unknown";
}

// ─── Unified Formatter ──────────────────────────────────────────────────────

/**
 * Format model evidence for display surfaces.
 * Returns a consistent string for delegate/check/list/review output.
 *
 * @param {object} options
 * @param {string|null} options.requestedModel - User's explicit model override
 * @param {string} options.requestMode - 'explicit' or 'inherited'
 * @param {object} options.modelEvidence - The modelEvidence structure
 * @param {object|null} options.routeSnapshot - Non-secret route snapshot (v5)
 * @param {string|null} options.routeStatus - Route status (v5)
 * @param {string|null} options.selectorKind - Selector kind (v5)
 * @returns {string} Formatted model evidence lines
 */
export function formatModelEvidence({ requestedModel, requestMode, modelEvidence, routeSnapshot, routeStatus, selectorKind }) {
  if (!modelEvidence) {
    // Legacy/fallback — should not happen in v4 but be safe
    if (requestedModel) {
      return `**Requested model:** ${safeModelIdForDisplay(requestedModel)}`;
    }
    return `**Model request:** inherited from Claude Code configuration`;
  }

  const lines = [];

  // Request line — show selector kind when available (v5)
  if (selectorKind === "alias" && requestedModel) {
    lines.push(`**Requested model:** ${safeModelIdForDisplay(requestedModel)} (alias)`);
  } else if (selectorKind === "native" && requestedModel) {
    lines.push(`**Requested model:** ${safeModelIdForDisplay(requestedModel)} (native ID)`);
  } else if (requestMode === "explicit" && requestedModel) {
    lines.push(`**Requested model:** ${safeModelIdForDisplay(requestedModel)}`);
  } else {
    lines.push(`**Model request:** inherited from Claude Code configuration`);
  }

  // Route snapshot — non-secret configuration claim (v5)
  if (routeSnapshot && routeSnapshot.profileIdentity) {
    const aliasClaim = routeSnapshot.aliasClaim
      ? ` — alias claim: ${escapeModelIdForMarkdown(routeSnapshot.aliasClaim.alias)} → ${safeModelIdForDisplay(routeSnapshot.aliasClaim.nativeId)}`
      : "";
    lines.push(`**Route snapshot:** profile ${escapeModelIdForMarkdown(routeSnapshot.profileIdentity)} (fingerprint: ${escapeModelIdForMarkdown(routeSnapshot.profileFingerprint || "—")})${aliasClaim}`);
  }

  // Route status — honest post-execution verification (v5)
  if (routeStatus) {
    const statusLabels = {
      resolved: "resolved (claim confirmed by execution evidence)",
      accepted_but_unverified: "accepted but unverified (no transcript evidence)",
      model_drift_possible: "model drift possible (claim and evidence disagree)",
      rejected: "rejected (CLI or Provider failure)",
    };
    lines.push(`**Route status:** ${statusLabels[routeStatus] || routeStatus}`);
  }

  // Execution models — re-sanitize at output boundary
  const executedModels = Array.isArray(modelEvidence.executedModels)
    ? modelEvidence.executedModels.slice(0, 16)
    : [];
  if (executedModels.length === 0) {
    lines.push(`**Claude-recorded execution model:** unavailable`);
  } else if (executedModels.length === 1) {
    const m = executedModels[0];
    lines.push(`**Claude-recorded execution model:** ${safeModelIdForDisplay(m?.id)}`);
  } else {
    lines.push(`**Claude-recorded execution models:**`);
    for (const m of executedModels) {
      const scopes = Array.isArray(m?.scopes) ? m.scopes.slice(0, 2) : [];
      const scopeLabel = scopes.map(safeScope).join(", ") || "unknown-scope";
      lines.push(`- ${safeModelIdForDisplay(m?.id)} (${scopeLabel})`);
    }
  }

  // Usage keys — re-sanitize at output boundary
  const rawUsageKeys = Array.isArray(modelEvidence.usageModelKeys)
    ? modelEvidence.usageModelKeys.slice(0, 16)
    : [];
  const usageKeys = rawUsageKeys.map(safeModelIdForDisplay);
  if (usageKeys.length === 1) {
    lines.push(`**Provider usage key:** ${usageKeys[0]}`);
  } else if (usageKeys.length > 1) {
    lines.push(`**Provider usage keys:** ${usageKeys.join(", ")}`);
  }

  // Evidence note
  const status = safeStatus(modelEvidence.status);
  if (status === "unavailable") {
    lines.push(`_Evidence note: Claude transcript was not available; the usage key is not treated as an execution model._`);
  } else if (status === "partial") {
    lines.push(`_Evidence note: model evidence is partial due to ${formatWarnings(modelEvidence.warnings)}._`);
  } else if (executedModels.length > 0 && usageKeys.length > 0) {
    // Check if execution models differ from usage keys (using normalized values for comparison)
    const execIds = executedModels.map((m) => normalizeModelIdForStorage(m?.id) || "");
    const usageIds = rawUsageKeys.map((k) => normalizeModelIdForStorage(k) || "");
    const hasOverlap = usageIds.some((k) => execIds.includes(k));
    if (!hasOverlap) {
      lines.push(`_Note: execution labels and usage keys have different semantics and may differ._`);
    }
  }

  // Explicit vs transcript mismatch note (using normalized values for comparison)
  if (requestMode === "explicit" && requestedModel && executedModels.length > 0) {
    const normalizedRequested = normalizeModelIdForStorage(requestedModel) || "";
    const allExecIds = executedModels.map((m) => normalizeModelIdForStorage(m?.id) || "");
    if (!allExecIds.includes(normalizedRequested)) {
      lines.push(`_Note: Claude Code recorded a different execution label than the requested identifier._`);
    }
  }

  return lines.join("\n");
}

/**
 * Format model evidence for compact table display (cc_check all=true).
 * Shows primary execution model or inherited/requested, with evidence status.
 */
export function formatModelCompact({ requestedModel, requestMode, modelEvidence, routeStatus }) {
  if (!modelEvidence) {
    return requestedModel ? safeModelIdForDisplay(requestedModel) : "inherited";
  }

  const executedModels = Array.isArray(modelEvidence.executedModels)
    ? modelEvidence.executedModels.slice(0, 16)
    : [];
  // Prefer main-scope execution model
  const mainModel = executedModels.find((m) => Array.isArray(m?.scopes) && m.scopes.includes("main"));
  if (mainModel) {
    let suffix = safeStatus(modelEvidence.status) === "partial" ? " ⚠" : "";
    if (routeStatus === "model_drift_possible") suffix += " ⚡";
    return safeModelIdForDisplay(mainModel?.id) + suffix;
  }
  // Fallback to first execution model
  if (executedModels.length > 0) {
    let suffix = "";
    if (routeStatus === "model_drift_possible") suffix = " ⚡";
    return safeModelIdForDisplay(executedModels[0]?.id) + suffix;
  }
  // No execution evidence
  if (requestMode === "explicit" && requestedModel) {
    return safeModelIdForDisplay(requestedModel);
  }
  return `inherited${safeStatus(modelEvidence.status) === "unavailable" ? " (no transcript)" : ""}`;
}

/**
 * Format warnings as human-readable string.
 * Unknown warning codes are displayed as "(unknown-warning)" to prevent injection.
 */
export function formatWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  const labels = {
    [WARNINGS.TRANSCRIPT_NOT_FOUND]: "transcript not found",
    [WARNINGS.INVALID_JSON_LINES]: "invalid JSON lines in transcript",
    [WARNINGS.SIZE_LIMIT]: "size limit reached",
    [WARNINGS.LINE_TOO_LONG]: "line too long",
    [WARNINGS.PATH_OUTSIDE_CONFIG_ROOT]: "path outside config root",
    [WARNINGS.SCAN_DEADLINE]: "scan deadline reached",
    [WARNINGS.INVALID_SESSION_ID]: "invalid session ID",
    [WARNINGS.TOO_MANY_MODELS]: "too many unique models",
    [WARNINGS.MODEL_ID_TRUNCATED]: "model ID truncated",
    [WARNINGS.TOO_MANY_SUBAGENTS]: "too many subagent files",
    [WARNINGS.TOO_MANY_LINES]: "line limit reached",
    [WARNINGS.SYMLINK_ESCAPE]: "symlink escape attempt",
    [WARNINGS.READ_ERROR]: "read error",
  };
  return warnings.slice(0, 16).map((w) => labels[w] || "(unknown-warning)").join(", ");
}
