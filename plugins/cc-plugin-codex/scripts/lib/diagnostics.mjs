/**
 * Diagnostics — structured, private failure envelopes with redaction.
 *
 * Every unsuccessful delegation produces a bounded diagnostic envelope with:
 *   - failure stage (from a fixed enum)
 *   - CLI version, requested selector, effort, exit code, signal, duration
 *   - redacted and byte-bounded stdout/stderr tails
 *   - whether a structured CLI error, session ID, usage key, or transcript was observed
 *
 * Detailed diagnostics live only in the private job artifact.
 * Normal MCP output exposes only the category, safe message, and job ID.
 *
 * Redaction prevents secrets, task text, raw settings content, and provider
 * credentials from reaching MCP output or persisted public metadata.
 */

import { normalizeModelIdForStorage } from "./model-evidence-shared.mjs";

// ─── Failure Stage Enum ──────────────────────────────────────────────────────

/**
 * The only valid failure stage values.
 * These are the categories defined in the design specification.
 */
export const FAILURE_STAGES = Object.freeze({
  SPAWN: "spawn",
  CLI_CONTRACT: "cli_contract",
  CONFIGURATION: "configuration",
  PROVIDER_HANDSHAKE: "provider_handshake",
  PROVIDER_RESPONSE: "provider_response",
  JSON_PROTOCOL: "json_protocol",
  TIMEOUT: "timeout",
  CANCELLED: "cancelled",
});

const VALID_STAGES = new Set(Object.values(FAILURE_STAGES));

// ─── Size Limits ─────────────────────────────────────────────────────────────

const MAX_TAIL_BYTES = 2048; // 2 KiB per stream tail
const MAX_SAFE_ERROR_BYTES = 4096; // 4 KiB for safe error message
const MIN_TASK_MARKER_LEN = 8; // shorter strings are not redacted as task markers

/**
 * Escape a string for safe use in a RegExp. Prevents regex injection from
 * task content (which is untrusted user input).
 */
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Redaction Patterns ──────────────────────────────────────────────────────

/**
 * Redaction patterns for secrets and sensitive content.
 * Each pattern matches a potential secret leak and replaces it with a placeholder.
 */
