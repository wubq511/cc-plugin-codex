#!/usr/bin/env node

/**
 * Watchdog — supervised Claude runner.
 *
 * Communication channels:
 *   stdin              — one-time JSON config (closed after read)
 *   IPC (process.send) — long-lived control channel from companion
 *                          "cancel" message → terminate Claude
 *                          disconnect → companion died → terminate Claude
 *   stdout             — structured JSON result to companion
 *
 * Claude is spawned with stdin=pipe; the task is written to Claude's stdin
 * and closed. The task never appears in any process argv.
 *
 * Exit codes follow the shared contract in `../lib/exit-codes.mjs`:
 *   0 = success · 1 = Claude failed / config error · 2 = timeout ·
 *   3 = output limit exceeded · 4 = cancelled (IPC disconnect or cancel)
 */

import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  extractContextWindow,
  extractUsageModelKeys,
  extractUsageTokens,
} from "../lib/model-evidence.mjs";
import { resolveCommandForSpawn, terminateProcessTree } from "../lib/process.mjs";
import {
  buildFailureEnvelope,
  classifyFailureStage,
  buildSafeErrorMessage,
  FAILURE_STAGES,
} from "../lib/diagnostics.mjs";
import {
  EXIT_SUCCESS,
  EXIT_FAILURE,
  EXIT_TIMEOUT,
  EXIT_OUTPUT_LIMIT,
  EXIT_CANCELLED,
} from "../lib/exit-codes.mjs";

const DEFAULT_MAX_CAPTURE = 8 * 1024 * 1024; // 8 MiB

// ── Stream-json event forwarding ──────────────────────────────────────
// Claude is invoked with --output-format stream-json --verbose. Each stdout
// line is one NDJSON event. Intermediate events (system/assistant/user) are
// forwarded to the companion over IPC for the live dashboard; the final
// type:"result" event is the authoritative result source. Forwarded events
// are bounded (per-field byte truncation + total count cap) and never written
// to disk — the task-content privacy contract is preserved.
const MAX_STREAM_EVENTS = 5000;
const MAX_FIELD_BYTES = 4096;
// A single newline-free line must not grow lineBuffer unbounded, bypassing
// the 8 MiB capture cap. Legitimate stream-json lines are bounded (fields are
// truncated to MAX_FIELD_BYTES elsewhere), so anything past 1 MiB is noise.
const MAX_LINE_BYTES = 1 * 1024 * 1024;
let lineBuffer = "";
let finalResultObj = null;
let streamEventCount = 0;
const stdoutDecoder = new StringDecoder("utf8");

let child = null;
let settled = false;
let terminationReason = null;
const stdoutChunks = [];
const stderrChunks = [];
let capturedBytes = 0;
let maxCapture = DEFAULT_MAX_CAPTURE;

function terminate(reason) {
  if (terminationReason === null) terminationReason = reason;
  if (!child?.pid) return;

  // Send SIGTERM first (graceful)
  terminateProcessTree(child.pid, "SIGTERM");

  // Force kill after 1 second if still alive
  setTimeout(() => {
    if (!settled && child?.pid) {
      terminateProcessTree(child.pid, "SIGKILL");
    }
  }, 1000).unref?.();
}

function capture(chunks, chunk) {
  if (terminationReason === "output-limit") return;
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  if (capturedBytes + buffer.length > maxCapture) {
    terminate("output-limit");
    return;
  }
  capturedBytes += buffer.length;
  chunks.push(buffer);
}

// Truncate a string to at most maxBytes of UTF-8, appending an ellipsis marker
// when truncated. Keeps multi-byte characters intact: back off trailing bytes
// that would split a UTF-8 sequence (continuation bytes match 0b10xxxxxx; a
// sequence is at most 4 bytes, so at most 3 back-offs).
function truncateToBytes(str, maxBytes) {
  const buf = Buffer.from(str, "utf8");
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  for (let backoffs = 0; end > 0 && backoffs < 3 && (buf[end] & 0xc0) === 0x80; backoffs++) {
    end--;
  }
  return buf.subarray(0, end).toString("utf8") + "…[truncated]";
}

