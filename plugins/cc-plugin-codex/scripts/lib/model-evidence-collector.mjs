/**
 * Model evidence collector — transcript-based execution model discovery.
 *
 * Reads Claude Code session JSONL files to extract message.model values,
 * providing strong evidence of which models actually executed during a task.
 * Does NOT read settings.json, Provider APIs, or transcript content.
 *
 * Safety constraints:
 *   - sessionId strictly validated (no path traversal)
 *   - Only searches <configRoot>/projects/ first-level directories
 *   - realpath must stay within configRoot/projects (symlink escape rejection)
 *   - Async streaming line-by-line parse (not full read)
 *   - 32 MiB main transcript, 32 MiB total subagents
 *   - Global 100,000 lines across main + all subagents
 *   - 1 MiB per-line limit (MAX_LINE_BYTES), lines exceeding are discarded
 *   - 256 subagent files, 16 unique models
 *   - 1,000 ms total budget (hard deadline)
 *   - Bad JSON lines produce partial warning, don't discard evidence
 *   - Model IDs sanitized (length limit, control char removal)
 *   - Never saves transcript content, prompts, thinking, or tool arguments
 *
 * Stream state machine:
 *   - 'close' event always resolves the Promise (prevents permanent hang)
 *   - teardown() sets settled=true + stream.destroy() → 'close' fires → resolve
 *   - TOO_MANY_MODELS triggers teardown() (stream destroyed, not left reading)
 */

import fs from "node:fs";
import path from "node:path";
import { createReadStream } from "node:fs";

import {
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
} from "./model-evidence-shared.mjs";

import { isValidSessionId, normalizeModelIdForStorage } from "./model-evidence-shared.mjs";

// ─── withDeadline — hard deadline wrapper for async operations ────────────────

class DeadlineExceeded extends Error {
  constructor(label) {
    super(`deadline exceeded: ${label}`);
    this.code = "DEADLINE";
  }
}

/**
 * Race a promise against an absolute deadline.
 * Clears timer on settle. Late results are safely ignored.
 */
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

/**
 * Async realpath with symlink escape rejection.
 * Returns classified result so callers can generate accurate warnings.
 *
 * @returns {{ path: string|null, escape: boolean, error: string|null }}
 *   - path: resolved path if safe, null otherwise
 *   - escape: true if symlink escaped rootDir
 *   - error: error code if realpath failed (e.g. "ENOENT", "EACCES"), null otherwise
 */
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

// ─── Transcript Finder (async, opendir-based) ────────────────────────────────

/**
 * Find the main transcript file for a sessionId.
 * Uses async opendir with hard deadline per operation.
 * Late-resolving directory handles are closed to prevent FD leaks.
 * Returns { path: string|null, deadlineExceeded: boolean, readError: boolean, symlinkEscape: boolean }
 */
async function findMainTranscript(projectsDir, sessionId, absoluteDeadline = Infinity) {

  const opendirPromise = fs.promises.opendir(projectsDir);
  let dirHandle;
  try {
    dirHandle = await withDeadline(opendirPromise, absoluteDeadline, "projects-opendir");
  } catch (err) {
    if (err.code === "DEADLINE") {
      // Close late-arriving handle to prevent FD leak
      opendirPromise.then((h) => h.close()).catch(() => {});
      return { path: null, deadlineExceeded: true, readError: false, symlinkEscape: false };
    }
    if (err.code === "ENOENT") return { path: null, deadlineExceeded: false, readError: false, symlinkEscape: false };
    return { path: null, deadlineExceeded: false, readError: true, symlinkEscape: false };
  }

  try {
    while (true) {
      let entry;
      try {
        entry = await withDeadline(dirHandle.read(), absoluteDeadline, "projects-dir-read");
      } catch (err) {
        if (err.code === "DEADLINE") return { path: null, deadlineExceeded: true, readError: false, symlinkEscape: false };
        return { path: null, deadlineExceeded: false, readError: true, symlinkEscape: false };
      }
      if (!entry) break;

      if (!entry.isDirectory()) continue;
      const candidate = path.join(projectsDir, entry.name, `${sessionId}.jsonl`);

      // Verify realpath stays within projects dir
      let safeResult;
      try {
        safeResult = await withDeadline(safeRealPathAsync(candidate, projectsDir), absoluteDeadline, "main-realpath");
      } catch (err) {
        if (err.code === "DEADLINE") return { path: null, deadlineExceeded: true, readError: false, symlinkEscape: false };
        continue;
      }
      if (safeResult.escape) {
        return { path: null, deadlineExceeded: false, readError: false, symlinkEscape: true };
      }
      if (safeResult.error) {
        if (safeResult.error === "ENOENT") continue; // Doesn't exist — try next
        // EACCES or other error
        return { path: null, deadlineExceeded: false, readError: true, symlinkEscape: false };
      }
      if (!safeResult.path) continue;

      // Check file exists and is accessible
      try {
        const stat = await withDeadline(fs.promises.stat(safeResult.path), absoluteDeadline, "main-stat");
        if (stat.isFile()) return { path: safeResult.path, deadlineExceeded: false, readError: false, symlinkEscape: false };
      } catch (err) {
        if (err.code === "DEADLINE") return { path: null, deadlineExceeded: true, readError: false, symlinkEscape: false };
        if (err.code !== "ENOENT") {
          return { path: null, deadlineExceeded: false, readError: true, symlinkEscape: false };
        }
        continue;
      }
    }
  } finally {
    try { await withDeadline(dirHandle.close(), absoluteDeadline, "projects-dir-close"); } catch { /* best effort */ }
  }

  return { path: null, deadlineExceeded: false, readError: false, symlinkEscape: false };
}

