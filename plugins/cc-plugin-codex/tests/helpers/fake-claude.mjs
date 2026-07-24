#!/usr/bin/env node

/**
 * Fake Claude CLI for testing.
 *
 * Reads mode from (in priority order):
 *   1. FAKE_CLAUDE_MODE env var
 *   2. -p CLI argument (legacy)
 *   3. stdin content (when no env/arg mode found)
 *
 * Modes:
 *   success             — return fake result
 *   delay:<ms>          — return result after delay
 *   invalid-json        — output non-JSON
 *   nonzero             — exit with code 7, stderr only
 *   stdout-error        — exit with code 7, stdout only (tests P0 stdout capture fix)
 *   structured-error    — exit with code 1, structured JSON error on stdout
 *   secret-leak         — exit with code 7, stderr contains secrets (tests redaction)
 *   print-strict        — verify --print is in argv; fail with CLI contract error if missing
 *   hang                — hang forever
 *   hang-pid            — write PID to $HANG_PID_FILE then hang (for crash tests)
 *   hang-tree           — spawn a child, write its PID, then hang (tree-kill tests)
 *   flood               — output 4096 bytes then hang
 *   cwd                 — return CWD
 *   args                — echo CLI args (legacy, needs -p)
 *   echo-args           — echo CLI args immediately (no stdin wait)
 *   is_error            — Claude is_error=true
 *   error_subtype       — top-level subtype="error_max_turns"
 *   error_result_object — result is object with error field
 *   stdin-prompt        — read from stdin, echo it back
 *   multi-usage-keys    — return multiple usage model keys
 *   exec-model          — return a specific execution model in modelUsage (via EXEC_MODEL env)
 *   echo-task-error     — read task from stdin, echo it in stderr, exit non-zero (tests task redaction)
 */

const args = process.argv.slice(2);
const taskIndex = args.indexOf("-p");
const taskFromArgs = taskIndex >= 0 ? args[taskIndex + 1] : "";

// Handle --version and --help immediately so cc_setup's spawnSync calls
// don't hang waiting for stdin. The budget-guard flag is controllable via
// FAKE_CLAUDE_HELP_BUDGET_GUARD=1 so tests can verify fail-closed behavior.
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("1.0.0-fake\n");
  process.exit(0);
}
if (args.includes("--help") || args.includes("-h")) {
  const helpLines = [
    "Usage: claude [options] [prompt]",
    "",
    "Options:",
    "  -p, --print          Print mode (non-interactive)",
    "  --input-format       Input format (text, stream-json)",
    "  --output-format      Output format (text, json, stream-json)",
    "  --model              Model to use",
    "  --max-turns          Maximum turns",
  ];
  if (process.env.FAKE_CLAUDE_HELP_BUDGET_GUARD === "1") {
    helpLines.push("  --max-budget-usd     Maximum budget in USD (budget guard)");
  }
  process.stdout.write(helpLines.join("\n") + "\n");
  process.exit(0);
}

function success(result = "fake result") {
  const execModel = process.env.EXEC_MODEL || "mimo-v2.5";
  process.stdout.write(JSON.stringify({
    result,
    session_id: "fake-session",
    total_cost_usd: 0.01,
    duration_ms: 25,
    modelUsage: { [execModel]: {} }
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
  } else if (mode === "stdout-error") {
    // P0 test: error appears in stdout only, stderr is empty
    process.stdout.write("Error: model not found (HTTP 404)\n");
    process.exitCode = 7;
  } else if (mode === "structured-error") {
    // Structured JSON error on stdout with non-zero exit
    process.stdout.write(JSON.stringify({
      is_error: true,
      error: "Model 'unknown-model' not found",
      result: "",
      session_id: "fake-session-struct-err",
      total_cost_usd: 0,
      duration_ms: 5,
      modelUsage: {}
    }));
    process.exitCode = 1;
  } else if (mode === "secret-leak") {
    // Simulates a Provider error that accidentally includes secrets in stderr.
    // Tests that the diagnostics redaction scrubs them before persistence.
    process.stderr.write("Error: auth failed. ANTHROPIC_API_KEY=sk-leak-abc123def456 token=tok_secret_xyz password=hunter2\n");
    process.stderr.write("Request URL: https://user:pass@api.provider.com/v1/messages\n");
    process.exitCode = 7;
  } else if (mode === "print-strict") {
    // Simulate Claude Code 2.1.208+ behavior: --output-format json requires --print
    if (!args.includes("--print")) {
      process.stderr.write("error: --output-format json requires --print mode\n");
      process.stderr.write("usage: claude --print --output-format json\n");
      process.exitCode = 1;
    } else {
      success();
    }
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
  } else if (mode === "echo-task-error") {
    // Read the task from stdin, then echo it back in stderr as if the
    // CLI/Provider echoed prompt text in an error message. Tests that
    // task markers are redacted from diagnostics, job state, and MCP output.
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      process.stderr.write(`Error processing request: task="${input.trim()}" failed\n`);
      process.stderr.write(`Context: ${input.trim()}\n`);
      process.exitCode = 7;
    });
    return;
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
