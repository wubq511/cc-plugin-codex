import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Check if a binary is available on PATH.
 */
export function binaryAvailable(command, args = [], options = {}) {
  try {
    // Keep setup/liveness checks on the same shell-free resolution path as
    // the watchdog. On Windows the normal Claude installation is an npm
    // `.cmd` shim; spawning the bare name directly makes `cc_setup` report
    // the CLI as missing even though delegation can resolve the shim.
    const resolved = resolveCommandForSpawn(command, args);
    const result = spawnSync(resolved.command, resolved.args, {
      cwd: options.cwd || process.cwd(),
      env: process.env,
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe",
      shell: resolved.shell,
      windowsHide: true,
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
 * Terminate a process tree (pid + all children).
 * - macOS/Linux: process.kill with negative pid to kill the process group
 * - Windows: taskkill /T /F for tree kill
 */
const IS_WIN = process.platform === "win32";

export function terminateProcessTree(pid, signal = "SIGTERM") {
  if (!pid || !Number.isFinite(pid)) {
    return;
  }
  if (IS_WIN) {
    try {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        timeout: 5000,
        windowsHide: true,
        stdio: "ignore"
      });
    } catch {
      try { process.kill(pid); } catch { /* already dead */ }
    }
  } else {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // already dead
      }
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

/**
 * Resolve a Windows .cmd shim to the underlying Node executable + script args.
 *
 * For npm-generated .cmd shims (e.g. claude.cmd), this parses the trusted shim
 * to locate the Node CLI entrypoint and returns { command, args } suitable for
 * spawn() with shell=false. User-controlled arguments (task, model, session)
 * remain as separate argv entries — never concatenated into a shell command.
 *
 * Prefers a native .exe when present.
 * Falls back to parsing the .cmd to find the underlying JS entrypoint.
 * Rejects unrecognized shims with a precise error.
 */
export function resolveWindowsCommand(command, userArgs = []) {
  // If the command is already an .exe, use it directly
  if (command.toLowerCase().endsWith(".exe")) {
    return { command, args: userArgs, shell: false };
  }

  // If the command is a .js/.mjs file, run it with node
  if (/\.(js|mjs)$/i.test(command)) {
    return { command: process.execPath, args: [command, ...userArgs], shell: false };
  }

  // If the command doesn't end in .cmd, check if it's a Node shebang script
  if (!command.toLowerCase().endsWith(".cmd")) {
    // On Windows, spawn() with shell=false cannot execute extensionless files
    // even if they have a shebang. Detect Node shebang scripts and wrap with node.
    try {
      const content = fs.readFileSync(command, "utf8");
      if (content.startsWith("#!/usr/bin/env node") || content.startsWith("#!node")) {
        return { command: process.execPath, args: [command, ...userArgs], shell: false };
      }
    } catch {
      // Can't read the file — fall through to return as-is
    }
    return { command, args: userArgs, shell: false };
  }

  // Try native .exe first (npm sometimes generates both)
  const exePath = command.replace(/\.cmd$/i, ".exe");
  try {
    fs.accessSync(exePath, fs.constants.X_OK);
    return { command: exePath, args: userArgs, shell: false };
  } catch {
    // .exe not available, parse the .cmd
  }

  // Parse the .cmd file to find the Node entrypoint
  let cmdContent;
  try {
    cmdContent = fs.readFileSync(command, "utf8");
  } catch (err) {
    throw new Error(`Cannot read .cmd file ${command}: ${err.message}`);
  }

  // Extract the Node.js script entrypoint from the .cmd shim.
  // npm-generated .cmd shims contain a pattern like:
  //   "%_prog%" "%dp0%\node_modules\...\cli.js" %*
  // where %_prog% resolves to the node executable.
  // Strategy: find lines that look like invocations of a .js file,
  // and extract the .js path as the entrypoint.
  const lines = cmdContent.split(/\r?\n/);
  let nodeExe = process.execPath;
  let scriptEntrypoint = null;

  // Search for .js file references in any line (including compound batch lines).
  // Batch files chain commands with & so we must scan every line.
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("@") || trimmed.startsWith("::")) continue;

    // Skip pure variable assignments (SET, IF, GOTO, etc.) that don't invoke commands
    if (/^(?:set\s|if\s|else|goto\s|shift\b)/i.test(trimmed) && !trimmed.includes("&")) continue;

    // Split compound lines on & to find the command that actually invokes the CLI
    const segments = trimmed.split("&");
    for (const segment of segments) {
      const seg = segment.trim();
      if (!seg) continue;
      // Skip batch flow-control segments
      if (/^(?:set\s|if\s|else|goto\s|endlocal|shift\b|title\b)/i.test(seg)) continue;

      // Match quoted .js file references: "path/to/file.js"
      const quotedJs = seg.match(/"([^"]*\.js)"/i);
      if (quotedJs) {
        scriptEntrypoint = quotedJs[1];
        // Try to extract the node executable if referenced in the same segment
        const nodeMatch = seg.match(/"([^"]*(?:node|node\.exe)[^"]*)"/i);
        if (nodeMatch) {
          nodeExe = nodeMatch[1];
        }
        break;
      }

      // Match unquoted .js file references that look like file paths (contain / or \)
      const unquotedJs = seg.match(/([^\s"]+[\\\/][^\s"]*\.js)/i);
      if (unquotedJs) {
        scriptEntrypoint = unquotedJs[1];
        break;
      }
    }
    if (scriptEntrypoint) break;
  }

  if (!scriptEntrypoint) {
    throw new Error(
      `Cannot parse .cmd shim: ${command}. ` +
      `No Node.js script entrypoint found. The shim may use an unrecognized format. ` +
      `Install the native .exe version of the CLI or ensure the .cmd file is a standard npm-generated shim.`
    );
  }

  // Resolve relative paths (like %dp0%\...) against the .cmd file's directory
  const cmdDir = path.dirname(command);
  let resolvedEntrypoint = scriptEntrypoint;

  // Handle %~dp0 and %dp0% patterns (common in npm shims)
  resolvedEntrypoint = resolvedEntrypoint
    .replace(/%~dp0[\\\/]?/gi, cmdDir + path.sep)
    .replace(/%dp0%[\\\/]?/gi, cmdDir + path.sep);

  // Normalize path separators to the current platform
  resolvedEntrypoint = resolvedEntrypoint.replace(/\\/g, path.sep);

  // Verify the entrypoint exists
  try {
    fs.accessSync(resolvedEntrypoint, fs.constants.R_OK);
  } catch {
    // Try relative to cmdDir
    const relativePath = path.resolve(cmdDir, scriptEntrypoint);
    try {
      fs.accessSync(relativePath, fs.constants.R_OK);
      resolvedEntrypoint = relativePath;
    } catch {
      throw new Error(
        `Cannot find CLI entrypoint ${resolvedEntrypoint} referenced by .cmd shim ${command}. ` +
        `The CLI may need to be reinstalled.`
      );
    }
  }

  return {
    command: nodeExe,
    args: [resolvedEntrypoint, ...userArgs],
    shell: false
  };
}