// Recursively bound an event payload: truncate every string field to
// MAX_FIELD_BYTES. Nested arrays/objects are walked. Non-string values pass
// through unchanged. Keeps the dashboard feed bounded regardless of Claude
// output size.
function boundEvent(value) {
  if (typeof value === "string") return truncateToBytes(value, MAX_FIELD_BYTES);
  if (Array.isArray(value)) return value.map(boundEvent);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value)) out[key] = boundEvent(value[key]);
    return out;
  }
  return value;
}

// Forward one intermediate stream event to the companion over IPC. Wrapped in
// try/catch so a closed/unavailable IPC channel never crashes the watchdog —
// the final result is still delivered via stdout. Total event count is capped
// to bound memory and IPC traffic.
function forwardEvent(event) {
  if (streamEventCount >= MAX_STREAM_EVENTS) return;
  streamEventCount++;
  if (typeof process.send !== "function") return;
  try {
    process.send({ kind: "claude_event", event: boundEvent(event) });
  } catch {
    // IPC channel closed (companion gone) — silently drop; stdout result still lands.
  }
}

// Parse one NDJSON line. The type:"result" line is stored as the authoritative
// final result; all other lines are forwarded as intermediate events. Malformed
// lines are skipped (Claude occasionally emits non-JSON fragments on stderr mix).
function processStreamLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return; // not a JSON line — skip
  }
  if (!parsed || typeof parsed !== "object") return;
  if (parsed.type === "result") {
    // Last result event wins (there is normally exactly one).
    finalResultObj = parsed;
    return;
  }
  forwardEvent(parsed);
}

// Incrementally decode and split Claude stdout into NDJSON lines. Uses a
// StringDecoder so multi-byte UTF-8 characters split across chunk boundaries
// are reassembled correctly.
function processStreamChunk(chunk) {
  lineBuffer += stdoutDecoder.write(chunk);
  let nl;
  while ((nl = lineBuffer.indexOf("\n")) >= 0) {
    const line = lineBuffer.slice(0, nl);
    lineBuffer = lineBuffer.slice(nl + 1);
    processStreamLine(line);
  }
  if (lineBuffer.length > MAX_LINE_BYTES) {
    // Oversized newline-free fragment — drop it as noise. The remainder of
    // the line (up to the next newline) fails JSON.parse and is skipped; the
    // whole-stdout JSON.parse fallback is unaffected because stdoutChunks are
    // captured separately under the 8 MiB cap.
    lineBuffer = "";
  }
}

// Flush any final partial line (the result event may arrive without a trailing
// newline). Called once when Claude's stdout closes.
function flushStreamBuffer() {
  try {
    const tail = stdoutDecoder.end();
    if (tail) lineBuffer += tail;
  } catch {
    // decoder already ended — ignore
  }
  if (lineBuffer.trim()) processStreamLine(lineBuffer);
  lineBuffer = "";
}

function writeResult(result) {
  try {
    process.stdout.write(JSON.stringify(result));
  } catch {
    // stdout may be broken (companion died)
  }
}

let exitCalled = false;
function exitWith(code) {
  if (exitCalled) return; // Prevent re-entry
  exitCalled = true;
  process.exitCode = code;
  // Destroy child streams and unref child process
  try { child?.stdin?.destroy(); } catch {}
  try { child?.stdout?.destroy(); } catch {}
  try { child?.stderr?.destroy(); } catch {}
  try { child?.unref?.(); } catch {}
  // Disconnect IPC channel — this removes the main event-loop blocker
  try { process.disconnect(); } catch {}
  // Unref all remaining active handles so event loop can drain
  try {
    const handles = process._getActiveHandles?.() ?? [];
    for (const h of handles) {
      try { h.unref?.(); } catch {}
    }
  } catch {}
}

