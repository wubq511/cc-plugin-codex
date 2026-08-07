import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createBudgetLedger,
  MAX_PAID_CALLS,
  PER_CALL_BUDGET_USD,
  TOTAL_BUDGET_USD,
} from "../scripts/calibrate-continuation.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const calibrationScript = path.join(pluginRoot, "scripts", "calibrate-continuation.mjs");
const fakeClaude = path.join(here, "helpers", "fake-claude.mjs");

function installFakeClaude(binDir) {
  const executable = path.join(binDir, "claude");
  fs.copyFileSync(fakeClaude, executable);
  fs.chmodSync(executable, 0o755);
  if (process.platform === "win32") {
    fs.copyFileSync(fakeClaude, path.join(binDir, "claude.js"));
    fs.writeFileSync(
      path.join(binDir, "claude.cmd"),
      `@ECHO off\r\n"${process.execPath}" "%~dp0claude.js" %*\r\n`,
      "utf8",
    );
  }
}

test("calibration ledger reserves exactly seven calls under the 4.90 USD cap", () => {
  const ledger = createBudgetLedger();
  for (let i = 0; i < MAX_PAID_CALLS; i += 1) {
    assert.equal(ledger.reserve(`call-${i}`), PER_CALL_BUDGET_USD);
  }
  const snapshot = ledger.snapshot();
  assert.equal(snapshot.totalBudgetUsd, TOTAL_BUDGET_USD);
  assert.equal(snapshot.paidCallsReserved, 7);
  assert.equal(snapshot.reservedUsd, 4.9);
  assert.equal(snapshot.remainingAuthorizationUsd, 0);
  assert.throws(() => ledger.reserve("eighth"), /paid-call-count-cap/);
});

test("calibration ledger rejects a total budget that cannot authorize the next call", () => {
  const ledger = createBudgetLedger({
    totalBudgetUsd: 1,
    perCallBudgetUsd: 0.6,
    maxPaidCalls: 7,
  });
  ledger.reserve("first");
  assert.throws(() => ledger.reserve("second"), /total-budget-cap/);
  assert.equal(ledger.snapshot().reservedUsd, 0.6);
});

test("calibration ledger carries a prior failed reservation into the same hard cap", () => {
  const ledger = createBudgetLedger({
    initialReservedUsd: 0.7,
    initialPaidCalls: 1,
  });
  for (let i = 0; i < 6; i += 1) ledger.reserve(`remaining-${i}`);
  assert.equal(ledger.snapshot().paidCallsReserved, 7);
  assert.equal(ledger.snapshot().reservedUsd, 4.9);
  assert.throws(() => ledger.reserve("overflow"), /paid-call-count-cap/);
});

test("dry-run exercises all three MCP strategies with fake Claude and six guarded calls", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "cc-calibration-test-"));
  const binDir = path.join(temp, "bin");
  const configDir = path.join(temp, "claude");
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  installFakeClaude(binDir);
  try {
    const result = spawnSync(process.execPath, [calibrationScript, "--dry-run"], {
      cwd: pluginRoot,
      encoding: "utf8",
      timeout: 120000,
      env: {
        ...process.env,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
        CLAUDE_CONFIG_DIR: configDir,
        FAKE_CLAUDE_HELP_BUDGET_GUARD: "1",
        // Headless calibration: never auto-open the dashboard in a real
        // browser, matching every other test that spawns the companion.
        CC_COMPANION_DASHBOARD_OPEN: "off",
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const report = JSON.parse(result.stdout);
    assert.equal(report.mode, "dry-run");
    assert.equal(report.preflight.toolCount, 9);
    assert.equal(report.preflight.budgetGuard, true);
    assert.deepEqual(
      report.arms.map((arm) => arm.strategy),
      ["resume", "compact_resume", "fresh_handoff"],
    );
    assert.equal(report.budget.paidCallsReserved, 6);
    assert.equal(report.budget.reservedUsd, 4.2);
    assert.equal(report.errorCode, undefined);
  } finally {
    fs.rmSync(temp, {
      recursive: true,
      force: true,
      maxRetries: process.platform === "win32" ? 8 : 0,
      retryDelay: 100,
    });
  }
});
