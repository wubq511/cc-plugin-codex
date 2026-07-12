/**
 * Model evidence — barrel re-export.
 *
 * Splits concerns into:
 *   - shared:    constants, validation, sanitization
 *   - collector: transcript scanning, usage key extraction
 *   - formatter: unified display formatting
 *   - migration: v3 → v4 schema conversion
 *
 * All downstream imports remain unchanged.
 */

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
  isValidSessionId,
  normalizeModelIdForStorage,
  escapeModelIdForMarkdown,
  sanitizeModelId,
} from "./model-evidence-shared.mjs";

export {
  parseTranscriptModels,
  collectModelEvidence,
  extractUsageModelKeys,
} from "./model-evidence-collector.mjs";

export {
  formatModelEvidence,
  formatModelCompact,
  formatWarnings,
} from "./model-evidence-formatter.mjs";

export {
  migrateV3ModelFields,
} from "./model-evidence-migration.mjs";
