/**
 * Task title derivation for the live dashboard.
 *
 * The dashboard job list needs a human-meaningful label (a bare job UUID is
 * not one), but the persisted job record carries only a non-reversible
 * taskRef by design. The title therefore comes from the live task text held
 * in companion memory during delegation, never from disk.
 *
 * Boundary: single line, char-bounded with an ellipsis (code-point safe),
 * and passed through the same credential redaction patterns as failure
 * evidence. The bound happens BEFORE redactText so the diagnostic truncation
 * marker ("redacted tail, N bytes total") never reaches a UI label.
 */

import { redactText } from "./diagnostics.mjs";

export const TASK_TITLE_MAX_CHARS = 80;

/**
 * Derive a display title from raw task text. Returns "" for empty input.
 * Whitespace (including newlines) collapses to single spaces; overlong
 * titles are cut at maxChars code points with an ellipsis; credential
 * patterns are redacted.
 */
export function deriveTaskTitle(task, maxChars = TASK_TITLE_MAX_CHARS) {
  if (!task || typeof task !== "string") return "";
  const oneLine = task.trim().replace(/\s+/g, " ");
  if (!oneLine) return "";
  const chars = [...oneLine];
  const bounded = chars.length > maxChars ? chars.slice(0, maxChars).join("") + "…" : oneLine;
  // 1024 bytes comfortably holds any maxChars-bounded string, so redactText
  // applies its credential patterns without ever hitting its byte cap.
  return redactText(bounded, 1024);
}
