import { spawn, spawnSync } from "node:child_process";

/**
 * Check if a binary is available on PATH.
 */
export function binaryAvailable(command, args = [], options = {}) {
  try {
    const result = spawnSync(command, args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe"
    });
    const ok = result.status === 0;
    return {
      available: ok,
      detail: ok ? `${command} available: ${(result.stdout || "").trim()}` : `${command} not found or failed`
    };
  } catch {
    return { available: false, detail: `${command} not found` };
  }
}

/**
 * Terminate a process tree (pid + all children) by sending SIGTERM.
 * On macOS/Linux, use process.kill with negative pid to kill the group.
 */
export function terminateProcessTree(pid) {
  if (!pid || !Number.isFinite(pid)) {
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // already dead
    }
  }
}

/**
 * Spawn a detached child process and return it.
 */
export function spawnDetached(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd || process.cwd(),
    env: options.env || process.env,
    detached: true,
    stdio: options.stdio || "ignore",
    windowsHide: true
  });
  child.unref();
  return child;
}