async function main() {
  // ── Phase 1: Read one-time config from stdin ──
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  if (!input.trim()) {
    exitWith(EXIT_CANCELLED);
    return;
  }

  let config;
  try {
    config = JSON.parse(input);
  } catch {
    process.stderr.write("[watchdog] Invalid config JSON\n");
    exitWith(EXIT_FAILURE);
    return;
  }

  const {
    task,
    cwd = process.cwd(),
    write = true,
    model = null,
    effort = null,
    dangerouslySkipPermissions = false,
    resume = false,
    resumeSession = null,
    sessionId = null,
    timeoutMs = null,
    maxCaptureBytes = DEFAULT_MAX_CAPTURE,
    command = "claude",
    childEnv = null,
    routeSnapshot = null,
    cliVersion = null,
    maxBudgetUsd = null,
    inlineSettings = null
  } = config;

  maxCapture = maxCaptureBytes;

  if (!task) {
    process.stderr.write("[watchdog] Missing task\n");
    exitWith(EXIT_FAILURE);
    return;
  }

  // ── Phase 2: Set up IPC control channel ──
  // "cancel" message from companion → terminate Claude
  // "disconnect" event → companion died → terminate Claude
  if (typeof process.send === "function") {
    process.on("message", (msg) => {
      if (msg === "cancel") {
        if (!settled) terminate("cancelled");
      }
    });
    process.on("disconnect", () => {
      // Companion died — terminate Claude
      if (!settled) terminate("cancelled");
    });
  }

  // ── Phase 3: Build Claude args (task via stdin, never argv) ──
  // stream-json + --verbose: Claude emits one NDJSON event per line on stdout
  // (system/assistant/user/result). The watchdog parses incrementally and
  // forwards intermediate events over IPC for the live dashboard; the final
  // type:"result" event is the authoritative result source. --verbose is
  // required by stream-json with --print. The task is delivered via stdin
  // (--input-format text), never in argv.
  const args = ["--print", "--input-format", "text", "--output-format", "stream-json", "--verbose"];
  if (dangerouslySkipPermissions === true) args.push("--dangerously-skip-permissions");
  if (model) args.push("--model", model);
  if (maxBudgetUsd && Number.isFinite(maxBudgetUsd) && maxBudgetUsd > 0) {
    args.push("--max-budget-usd", String(maxBudgetUsd));
  }
  if (effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)) args.push("--effort", effort);
  if (write === false) {
    // Strict read-only: only Read, Glob, Grep — NO Bash
    args.push("--allowedTools", "Read,Glob,Grep");
  }
  if (resumeSession) {
    args.push("--resume", resumeSession);
  } else if (sessionId) {
    // Pre-allocated session UUID for new (non-resume) delegations.
    // --session-id and --resume are mutually exclusive: --session-id starts a
    // new conversation with a caller-chosen UUID, --resume continues an
    // existing one. The UUID is generated by the companion before spawn.
    args.push("--session-id", sessionId);
  }
  // Inline --settings: injects compact env keys for this CLI invocation only.
  // The settings JSON is passed as a single argv element — never written to
  // ~/.claude/**, project .claude/, or parent process.env. Contains only two
  // non-secret env keys (CLAUDE_CODE_AUTO_COMPACT_WINDOW, CLAUDE_AUTOCOMPACT_PCT_OVERRIDE).
  if (inlineSettings && typeof inlineSettings === "string") {
    args.push("--settings", inlineSettings);
  }

  // ── Phase 4: Spawn Claude with stdin=pipe ──
  // Task is written to Claude stdin, never appears in argv.
  // Use the inherited child environment unchanged; native Claude owns its configuration.
  const startTime = Date.now();
  try {
    const resolved = resolveCommandForSpawn(command, args);
    child = spawn(resolved.command, resolved.args, {
      cwd,
      env: childEnv || process.env,
      // On POSIX, make Claude the leader of its own process group so the
      // watchdog can terminate Claude plus tool/subagent descendants. Windows
      // uses taskkill /T in terminateProcessTree instead.
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: resolved.shell
    });
  } catch (err) {
    process.stderr.write(`[watchdog] Failed to spawn: ${err.message}\n`);
    const stage = FAILURE_STAGES.SPAWN;
    writeResult({
      ok: false,
      error: buildSafeErrorMessage(stage, err.message),
      exitCode: -1,
      failureStage: stage,
      diagnostics: buildFailureEnvelope({
        stage,
        requestedSelector: routeSnapshot ? { kind: routeSnapshot.selectorKind, value: routeSnapshot.requestedValue } : null,
        effort,
        cliVersion,
        exitCode: -1,
        signal: null,
        durationMs: Date.now() - startTime,
        stdout: "",
        stderr: err.message,
        structuredError: false,
        taskMarkers: [task],
      }),
    });
    exitWith(EXIT_FAILURE);
    return;
  }

  // Write task to Claude's stdin then close
  try {
    child.stdin.write(task);
    child.stdin.end();
  } catch {
    // stdin write failed — Claude may have exited already
  }

  // Capture output (bounded for diagnostics + capture-limit) and parse
  // stream-json lines incrementally for IPC event forwarding + result extraction.
  child.stdout.on("data", (chunk) => {
    capture(stdoutChunks, chunk);
    processStreamChunk(chunk);
  });
  child.stderr.on("data", (chunk) => capture(stderrChunks, chunk));

  // Handle child error (e.g., ENOENT)
  child.once("error", (err) => {
    if (settled) return;
    settled = true;
    const stage = FAILURE_STAGES.SPAWN;
    writeResult({
      ok: false,
      error: buildSafeErrorMessage(stage, err.message || String(err)),
      exitCode: -1,
      failureStage: stage,
      diagnostics: buildFailureEnvelope({
        stage,
        requestedSelector: routeSnapshot ? { kind: routeSnapshot.selectorKind, value: routeSnapshot.requestedValue } : null,
        effort,
        cliVersion,
        exitCode: -1,
        signal: null,
        durationMs: Date.now() - startTime,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        structuredError: false,
        taskMarkers: [task],
      }),
    });
    exitWith(EXIT_FAILURE);
  });

  // Handle child exit
  child.once("close", (code, signal) => {
    if (settled) return;
    settled = true;

    // Flush the final partial stream-json line (the result event may arrive
    // without a trailing newline) so finalResultObj is fully populated.
    flushStreamBuffer();

    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    const durationMs = Date.now() - startTime;
    const requestedSelector = routeSnapshot
      ? { kind: routeSnapshot.selectorKind, value: routeSnapshot.requestedValue }
      : null;

    // Helper: build a failure result with diagnostics
    function failResult(stage, exitCodeVal, opts = {}) {
      const { cancelled = false, structuredError = false, parsedError = null, sessionId = null, usageKey = null, transcriptFound = false } = opts;
      const errorDetail = opts.errorDetail || (structuredError && parsedError
        ? (typeof parsedError?.error === "string" ? parsedError.error : typeof parsedError?.result === "string" ? parsedError.result : null)
        : null) || stderr || null;
      return {
        ok: false,
        cancelled,
        error: buildSafeErrorMessage(stage, errorDetail),
        exitCode: exitCodeVal,
        failureStage: stage,
        diagnostics: buildFailureEnvelope({
          stage,
          requestedSelector,
          effort,
          cliVersion,
          exitCode: exitCodeVal,
          signal: signal || null,
          durationMs,
          structuredError,
          sessionId,
          usageKey,
          transcriptFound,
          errorDetail,
          stdout,
          stderr,
          taskMarkers: [task],
        }),
      };
    }

    if (terminationReason === "output-limit") {
      const stage = FAILURE_STAGES.PROVIDER_RESPONSE;
      writeResult(failResult(stage, code ?? -1, {
        errorDetail: `Claude output exceeded the ${maxCaptureBytes}-byte capture limit and was terminated.`,
      }));
      exitWith(EXIT_OUTPUT_LIMIT);
      return;
    }

    if (terminationReason === "timeout") {
      const stage = FAILURE_STAGES.TIMEOUT;
      writeResult(failResult(stage, code ?? -1, {
        errorDetail: `Claude task timed out after ${timeoutMs}ms and was terminated.`,
      }));
      exitWith(EXIT_TIMEOUT);
      return;
    }

    if (terminationReason === "cancelled") {
      const stage = FAILURE_STAGES.CANCELLED;
      writeResult({
        ok: false,
        cancelled: true,
        error: buildSafeErrorMessage(stage, "Claude task was cancelled."),
        exitCode: code ?? -1,
        failureStage: stage,
        diagnostics: buildFailureEnvelope({
          stage,
          requestedSelector,
          effort,
          cliVersion,
          exitCode: code ?? -1,
          signal: signal || null,
          durationMs,
          stdout,
          stderr,
          structuredError: false,
          taskMarkers: [task],
        }),
      });
      exitWith(EXIT_CANCELLED);
      return;
    }

    // Non-zero exit: inspect BOTH stdout and stderr (P0 fix — previously only stderr was used)
    if (code !== 0) {
      // Try to detect a structured JSON error in stdout even on non-zero exit
      let structuredError = false;
      let parsedError = null;
      let sessionId = null;
      let usageKey = null;
      try {
        // Prefer the stream-json result event when available; fall back to
        // whole-output JSON.parse for non-streaming/truncated output.
        const parsed = finalResultObj !== null ? finalResultObj : JSON.parse(stdout);
        if (parsed.is_error === true || (parsed.subtype && String(parsed.subtype).startsWith("error")) ||
            (parsed.result && typeof parsed.result === "object" && parsed.result.error)) {
          structuredError = true;
          parsedError = parsed;
          sessionId = parsed.session_id || null;
          if (parsed.modelUsage) {
            const keys = extractUsageModelKeys(parsed.modelUsage);
            usageKey = keys.length > 0 ? keys[0] : null;
          }
        }
      } catch {
        // stdout is not JSON — not a structured error
      }

      const stage = classifyFailureStage({
        terminationReason,
        spawnError: false,
        stdout,
        stderr,
        structuredError,
        parsedError,
      });

      writeResult(failResult(stage, code ?? -1, {
        structuredError,
        parsedError,
        sessionId,
        usageKey,
        errorDetail: structuredError && parsedError
          ? (typeof parsedError?.error === "string" ? parsedError.error : typeof parsedError?.result === "string" ? parsedError.result : `claude exited with code ${code}`)
          : (stderr || `claude exited with code ${code}${signal ? ` (${signal})` : ""}`),
      }));
      exitWith(EXIT_FAILURE);
      return;
    }

    // Exit code 0: check for Claude structured error, then parse success.
    // Prefer the stream-json result event when available; fall back to
    // whole-output JSON.parse for non-streaming/truncated output.
    try {
      const parsed = finalResultObj !== null ? finalResultObj : JSON.parse(stdout);

      // Check is_error flag (top-level)
      if (parsed.is_error === true) {
        const errorMsg = parsed.error || parsed.result || "Claude reported a structured error";
        const stage = classifyFailureStage({
          terminationReason: null,
          spawnError: false,
          stdout,
          stderr,
          structuredError: true,
          parsedError: parsed,
        });
        const usageKeys = parsed.modelUsage ? extractUsageModelKeys(parsed.modelUsage) : [];
        writeResult(failResult(stage, 0, {
          structuredError: true,
          parsedError: parsed,
          sessionId: parsed.session_id || null,
          usageKey: usageKeys.length > 0 ? usageKeys[0] : null,
          errorDetail: typeof errorMsg === "string" ? errorMsg : JSON.stringify(errorMsg),
        }));
        exitWith(EXIT_FAILURE);
        return;
      }

      // Check top-level subtype (error indicators)
      if (parsed.subtype && String(parsed.subtype).startsWith("error")) {
        const errorMsg = parsed.error || parsed.result || `Claude error subtype: ${parsed.subtype}`;
        const stage = classifyFailureStage({
          terminationReason: null,
          spawnError: false,
          stdout,
          stderr,
          structuredError: true,
          parsedError: parsed,
        });
        const usageKeys = parsed.modelUsage ? extractUsageModelKeys(parsed.modelUsage) : [];
        writeResult(failResult(stage, 0, {
          structuredError: true,
          parsedError: parsed,
          sessionId: parsed.session_id || null,
          usageKey: usageKeys.length > 0 ? usageKeys[0] : null,
          errorDetail: typeof errorMsg === "string" ? errorMsg : JSON.stringify(errorMsg),
        }));
        exitWith(EXIT_FAILURE);
        return;
      }

      // Check nested result.error (object with error field)
      if (parsed.result && typeof parsed.result === "object" && parsed.result.error) {
        const stage = classifyFailureStage({
          terminationReason: null,
          spawnError: false,
          stdout,
          stderr,
          structuredError: true,
          parsedError: parsed,
        });
        const usageKeys = parsed.modelUsage ? extractUsageModelKeys(parsed.modelUsage) : [];
        writeResult(failResult(stage, 0, {
          structuredError: true,
          parsedError: parsed,
          sessionId: parsed.session_id || null,
          usageKey: usageKeys.length > 0 ? usageKeys[0] : null,
          errorDetail: typeof parsed.result.error === "string" ? parsed.result.error : JSON.stringify(parsed.result.error),
        }));
        exitWith(EXIT_FAILURE);
        return;
      }

      // Extract ALL usage model keys (not just first), with sanitization
      const usageModelKeys = extractUsageModelKeys(parsed.modelUsage);

      // Extract per-round token usage for the continuation planner. Best-effort:
      // null when the Provider did not report token counts. Never persisted to
      // state/artifacts/logs — lives only in the in-memory result envelope.
      const usageTokens = extractUsageTokens(parsed);
      const contextWindow = extractContextWindow(parsed);

      // Honest cost: null when the Provider did not report total_cost_usd.
      // Never coerce absent telemetry to 0 — that would display as "$0.00"
      // and mislead callers into thinking the probe was free.
      const rawCost = parsed.total_cost_usd;
      const honestCost = (typeof rawCost === "number" && Number.isFinite(rawCost))
        ? rawCost
        : null;

      writeResult({
        ok: true,
        result: parsed.result || "",
        sessionId: parsed.session_id || null,
        cost: honestCost,
        duration: parsed.duration_ms ? parsed.duration_ms / 1000 : null,
        usageModelKeys,
        usage: usageTokens,
        contextWindow,
        exitCode: 0
      });
      exitWith(EXIT_SUCCESS);
    } catch (parseError) {
      const stage = FAILURE_STAGES.JSON_PROTOCOL;
      writeResult(failResult(stage, 0, {
        errorDetail: `Claude output was not valid JSON: ${parseError.message}`,
      }));
      exitWith(EXIT_FAILURE);
    }
  });

  // ── Phase 5: Set up timeout ──
  if (timeoutMs > 0) {
    setTimeout(() => {
      if (!settled) terminate("timeout");
    }, timeoutMs).unref?.();
  }
}

// ── Signal handlers: SIGTERM/SIGINT → kill Claude and exit ──
function handleSignal() {
  if (terminationReason === null) terminationReason = "cancelled";
  if (child?.pid) {
    terminateProcessTree(child.pid, "SIGTERM");
    setTimeout(() => {
      if (child?.pid) {
        terminateProcessTree(child.pid, "SIGKILL");
      }
      // Write a cancellation result so the companion gets a response
      if (!settled) {
        writeResult({
          ok: false,
          cancelled: true,
          error: buildSafeErrorMessage(FAILURE_STAGES.CANCELLED, "Claude task was cancelled (signal)."),
          exitCode: -1,
          failureStage: FAILURE_STAGES.CANCELLED,
        });
      }
      exitWith(EXIT_CANCELLED);
    }, 200).unref?.();
  } else {
    exitWith(EXIT_CANCELLED);
  }
}

process.on("SIGTERM", handleSignal);
process.on("SIGINT", handleSignal);

main().catch((err) => {
  process.stderr.write(`[watchdog] Fatal: ${err.message}\n`);
  process.exit(1);
});
