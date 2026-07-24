/**
 * Claude runner — watchdog-based supervised execution.
 *
 * Spawns a small watchdog process that owns the Claude CLI.
 * Communication channels:
 *   watchdog stdin  — one-time JSON config (closed after write)
 *   IPC channel     — long-lived control channel (cancel / companion-death detection)
 *   watchdog stdout  — structured JSON result
 *
 * The watchdog writes the task to Claude's stdin (never argv) for privacy.
 * When the companion disconnects the IPC channel, the watchdog kills Claude.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { binaryAvailable } from "./process.mjs";

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
export const MAX_CAPTURE_BYTES = 8 * 1024 * 1024; // 8 MiB

const here = path.dirname(fileURLToPath(import.meta.url));
const WATCHDOG_PATH = path.join(here, "watchdog.mjs");

/**
 * Run claude via the watchdog process.
 *
 * Returns { child, pid, cancel, result }.
 */
export function runClaude(task, options = {}) {
  const cwd = options.cwd || process.cwd();
  const timeoutMs = options.timeout ?? null;
  const maxCaptureBytes = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
  const command = options.command || "claude";

  const watchdogConfig = {
    task,
    cwd,
    write: options.write !== false,
    model: options.model || null,
    effort: options.effort && VALID_EFFORTS.has(options.effort) ? options.effort : null,
    dangerouslySkipPermissions: options.dangerouslySkipPermissions === true,
    resume: options.resume === true,
    resumeSession: options.resumeSession || null,
    timeoutMs,
    maxCaptureBytes,
    command,
    childEnv: options.childEnv || null,
    sensitiveMarkers: Array.isArray(options.sensitiveMarkers) ? options.sensitiveMarkers : [],
    routeSnapshot: options.routeSnapshot || null,
    cliVersion: options.cliVersion || null,
    maxBudgetUsd: options.maxBudgetUsd || null
  };

  // Spawn watchdog with IPC channel for control.
  // stdio: [stdin(config), stdout(result), stderr, ipc(control)]
  const child = spawn(process.execPath, [WATCHDOG_PATH], {
    cwd,
    env: options.env || process.env,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    windowsHide: true
  });

  let settled = false;
  let cancelRequested = false;
  let stderr = "";

  // Send config via stdin then close
  try {
    child.stdin.write(JSON.stringify(watchdogConfig));
    child.stdin.end();
  } catch {
    // stdin write failed (watchdog may have exited)
  }

  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  const result = new Promise((resolve, reject) => {
    const stdoutChunks = [];

    child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      try { child.disconnect(); } catch { /* */ }
      resolve({ ok: false, error: error.message || String(error), exitCode: -1 });
    });

    // With an IPC stdio channel, `close` can be delayed by inherited pipe
    // handles even after the watchdog process has exited. For cancellation,
    // watchdog exit is the ownership boundary: it has already completed its
    // bounded process-tree termination path, so settle without waiting for
    // every inherited descriptor to close.
    child.once("exit", (code) => {
      if (settled || !cancelRequested) return;
      settled = true;
      resolve({ ok: false, cancelled: true, error: "Claude task was cancelled.", exitCode: code ?? -1 });
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;

      const stdout = Buffer.concat(stdoutChunks).toString("utf8").trim();

      // Parse watchdog result from stdout
      if (stdout) {
        try {
          const parsed = JSON.parse(stdout);
          resolve(parsed);
          return;
        } catch {
          // stdout was not valid JSON — fall through to error
        }
      }

      // No valid result from watchdog
      if (code === 4) {
        resolve({ ok: false, cancelled: true, error: "Claude task was cancelled or companion died.", exitCode: code, failureStage: "cancelled" });
      } else if (code === 2) {
        resolve({ ok: false, error: `Claude task timed out after ${timeoutMs}ms.`, exitCode: code, failureStage: "timeout" });
      } else if (code === 3) {
        resolve({ ok: false, error: `Claude output exceeded the ${maxCaptureBytes}-byte capture limit.`, exitCode: code, failureStage: "provider_response" });
      } else {
        resolve({
          ok: false,
          error: stderr.trim() || `Watchdog exited with code ${code}${signal ? ` (${signal})` : ""}`,
          exitCode: code ?? -1,
          failureStage: "spawn"
        });
      }
    });
  });

  return {
    child,
    pid: child.pid ?? null,
    cancel: () => {
      cancelRequested = true;
      // Send cancel command via IPC channel
      try { child.send("cancel"); } catch { /* channel may be closed */ }
      // Disconnect IPC channel (signals companion is done)
      try { child.disconnect(); } catch { /* already disconnected */ }
      // Send SIGTERM to watchdog (which forwards to Claude)
      try {
        process.kill(child.pid, "SIGTERM");
      } catch {
        try { process.kill(-child.pid, "SIGTERM"); } catch { /* already dead */ }
      }
    },
    result
  };
}

/**
 * Check if claude CLI is available.
 */
export function getClaudeAvailability(cwd) {
  return binaryAvailable("claude", ["--version"], { cwd });
}

// Re-export for backward compat (tests may import MAX_CAPTURE_BYTES)
export { MAX_CAPTURE_BYTES as MAX_CAPTURE };
