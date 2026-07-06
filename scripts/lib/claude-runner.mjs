import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { binaryAvailable } from "./process.mjs";

const VALID_MODELS = new Set(["fable", "opus", "sonnet", "haiku"]);
const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * Build the claude CLI command args for a given task and options.
 */
export function buildClaudeArgs(task, options = {}) {
  const args = ["-p", task, "--output-format", "json"];

  // Opt-in: only skip permissions when explicitly requested
  if (options.dangerouslySkipPermissions === true) {
    args.push("--dangerously-skip-permissions");
  }

  if (options.model && VALID_MODELS.has(options.model)) {
    args.push("--model", options.model);
  }

  if (options.effort && VALID_EFFORTS.has(options.effort)) {
    args.push("--effort", options.effort);
  }

  if (options.write === false) {
    args.push("--allowedTools", "Read,Glob,Grep,Bash(git log*),Bash(git diff*),Bash(git show*),Bash(git status*),Bash(git branch --show-current)");
  }

  if (options.maxBudgetUsd) {
    args.push("--max-budget-usd", String(options.maxBudgetUsd));
  }

  // Resume support
  if (options.resumeSession) {
    args.push("--resume", options.resumeSession);
  } else if (options.resume) {
    args.push("--resume-last");
  }

  return args;
}

/**
 * Run claude -p synchronously and return parsed JSON output.
 */
export function runClaudeSync(task, options = {}) {
  const args = buildClaudeArgs(task, options);
  const cwd = options.cwd || process.cwd();

  const result = spawnSync("claude", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: options.timeout || 15 * 60 * 1000,
    stdio: "pipe",
    maxBuffer: 50 * 1024 * 1024
  });

  if (result.error) {
    return {
      ok: false,
      error: result.error.message || String(result.error),
      exitCode: result.status ?? -1
    };
  }

  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || "").trim() || `claude exited with code ${result.status}`,
      exitCode: result.status
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    return {
      ok: true,
      result: parsed.result || "",
      sessionId: parsed.session_id || null,
      cost: parsed.total_cost_usd || 0,
      duration: parsed.duration_ms ? parsed.duration_ms / 1000 : null,
      model: (parsed.modelUsage && Object.keys(parsed.modelUsage).length > 0) ? Object.keys(parsed.modelUsage)[0] : null,
      exitCode: 0
    };
  } catch (parseError) {
    // JSON parse failed — treat as error, not silent success
    return {
      ok: false,
      error: `Claude output was not valid JSON: ${parseError.message}`,
      rawOutput: result.stdout,
      exitCode: 0
    };
  }
}

/**
 * Spawn claude -p as a detached background process.
 * Returns the child process. The caller should listen for 'exit' to update job state.
 *
 * Unlike the previous version, this captures stdout so we can parse results on completion.
 */
export function runClaudeDetached(task, options = {}) {
  const args = buildClaudeArgs(task, options);
  const cwd = options.cwd || process.cwd();

  // Write stdout to a result file so we can read it on completion
  const resultFile = options.resultFile || null;
  const outFd = resultFile
    ? fs.openSync(resultFile, "w")
    : null;

  const stdioConfig = resultFile
    ? ["ignore", outFd, "ignore"]
    : ["ignore", "ignore", "ignore"];

  const child = spawn("claude", args, {
    cwd,
    env: process.env,
    detached: true,
    stdio: stdioConfig,
    windowsHide: true
  });
  child.unref();

  // Close the fd in the parent so it doesn't leak
  if (outFd !== null) {
    try { fs.closeSync(outFd); } catch { /* ignore */ }
  }

  return child;
}

/**
 * Check if claude CLI is available.
 */
export function getClaudeAvailability(cwd) {
  return binaryAvailable("claude", ["--version"], { cwd });
}

/**
 * Get the list of known Claude models with metadata.
 */
export function getKnownModels() {
  return [
    {
      alias: "fable",
      fullId: "claude-fable-5",
      bestFor: "Complex architecture, multi-step reasoning",
      recommendedEfforts: ["high", "xhigh", "max"]
    },
    {
      alias: "opus",
      fullId: "claude-opus-4-8",
      bestFor: "Deep analysis, careful reasoning",
      recommendedEfforts: ["high", "xhigh"]
    },
    {
      alias: "sonnet",
      fullId: "claude-sonnet-5",
      bestFor: "Balanced speed and quality",
      recommendedEfforts: ["medium", "high"]
    },
    {
      alias: "haiku",
      fullId: "claude-haiku-4-5-20251001",
      bestFor: "Quick tasks, simple changes",
      recommendedEfforts: ["low", "medium"]
    }
  ];
}
