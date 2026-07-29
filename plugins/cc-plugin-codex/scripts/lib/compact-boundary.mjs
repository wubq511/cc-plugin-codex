/**
 * Compact boundary collector — transcript-based compaction evidence.
 *
 * Reads Claude Code session JSONL files to detect whether a `/compact` (or
 * auto-compact) boundary was crossed, and extracts the pre-compaction token
 * count and trigger. Uses the same path-safety pattern as
 * model-evidence-collector: sessionId validated, realpath containment, bounded
 * streaming read, hard deadline.
 *
 * Safety constraints:
 *   - sessionId strictly validated (no path traversal)
 *   - Only searches <configRoot>/projects/ first-level directories
 *   - realpath must stay within configRoot/projects (symlink escape rejection)
 *   - Async streaming line-by-line parse (not full read)
 *   - 32 MiB transcript, 1 MiB per-line limit
 *   - 1,000 ms total budget (hard deadline)
 *   - Never reads or persists transcript content beyond boundary metadata
 *
 * The collector NEVER fabricates evidence. If no boundary is observed, all
 * evidence fields are null and compacted is false.
 */

import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";

import { isValidSessionId } from "./model-evidence-shared.mjs";

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024; // 32 MiB
const MAX_LINE_BYTES = 1 * 1024 * 1024;        // 1 MiB per line
const DEFAULT_DEADLINE_MS = 1000;

// ─── withDeadline — hard deadline wrapper ────────────────────────────────────

class DeadlineExceeded extends Error {
  constructor(label) {
    super(`deadline exceeded: ${label}`);
    this.code = "DEADLINE";
  }
}

async function withDeadline(promise, absoluteDeadline, label) {
  let timer;
  const remaining = absoluteDeadline - Date.now();
  if (remaining <= 0) {
    throw new DeadlineExceeded(label);
  }
  const deadlinePromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(label)), remaining);
  });
  try {
    const result = await Promise.race([promise, deadlinePromise]);
    clearTimeout(timer);
    return result;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Path Safety (async) ────────────────────────────────────────────────────

async function safeRealPathAsync(filePath, rootDir) {
  let resolved;
  try {
    resolved = await fs.promises.realpath(filePath);
  } catch (err) {
    return { path: null, escape: false, error: err.code || "UNKNOWN" };
  }
  let resolvedRoot;
  try {
    resolvedRoot = await fs.promises.realpath(rootDir);
  } catch (err) {
    return { path: null, escape: false, error: err.code || "UNKNOWN" };
  }
  if (!resolved.startsWith(resolvedRoot + path.sep) && resolved !== resolvedRoot) {
    return { path: null, escape: true, error: null };
  }
  return { path: resolved, escape: false, error: null };
}

// ─── Transcript Finder ──────────────────────────────────────────────────────

async function findMainTranscript(projectsDir, sessionId, absoluteDeadline = Infinity) {
  const opendirPromise = fs.promises.opendir(projectsDir);
  let dirHandle;
  try {
    dirHandle = await withDeadline(opendirPromise, absoluteDeadline, "projects-opendir");
  } catch (err) {
    if (err.code === "DEADLINE") {
      opendirPromise.then((h) => h.close()).catch(() => {});
      return { path: null, deadlineExceeded: true };
    }
    if (err.code === "ENOENT") return { path: null, deadlineExceeded: false };
    return { path: null, deadlineExceeded: false };
  }

  try {
    while (true) {
      let entry;
      try {
        entry = await withDeadline(dirHandle.read(), absoluteDeadline, "projects-dir-read");
      } catch (err) {
        if (err.code === "DEADLINE") return { path: null, deadlineExceeded: true };
        return { path: null, deadlineExceeded: false };
      }
      if (!entry) break;

      if (!entry.isDirectory()) continue;
      const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);

      let safeResult;
      try {
        safeResult = await withDeadline(safeRealPathAsync(candidate, projectsDir), absoluteDeadline, "main-realpath");
      } catch (err) {
        if (err.code === "DEADLINE") return { path: null, deadlineExceeded: true };
        continue;
      }
      if (safeResult.escape) return { path: null, deadlineExceeded: false };
      if (safeResult.error) {
        if (safeResult.error === "ENOENT") continue;
        return { path: null, deadlineExceeded: false };
      }
      if (!safeResult.path) continue;

      try {
        const stat = await withDeadline(fs.promises.stat(safeResult.path), absoluteDeadline, "main-stat");
        if (stat.isFile()) return { path: safeResult.path, deadlineExceeded: false };
      } catch (err) {
        if (err.code === "DEADLINE") return { path: null, deadlineExceeded: true };
        if (err.code !== "ENOENT") return { path: null, deadlineExceeded: false };
        continue;
      }
    }
  } finally {
    try { await withDeadline(dirHandle.close(), absoluteDeadline, "projects-dir-close"); } catch { /* best effort */ }
  }

  return { path: null, deadlineExceeded: false };
}