/**
 * Resolve a command for shell-free spawn on the current platform.
 *
 * Windows does not resolve npm-generated `.cmd` shims when `shell` is false.
 * Locate a bare command with `where.exe`, then convert a discovered `.cmd`
 * shim into a direct Node invocation via resolveWindowsCommand(). The optional
 * lookup function keeps the platform branch deterministic in unit tests.
 */
export function resolveCommandForSpawn(command, userArgs = [], options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== "win32") {
    return { command, args: userArgs, shell: false };
  }

  const hasPath = /[\\/]/.test(command);
  const hasExecutableExtension = /\.(?:exe|cmd)$/i.test(command);
  if (hasPath || hasExecutableExtension) {
    return resolveWindowsCommand(command, userArgs);
  }

  const lookup = options.lookup || ((name) => {
    const result = spawnSync("where.exe", [name], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
      stdio: "pipe"
    });
    if (result.status !== 0) return [];
    return String(result.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  });

  const matches = lookup(command);
  const candidates = Array.isArray(matches) ? matches : [matches].filter(Boolean);
  const selected = candidates.find((candidate) => /\.exe$/i.test(candidate))
    || candidates.find((candidate) => /\.cmd$/i.test(candidate))
    || candidates[0];

  if (!selected) {
    throw new Error(`Cannot resolve Windows command "${command}" on PATH.`);
  }
  return resolveWindowsCommand(selected, userArgs);
}
