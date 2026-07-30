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
import { isValidRouteStatus } from "./route-status.mjs";

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
 * @param {string|null} options.routeStatus - Route status (v7)
 * @param {string|null} options.selectorKind - Selector kind (v7)
 * @returns {string} Formatted model evidence lines
 */
export function formatModelEvidence({ requestedModel, requestMode, modelEvidence, routeStatus, selectorKind }) {
  if (!modelEvidence) {
    // Legacy/fallback — should not happen in v4 but be safe
    if (requestedModel) {
      return `**请求的模型：** ${safeModelIdForDisplay(requestedModel)}`;
    }
    return `**模型请求：** 继承自 Claude Code 配置`;
  }

  const lines = [];

  // Request line — show selector kind when available (v7)
  if (selectorKind === "alias" && requestedModel) {
    lines.push(`**请求的模型：** ${safeModelIdForDisplay(requestedModel)} (alias)`);
  } else if (selectorKind === "native" && requestedModel) {
    lines.push(`**请求的模型：** ${safeModelIdForDisplay(requestedModel)} (native ID)`);
  } else if (requestMode === "explicit" && requestedModel) {
    lines.push(`**请求的模型：** ${safeModelIdForDisplay(requestedModel)}`);
  } else {
    lines.push(`**模型请求：** 继承自 Claude Code 配置`);
  }

  // Route status — honest post-execution verification (v7)
  if (routeStatus && isValidRouteStatus(routeStatus)) {
    const statusLabels = {
      resolved: "resolved（声明已被执行证据确认）",
      accepted_but_unverified: "accepted but unverified（具体原生模型未确认）",
      model_drift_possible: "model drift possible（声明与证据不一致）",
      rejected: "rejected（CLI 或 Provider 失败）",
      cancelled: "cancelled（路由验证完成前已取消）",
    };
    lines.push(`**路由状态：** ${statusLabels[routeStatus]}`);
  } else if (routeStatus) {
    lines.push(`**路由状态：** unavailable`);
  }

  // Execution models — re-sanitize at output boundary
  const executedModels = Array.isArray(modelEvidence.executedModels)
    ? modelEvidence.executedModels.slice(0, 16)
    : [];
  if (executedModels.length === 0) {
    lines.push(`**Claude 记录的执行模型：** unavailable`);
  } else if (executedModels.length === 1) {
    const m = executedModels[0];
    lines.push(`**Claude 记录的执行模型：** ${safeModelIdForDisplay(m?.id)}`);
  } else {
    lines.push(`**Claude 记录的执行模型：**`);
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
    lines.push(`**Provider usage key:** ${usageKeys.join(", ")}`);
  }

  // Evidence note
  const status = safeStatus(modelEvidence.status);
  if (status === "unavailable") {
    lines.push(`_证据说明：Claude transcript 不可用；usage key 不被视为执行模型。_`);
  } else if (status === "partial") {
    lines.push(`_证据说明：模型证据不完整，原因：${formatWarnings(modelEvidence.warnings)}。_`);
  } else if (executedModels.length > 0 && usageKeys.length > 0) {
    // Check if execution models differ from usage keys (using normalized values for comparison)
    const execIds = executedModels.map((m) => normalizeModelIdForStorage(m?.id) || "");
    const usageIds = rawUsageKeys.map((k) => normalizeModelIdForStorage(k) || "");
    const hasOverlap = usageIds.some((k) => execIds.includes(k));
    if (!hasOverlap) {
      lines.push(`_注意：执行标签与 usage key 语义不同，可能不一致。_`);
    }
  }

  // Explicit vs transcript mismatch note (using normalized values for comparison)
  if (requestMode === "explicit" && requestedModel && executedModels.length > 0) {
    const normalizedRequested = normalizeModelIdForStorage(requestedModel) || "";
    const allExecIds = executedModels.map((m) => normalizeModelIdForStorage(m?.id) || "");
    if (!allExecIds.includes(normalizedRequested)) {
      lines.push(`_注意：Claude Code 记录的执行标签与请求的标识符不同。_`);
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
  return `inherited${safeStatus(modelEvidence.status) === "unavailable" ? "（无 transcript）" : ""}`;
}

/**
 * Format warnings as human-readable string.
 * Unknown warning codes are displayed as "(unknown-warning)" to prevent injection.
 */
export function formatWarnings(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return "";
  const labels = {
    [WARNINGS.TRANSCRIPT_NOT_FOUND]: "未找到 transcript",
    [WARNINGS.INVALID_JSON_LINES]: "transcript 中存在无效 JSON 行",
    [WARNINGS.SIZE_LIMIT]: "达到大小限制",
    [WARNINGS.LINE_TOO_LONG]: "行过长",
    [WARNINGS.PATH_OUTSIDE_CONFIG_ROOT]: "路径在 config root 之外",
    [WARNINGS.SCAN_DEADLINE]: "扫描截止",
    [WARNINGS.INVALID_SESSION_ID]: "无效的 session ID",
    [WARNINGS.TOO_MANY_MODELS]: "唯一模型过多",
    [WARNINGS.MODEL_ID_TRUNCATED]: "模型 ID 被截断",
    [WARNINGS.TOO_MANY_SUBAGENTS]: "subagent 文件过多",
    [WARNINGS.TOO_MANY_LINES]: "达到行数限制",
    [WARNINGS.SYMLINK_ESCAPE]: "symlink 逸出尝试",
    [WARNINGS.READ_ERROR]: "读取错误",
  };
  return warnings.slice(0, 16).map((w) => labels[w] || "(unknown-warning)").join(", ");
}
