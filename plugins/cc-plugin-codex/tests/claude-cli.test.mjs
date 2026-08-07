/**
 * Tests for claude-cli.mjs — the Claude CLI query adapter.
 *
 * All probes are synchronous and make zero model calls. A fake `claude`
 * binary (tests/helpers/fake-claude.mjs) is placed on PATH so the probes
 * exercise the real spawnSync + resolveCommandForSpawn path deterministically.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  getClaudeVersion,
  readClaudeHelp,
  checkBudgetGuardSupported,
  getClaudeAvailability,
} from "../scripts/lib/claude-cli.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const fakeClaudeSource = path.join(here, "helpers", "fake-claude.mjs");

/**
 * Put the fake claude on PATH for the duration of the test.
 * Mirrors installFakeClaude in the MCP e2e suites: on Windows a `.cmd` shim
 * plus `.js` entrypoint are installed so resolveCommandForSpawn can resolve
 * the shim to a direct Node invocation.
 */
function withFakeClaude(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-cli-"));
  const binDir = path.join(dir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

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

  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${prevPath || ""}`;
  t.after(() => {
    process.env.PATH = prevPath;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

// ─── readClaudeHelp ─────────────────────────────────────────────────────────

test("readClaudeHelp: fake claude on PATH returns ok with help text", (t) => {
  withFakeClaude(t);
  const help = readClaudeHelp(process.cwd());
  assert.equal(help.ok, true);
  assert.match(help.text, /--print\b/);
  assert.match(help.text, /--output-format\b/);
});

test("readClaudeHelp: non-zero help exit fails closed", (t) => {
  withFakeClaude(t);
  process.env.FAKE_CLAUDE_HELP_EXIT_CODE = "7";
  t.after(() => { delete process.env.FAKE_CLAUDE_HELP_EXIT_CODE; });
  const help = readClaudeHelp(process.cwd());
  assert.equal(help.ok, false);
});

// ─── checkBudgetGuardSupported ───────────────────────────────────────────────

test("checkBudgetGuardSupported: true when help advertises --max-budget-usd", (t) => {
  withFakeClaude(t);
  process.env.FAKE_CLAUDE_HELP_BUDGET_GUARD = "1";
  t.after(() => { delete process.env.FAKE_CLAUDE_HELP_BUDGET_GUARD; });
  assert.equal(checkBudgetGuardSupported(process.cwd()), true);
});

test("checkBudgetGuardSupported: false when help omits the flag", (t) => {
  withFakeClaude(t);
  assert.equal(checkBudgetGuardSupported(process.cwd()), false);
});

// ─── getClaudeVersion ────────────────────────────────────────────────────────

test("getClaudeVersion: returns the CLI version string", (t) => {
  withFakeClaude(t);
  assert.equal(getClaudeVersion(process.cwd()), "1.0.0-fake");
});

test("getClaudeVersion: unresolvable command returns null", () => {
  assert.equal(getClaudeVersion(process.cwd(), { command: "definitely-not-a-claude-xyz" }), null);
});

// ─── getClaudeAvailability ───────────────────────────────────────────────────

test("getClaudeAvailability: available with fake claude on PATH", (t) => {
  withFakeClaude(t);
  const { available, detail } = getClaudeAvailability(process.cwd());
  assert.equal(available, true);
  assert.match(detail, /claude available/);
});

test("getClaudeAvailability: unresolvable command reports unavailable", () => {
  const { available } = getClaudeAvailability(process.cwd(), { command: "definitely-not-a-claude-xyz" });
  assert.equal(available, false);
});
