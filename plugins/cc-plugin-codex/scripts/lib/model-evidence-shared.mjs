/**
 * Model evidence — shared constants and utilities.
 *
 * Used by collector, formatter, and migration modules.
 * No filesystem I/O — pure functions and constants only.
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_MAIN_TRANSCRIPT_BYTES = 32 * 1024 * 1024; // 32 MiB
const MAX_SUBAGENT_TOTAL_BYTES = 32 * 1024 * 1024;  // 32 MiB
const MAX_LINE_BYTES = 1 * 1024 * 1024;             // 1 MiB per line
const MAX_LINES = 100_000;
const MAX_SUBAGENT_FILES = 256;
const MAX_UNIQUE_MODELS = 16;
const MAX_MODEL_ID_BYTES = 256;
const DEFAULT_DEADLINE_MS = 1000;
const MAX_RETRIES = 2;
const RETRY_WAIT_MS = 100;

// Predefined warning codes (no sensitive content)
const WARNINGS = Object.freeze({
  TRANSCRIPT_NOT_FOUND: "transcript-not-found",
  INVALID_JSON_LINES: "invalid-json-lines",
  SIZE_LIMIT: "size-limit",
  LINE_TOO_LONG: "line-too-long",
  PATH_OUTSIDE_CONFIG_ROOT: "path-outside-config-root",
  SCAN_DEADLINE: "scan-deadline",
  INVALID_SESSION_ID: "invalid-session-id",
  TOO_MANY_MODELS: "too-many-models",
  MODEL_ID_TRUNCATED: "model-id-truncated",
  TOO_MANY_SUBAGENTS: "too-many-subagents",
  TOO_MANY_LINES: "too-many-lines",
  SYMLINK_ESCAPE: "symlink-escape",
  READ_ERROR: "read-error",
});

// Known scope values (untrusted data validation)
const KNOWN_SCOPES = new Set(["main", "subagent"]);

// Known status values (untrusted data validation)
const KNOWN_STATUSES = new Set(["complete", "partial", "unavailable"]);

export {
  MAX_MAIN_TRANSCRIPT_BYTES,
  MAX_SUBAGENT_TOTAL_BYTES,
  MAX_LINE_BYTES,
  MAX_LINES,
  MAX_SUBAGENT_FILES,
  MAX_UNIQUE_MODELS,
  MAX_MODEL_ID_BYTES,
  DEFAULT_DEADLINE_MS,
  MAX_RETRIES,
  RETRY_WAIT_MS,
  WARNINGS,
  KNOWN_SCOPES,
  KNOWN_STATUSES,
};

// ─── Session ID Validation ──────────────────────────────────────────────────

/**
 * Validate sessionId: must match restricted UUID/Claude session id format.
 * Rejects /, \, .., NUL, control characters.
 * Used as exact filename — never as a path component.
 */
export function isValidSessionId(sessionId) {
  if (!sessionId || typeof sessionId !== "string") return false;
  if (sessionId.length === 0 || sessionId.length > 256) return false;
  // Reject path traversal and control characters
  if (/[\/\\]/.test(sessionId)) return false;
  if (sessionId.includes("..")) return false;
  if (sessionId.includes("\0")) return false;
  if (/[\x00-\x1f\x7f]/.test(sessionId)) return false;
  // Must look like a session identifier (UUID-like or Claude session format)
  // Allow alphanumeric, hyphens, underscores, dots
  if (!/^[a-zA-Z0-9._-]+$/.test(sessionId)) return false;
  return true;
}

// ─── Model ID Normalization (for storage/comparison) ────────────────────────

/**
 * Normalize a model ID for storage and comparison.
 * - Strip ALL control characters (C0 + DEL), including LF/CR/Tab
 * - Truncate to MAX_MODEL_ID_BYTES
 * - Does NOT do Markdown escaping (that's escapeModelIdForMarkdown)
 * - Idempotent
 */
export function normalizeModelIdForStorage(modelId) {
  if (!modelId || typeof modelId !== "string") return null;
  // Strip ALL control characters (C0 + DEL), including LF/CR/Tab
  let normalized = modelId.replace(/[\x00-\x1f\x7f]/g, "");
  // Truncate to byte limit
  if (Buffer.byteLength(normalized, "utf8") > MAX_MODEL_ID_BYTES) {
    while (normalized.length > 0 && Buffer.byteLength(normalized, "utf8") > MAX_MODEL_ID_BYTES) {
      normalized = normalized.slice(0, -1);
    }
  }
  return normalized || null;
}

// ─── Model ID Markdown Escaping (for output boundary only) ──────────────────

/**
 * Escape a model ID for safe Markdown display.
 * Only escapes pipe (|) and backtick (`) that are not already escaped.
 * Uses odd/even preceding backslash count to determine if already escaped.
 *
 * Rules:
 *   a|b       → a\|b       (unescaped pipe → escape)
 *   a\|b      → a\|b       (odd backslashes before pipe = already escaped)
 *   a\\|b     → a\\\|b     (even backslashes before pipe = unescaped)
 *   org\model → org\model  (backslash before non-special = unchanged)
 *   a`b       → a\`b       (same rules for backtick)
 *
 * Idempotent: applying twice produces the same result.
 * Never deletes or rewrites legitimate backslashes in model IDs.
 */
export function escapeModelIdForMarkdown(modelId) {
  if (!modelId || typeof modelId !== "string") return null;

  // Process character by character, tracking preceding backslash count
  let result = "";
  let backslashRun = 0;

  for (let i = 0; i < modelId.length; i++) {
    const ch = modelId[i];

    if (ch === "\\") {
      backslashRun++;
      result += ch;
    } else if (ch === "|" || ch === "`") {
      // Odd preceding backslashes = already escaped, don't add another
      // Even (including 0) = unescaped, add escape
      if (backslashRun % 2 === 0) {
        result += "\\" + ch;
      } else {
        result += ch;
      }
      backslashRun = 0;
    } else {
      backslashRun = 0;
      result += ch;
    }
  }

  return result || null;
}

// ─── Legacy Compat Alias ────────────────────────────────────────────────────

/**
 * Sanitize a model ID for safe display/storage.
 * Legacy alias: normalize + escape in one step.
 * New code should use normalizeModelIdForStorage + escapeModelIdForMarkdown separately.
 */
export function sanitizeModelId(modelId) {
  const normalized = normalizeModelIdForStorage(modelId);
  if (!normalized) return null;
  return escapeModelIdForMarkdown(normalized);
}