// ─── Streaming JSONL Parser for compact boundary ────────────────────────────

/**
 * Detect a compact boundary in a JSONL transcript.
 *
 * Real Claude Code transcript structure (canonical):
 *   { type: "system", subtype: "compact_boundary",
 *     compactMetadata: { preTokens: <number>, trigger?: "manual"|"auto" } }
 *
 * A legacy top-level boundary is accepted defensively:
 *   - record.type === "compact_boundary" (legacy)
 *
 * Summary markers are deliberately not accepted: they can remain in a
 * transcript after an earlier compaction and are not boundary evidence.
 *
 * Extracts:
 *   - preTokens: from compactMetadata.preTokens (real), then top-level fallbacks.
 *   - trigger: "manual" | "auto" | null (from compactMetadata or top-level).
 *
 * Scans forward (bounded) and returns the LAST boundary found (most recent).
 *
 * @returns {{ compacted: boolean, preTokens: number|null, trigger: string|null, observedBoundary: number|null, warning: string|null }}
 */
async function parseTranscriptForBoundary(
  filePath,
  deadlineMs,
  { startOffset = 0, discardInitialPartialLine = false } = {},
) {
  const startTime = Date.now();
  let bytesRead = 0;
  let settled = false;
  let deadlineTimer = null;
  let stream = null;
  let resolvePromise = null;

  let lastBoundary = null;
  let lineBuffer = "";
  let lineBufferBytes = 0;
  let state = discardInitialPartialLine ? "DISCARDING" : "READING";
  let invalidJsonCount = 0;

  function processLine(line) {
    if (!line.trim()) return;

    let record;
    try {
      record = JSON.parse(line);
    } catch {
      invalidJsonCount++;
      return;
    }

    // Detect compact boundary markers.
    // Canonical real structure: type:"system" + subtype:"compact_boundary".
    // Legacy top-level marker kept defensively for older CLI versions.
    const isSystemCompactBoundary =
      record.type === "system" && record.subtype === "compact_boundary";
    const isLegacyBoundary = record.type === "compact_boundary";

    if (!isSystemCompactBoundary && !isLegacyBoundary) return;

    // Extract preTokens: prefer compactMetadata.preTokens (real structure),
    // then fall back to top-level fields (legacy/alternate).
    const cm = record.compactMetadata || record.compact_metadata || {};
    let preTokens = null;
    if (typeof cm.preTokens === "number") {
      preTokens = cm.preTokens;
    } else if (typeof cm.pre_tokens === "number") {
      preTokens = cm.pre_tokens;
    } else if (typeof record.preTokens === "number") {
      preTokens = record.preTokens;
    } else if (record.tokenUsage && typeof record.tokenUsage.input_tokens === "number") {
      preTokens = record.tokenUsage.input_tokens;
    } else if (record.usage && typeof record.usage.input_tokens === "number") {
      preTokens = record.usage.input_tokens;
    } else if (typeof record.tokenCount === "number") {
      preTokens = record.tokenCount;
    }

    // Extract trigger from compactMetadata (real) or top-level (legacy)
    let trigger = null;
    if (typeof cm.trigger === "string") {
      trigger = cm.trigger;
    } else if (typeof cm.compactTrigger === "string") {
      trigger = cm.compactTrigger;
    } else if (typeof record.compactTrigger === "string") {
      trigger = record.compactTrigger;
    } else if (typeof record.trigger === "string") {
      trigger = record.trigger;
    }

    lastBoundary = {
      compacted: true,
      preTokens: Number.isFinite(preTokens) ? preTokens : null,
      trigger: trigger === "manual" || trigger === "auto" ? trigger : null,
      observedBoundary: Number.isFinite(preTokens) ? preTokens : null,
    };
  }

  function teardown() {
    if (settled) return;
    settled = true;
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
    if (stream && !stream.destroyed) { stream.destroy(); }
  }

  try {
    stream = createReadStream(filePath, {
      highWaterMark: 64 * 1024,
      start: startOffset,
    });

    const remainingMs = Math.max(0, deadlineMs - (Date.now() - startTime));
    deadlineTimer = setTimeout(() => teardown(), remainingMs);

    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

    await new Promise((resolve) => {
      resolvePromise = resolve;

      stream.on("data", (chunk) => {
        if (settled) return;

        if (Date.now() - startTime > deadlineMs) {
          teardown();
          return;
        }

        bytesRead += chunk.length;
        if (bytesRead > MAX_TRANSCRIPT_BYTES) {
          teardown();
          return;
        }

        const text = decoder.decode(chunk, { stream: true });
        const parts = text.split("\n");

        for (let i = 0; i < parts.length; i++) {
          if (settled) break;

          const isLast = i === parts.length - 1;

          if (state === "DISCARDING") {
            if (!isLast) {
              state = "READING";
              lineBuffer = "";
              lineBufferBytes = 0;
            }
            continue;
          }

          if (isLast) {
            const partBytes = Buffer.byteLength(parts[i], "utf8");
            if (lineBufferBytes + partBytes > MAX_LINE_BYTES) {
              state = "DISCARDING";
              lineBuffer = "";
              lineBufferBytes = 0;
            } else {
              lineBuffer += parts[i];
              lineBufferBytes += partBytes;
            }
          } else {
            const fullLine = lineBuffer + parts[i];
            const fullLineBytes = lineBufferBytes + Buffer.byteLength(parts[i], "utf8");

            lineBuffer = "";
            lineBufferBytes = 0;

            if (fullLineBytes > MAX_LINE_BYTES) {
              continue;
            }

            const cleanLine = fullLine.replace(/\r$/, "");
            processLine(cleanLine);

            if (settled) break;
          }
        }
      });

      stream.on("end", () => {
        if (!settled) {
          if (lineBuffer.length > 0 && state === "READING") {
            if (lineBufferBytes <= MAX_LINE_BYTES) {
              const cleanLine = lineBuffer.replace(/\r$/, "");
              processLine(cleanLine);
            }
          }
          decoder.decode(new Uint8Array(), { stream: false });
          settled = true;
          if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
        }
        resolvePromise();
      });

      stream.on("error", () => {
        if (!settled) {
          settled = true;
          if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
        }
        resolvePromise();
      });

      stream.on("close", () => {
        resolvePromise();
      });
    });
  } catch {
    // Unexpected error — return what we have
  } finally {
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
    if (stream && !stream.destroyed) { try { stream.destroy(); } catch {} }
  }

  if (lastBoundary) {
    return { ...lastBoundary, warning: invalidJsonCount > 0 ? "invalid-json-lines" : null };
  }

  return {
    compacted: false,
    preTokens: null,
    trigger: null,
    observedBoundary: null,
    warning: null,
  };
}