const REDACTION_PATTERNS = [
  // API keys: sk-..., sk-ant-..., etc.
  { pattern: /\bsk-[a-zA-Z0-9_\-]{8,}/g, replacement: "sk-[REDACTED]" },
  // Bearer tokens
  { pattern: /\bBearer\s+[a-zA-Z0-9_\-\.]{8,}/gi, replacement: "Bearer [REDACTED]" },
  // Authorization headers
  { pattern: /Authorization\s*[:=]\s*\S+/gi, replacement: "Authorization: [REDACTED]" },
  // x-api-key headers
  { pattern: /x-api-key\s*[:=]\s*\S+/gi, replacement: "x-api-key: [REDACTED]" },
  // password= or password: followed by non-whitespace
  { pattern: /password\s*[:=]\s*[^\s;,\}]+/gi, replacement: "password=[REDACTED]" },
  // api_key= or api_key: followed by non-whitespace
  { pattern: /api[_-]?key\s*[:=]\s*[^\s;,\}]+/gi, replacement: "api_key=[REDACTED]" },
  // token= or token: followed by non-whitespace
  { pattern: /\btoken\s*[:=]\s*[^\s;,\}]+/gi, replacement: "token=[REDACTED]" },
  // secret= or secret: followed by non-whitespace
  { pattern: /\bsecret\s*[:=]\s*[^\s;,\}]+/gi, replacement: "secret=[REDACTED]" },
  // URLs with embedded credentials: https://user:pass@host
  { pattern: /(https?:\/\/)[^:\/\s]+:[^@\/\s]+@/gi, replacement: "$1[REDACTED]@" },
  // Anthropic-specific env var values
  { pattern: /(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)\s*[=:]\s*\S+/gi, replacement: "$1=[REDACTED]" },
  // Base URL with path components (redact the full URL to host only)
  { pattern: /(https?:\/\/[a-zA-Z0-9\-._:]+)\/[^\s"']+/gi, replacement: "$1/[REDACTED]" },
];

/**
 * Redact sensitive content from a text string.
 * First redacts task markers (prompt text echoed by CLI/Provider), then
 * applies secret redaction patterns, then bounds the size.
 *
 * @param {string} text - The text to redact
 * @param {number} maxBytes - Maximum bytes to retain (default MAX_TAIL_BYTES)
 * @param {string[]} [taskMarkers=[]] - Task text fragments to redact
 * @returns {string} Redacted, bounded text
 */
export function redactText(text, maxBytes = MAX_TAIL_BYTES, taskMarkers = []) {
  if (!text || typeof text !== "string") return "";

  let redacted = text;

  // Redact task markers first — the CLI or Provider may echo prompt text
  // in error messages. Only markers above a minimum length are redacted
  // to avoid false positives on short common substrings.
  for (const marker of taskMarkers) {
    if (typeof marker === "string" && marker.length >= MIN_TASK_MARKER_LEN) {
      const escaped = escapeRegExp(marker);
      redacted = redacted.replace(new RegExp(escaped, "g"), "[TASK_REDACTED]");
    }
  }

  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  // Bound to maxBytes, cutting at a safe UTF-8 boundary
  const bytes = Buffer.byteLength(redacted, "utf8");
  if (bytes > maxBytes) {
    let truncated = redacted.slice(0, maxBytes);
    while (truncated.length > 0 && Buffer.byteLength(truncated, "utf8") > maxBytes) {
      truncated = truncated.slice(0, -1);
    }
    redacted = truncated + `... (redacted tail, ${bytes} bytes total)`;
  }

  return redacted;
}

// ─── Failure Stage Classification ────────────────────────────────────────────

/**
 * Classify the failure stage from the available signals.
 *
 * @param {object} signals
 * @param {string|null} signals.terminationReason - "timeout" | "cancelled" | "output-limit" | null
 * @param {number|null} signals.exitCode - Process exit code
 * @param {string|null} signals.signal - Process signal
 * @param {string} signals.stdout - Captured stdout
 * @param {string} signals.stderr - Captured stderr
 * @param {boolean} signals.spawnError - Whether a spawn error occurred (ENOENT etc.)
 * @param {boolean} signals.structuredError - Whether a structured CLI error was detected
 * @param {object|null} signals.parsedError - Parsed structured error (if available)
 * @param {string|null} signals.configError - Configuration-stage error message (if any)
 * @returns {string} Failure stage from FAILURE_STAGES
 */
export function classifyFailureStage(signals) {
  const {
    terminationReason,
    spawnError,
    configError,
    stdout = "",
    stderr = "",
    structuredError,
    parsedError,
  } = signals;

  // Cancellation takes priority
  if (terminationReason === "cancelled") {
    return FAILURE_STAGES.CANCELLED;
  }

  // Timeout
  if (terminationReason === "timeout") {
    return FAILURE_STAGES.TIMEOUT;
  }

  // Configuration-stage error (before Claude was spawned)
  if (configError) {
    return FAILURE_STAGES.CONFIGURATION;
  }

  // Spawn failure (ENOENT, EACCES, etc.)
  if (spawnError) {
    return FAILURE_STAGES.SPAWN;
  }

  // Combined text for pattern matching
  const combinedText = `${stdout}\n${stderr}`.toLowerCase();

  // CLI contract issues: missing --print, invalid flags, print-mode errors
  if (
    combinedText.includes("--print") ||
    combinedText.includes("print mode") ||
    combinedText.includes("print-mode") ||
    combinedText.includes("invalid argument") ||
    combinedText.includes("unknown option") ||
    combinedText.includes("unknown flag") ||
    combinedText.includes("usage: claude") ||
    combinedText.includes("unrecognized arguments")
  ) {
    return FAILURE_STAGES.CLI_CONTRACT;
  }

  // Provider handshake: authentication, authorization, API key issues
  if (
    combinedText.includes("401") ||
    combinedText.includes("403") ||
    combinedText.includes("unauthorized") ||
    combinedText.includes("forbidden") ||
    combinedText.includes("authentication") ||
    combinedText.includes("api key") ||
    combinedText.includes("api_key") ||
    combinedText.includes("invalid key") ||
    combinedText.includes("permission denied")
  ) {
    return FAILURE_STAGES.PROVIDER_HANDSHAKE;
  }

  // Provider response: model errors, rate limits, server errors
  if (
    combinedText.includes("429") ||
    combinedText.includes("rate limit") ||
    combinedText.includes("overloaded") ||
    combinedText.includes("500") ||
    combinedText.includes("502") ||
    combinedText.includes("503") ||
    combinedText.includes("internal server error") ||
    combinedText.includes("model not found") ||
    combinedText.includes("model_not_found") ||
    combinedText.includes("unsupported model") ||
    combinedText.includes("invalid model") ||
    combinedText.includes("not available")
  ) {
    return FAILURE_STAGES.PROVIDER_RESPONSE;
  }

  // Structured error — inspect parsed error for type indicators
  if (structuredError && parsedError) {
    const errorStr = JSON.stringify(parsedError).toLowerCase();
    if (errorStr.includes("auth") || errorStr.includes("key") || errorStr.includes("401") || errorStr.includes("403")) {
      return FAILURE_STAGES.PROVIDER_HANDSHAKE;
    }
    if (errorStr.includes("model") || errorStr.includes("rate") || errorStr.includes("overload") || errorStr.includes("429")) {
      return FAILURE_STAGES.PROVIDER_RESPONSE;
    }
  }

  // Output limit exceeded — the provider produced too much output
  if (terminationReason === "output-limit") {
    return FAILURE_STAGES.PROVIDER_RESPONSE;
  }

  // If stdout exists but isn't valid JSON, it's a JSON protocol error
  if (stdout.trim() && !structuredError) {
    try {
      JSON.parse(stdout);
    } catch {
      return FAILURE_STAGES.JSON_PROTOCOL;
    }
  }

  // Default: provider response (unknown non-zero exit)
  return FAILURE_STAGES.PROVIDER_RESPONSE;
}

// ─── Failure Envelope Construction ───────────────────────────────────────────

/**
 * Build a bounded, redacted failure envelope for a failed delegation.
 *
 * This envelope is stored only in the private job artifact.
 * The MCP response should only use the safe summary from buildSafeErrorSummary().
 *
 * @param {object} options
 * @param {string} options.stage - Failure stage (from FAILURE_STAGES)
 * @param {object|null} options.requestedSelector - { kind, value } or null
 * @param {string|null} options.effort - Requested effort level
 * @param {string|null} options.cliVersion - Claude CLI version
 * @param {number|null} options.exitCode - Process exit code
 * @param {string|null} options.signal - Process signal
 * @param {number|null} options.durationMs - Duration in milliseconds
 * @param {boolean} options.structuredError - Whether a structured CLI error was found
 * @param {string|null} options.sessionId - Claude session ID (if observed)
 * @param {string|null} options.usageKey - Usage model key (if observed)
 * @param {boolean} options.transcriptFound - Whether a transcript was found
 * @param {string} options.stdout - Raw stdout
 * @param {string} options.stderr - Raw stderr
 * @param {string[]} [options.taskMarkers=[]] - Task text fragments to redact from diagnostics
 * @returns {object} Bounded, redacted failure envelope
 */
export function buildFailureEnvelope(options) {
  const stage = VALID_STAGES.has(options.stage) ? options.stage : FAILURE_STAGES.PROVIDER_RESPONSE;
  const taskMarkers = options.taskMarkers || [];

  return {
    stage,
    requestedSelector: options.requestedSelector || null,
    effort: options.effort || null,
    cliVersion: options.cliVersion || null,
    exitCode: options.exitCode ?? null,
    signal: options.signal || null,
    durationMs: options.durationMs ?? null,
    structuredError: options.structuredError || false,
    sessionId: options.sessionId || null,
    usageKey: options.usageKey || null,
    transcriptFound: options.transcriptFound || false,
    errorDetail: options.errorDetail ? redactText(options.errorDetail, MAX_TAIL_BYTES, taskMarkers) : null,
    stdoutTail: redactText(options.stdout, MAX_TAIL_BYTES, taskMarkers),
    stderrTail: redactText(options.stderr, MAX_TAIL_BYTES, taskMarkers),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Build a safe error summary for MCP output and job metadata.
 * This does NOT include stdout/stderr tails, session IDs, or detailed diagnostics.
 *
 * @param {string} stage - Failure stage
 * @param {string} fallbackMessage - Fallback error message if stage is unknown
 * @returns {string} Safe error summary
 */
export function buildSafeErrorSummary(stage, fallbackMessage) {
  const messages = {
    [FAILURE_STAGES.SPAWN]: "Failed to start Claude Code. The CLI binary may be missing or not executable.",
    [FAILURE_STAGES.CLI_CONTRACT]: "Claude CLI protocol error. The installed CLI may not support print-mode JSON output. Try updating Claude Code.",
    [FAILURE_STAGES.CONFIGURATION]: "Configuration error. The active profile could not be safely resolved.",
    [FAILURE_STAGES.PROVIDER_HANDSHAKE]: "Provider authentication or authorization failed. Check API keys and profile configuration.",
    [FAILURE_STAGES.PROVIDER_RESPONSE]: "Provider returned an error. The model may be unavailable, rate-limited, or rejected.",
    [FAILURE_STAGES.JSON_PROTOCOL]: "Claude CLI produced non-JSON output. The CLI version may be incompatible.",
    [FAILURE_STAGES.TIMEOUT]: "Claude task timed out and was terminated.",
    [FAILURE_STAGES.CANCELLED]: "Claude task was cancelled.",
  };

  const message = messages[stage] || fallbackMessage || "Claude task failed.";
  // Bound the message size
  if (Buffer.byteLength(message, "utf8") > MAX_SAFE_ERROR_BYTES) {
    return message.slice(0, MAX_SAFE_ERROR_BYTES) + "...";
  }
  return message;
}

/**
 * Build a safe error message for MCP output, including the failure stage.
 * This is what the user sees in the MCP response.
 *
 * Per the design spec: "普通 MCP 展示只能返回安全摘要、错误分类和 job ID；
 * 详细证据仅放在私有 job artifact。" The raw error detail (even redacted)
 * is NEVER included in MCP output — it lives only in the private diagnostics
 * envelope (buildFailureEnvelope).
 *
 * @param {string} stage - Failure stage
 * @param {string} rawError - Raw error message (used only as fallback if stage is unknown)
 * @returns {string} Safe error message with stage prefix
 */
export function buildSafeErrorMessage(stage, rawError) {
  const summary = buildSafeErrorSummary(stage, rawError);
  return `[${stage}] ${summary}`;
}

// ─── Safe Stage Validation ───────────────────────────────────────────────────

/**
 * Validate that a stage value is from the fixed enum.
 * Used when reading persisted diagnostics back.
 */
export function isValidStage(stage) {
  return VALID_STAGES.has(stage);
}
