import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listJobs } from "../scripts/lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverPath = path.join(pluginRoot, "scripts", "cc-companion.mjs");
const fakeClaudeSource = path.join(here, "helpers", "fake-claude.mjs");

// Budget lines for the Codex-side always-on context cost. Set ~15% above the
// measured post-slimming sizes (tools/list 13,480 bytes, instructions 294
// bytes as of the token-cost pass); tighten only deliberately.
const TOOLS_LIST_BUDGET_BYTES = 15500;
const INSTRUCTIONS_BUDGET_BYTES = 400;

// ─── Test helpers (same pattern as continuation-mcp.test.mjs) ───────────────

function installFakeClaude(binDir) {
  const fakeClaude = path.join(binDir, "claude");
  fs.copyFileSync(fakeClaudeSource, fakeClaude);
  fs.chmodSync(fakeClaude, 0o755);
  if (process.platform === "win32") {
    fs.copyFileSync(fakeClaudeSource, path.join(binDir, "claude.js"));
    fs.writeFileSync(
      path.join(binDir, "claude.cmd"),
      `@ECHO off\r\n"${process.execPath}" "%~dp0claude.js" %*\r\n`,
      "utf8",
    );
  }
  return fakeClaude;
}

function startServer(t, opts = {}) {
  const workspace = opts.workspace || fs.mkdtempSync(path.join(os.tmpdir(), "cc-budget-"));
  const binDir = path.join(workspace, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  installFakeClaude(binDir);

  // Drain state.mjs's first-access orphan reconciliation while the workspace
  // is still empty (see continuation-mcp.test.mjs for the rationale).
  listJobs(workspace);

  const child = spawn(process.execPath, [serverPath], {
    cwd: workspace,
    env: {
      ...process.env,
      CC_COMPANION_DASHBOARD_OPEN: "off",
      ...opts.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const waiters = new Map();
  let stderr = "";
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      const waiter = waiters.get(message.id);
      if (waiter) {
        waiters.delete(message.id);
        waiter.resolve(message);
      }
    } catch { /* ignore non-JSON */ }
  });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

  function request(id, method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Timed out waiting for response ${id}. stderr: ${stderr}`));
      }, 15000);
      waiters.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message); } });
    });
  }

  function send(id, name, args = {}) {
    return request(id, "tools/call", { name, arguments: { cwd: workspace, ...args } });
  }

  t.after(async () => {
    try { child.kill("SIGTERM"); } catch { /* already dead */ }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
    try { fs.rmSync(workspace, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  return { child, request, send, workspace, getStderr: () => stderr };
}

// ─── Always-on budget: tools/list + initialize instructions ─────────────────

test("tools/list total size stays within the token budget", async (t) => {
  const server = startServer(t);
  const res = await server.request(1, "tools/list");
  const bytes = Buffer.byteLength(JSON.stringify(res.result));
  assert.ok(
    bytes <= TOOLS_LIST_BUDGET_BYTES,
    `tools/list is ${bytes} bytes, budget is ${TOOLS_LIST_BUDGET_BYTES} — slim the tool schemas or raise the budget deliberately`,
  );
});

test("initialize instructions stay within the token budget", async (t) => {
  const server = startServer(t);
  const res = await server.request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "budget-test", version: "0" },
  });
  const bytes = Buffer.byteLength(res.result.instructions || "");
  assert.ok(
    bytes <= INSTRUCTIONS_BUDGET_BYTES,
    `initialize instructions are ${bytes} bytes, budget is ${INSTRUCTIONS_BUDGET_BYTES}`,
  );
});

// ─── Text-first contract: no structuredContent on the wire ──────────────────

test("cc_resolve_route emits no structuredContent", async (t) => {
  const server = startServer(t);
  // cc_resolve_route takes no cwd — call it without one.
  const res = await server.request(1, "tools/call", {
    name: "cc_resolve_route",
    arguments: { selector: "Opus" },
  });
  assert.ok(!res.result.structuredContent, "cc_resolve_route must be text-first");
  assert.match(res.result.content[0].text, /--model opus/);
});

test("cc_plan_continuation emits no structuredContent", async (t) => {
  const server = startServer(t);
  const res = await server.send(1, "cc_plan_continuation", {
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "auto",
    correctionCount: 0,
    allowCompact: true,
    model: null,
    write: true,
  });
  assert.ok(!res.result.structuredContent, "cc_plan_continuation must be text-first");
  assert.match(res.result.content[0].text, /\*\*动作：\*\*/);
});

test("cc_compact emits no structuredContent", async (t) => {
  const server = startServer(t);
  await server.send(1, "cc_delegate", { task: "success" });
  const res = await server.send(2, "cc_compact", {});
  assert.ok(!res.result.structuredContent, "cc_compact must be text-first");
  assert.match(res.result.content[0].text, /\*\*已压缩：\*\*/);
});

// ─── cc_check terminal-result dedup ─────────────────────────────────────────

test("cc_check does not re-pay the full result for an unchanged terminal job", async (t) => {
  const server = startServer(t);
  // echo-args: the fake claude echoes its CLI args as the result, so "--print"
  // is a marker that only survives inside the full result payload.
  const delegate = await server.send(1, "cc_delegate", { task: "echo-args" });
  assert.match(delegate.result.content[0].text, /### 结果\n[\s\S]*--print/);

  // The delegate terminal return already delivered the result: the very next
  // cc_check must show the fingerprint + unchanged note, not the payload.
  const check = await server.send(2, "cc_check");
  const text = check.result.content[0].text;
  assert.match(text, /\*\*结果指纹：\*\* sha256:[0-9a-f]{12}/);
  assert.match(text, /与上次交付一致/);
  assert.doesNotMatch(text, /--print/);

  // includeResult=true is the explicit escape hatch and re-delivers.
  const forced = await server.send(3, "cc_check", { includeResult: true });
  assert.match(forced.result.content[0].text, /### 结果\n[\s\S]*--print/);

  // After a forced re-delivery, subsequent plain checks dedup again.
  const again = await server.send(4, "cc_check");
  assert.doesNotMatch(again.result.content[0].text, /--print/);
});