/**
 * Find subagent transcript files for a sessionId.
 * Uses async opendir with hard deadline per operation.
 * Late-resolving directory handles are closed to prevent FD leaks.
 * Returns { files: string[], warnings: string[], deadlineExceeded: boolean, readError: boolean }
 */
async function findSubagentTranscripts(projectsDir, sessionId, projectDir, absoluteDeadline = Infinity) {
  const subagentsDir = path.join(projectDir, sessionId, "subagents");

  const opendirPromise = fs.promises.opendir(subagentsDir);
  let dirHandle;
  try {
    dirHandle = await withDeadline(opendirPromise, absoluteDeadline, "subagents-opendir");
  } catch (err) {
    if (err.code === "DEADLINE") {
      opendirPromise.then((h) => h.close()).catch(() => {});
      return { files: [], warnings: [WARNINGS.SCAN_DEADLINE], deadlineExceeded: true, readError: false };
    }
    if (err.code === "ENOENT") return { files: [], warnings: [], deadlineExceeded: false, readError: false };
    return { files: [], warnings: [WARNINGS.READ_ERROR], deadlineExceeded: false, readError: true };
  }

  const warnings = [];
  const files = [];
  let totalFound = 0;

  try {
    while (true) {
      let entry;
      try {
        entry = await withDeadline(dirHandle.read(), absoluteDeadline, "subagents-dir-read");
      } catch (err) {
        if (err.code === "DEADLINE") {
          if (!warnings.includes(WARNINGS.SCAN_DEADLINE)) warnings.push(WARNINGS.SCAN_DEADLINE);
          return { files, warnings, deadlineExceeded: true, readError: false };
        }
        if (!warnings.includes(WARNINGS.READ_ERROR)) warnings.push(WARNINGS.READ_ERROR);
        return { files, warnings, deadlineExceeded: false, readError: true };
      }
      if (!entry) break;

      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".jsonl")) continue;
      totalFound++;

      if (files.length >= MAX_SUBAGENT_FILES) continue;

      const candidate = path.join(subagentsDir, entry.name);
      let safeResult;
      try {
        safeResult = await withDeadline(safeRealPathAsync(candidate, projectsDir), absoluteDeadline, "subagent-realpath");
      } catch (err) {
        if (err.code === "DEADLINE") {
          if (!warnings.includes(WARNINGS.SCAN_DEADLINE)) warnings.push(WARNINGS.SCAN_DEADLINE);
          return { files, warnings, deadlineExceeded: true, readError: false };
        }
        continue;
      }
      if (safeResult.escape) {
        if (!warnings.includes(WARNINGS.SYMLINK_ESCAPE)) warnings.push(WARNINGS.SYMLINK_ESCAPE);
        continue;
      }
      if (safeResult.error) {
        if (safeResult.error !== "ENOENT" && !warnings.includes(WARNINGS.READ_ERROR)) {
          warnings.push(WARNINGS.READ_ERROR);
        }
        continue;
      }
      if (!safeResult.path) continue;

      try {
        const stat = await withDeadline(fs.promises.stat(safeResult.path), absoluteDeadline, "subagent-stat");
        if (stat.isFile()) files.push(safeResult.path);
      } catch (err) {
        if (err.code === "DEADLINE") {
          if (!warnings.includes(WARNINGS.SCAN_DEADLINE)) warnings.push(WARNINGS.SCAN_DEADLINE);
          return { files, warnings, deadlineExceeded: true, readError: false };
        }
        if (err.code !== "ENOENT" && !warnings.includes(WARNINGS.READ_ERROR)) {
          warnings.push(WARNINGS.READ_ERROR);
        }
        continue;
      }
    }
  } finally {
    try { await withDeadline(dirHandle.close(), absoluteDeadline, "subagents-dir-close"); } catch { /* best effort */ }
  }

  if (totalFound > MAX_SUBAGENT_FILES) {
    warnings.push(WARNINGS.TOO_MANY_SUBAGENTS);
  }

  return { files, warnings, deadlineExceeded: false, readError: false };
}

