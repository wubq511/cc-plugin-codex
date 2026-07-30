#!/usr/bin/env node

const fs = process.getBuiltinModule("fs");
const path = process.getBuiltinModule("path");

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
 *   echo-task-encoded   — read task from stdin, echo it in stderr using the encoding selected by
 *                         ECHO_TASK_ENCODING (raw|json|escaped-newline|whitespace-normalized|chunked|short),
 *                         exit non-zero (tests multi-encoding task redaction + fail-safe)
 *   success-no-cost     — return fake result with NO total_cost_usd (tests honest null cost)
 */

const args = process.argv.slice(2);
const taskIndex = args.indexOf("-p");
const taskFromArgs = taskIndex >= 0 ? args[taskIndex + 1] : "";

if (process.env.FAKE_CLAUDE_ARGS_LOG) {
  fs.appendFileSync(process.env.FAKE_CLAUDE_ARGS_LOG, `${JSON.stringify(args)}\n`, "utf8");
}

function appendCompactBoundary() {
  if (process.env.FAKE_CLAUDE_APPEND_COMPACT_BOUNDARY !== "1") return;
  const resumeIndex = args.indexOf("--resume");
  const sessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : null;
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (!sessionId || !configDir) return;

  const projectDir = path.join(configDir, "projects", "test-project");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.appendFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    `${JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      compactMetadata: {
        preTokens: Number(process.env.FAKE_CLAUDE_COMPACT_PRE_TOKENS || 45000),
        trigger: process.env.FAKE_CLAUDE_COMPACT_TRIGGER || "manual",
      },
    })}\n`,
    "utf8",
  );
}

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
  process.exit(Number(process.env.FAKE_CLAUDE_HELP_EXIT_CODE || 0));
}

function success(result = "fake result") {
  const execModel = process.env.EXEC_MODEL || "mimo-v2.5";
  const highPressure = process.env.FAKE_USAGE_PROFILE === "high";
  const lastIteration = highPressure
    ? {
        input_tokens: 20000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 140000,
        output_tokens: 1000,
        type: "message",
      }
    : {
        input_tokens: 1000,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 10000,
        output_tokens: 500,
        type: "message",
      };
  process.stdout.write(JSON.stringify({
    result,
    session_id: "fake-session",
    total_cost_usd: 0.01,
    duration_ms: 25,
    num_turns: 2,
    usage: {
      input_tokens: lastIteration.input_tokens + 500,
      cache_creation_input_tokens: lastIteration.cache_creation_input_tokens,
      cache_read_input_tokens: lastIteration.cache_read_input_tokens + 1000,
      output_tokens: lastIteration.output_tokens + 100,
      iterations: [
        {
          input_tokens: 500,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 1000,
          output_tokens: 100,
          type: "message",
        },
        lastIteration,
      ],
    },
    modelUsage: {
      [execModel]: {
        inputTokens: lastIteration.input_tokens + 500,
        cacheCreationInputTokens: lastIteration.cache_creation_input_tokens,
        cacheReadInputTokens: lastIteration.cache_read_input_tokens + 1000,
        outputTokens: lastIteration.output_tokens + 100,
        contextWindow: 200000,
      },
    }
  }));
}

