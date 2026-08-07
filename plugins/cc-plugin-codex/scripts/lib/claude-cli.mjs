/**
 * Claude CLI query adapter — every synchronous probe of the `claude` binary
 * lives here, behind one small interface.
 *
 * Before this module the CLI was probed in three places with three shapes:
 * cc-companion.mjs ran `claude --help`, routing.mjs ran `claude --version`,
 * and claude-runner.mjs probed availability through process.mjs's generic
 * binaryAvailable. Each had its own spawn call; routing.mjs's version probe
 * even skipped the shell-free `.cmd` shim resolution the other probes use, so
 * on Windows it could not reliably invoke npm's wrapper.
 *
 * All probes funnel through one private spawnSync helper that routes the
 * command through resolveCommandForSpawn (shell-free, Windows `.cmd` aware).
 * Probes are synchronous, make zero model calls, and never touch state.
 */

import { spawnSync } from "node:child_process";

import { resolveCommandForSpawn } from "./process.mjs";

/**
 * Shell-free synchronous probe of the Claude CLI.
 * @returns {import("node:child_process").SpawnSyncReturns<string>}
 */
function probeClaude(args, { cwd, command = "claude", timeout = 5000 } = {}) {
  const resolved = resolveCommandForSpawn(command, args);
  return spawnSync(resolved.command, resolved.args, {
    cwd: cwd || process.cwd(),
    encoding: "utf8",
    timeout,
    stdio: "pipe",
    shell: resolved.shell,
    windowsHide: true,
  });
}

/**
 * Get the Claude CLI version string (best-effort, zero model calls).
 * @param {string} [cwd]
 * @param {{ command?: string }} [options] — command override for tests.
 * @returns {string|null}
 */
export function getClaudeVersion(cwd, { command = "claude" } = {}) {
  try {
    const result = probeClaude(["--version"], { cwd, command });
    if (result.status === 0) {
      const version = (result.stdout || "").trim();
      if (version) return version;
    }
  } catch {
    // best effort
  }
  return null;
}

/**
 * Run `claude --help` (best-effort, zero model calls).
 * @param {string} [cwd]
 * @returns {{ ok: boolean, text: string }} — text concatenates stdout and
 *   stderr so callers can grep for feature flags.
 */
export function readClaudeHelp(cwd) {
  try {
    const result = probeClaude(["--help"], { cwd, timeout: 10000 });
    return {
      ok: result.status === 0,
      text: `${result.stdout || ""}\n${result.stderr || ""}`,
    };
  } catch {
    return { ok: false, text: "" };
  }
}

/**
 * Check whether the Claude CLI supports --max-budget-usd by inspecting --help.
 * Zero model calls. Returns true only when a successful help invocation
 * explicitly recognizes the flag.
 * @param {string} [cwd]
 * @returns {boolean}
 */
export function checkBudgetGuardSupported(cwd) {
  const help = readClaudeHelp(cwd);
  return help.ok && /--max-budget-usd\b/.test(help.text);
}

/**
 * Check if the Claude CLI is available on PATH (zero model calls).
 * @param {string} [cwd]
 * @param {{ command?: string }} [options] — command override for tests.
 * @returns {{ available: boolean, detail: string }}
 */
export function getClaudeAvailability(cwd, { command = "claude" } = {}) {
  try {
    const result = probeClaude(["--version"], { cwd, command });
    const ok = result.status === 0;
    return {
      available: ok,
      detail: ok ? `${command} available: ${(result.stdout || "").trim()}` : `${command} not found or failed`,
    };
  } catch {
    return { available: false, detail: `${command} not found` };
  }
}