// ─── Main Collector ─────────────────────────────────────────────────────────

function emptyBoundary(warning) {
  return {
    compacted: false,
    preTokens: null,
    trigger: null,
    observedBoundary: null,
    warning,
  };
}

async function resolveTranscript({
  sessionId,
  claudeConfigDir,
  deadlineMs,
}) {
  if (!isValidSessionId(sessionId)) {
    return { warning: "invalid-session-id", path: null, stat: null };
  }

  const configRoot = claudeConfigDir ||
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || "", ".claude");
  if (!configRoot) {
    return { warning: "transcript-not-found", path: null, stat: null };
  }

  const absoluteDeadline = Date.now() + deadlineMs;
  let projectsDir;
  try {
    if (absoluteDeadline - Date.now() <= 0) {
      throw new DeadlineExceeded("deadline-pre-check");
    }
    const resolvedConfigRoot = await withDeadline(
      fs.promises.realpath(configRoot), absoluteDeadline, "config-root-realpath"
    );
    projectsDir = await withDeadline(
      fs.promises.realpath(path.join(configRoot, "projects")), absoluteDeadline, "projects-root-realpath"
    );
    if (!projectsDir.startsWith(resolvedConfigRoot + path.sep)) {
      return { warning: "symlink-escape", path: null, stat: null };
    }
  } catch (err) {
    return {
      warning: err.code === "DEADLINE"
        ? "scan-deadline"
        : err.code === "ENOENT"
          ? "transcript-not-found"
          : "read-error",
      path: null,
      stat: null,
    };
  }

  const findResult = await findMainTranscript(projectsDir, sessionId, absoluteDeadline);
  if (!findResult.path) {
    return {
      warning: findResult.deadlineExceeded ? "scan-deadline" : "transcript-not-found",
      path: null,
      stat: null,
    };
  }

  try {
    const stat = await withDeadline(
      fs.promises.stat(findResult.path),
      absoluteDeadline,
      "transcript-stat",
    );
    if (!stat.isFile()) {
      return { warning: "read-error", path: null, stat: null };
    }
    return {
      warning: null,
      path: findResult.path,
      stat,
      remainingMs: Math.max(0, absoluteDeadline - Date.now()),
    };
  } catch (err) {
    return {
      warning: err.code === "DEADLINE" ? "scan-deadline" : "read-error",
      path: null,
      stat: null,
    };
  }
}