function handleMode(mode) {
  if (mode === "/compact") {
    appendCompactBoundary();
    success("compact command handled");
  } else if (mode.startsWith("delay")) {
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
  } else if (mode === "hang-slow") {
    // Like hang, but traps SIGTERM and waits 300ms before exiting.
    // This makes the `cancelling` status observable by tests that poll disk
    // state — without it, the process dies too fast for the polling interval.
    process.on("SIGTERM", () => {
      setTimeout(() => process.exit(0), 300).unref?.();
    });
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
  } else if (mode === "success-no-cost") {
    // Return a successful result with NO total_cost_usd field. Tests that
    // the liveness probe reports cost as "unknown" (never "$0.00") when
    // Provider telemetry is missing.
    const execModel = process.env.EXEC_MODEL || "mimo-v2.5";
    process.stdout.write(JSON.stringify({
      result: "OK",
      session_id: "fake-session-no-cost",
      duration_ms: 15,
      modelUsage: { [execModel]: {} }
    }));
  } else if (mode === "success-reported-zero-cost") {
    const execModel = process.env.EXEC_MODEL || "mimo-v2.5";
    process.stdout.write(JSON.stringify({
      result: "OK",
      session_id: "fake-session-reported-zero-cost",
      total_cost_usd: 0,
      duration_ms: 15,
      modelUsage: { [execModel]: {} }
    }));
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
  } else if (mode === "echo-task-encoded") {
    // Read the task from stdin, then echo it back in stderr using the
    // encoding selected by ECHO_TASK_ENCODING. Tests that task redaction
    // handles raw, JSON-escaped, newline-escaped, whitespace-normalized,
    // chunked, and short-task echoes — including the fail-safe marker when
    // reliable redaction is impossible.
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const task = input.trim();
      const enc = process.env.ECHO_TASK_ENCODING || "raw";
      let echo;
      if (enc === "json") {
        echo = `Error: failed for ${JSON.stringify(task)} end`;
      } else if (enc === "escaped-newline") {
        // Real newlines/tabs become literal backslash escapes.
        const escaped = task
          .replace(/\r\n/g, "\\n")
          .replace(/\n/g, "\\n")
          .replace(/\r/g, "\\n")
          .replace(/\t/g, "\\t");
        echo = `Error: processing ${escaped} failed`;
      } else if (enc === "whitespace-normalized") {
        const collapsed = task.replace(/\s+/g, " ").trim();
        echo = `Error: processing ${collapsed} failed`;
      } else if (enc === "chunked") {
        // Split the task on whitespace and emit each token on its own line
        // so no exact variant matches, but all task content is present.
        const tokens = task.split(/\s+/).filter(Boolean);
        echo = tokens.map((tok) => `chunk: ${tok}`).join("\n");
      } else if (enc === "short") {
        echo = `Error: ${task} bad`;
      } else {
        // raw
        echo = `Error processing request: task="${task}" failed`;
      }
      process.stderr.write(echo + "\n");
      process.exitCode = 7;
    });
    return;
  } else if (mode === "stream-success") {
    // Emit a complete stream-json NDJSON sequence mirroring the real Claude
    // Code event schema (system/init, assistant with tool_use, user
    // tool_result, assistant text, type:result). See
    // tests/fixtures/stream-json-success-sample.ndjson. Exit 0.
    emitStreamSequence("fake-stream-session", "target.json 的 name 字段值是 probe-target。", false);
    return;
  } else if (mode === "stream-big-field") {
    // Emit an assistant event whose text block far exceeds the per-field
    // truncation cap, then a normal result. Tests watchdog payload bounding.
    const sid = "fake-stream-big";
    const big = "A".repeat(20000); // 20 KB, well over the 4 KB cap
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-4-5" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: big }] }, session_id: sid }),
      JSON.stringify({ type: "result", subtype: "success", result: "big done", session_id: sid, total_cost_usd: 0.01, duration_ms: 10, is_error: false, usage: { input_tokens: 100, output_tokens: 10, type: "message" }, modelUsage: { "claude-sonnet-4-5": { inputTokens: 100, outputTokens: 10, contextWindow: 200000 } } }),
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return;
  } else if (mode === "stream-split") {
    // Emit events where one NDJSON line is split across two stdout chunks,
    // testing the watchdog's incremental line reassembly.
    const sid = "fake-stream-split";
    const ev1 = JSON.stringify({ type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-4-5" });
    const ev2 = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "reassembled split event" }] }, session_id: sid });
    const ev3 = JSON.stringify({ type: "result", subtype: "success", result: "split done", session_id: sid, total_cost_usd: 0.01, duration_ms: 10, is_error: false, usage: { input_tokens: 100, output_tokens: 10, type: "message" }, modelUsage: { "claude-sonnet-4-5": { inputTokens: 100, outputTokens: 10, contextWindow: 200000 } } });
    process.stdout.write(ev1 + "\n" + ev2.slice(0, 20));
    setImmediate(() => {
      process.stdout.write(ev2.slice(20) + "\n" + ev3 + "\n");
    });
    return;
  } else if (mode === "stream-huge-line") {
    // Emit a single newline-free line far above the watchdog's line-buffer
    // cap, then a normal result event. Tests that the watchdog bounds its
    // incremental line buffer instead of growing memory until the 8 MiB
    // capture cap.
    const sid = "fake-stream-huge-line";
    process.stdout.write("x".repeat(2 * 1024 * 1024) + "\n");
    process.stdout.write(JSON.stringify({ type: "result", subtype: "success", result: "huge line done", session_id: sid, total_cost_usd: 0.01, duration_ms: 10, is_error: false, usage: { input_tokens: 100, output_tokens: 10, type: "message" }, modelUsage: { "claude-sonnet-4-5": { inputTokens: 100, outputTokens: 10, contextWindow: 200000 } } }) + "\n");
    return;
  } else if (mode === "stream-no-result") {
    // Emit intermediate events but NO type:result event (truncated stream),
    // then exit 0. Tests watchdog fallback / error handling.
    const sid = "fake-stream-noresult";
    const lines = [
      JSON.stringify({ type: "system", subtype: "init", session_id: sid, model: "claude-sonnet-4-5" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "no result coming" }] }, session_id: sid }),
    ];
    process.stdout.write(lines.join("\n") + "\n");
    return;
  } else if (mode === "stream-slow") {
    // Emit a stream-json sequence with deliberate delays between events so the
    // dashboard e2e test can connect SSE and observe ≥2 intermediate events
    // arriving in real time BEFORE the final result event. The delays are
    // small (40ms) but sufficient for IPC + SSE broadcast to deliver each
    // event to a connected EventSource within the same event loop.
    const sid = "fake-stream-slow";
    const init = JSON.stringify({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: ["Read", "Grep", "Glob", "Bash"], model: "claude-sonnet-4-5", permissionMode: "default", claude_code_version: "1.0.0-fake" });
    const a1 = JSON.stringify({ type: "assistant", message: { id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "正在分析任务…" }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 20, type: "message" } }, session_id: sid });
    const a2 = JSON.stringify({ type: "assistant", message: { id: "msg_02", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "任务完成。" }], stop_reason: "end_turn", usage: { input_tokens: 150, cache_read_input_tokens: 100, output_tokens: 15, type: "message" } }, session_id: sid });
    const result = JSON.stringify({ type: "result", subtype: "success", result: "slow done", session_id: sid, total_cost_usd: 0.01, duration_ms: 30, num_turns: 2, is_error: false, usage: { input_tokens: 250, cache_read_input_tokens: 100, output_tokens: 35, iterations: [{ input_tokens: 100, output_tokens: 20, type: "message" }, { input_tokens: 150, cache_read_input_tokens: 100, output_tokens: 15, type: "message" }] }, modelUsage: { "claude-sonnet-4-5": { inputTokens: 250, cacheReadInputTokens: 100, outputTokens: 35, contextWindow: 200000 } } });
    process.stdout.write(init + "\n");
    setTimeout(() => { process.stdout.write(a1 + "\n"); }, 60);
    setTimeout(() => { process.stdout.write(a2 + "\n"); }, 120);
    setTimeout(() => { process.stdout.write(result + "\n"); }, 180);
    return;
  } else {
    success();
  }
}

