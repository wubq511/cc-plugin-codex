#!/usr/bin/env node

/**
 * Fake Claude CLI for testing.
 *
 * Reads mode from (in priority order):
 *   1. FAKE_CLAUDE_MODE env var
 *   2. -p CLI argument
 *   3. stdin content (when no env/arg mode found)
 *
 * Modes:
 *   success        — return fake result
 *   delay:<ms>     — return result after delay
 *   invalid-json   — output non-JSON
 *   nonzero        — exit with code 7
 *   hang           — hang forever
 *   hang-pid       — write PID to $HANG_PID_FILE then hang (for crash tests)
 *   hang-tree      — spawn a child, write its PID, then hang (tree-kill tests)
 *   flood          — output 4096 bytes then hang
 *   cwd            — return CWD
 *   args           — echo CLI args (legacy, needs -p)
 *   echo-args      — echo CLI args immediately (no stdin wait)
 *   is_error       — Claude is_error=true
 *   error_subtype  — top-level subtype="error_max_turns"
 *   error_result_object — result is object with error field
 *   stdin-prompt   — read from stdin, echo it back
 */

const args = process.argv.slice(2);
const taskIndex = args.indexOf("-p");
const taskFromArgs = taskIndex >= 0 ? args[taskIndex + 1] : "";

function success(result = "fake result") {
  process.stdout.write(JSON.stringify({
    result,
    session_id: "fake-session",
    total_cost_usd: 0.01,
    duration_ms: 25,
    modelUsage: { "mimo-v2.5": {} }
  }));
}

function handleMode(mode) {
  if (mode.startsWith("delay")) {
    const delayMs = Number(mode.split(":")[1] || 150);
    setTimeout(() => success("delayed result"), delayMs);
  } else if (mode === "invalid-json") {
    process.stdout.write("not json");
  } else if (mode === "nonzero") {
    process.stderr.write("fake claude failure\n");
    process.exitCode = 7;
  } else if (mode === "hang") {
    setInterval(() => {}, 1000);
  } else if (mode === "hang-pid") {
    // Write PID to file for crash tests to track liveness
    const pidFile = process.env.HANG_PID_FILE;
    if (pidFile) {
      try { require("fs").writeFileSync(pidFile, String(process.pid), "utf8"); } catch {}
    }
    setInterval(() => {}, 1000);
  } else if (mode === "hang-tree") {
    const { spawn } = require("node:child_process");
    const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pidFile = process.env.TREE_CHILD_PID_FILE;
    if (pidFile) {
      try { require("fs").writeFileSync(pidFile, String(grandchild.pid), "utf8"); } catch {}
    }
    setInterval(() => {}, 1000);
  } else if (mode === "flood") {
    process.stdout.write("x".repeat(4096));
    setInterval(() => {}, 1000);
  } else if (mode === "cwd") {
    success(process.cwd());
  } else if (mode === "args") {
    success(args.join(" "));
  } else if (mode === "echo-args") {
    // Echo CLI args immediately without waiting for stdin
    success(args.join(" "));
    return;
  } else if (mode === "is_error") {
    process.stdout.write(JSON.stringify({
      is_error: true,
      error: "Model overloaded",
      result: "",
      session_id: "fake-session-error",
      total_cost_usd: 0,
      duration_ms: 10,
      modelUsage: { "fake-model": {} }
    }));
  } else if (mode === "error_subtype") {
    process.stdout.write(JSON.stringify({
      subtype: "error_max_turns",
      result: "Max turns reached",
      session_id: "fake-session-subtype",
      total_cost_usd: 0,
      duration_ms: 10,
      modelUsage: { "fake-model": {} }
    }));
  } else if (mode === "error_result_object") {
    process.stdout.write(JSON.stringify({
      result: { error: "Rate limit exceeded", code: 429 },
      session_id: "fake-session-result-obj",
      total_cost_usd: 0,
      duration_ms: 10,
      modelUsage: { "fake-model": {} }
    }));
  } else if (mode === "stdin-prompt") {
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const prompt = input.trim();
      success(`stdin prompt: ${prompt}`);
    });
    return; // Don't call success() below
  } else if (mode === "multi-usage-keys") {
    // Return multiple usage model keys to test multi-key handling
    process.stdout.write(JSON.stringify({
      result: "multi-usage result",
      session_id: "fake-session-multi",
      total_cost_usd: 0.02,
      duration_ms: 50,
      modelUsage: { "mimo-v2.5": {}, "glm-5.1": {} }
    }));
  } else {
    success();
  }
}

// Determine mode from env, args, or stdin
const envMode = process.env.FAKE_CLAUDE_MODE;
const argMode = taskFromArgs;

if (envMode || argMode) {
  handleMode(envMode || argMode);
} else {
  // Read from stdin (the watchdog writes the task/mode here)
  let stdinData = "";
  process.stdin.on("data", (chunk) => { stdinData += chunk; });
  process.stdin.on("end", () => {
    const mode = stdinData.trim();
    handleMode(mode);
  });
}