/**
 * Capture a non-sensitive, in-memory transcript cursor immediately before a
 * Claude invocation. It contains only file identity, byte size, and whether
 * the size is at a JSONL line boundary; no transcript content or path.
 */
export async function captureCompactBoundaryCursor({
  sessionId,
  claudeConfigDir,
  deadlineMs = DEFAULT_DEADLINE_MS,
} = {}) {
  const resolved = await resolveTranscript({
    sessionId,
    claudeConfigDir,
    deadlineMs,
  });
  if (!resolved.path || !resolved.stat) {
    return {
      sessionId,
      exists: false,
      dev: null,
      ino: null,
      size: 0,
      endsAtLineBoundary: true,
      warning: resolved.warning,
    };
  }

  let endsAtLineBoundary = resolved.stat.size === 0;
  if (resolved.stat.size > 0) {
    let handle;
    try {
      handle = await fs.promises.open(resolved.path, "r");
      const byte = Buffer.allocUnsafe(1);
      await handle.read(byte, 0, 1, resolved.stat.size - 1);
      endsAtLineBoundary = byte[0] === 0x0a;
    } catch {
      return {
        sessionId,
        exists: false,
        dev: null,
        ino: null,
        size: 0,
        endsAtLineBoundary: true,
        warning: "read-error",
      };
    } finally {
      try { await handle?.close(); } catch { /* best effort */ }
    }
  }

  return {
    sessionId,
    exists: true,
    dev: resolved.stat.dev,
    ino: resolved.stat.ino,
    size: resolved.stat.size,
    endsAtLineBoundary,
    warning: null,
  };
}

/**
 * Collect compact boundary evidence from a Claude Code session transcript.
 *
 * @param {object} options
 * @param {string} options.sessionId - Claude session ID
 * @param {string} [options.claudeConfigDir] - Override CLAUDE_CONFIG_DIR
 * @param {number} [options.deadlineMs] - Total budget in ms (default 1000)
 * @param {object} [options.afterCursor] - Only accept boundaries appended after this cursor
 * @returns {Promise<object>} { compacted, preTokens, trigger, observedBoundary, warning }
 */
export async function collectCompactBoundary({
  sessionId,
  claudeConfigDir,
  deadlineMs = DEFAULT_DEADLINE_MS,
  afterCursor = null,
} = {}) {
  const startTime = Date.now();
  const resolved = await resolveTranscript({
    sessionId,
    claudeConfigDir,
    deadlineMs,
  });
  if (!resolved.path || !resolved.stat) {
    return emptyBoundary(resolved.warning);
  }

  let startOffset = 0;
  let discardInitialPartialLine = false;
  if (afterCursor !== null) {
    if (!afterCursor || typeof afterCursor !== "object" || afterCursor.sessionId !== sessionId) {
      return emptyBoundary("invalid-cursor");
    }
    if (afterCursor.exists === true) {
      if (resolved.stat.dev !== afterCursor.dev || resolved.stat.ino !== afterCursor.ino) {
        return emptyBoundary("transcript-replaced");
      }
      if (!Number.isSafeInteger(afterCursor.size) || afterCursor.size < 0) {
        return emptyBoundary("invalid-cursor");
      }
      if (resolved.stat.size < afterCursor.size) {
        return emptyBoundary("transcript-truncated");
      }
      if (resolved.stat.size === afterCursor.size) {
        return emptyBoundary(null);
      }
      startOffset = afterCursor.size;
      discardInitialPartialLine = afterCursor.endsAtLineBoundary !== true;
    } else if (afterCursor.exists !== false) {
      return emptyBoundary("invalid-cursor");
    } else if (afterCursor.warning && afterCursor.warning !== "transcript-not-found") {
      // An uncertain pre-invocation scan must fail closed. Reading the whole
      // transcript here could mistake a historical boundary for fresh evidence.
      return emptyBoundary(afterCursor.warning);
    }
  }

  const remainingBudget = Math.max(0, deadlineMs - (Date.now() - startTime));
  return parseTranscriptForBoundary(resolved.path, remainingBudget, {
    startOffset,
    discardInitialPartialLine,
  });
}