// ─── Streaming JSONL Parser (chunk-based, readline-free) ──────────────────────

/**
 * Async chunk-based parse of a JSONL file, extracting model IDs from
 * assistant messages. Replaces readline to prevent single long line
 * from bypassing byte budget.
 *
 * State machine: READING | DISCARDING
 *   READING   — normal line accumulation
 *   DISCARDING — discarding chunks until next newline (line too long)
 *
 * Stream settle/close contract:
 *   - 'close' event ALWAYS resolves the Promise (prevents permanent hang)
 *   - teardown() sets settled=true + stream.destroy() → 'close' fires → resolve
 *   - 'end' and 'error' also resolve; subsequent 'close' is a no-op
 *   - TOO_MANY_MODELS triggers teardown() (stream destroyed, not left reading)
 *
 * @returns {{ models: Map, warnings: string[], linesParsed: number, bytesRead: number }}
 */
export async function parseTranscriptModels(filePath, scope, options = {}) {
  const {
    maxBytes = MAX_MAIN_TRANSCRIPT_BYTES,
    maxLineBytes = MAX_LINE_BYTES,
    maxLines = MAX_LINES,
    deadlineMs = DEFAULT_DEADLINE_MS,
    existingModels = new Map(),
    existingWarnings = [],
    totalLinesCounter = { value: 0 },
    streamFactory = createReadStream,
  } = options;

  const models = existingModels;
  const warnings = existingWarnings;
  let linesParsed = 0;
  let bytesRead = 0;
  let invalidJsonCount = 0;
  const startTime = Date.now();

  let state = "READING"; // READING | DISCARDING
  let lineBuffer = "";
  let lineBufferBytes = 0;
  let settled = false;
  let deadlineTimer = null;
  let stream = null;
  let resolvePromise = null;

  if (deadlineMs <= 0) {
    if (!warnings.includes(WARNINGS.SCAN_DEADLINE)) warnings.push(WARNINGS.SCAN_DEADLINE);
    return { models, warnings, linesParsed, bytesRead };
  }

  function addWarning(code) {
    if (!warnings.includes(code)) warnings.push(code);
  }

  function processLine(line) {
    linesParsed++;
    totalLinesCounter.value++;

    // Skip empty lines
    if (!line.trim()) return;

    // Parse JSON
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      invalidJsonCount++;
      return;
    }

    // Only accept assistant messages with model
    if (record.type !== "assistant") return;
    if (!record.message || record.message.role !== "assistant") return;
    if (typeof record.message.model !== "string" || !record.message.model) return;

    const rawModel = record.message.model;
    const normalized = normalizeModelIdForStorage(rawModel);
    if (!normalized) return;

    // Check unique model limit — teardown stream to stop reading
    if (models.size >= MAX_UNIQUE_MODELS && !models.has(normalized)) {
      addWarning(WARNINGS.TOO_MANY_MODELS);
      teardown("too-many-models");
      return;
    }

    // Track model with scope
    if (models.has(normalized)) {
      models.get(normalized).scopes.add(scope);
    } else {
      models.set(normalized, { scopes: new Set([scope]), source: "claude-transcript" });
    }

    // Check if model ID was truncated (original byte length exceeded limit)
    if (Buffer.byteLength(rawModel, "utf8") > MAX_MODEL_ID_BYTES) {
      addWarning(WARNINGS.MODEL_ID_TRUNCATED);
    }
  }

  function teardown(reason) {
    if (settled) return;
    settled = true;
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
    if (stream && !stream.destroyed) { stream.destroy(); }
    if (reason === "deadline") addWarning(WARNINGS.SCAN_DEADLINE);
    if (reason === "size") addWarning(WARNINGS.SIZE_LIMIT);
    if (reason === "lines") addWarning(WARNINGS.TOO_MANY_LINES);
    // Promise is resolved by the 'close' event on the stream,
    // which always fires after stream.destroy().
  }

  try {
    stream = streamFactory(filePath, { highWaterMark: 64 * 1024 });

    // Active deadline timer — terminates stalled stream
    const remainingMs = Math.max(0, deadlineMs - (Date.now() - startTime));
    deadlineTimer = setTimeout(() => teardown("deadline"), remainingMs);

    const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });

    await new Promise((resolve) => {
      resolvePromise = resolve;

      stream.on("data", (chunk) => {
        if (settled) return;

        // Check deadline on each chunk
        if (Date.now() - startTime > deadlineMs) {
          teardown("deadline");
          return;
        }

        // Track bytes
        bytesRead += chunk.length;
        if (bytesRead > maxBytes) {
          teardown("size");
          return;
        }

        // Check global line limit
        if (totalLinesCounter.value >= maxLines) {
          teardown("lines");
          return;
        }

        // Decode chunk (handles cross-chunk UTF-8)
        const text = decoder.decode(chunk, { stream: true });

        // Split on \n, process complete lines
        const parts = text.split("\n");

        for (let i = 0; i < parts.length; i++) {
          if (settled) break;

          const isLast = i === parts.length - 1;

          if (state === "DISCARDING") {
            // In DISCARDING state — skip until we see a newline
            // A non-last part means we hit a newline, return to READING
            if (!isLast) {
              state = "READING";
              lineBuffer = "";
              lineBufferBytes = 0;
            }
            continue;
          }

          // READING state
          if (isLast) {
            // Last part is incomplete — accumulate in lineBuffer
            const partBytes = Buffer.byteLength(parts[i], "utf8");
            if (lineBufferBytes + partBytes > maxLineBytes) {
              // Line buffer exceeds per-line limit → discard
              addWarning(WARNINGS.LINE_TOO_LONG);
              state = "DISCARDING";
              lineBuffer = "";
              lineBufferBytes = 0;
            } else {
              lineBuffer += parts[i];
              lineBufferBytes += partBytes;
            }
          } else {
            // Complete line (newline found)
            const fullLine = lineBuffer + parts[i];
            const fullLineBytes = lineBufferBytes + Buffer.byteLength(parts[i], "utf8");

            // Reset buffer for next line
            lineBuffer = "";
            lineBufferBytes = 0;

            // Check per-line byte limit
            if (fullLineBytes > maxLineBytes) {
              addWarning(WARNINGS.LINE_TOO_LONG);
              continue; // Discard this line, stay in READING
            }

            // Strip \r for CRLF handling
            const cleanLine = fullLine.replace(/\r$/, "");

            // Check global line limit
            if (totalLinesCounter.value >= maxLines) {
              teardown("lines");
              break;
            }

            // Process the complete line
            processLine(cleanLine);

            if (settled) break;
          }
        }
      });

      stream.on("end", () => {
        if (!settled) {
          // Process any remaining lineBuffer (last line without newline)
          if (lineBuffer.length > 0 && state === "READING") {
            if (lineBufferBytes <= maxLineBytes) {
              const cleanLine = lineBuffer.replace(/\r$/, "");
              if (totalLinesCounter.value < maxLines) {
                processLine(cleanLine);
              }
            }
          }

          // Flush decoder
          decoder.decode(new Uint8Array(), { stream: false });

          settled = true;
          if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
        }
        resolvePromise();
      });

      stream.on("error", (err) => {
        if (!settled) {
          settled = true;
          if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
          // EACCES is also a read error
          if (err.code !== "ENOENT") {
            addWarning(WARNINGS.READ_ERROR);
          }
        }
        resolvePromise();
      });

      stream.on("close", () => {
        // Always resolve — ensures Promise settles even after destroy().
        // This is the critical fix for the permanent hang bug:
        // teardown() calls stream.destroy() which emits 'close',
        // but neither 'end' nor 'error' may fire after destroy().
        // Promise.resolve is idempotent — subsequent calls are no-ops.
        resolvePromise();
      });
    });

  } catch (err) {
    // Unexpected error — keep what we have
    if (err.code !== "ENOENT" && err.code !== "EACCES") {
      addWarning(WARNINGS.READ_ERROR);
    }
  } finally {
    if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null; }
    if (stream && !stream.destroyed) { try { stream.destroy(); } catch {} }
  }

  if (invalidJsonCount > 0 && !warnings.includes(WARNINGS.INVALID_JSON_LINES)) {
    warnings.push(WARNINGS.INVALID_JSON_LINES);
  }

  return { models, warnings, linesParsed, bytesRead };
}

