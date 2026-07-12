import fs from "node:fs";
import path from "node:path";

import { resolveStateDir, resolveJobsDir } from "./state.mjs";

/**
 * Per-job log file with timestamped entries.
 *
 * Format: human-readable lines like [2026-07-06T10:00:00Z] message
 * Plus structured blocks with [timestamp] Title\nBody
 *
 * Matches codex-plugin-cc's tracked-jobs.mjs format for compatibility.
 */

function resolveLogFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

function ensureLogDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true, mode: 0o700 });
}

function nowIso() {
  return new Date().toISOString();
}

const MAX_LOG_BYTES = 1 * 1024 * 1024; // 1 MiB per job log

/**
 * Check if a log file exceeds the size limit.
 */
export function checkLogSizeLimit(cwd, jobId) {
  const logFile = resolveLogFile(cwd, jobId);
  if (!fs.existsSync(logFile)) return false;
  try {
    const stat = fs.statSync(logFile);
    return stat.size >= MAX_LOG_BYTES;
  } catch {
    return false;
  }
}

/**
 * Append a single log line: [timestamp] message.
 * Silently skips if log exceeds MAX_LOG_BYTES.
 */
export function appendLogLine(cwd, jobId, message) {
  ensureLogDir(cwd);
  const logFile = resolveLogFile(cwd, jobId);
  const normalized = String(message ?? "").trim();
  if (!normalized) return;
  appendBounded(logFile, `[${nowIso()}] ${normalized}\n`);
}

/**
 * Append a log block: [timestamp] Title\nBody.
 * Silently skips if log exceeds MAX_LOG_BYTES.
 */
export function appendLogBlock(cwd, jobId, title, body) {
  ensureLogDir(cwd);
  const logFile = resolveLogFile(cwd, jobId);
  if (!body) return;
  appendBounded(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`);
}

function appendBounded(logFile, text) {
  let currentSize = 0;
  try { currentSize = fs.statSync(logFile).size; } catch { /* new file */ }
  const remaining = MAX_LOG_BYTES - currentSize;
  if (remaining <= 0) return;
  let output = text;
  if (Buffer.byteLength(output, "utf8") > remaining) {
    output = output.slice(0, remaining);
    while (output.length > 0 && Buffer.byteLength(output, "utf8") > remaining) {
      output = output.slice(0, -1);
    }
  }
  fs.appendFileSync(logFile, output, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(logFile, 0o600); } catch { /* best effort */ }
}

/**
 * Create an empty log file and optionally write a starting line.
 * Returns the log file path.
 */
export function createJobLogFile(cwd, jobId, title) {
  ensureLogDir(cwd);
  const logFile = resolveLogFile(cwd, jobId);
  fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  if (title) {
    appendLogLine(cwd, jobId, `Starting ${title}.`);
  }
  return logFile;
}

/**
 * Read the last N log lines for a job (for progress preview).
 * Strips the timestamp prefix for display.
 * Reads only the last 8KB of the file to avoid loading large logs.
 */
export function readLogTail(cwd, jobId, maxLines = 4) {
  const logFile = resolveLogFile(cwd, jobId);
  if (!fs.existsSync(logFile)) return [];
  try {
    const stat = fs.statSync(logFile);
    const readSize = Math.min(stat.size, 8192);
    const offset = Math.max(0, stat.size - readSize);
    const buf = Buffer.alloc(readSize);
    const fd = fs.openSync(logFile, "r");
    try {
      fs.readSync(fd, buf, 0, readSize, offset);
    } finally {
      fs.closeSync(fd);
    }
    const content = buf.toString("utf8");
    let lines = content.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    // Discard first line if we started mid-file (it's a partial line)
    if (offset > 0 && lines.length > 0) lines.shift();
    // Strip timestamp prefix: [2026-07-06T10:00:00Z] message → message
    const stripped = lines.map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim()).filter(Boolean);
    return stripped.slice(-maxLines);
  } catch {
    return [];
  }
}

/**
 * Read all log entries for a job as structured objects.
 */
export function readLog(cwd, jobId) {
  const logFile = resolveLogFile(cwd, jobId);
  if (!fs.existsSync(logFile)) return [];
  try {
    const content = fs.readFileSync(logFile, "utf8");
    return content.split(/\r?\n/).filter(Boolean).map((line) => {
      const match = line.match(/^\[([^\]]+)\]\s*(.*)/);
      if (match) return { ts: match[1], message: match[2].trim() };
      return { ts: "", message: line.trim() };
    });
  } catch {
    return [];
  }
}

/**
 * Get the log file path for a job.
 */
export function getLogFilePath(cwd, jobId) {
  return resolveLogFile(cwd, jobId);
}

/**
 * Delete a job's log file.
 */
export function deleteLog(cwd, jobId) {
  const logFile = resolveLogFile(cwd, jobId);
  if (fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }
}

// ─── Phase Tracking ──────────────────────────────────────────────────────────

const PHASES = ["starting", "executing", "reviewing", "editing", "verifying", "finalizing", "completed", "failed", "cancelled"];

/**
 * Validate and return the next allowed phases from a given phase.
 */
export function allowedTransitions(from) {
  switch (from) {
    case "starting":    return ["executing", "failed", "cancelled"];
    case "executing":   return ["reviewing", "editing", "verifying", "finalizing", "completed", "failed", "cancelled"];
    case "reviewing":   return ["editing", "verifying", "finalizing", "completed", "failed", "cancelled"];
    case "editing":     return ["verifying", "finalizing", "completed", "failed", "cancelled"];
    case "verifying":   return ["finalizing", "completed", "failed", "cancelled"];
    case "finalizing":  return ["completed", "failed", "cancelled"];
    case "completed":   return [];
    case "failed":      return [];
    case "cancelled":   return [];
    default:            return [];
  }
}

/**
 * Check if a phase transition is valid.
 */
export function isValidTransition(from, to) {
  return allowedTransitions(from).includes(to);
}

/**
 * Get a human-readable description of a phase.
 */
export function phaseDescription(phase) {
  switch (phase) {
    case "starting":    return "Preparing to execute task";
    case "executing":   return "Claude Code is working on the task";
    case "reviewing":   return "Reviewing the implementation";
    case "editing":     return "Applying edits to files";
    case "verifying":   return "Verifying the implementation";
    case "finalizing":  return "Finalizing changes";
    case "completed":   return "Task completed successfully";
    case "failed":      return "Task failed";
    case "cancelled":   return "Task cancelled by user";
    default:            return phase;
  }
}

/**
 * Infer phase from log content (for jobs that don't have explicit phase tracking).
 * Mirrors codex-plugin-cc's inferLegacyJobPhase.
 */
export function inferPhaseFromLog(logLines) {
  for (let i = logLines.length - 1; i >= 0; i--) {
    const line = logLines[i].toLowerCase();
    if (line.startsWith("starting") || line.includes("claude -p")) return "starting";
    if (line.startsWith("reviewer started") || line.includes("review mode")) return "reviewing";
    if (line.startsWith("applying") || line.startsWith("file changes")) return "editing";
    if (line.startsWith("running command:") || line.includes("verifying")) return "verifying";
    if (line.startsWith("task completed") || line.includes("done.")) return "completed";
    if (line.startsWith("failed") || line.includes("error:")) return "failed";
    if (line.startsWith("cancelled")) return "cancelled";
  }
  return "executing";
}