// Emit a complete stream-json NDJSON success sequence. If includeToolUse is
// true, the first assistant event contains a Read tool_use block and a user
// tool_result follows. Mirrors tests/fixtures/stream-json-success-sample.ndjson.
function emitStreamSequence(sessionId, resultText, includeToolUse) {
  const sid = sessionId;
  const lines = [
    JSON.stringify({ type: "system", subtype: "init", cwd: process.cwd(), session_id: sid, tools: ["Read", "Grep", "Glob", "Bash"], model: "claude-sonnet-4-5", permissionMode: "default", claude_code_version: "1.0.0-fake" }),
  ];
  if (includeToolUse) {
    lines.push(JSON.stringify({ type: "assistant", message: { id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: "我先读取 target.json 文件。" }, { type: "tool_use", id: "toolu_01", name: "Read", input: { file_path: path.join(process.cwd(), "target.json") } }], stop_reason: "tool_use", usage: { input_tokens: 120, output_tokens: 40, type: "message" } }, session_id: sid }));
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: '{\n  "name": "probe-target"\n}', is_error: false }] }, session_id: sid }));
  } else {
    lines.push(JSON.stringify({ type: "assistant", message: { id: "msg_01", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: resultText }], stop_reason: "end_turn", usage: { input_tokens: 120, output_tokens: 40, type: "message" } }, session_id: sid }));
  }
  lines.push(JSON.stringify({ type: "assistant", message: { id: "msg_02", type: "message", role: "assistant", model: "claude-sonnet-4-5", content: [{ type: "text", text: resultText }], stop_reason: "end_turn", usage: { input_tokens: 180, cache_read_input_tokens: 120, output_tokens: 25, type: "message" } }, session_id: sid }));
  lines.push(JSON.stringify({ type: "result", subtype: "success", result: resultText, session_id: sid, total_cost_usd: 0.01, duration_ms: 25, num_turns: 2, is_error: false, usage: { input_tokens: 300, cache_read_input_tokens: 120, output_tokens: 65, iterations: [{ input_tokens: 120, output_tokens: 40, type: "message" }, { input_tokens: 180, cache_read_input_tokens: 120, output_tokens: 25, type: "message" }] }, modelUsage: { "claude-sonnet-4-5": { inputTokens: 300, cacheReadInputTokens: 120, outputTokens: 65, contextWindow: 200000 } } }));
  process.stdout.write(lines.join("\n") + "\n");
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