// ─── Main Collector ─────────────────────────────────────────────────────────

/**
 * Collect model evidence from Claude Code transcript files.
 *
 * @param {object} options
 * @param {string} options.sessionId - Claude session ID
 * @param {string[]} options.usageModelKeys - Keys from modelUsage in final JSON
 * @param {string} [options.claudeConfigDir] - Override CLAUDE_CONFIG_DIR
 * @param {number} [options.deadlineMs] - Total budget in ms (default 1000)
 * @returns {Promise<object>} modelEvidence structure for job v4
 */
export async function collectModelEvidence({
  sessionId,
  usageModelKeys = [],
  claudeConfigDir,
  deadlineMs = DEFAULT_DEADLINE_MS,
}) {
  const startTime = Date.now();

  // Validate sessionId
  if (!isValidSessionId(sessionId)) {
    return {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: normalizeUsageKeys(usageModelKeys),
      usageSource: "claude-result-modelUsage",
      warnings: [WARNINGS.INVALID_SESSION_ID],
    };
  }

  // Determine config root
  const configRoot = claudeConfigDir ||
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(process.env.HOME || "", ".claude");

  if (!configRoot) {
    return {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: normalizeUsageKeys(usageModelKeys),
      usageSource: "claude-result-modelUsage",
      warnings: [WARNINGS.TRANSCRIPT_NOT_FOUND],
    };
  }

  // Resolve and validate the search root itself before trusting it as the
  // containment boundary. Otherwise a symlinked <configRoot>/projects could
  // redefine the boundary to an arbitrary external directory.
  const absoluteDeadline = startTime + deadlineMs;
  let projectsDir;
  try {
    const resolvedConfigRoot = await withDeadline(
      fs.promises.realpath(configRoot), absoluteDeadline, "config-root-realpath"
    );
    projectsDir = await withDeadline(
      fs.promises.realpath(path.join(configRoot, "projects")), absoluteDeadline, "projects-root-realpath"
    );
    if (!projectsDir.startsWith(resolvedConfigRoot + path.sep)) {
      return {
        status: "unavailable",
        executedModels: [],
        usageModelKeys: normalizeUsageKeys(usageModelKeys),
        usageSource: "claude-result-modelUsage",
        warnings: [WARNINGS.SYMLINK_ESCAPE],
      };
    }
  } catch (err) {
    const warning = err.code === "DEADLINE"
      ? WARNINGS.SCAN_DEADLINE
      : err.code === "ENOENT"
        ? WARNINGS.TRANSCRIPT_NOT_FOUND
        : WARNINGS.READ_ERROR;
    return {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: normalizeUsageKeys(usageModelKeys),
      usageSource: "claude-result-modelUsage",
      warnings: [warning],
    };
  }

  // Find main transcript with retries, respecting deadline
  let findResult = { path: null, deadlineExceeded: false, readError: false };
  let retryCount = 0;
  const remainingBudget = () => Math.max(0, deadlineMs - (Date.now() - startTime));
  findResult = await findMainTranscript(projectsDir, sessionId, absoluteDeadline);

  // If deadline exceeded, stop immediately — no retry
  while (!findResult.path && !findResult.deadlineExceeded && !findResult.readError && retryCount < MAX_RETRIES && remainingBudget() > RETRY_WAIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS));
    retryCount++;
    findResult = await findMainTranscript(projectsDir, sessionId, absoluteDeadline);
  }

  // Classify the reason for not finding the transcript
  if (!findResult.path) {
    const warnings = findResult.deadlineExceeded
      ? [WARNINGS.SCAN_DEADLINE]
      : findResult.readError
        ? [WARNINGS.READ_ERROR]
        : findResult.symlinkEscape
          ? [WARNINGS.SYMLINK_ESCAPE]
          : [WARNINGS.TRANSCRIPT_NOT_FOUND];
    return {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: normalizeUsageKeys(usageModelKeys),
      usageSource: "claude-result-modelUsage",
      warnings,
    };
  }

  const mainTranscriptPath = findResult.path;

  // Shared line counter across main + all subagents (global 100k limit)
  const totalLinesCounter = { value: 0 };

  // Parse main transcript
  const parseBudget = remainingBudget();
  const mainResult = await parseTranscriptModels(mainTranscriptPath, "main", {
    maxBytes: MAX_MAIN_TRANSCRIPT_BYTES,
    maxLines: MAX_LINES,
    deadlineMs: parseBudget,
    existingModels: new Map(),
    existingWarnings: [],
    totalLinesCounter,
  });

  // Find and parse subagent transcripts
  // Determine project directory from main transcript path
  const projectDir = path.dirname(mainTranscriptPath);
  const { files: subagentFiles, warnings: subagentWarnings, deadlineExceeded: subDeadline, readError: subReadError } = await findSubagentTranscripts(
    projectsDir, sessionId, projectDir, absoluteDeadline
  );

  // Merge subagent discovery warnings
  for (const w of subagentWarnings) {
    if (!mainResult.warnings.includes(w)) {
      mainResult.warnings.push(w);
    }
  }

  // Parse subagent files with shared byte budget
  let subagentBytesRead = 0;
  for (const subagentFile of subagentFiles) {
    if (Date.now() - startTime > deadlineMs) {
      if (!mainResult.warnings.includes(WARNINGS.SCAN_DEADLINE)) {
        mainResult.warnings.push(WARNINGS.SCAN_DEADLINE);
      }
      break;
    }

    // Pre-check subagent byte budget with async stat (optimization)
    try {
      const stat = await withDeadline(fs.promises.stat(subagentFile), absoluteDeadline, "subagent-prestat");
      if (subagentBytesRead + stat.size > MAX_SUBAGENT_TOTAL_BYTES) {
        if (!mainResult.warnings.includes(WARNINGS.SIZE_LIMIT)) {
          mainResult.warnings.push(WARNINGS.SIZE_LIMIT);
        }
        break;
      }
      // Don't add stat.size yet — use actual bytes from streaming parser
    } catch (err) {
      if (err.code === "DEADLINE") {
        if (!mainResult.warnings.includes(WARNINGS.SCAN_DEADLINE)) {
          mainResult.warnings.push(WARNINGS.SCAN_DEADLINE);
        }
        break;
      }
      if (!mainResult.warnings.includes(WARNINGS.READ_ERROR)) {
        mainResult.warnings.push(WARNINGS.READ_ERROR);
      }
      continue; // stat failed — preserve partial evidence and continue
    }

    // Parse with remaining byte budget
    const subBudget = remainingBudget();
    const subMaxBytes = Math.max(0, MAX_SUBAGENT_TOTAL_BYTES - subagentBytesRead);
    const subResult = await parseTranscriptModels(subagentFile, "subagent", {
      maxBytes: subMaxBytes,
      maxLines: MAX_LINES,
      deadlineMs: subBudget,
      existingModels: mainResult.models,
      existingWarnings: mainResult.warnings,
      totalLinesCounter,
    });
    subagentBytesRead += subResult.bytesRead;
  }

  // Build executedModels array (preserving first-seen order)
  const executedModels = [];
  for (const [id, info] of mainResult.models) {
    executedModels.push({
      id,
      source: info.source,
      scopes: [...info.scopes].sort(),
    });
  }

  // Determine status
  let status = "complete";
  if (executedModels.length === 0) {
    status = mainResult.warnings.length > 0 ? "partial" : "unavailable";
  } else if (mainResult.warnings.length > 0) {
    status = "partial";
  }

  return {
    status,
    executedModels,
    usageModelKeys: normalizeUsageKeys(usageModelKeys),
    usageSource: "claude-result-modelUsage",
    warnings: mainResult.warnings,
  };
}

// ─── Usage Key Normalization ────────────────────────────────────────────────

/**
 * Normalize usageModelKeys: sanitize, dedup, limit to 16.
 */
function normalizeUsageKeys(keys) {
  if (!Array.isArray(keys)) return [];
  const seen = new Set();
  const result = [];
  for (const key of keys) {
    if (typeof key !== "string" || !key) continue;
    const sanitized = normalizeModelIdForStorage(key);
    if (!sanitized || seen.has(sanitized)) continue;
    seen.add(sanitized);
    result.push(sanitized);
    if (result.length >= MAX_UNIQUE_MODELS) break;
  }
  return result;
}

/**
 * Extract usageModelKeys from Claude final JSON modelUsage object.
 * Returns all keys (not just first), sanitized and bounded.
 */
export function extractUsageModelKeys(modelUsage) {
  if (!modelUsage || typeof modelUsage !== "object" || Array.isArray(modelUsage)) {
    return [];
  }
  try {
    return normalizeUsageKeys(Object.keys(modelUsage));
  } catch {
    return [];
  }
}
