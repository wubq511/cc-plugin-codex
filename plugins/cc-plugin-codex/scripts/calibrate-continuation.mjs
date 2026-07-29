#!/usr/bin/env node

/**
 * Paid, fail-closed A/B calibration for continuation strategies.
 *
 * The harness talks only to the source plugin over MCP. Claude is never
 * launched directly. Three isolated copies of the same fixture exercise:
 *   - Resume
 *   - explicit /compact, then Resume
 *   - Fresh with a bounded handoff
 *
 * A clean run uses six Provider calls: two seed delegations, three follow-up
 * delegations, and one compact. Fresh starts from a cloned post-seed workspace
 * and intentionally has no old Claude session. Every call reserves its full
 * per-call ceiling before MCP invocation; reservations are never refunded and
 * there are no automatic retries. Output contains aggregate metrics only —
 * never task text, transcript content, job IDs, session IDs, or paths.
 */

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { listJobs } from "./lib/state.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverPath = path.join(here, "cc-companion.mjs");

export const TOTAL_BUDGET_USD = 4.90;
export const PER_CALL_BUDGET_USD = 0.70;
export const MAX_PAID_CALLS = 7;
const REQUEST_TIMEOUT_MS = 12 * 60 * 1000;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MODEL_ALIASES = new Set(["Opus", "Fable", "Sonnet", "Haiku"]);

const INITIAL_TASK = [
  "Implement the rule evaluator described by AGENTS.md in this isolated fixture.",
  "Read the existing source and tests, implement the missing behavior, add focused tests where useful,",
  "and run the acceptance test. Keep the public API small and do not add dependencies.",
].join(" ");

const FOLLOW_UP_TASK = [
  "Address the review finding in this same fixture: add safe dotted-path field lookup for rule.field,",
  "reject __proto__, prototype, and constructor path segments, preserve all existing behavior,",
  "add regression tests, and run the acceptance test. Inspect the current workspace and diff first.",
].join(" ");

const FRESH_HANDOFF_TASK = [
  "Objective",
  "Harden the existing rule evaluator after the first implementation round.",
  "",
  "Current findings",
  "Add safe dotted-path lookup for rule.field and reject __proto__, prototype, and constructor segments.",
  "",
  "Constraints",
  "Preserve existing behavior, add no dependencies, and treat current files and git diff as truth.",
  "",
  "Acceptance checks",
  "Add regression tests and run node --test tests/rules.test.mjs.",
  "",
  "Inspect the current workspace and git diff as primary evidence before editing.",
].join("\n");

export function createBudgetLedger({
  totalBudgetUsd = TOTAL_BUDGET_USD,
  perCallBudgetUsd = PER_CALL_BUDGET_USD,
  maxPaidCalls = MAX_PAID_CALLS,
  initialReservedUsd = 0,
  initialPaidCalls = 0,
} = {}) {
  if (!Number.isFinite(initialReservedUsd) || initialReservedUsd < 0) {
    throw new Error("invalid-initial-reserved-usd");
  }
  if (!Number.isInteger(initialPaidCalls) || initialPaidCalls < 0) {
    throw new Error("invalid-initial-paid-calls");
  }
  if (initialReservedUsd > totalBudgetUsd || initialPaidCalls > maxPaidCalls) {
    throw new Error("initial-reservation-exceeds-cap");
  }
  let reservedUsd = Number(initialReservedUsd.toFixed(10));
  const calls = Array.from({ length: initialPaidCalls }, () => "prior-reservation");

  function reserve(label) {
    if (calls.length >= maxPaidCalls) {
      throw new Error(`paid-call-count-cap:${maxPaidCalls}`);
    }
    const next = Number((reservedUsd + perCallBudgetUsd).toFixed(10));
    if (next > totalBudgetUsd + Number.EPSILON) {
      throw new Error(`total-budget-cap:${totalBudgetUsd.toFixed(2)}`);
    }
    reservedUsd = next;
    calls.push(String(label));
    return perCallBudgetUsd;
  }

  function snapshot() {
    return {
      totalBudgetUsd,
      perCallBudgetUsd,
      maxPaidCalls,
      paidCallsReserved: calls.length,
      reservedUsd,
      remainingAuthorizationUsd: Number((totalBudgetUsd - reservedUsd).toFixed(10)),
    };
  }

  return { reserve, snapshot };
}

class McpClient {
  constructor({ cwd, env = process.env } = {}) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.child = spawn(process.execPath, [serverPath], {
      cwd: cwd || pluginRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`mcp-jsonrpc:${message.error.code}`));
      else pending.resolve(message.result);
    });
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-8192);
    });
  }

  request(method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`mcp-timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${payload}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "continuation-calibrator", version: "1.0.0" },
    }, 30000);
    this.notify("notifications/initialized");
  }

  async call(name, args) {
    const result = await this.request("tools/call", {
      name,
      arguments: args,
    });
    if (result?.isError) {
      const text = result?.content?.map((item) => item.text || "").join("\n") || "";
      const stage = text.match(/\[(spawn|cli_contract|configuration|provider_handshake|provider_response|json_protocol|timeout|cancelled)\]/)?.[1]
        || (text.match(/##\s+([A-Za-z ]+?)\s*(?:\n|$)/)?.[1] || "unspecified")
          .trim()
          .toLowerCase()
          .replace(/[^a-z]+/g, "-")
          .slice(0, 40);
      throw new Error(`tool-error:${name}:${stage || "unspecified"}`);
    }
    return result;
  }

  async close() {
    try {
      this.child.stdin.end();
      this.child.kill("SIGTERM");
    } catch {
      return;
    }
    await new Promise((resolve) => {
      if (this.child.exitCode !== null || this.child.signalCode !== null) {
        resolve();
        return;
      }
      this.child.once("exit", resolve);
      setTimeout(resolve, 3000);
    });
  }
}

function seedWorkspace(workspace) {
  fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  fs.mkdirSync(path.join(workspace, "tests"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "package.json"), `${JSON.stringify({
    name: "continuation-calibration-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test tests/rules.test.mjs" },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(workspace, "AGENTS.md"), [
    "# Fixture contract",
    "",
    "Implement `evaluate(record, rule)` in `src/rules.mjs`.",
    "Supported operators: `eq`, `includes`, `gt`, `and`, and `or`.",
    "`and`/`or` use a non-empty `rules` array; leaf rules use `field`, `op`, and `value`.",
    "Invalid shapes and unknown operators must throw TypeError.",
    "Do not mutate inputs or add dependencies.",
    "Acceptance: `node --test tests/rules.test.mjs`.",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(workspace, "src", "rules.mjs"), [
    "export function evaluate(_record, _rule) {",
    "  throw new Error(\"not implemented\");",
    "}",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(workspace, "tests", "rules.test.mjs"), [
    "import assert from \"node:assert/strict\";",
    "import test from \"node:test\";",
    "import { evaluate } from \"../src/rules.mjs\";",
    "",
    "test(\"leaf operators\", () => {",
    "  const record = { role: \"admin\", tags: [\"a\", \"b\"], score: 8 };",
    "  assert.equal(evaluate(record, { field: \"role\", op: \"eq\", value: \"admin\" }), true);",
    "  assert.equal(evaluate(record, { field: \"tags\", op: \"includes\", value: \"b\" }), true);",
    "  assert.equal(evaluate(record, { field: \"score\", op: \"gt\", value: 7 }), true);",
    "});",
    "",
    "test(\"boolean composition\", () => {",
    "  const record = { role: \"admin\", score: 8 };",
    "  assert.equal(evaluate(record, { op: \"and\", rules: [",
    "    { field: \"role\", op: \"eq\", value: \"admin\" },",
    "    { field: \"score\", op: \"gt\", value: 7 },",
    "  ] }), true);",
    "  assert.equal(evaluate(record, { op: \"or\", rules: [",
    "    { field: \"role\", op: \"eq\", value: \"user\" },",
    "    { field: \"score\", op: \"gt\", value: 7 },",
    "  ] }), true);",
    "});",
    "",
    "test(\"invalid rules fail closed\", () => {",
    "  assert.throws(() => evaluate({}, { op: \"unknown\" }), TypeError);",
    "  assert.throws(() => evaluate({}, { op: \"and\", rules: [] }), TypeError);",
    "});",
    "",
  ].join("\n"));
  spawnSync("git", ["init", "-q"], { cwd: workspace, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: workspace, stdio: "ignore" });
  spawnSync("git", ["-c", "user.name=Calibration", "-c", "user.email=calibration@local",
    "commit", "-qm", "seed"], { cwd: workspace, stdio: "ignore" });
}

function cloneImplementedWorkspace(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of ["AGENTS.md", "package.json", "src", "tests"]) {
    fs.cpSync(path.join(source, entry), path.join(target, entry), {
      recursive: true,
      force: true,
    });
  }
  spawnSync("git", ["init", "-q"], { cwd: target, stdio: "ignore" });
  spawnSync("git", ["add", "."], { cwd: target, stdio: "ignore" });
  spawnSync("git", ["-c", "user.name=Calibration", "-c", "user.email=calibration@local",
    "commit", "-qm", "post-seed snapshot"], { cwd: target, stdio: "ignore" });
}

function newestNewJob(workspace, beforeIds) {
  const candidates = listJobs(workspace)
    .filter((job) => !beforeIds.has(job.id))
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const job = candidates[0];
  if (!job || job.status !== "completed" || !job.claudeSessionId) {
    throw new Error("completed-job-not-found");
  }
  return job;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : null;
}

function runAcceptance(workspace) {
  const result = spawnSync(process.execPath, ["--test", "tests/rules.test.mjs"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 30000,
    stdio: "pipe",
  });
  return result.status === 0;
}

function workspaceDigest(workspace) {
  const hash = createHash("sha256");
  const roots = ["src", "tests"];
  for (const root of roots) {
    const rootPath = path.join(workspace, root);
    const stack = [rootPath];
    while (stack.length > 0) {
      const current = stack.pop();
      for (const entry of fs.readdirSync(current, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const candidate = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(candidate);
        else if (entry.isFile()) {
          hash.update(path.relative(workspace, candidate));
          hash.update(fs.readFileSync(candidate));
        }
      }
    }
  }
  return hash.digest("hex").slice(0, 16);
}

function transcriptProjectsDir() {
  const configRoot = process.env.CLAUDE_CONFIG_DIR
    ? path.resolve(process.env.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), ".claude");
  return path.join(configRoot, "projects");
}

function findTranscript(sessionId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(sessionId || ""))) return null;
  const projects = transcriptProjectsDir();
  let entries;
  try {
    entries = fs.readdirSync(projects, { withFileTypes: true });
  } catch {
    return null;
  }
  const realProjects = fs.realpathSync(projects);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projects, entry.name, `${sessionId}.jsonl`);
    try {
      const realCandidate = fs.realpathSync(candidate);
      if (!realCandidate.startsWith(`${realProjects}${path.sep}`)) continue;
      const stat = fs.statSync(realCandidate);
      if (stat.isFile() && stat.size <= MAX_TRANSCRIPT_BYTES) return realCandidate;
    } catch {
      // Try the next project directory.
    }
  }
  return null;
}

function transcriptReadMetrics(sessionId) {
  const transcript = findTranscript(sessionId);
  if (!transcript) return null;
  const counts = new Map();
  let assistantTurns = 0;
  let bytes = 0;
  const lines = fs.readFileSync(transcript, "utf8").split("\n");
  for (const line of lines) {
    bytes += Buffer.byteLength(line, "utf8") + 1;
    if (bytes > MAX_TRANSCRIPT_BYTES || !line) break;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const message = record?.message || record;
    if (message?.role === "assistant") assistantTurns += 1;
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const block of content) {
      if (block?.type !== "tool_use" || block?.name !== "Read") continue;
      const target = block?.input?.file_path || block?.input?.path;
      if (typeof target !== "string" || !target) continue;
      const key = createHash("sha256").update(target).digest("hex").slice(0, 16);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return { counts, assistantTurns };
}

function followReadMetrics(seedMetrics, finalMetrics, sameSession) {
  if (!seedMetrics || !finalMetrics) {
    return {
      available: false,
      followReadCalls: null,
      repeatedSeedReads: null,
      duplicateFollowReads: null,
    };
  }
  const followCounts = new Map();
  for (const [key, count] of finalMetrics.counts) {
    const prior = sameSession ? (seedMetrics.counts.get(key) || 0) : 0;
    const delta = Math.max(0, count - prior);
    if (delta > 0) followCounts.set(key, delta);
  }
  let followReadCalls = 0;
  let repeatedSeedReads = 0;
  let duplicateFollowReads = 0;
  for (const [key, count] of followCounts) {
    followReadCalls += count;
    if (seedMetrics.counts.has(key)) repeatedSeedReads += count;
    duplicateFollowReads += Math.max(0, count - 1);
  }
  return {
    available: true,
    followReadCalls,
    repeatedSeedReads,
    duplicateFollowReads,
  };
}

function plannerArgs(workspace, parentJob, model, overrides = {}) {
  return {
    cwd: workspace,
    parentJob: parentJob.id,
    relationship: "same_attempt",
    contextValue: "useful",
    userIntent: "auto",
    correctionCount: 0,
    allowCompact: true,
    model,
    write: true,
    sessionPollution: false,
    ...overrides,
  };
}

async function observePlan(client, workspace, parentJob, model) {
  const result = await client.call(
    "cc_plan_continuation",
    plannerArgs(workspace, parentJob, model),
  );
  const structured = result.structuredContent || {};
  return {
    action: structured.action || null,
    evidenceState: structured.evidenceState || null,
    pressure: safeNumber(structured.pressure),
    threshold: safeNumber(structured.pressureThreshold),
  };
}

async function issuePlan(client, workspace, parentJob, model, overrides) {
  const result = await client.call(
    "cc_plan_continuation",
    plannerArgs(workspace, parentJob, model, overrides),
  );
  if (!result.structuredContent?.planId || !result.structuredContent?.action) {
    throw new Error("planner-structured-content-missing");
  }
  return result.structuredContent;
}

async function runCalibration({
  mode,
  model,
  keepWorkspaces,
  priorReservedUsd = 0,
  priorPaidCalls = 0,
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cc-continuation-calibration-"));
  const workspaces = {
    resume: path.join(root, "resume"),
    compact_resume: path.join(root, "compact-resume"),
    fresh_handoff: path.join(root, "fresh-handoff"),
  };
  for (const workspace of [workspaces.resume, workspaces.compact_resume]) {
    fs.mkdirSync(workspace, { recursive: true });
    seedWorkspace(workspace);
  }

  const ledger = createBudgetLedger({
    initialReservedUsd: priorReservedUsd,
    initialPaidCalls: priorPaidCalls,
  });
  const client = new McpClient({ cwd: pluginRoot });
  const report = {
    schemaVersion: 1,
    mode,
    model,
    budget: null,
    preflight: { sourceMcp: true, toolCount: null, budgetGuard: false },
    arms: [],
    currentRunKnownCostUsd: null,
    actualKnownCostUsd: null,
    qualityComparable: false,
    conclusion: "inconclusive",
  };

  async function paidCall(label, tool, args) {
    const maxBudgetUsd = ledger.reserve(label);
    return client.call(tool, { ...args, maxBudgetUsd });
  }

  async function delegateAndGetJob(label, workspace, task, extra = {}) {
    const beforeIds = new Set(listJobs(workspace).map((job) => job.id));
    const startedAt = performance.now();
    await paidCall(label, "cc_delegate", {
      cwd: workspace,
      task,
      write: true,
      model,
      effort: "medium",
      dangerouslySkipPermissions: true,
      ...extra,
    });
    const wallSeconds = (performance.now() - startedAt) / 1000;
    return { job: newestNewJob(workspace, beforeIds), wallSeconds };
  }

  try {
    await client.initialize();
    const tools = await client.request("tools/list");
    const names = tools?.tools?.map((tool) => tool.name) || [];
    report.preflight.toolCount = names.length;
    for (const required of ["cc_delegate", "cc_compact", "cc_plan_continuation", "cc_setup"]) {
      if (!names.includes(required)) throw new Error(`preflight-missing-tool:${required}`);
    }
    const setup = await client.call("cc_setup", { cwd: pluginRoot });
    const setupText = setup?.content?.map((item) => item.text || "").join("\n") || "";
    report.preflight.budgetGuard = /Budget guard supported/i.test(setupText);
    if (!report.preflight.budgetGuard) throw new Error("preflight-budget-guard-unavailable");
    if (mode === "dry-run" && !/fake/i.test(setupText)) {
      throw new Error("dry-run-requires-fake-claude");
    }

    const resumeSeed = await delegateAndGetJob(
      "resume:seed",
      workspaces.resume,
      INITIAL_TASK,
    );
    const compactSeed = await delegateAndGetJob(
      "compact_resume:seed",
      workspaces.compact_resume,
      INITIAL_TASK,
    );
    cloneImplementedWorkspace(workspaces.resume, workspaces.fresh_handoff);

    const seedByStrategy = {
      resume: resumeSeed,
      compact_resume: compactSeed,
      fresh_handoff: resumeSeed,
    };
    const seedReadsByStrategy = {
      resume: transcriptReadMetrics(resumeSeed.job.claudeSessionId),
      compact_resume: transcriptReadMetrics(compactSeed.job.claudeSessionId),
      fresh_handoff: transcriptReadMetrics(resumeSeed.job.claudeSessionId),
    };
    const observationByStrategy = {
      resume: await observePlan(client, workspaces.resume, resumeSeed.job, model),
      compact_resume: await observePlan(
        client,
        workspaces.compact_resume,
        compactSeed.job,
        model,
      ),
    };
    observationByStrategy.fresh_handoff = observationByStrategy.resume;

    for (const [strategy, workspace] of Object.entries(workspaces)) {
      const seed = seedByStrategy[strategy];
      const seedReads = seedReadsByStrategy[strategy];
      const observation = observationByStrategy[strategy];
      let compact = null;
      let plan;
      let followTask = FOLLOW_UP_TASK;

      if (strategy === "resume") {
        plan = await issuePlan(client, workspace, seed.job, model, {
          userIntent: "same_session",
          allowCompact: false,
        });
        if (plan.action !== "resume") throw new Error("resume-arm-plan-mismatch");
      } else if (strategy === "fresh_handoff") {
        const result = await client.call("cc_plan_continuation", {
          cwd: workspace,
          relationship: "same_attempt",
          contextValue: "reconstructable",
          userIntent: "fresh",
          correctionCount: 0,
          allowCompact: true,
          model,
          write: true,
          sessionPollution: false,
        });
        plan = result.structuredContent;
        if (plan.action !== "fresh_handoff") throw new Error("fresh-arm-plan-mismatch");
        followTask = FRESH_HANDOFF_TASK;
      } else {
        const compactStartedAt = performance.now();
        const compactResult = await paidCall(`${strategy}:compact`, "cc_compact", {
          cwd: workspace,
          job: seed.job.id,
        });
        const compactWallSeconds = (performance.now() - compactStartedAt) / 1000;
        compact = {
          boundaryObserved: compactResult.structuredContent?.compacted === true,
          costUsd: safeNumber(compactResult.structuredContent?.costUsd),
          durationSeconds: safeNumber(compactResult.structuredContent?.durationSeconds),
          wallSeconds: Number(compactWallSeconds.toFixed(3)),
        };
        plan = await issuePlan(client, workspace, seed.job, model, {
          userIntent: "same_session",
          allowCompact: false,
        });
        if (plan.action !== "resume") throw new Error("post-compact-resume-plan-mismatch");
      }

      const follow = await delegateAndGetJob(
        `${strategy}:follow`,
        workspace,
        followTask,
        { continuationPlan: plan.planId },
      );
      const finalReads = transcriptReadMetrics(follow.job.claudeSessionId);
      const sameSession = strategy !== "fresh_handoff";
      const reads = followReadMetrics(seedReads, finalReads, sameSession);
      const qualityPassed = mode === "dry-run" ? null : runAcceptance(workspace);
      const knownCosts = [
        safeNumber(follow.job.cost),
        compact?.costUsd ?? 0,
      ];
      const incrementalCostUsd = knownCosts.every((value) => value !== null)
        ? knownCosts.reduce((sum, value) => sum + value, 0)
        : null;
      const seedCostUsd = safeNumber(seed.job.cost);
      const scenarioCostUsd = seedCostUsd !== null && incrementalCostUsd !== null
        ? seedCostUsd + incrementalCostUsd
        : null;
      report.arms.push({
        strategy,
        plannerRecommendationAfterSeed: observation,
        compact,
        seedCostUsd,
        incrementalCostUsd: incrementalCostUsd === null
          ? null
          : Number(incrementalCostUsd.toFixed(6)),
        scenarioCostUsd: scenarioCostUsd === null
          ? null
          : Number(scenarioCostUsd.toFixed(6)),
        providerDurationSeconds: Number((
          + (safeNumber(follow.job.duration) || 0)
          + (compact?.durationSeconds || 0)
        ).toFixed(3)),
        wallSeconds: Number((
          follow.wallSeconds
          + (compact?.wallSeconds || 0)
        ).toFixed(3)),
        qualityPassed,
        workspaceDigest: mode === "dry-run" ? null : workspaceDigest(workspace),
        transcriptReadMetrics: reads,
      });
    }

    report.budget = ledger.snapshot();
    const uniqueActualCosts = [
      safeNumber(resumeSeed.job.cost),
      safeNumber(compactSeed.job.cost),
      ...report.arms.map((arm) => arm.incrementalCostUsd),
    ];
    report.currentRunKnownCostUsd = uniqueActualCosts.every((cost) => cost !== null)
      ? Number(uniqueActualCosts.reduce((sum, cost) => sum + cost, 0).toFixed(6))
      : null;
    report.actualKnownCostUsd = priorPaidCalls === 0
      ? report.currentRunKnownCostUsd
      : null;
    report.qualityComparable = mode === "dry-run"
      ? false
      : report.arms.every((arm) => arm.qualityPassed === true);
    const compactArm = report.arms.find((arm) => arm.strategy === "compact_resume");
    if (!report.qualityComparable) {
      report.conclusion = "inconclusive-quality";
    } else if (!compactArm?.compact?.boundaryObserved) {
      report.conclusion = "inconclusive-compact-boundary";
    } else {
      report.conclusion = "comparable-single-run";
    }
    return report;
  } catch (error) {
    report.budget = ledger.snapshot();
    report.errorCode = String(error?.message || "calibration-failed")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "[session]")
      .slice(0, 160);
    return report;
  } finally {
    await client.close();
    if (!keepWorkspaces) {
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: process.platform === "win32" ? 8 : 0,
        retryDelay: 100,
      });
    }
  }
}

function parseArgs(argv) {
  const dryRun = argv.includes("--dry-run");
  const paid = argv.includes("--confirm-paid-calibration");
  if (dryRun === paid) {
    throw new Error("Choose exactly one mode: --dry-run or --confirm-paid-calibration");
  }
  const modelArg = argv.find((arg) => arg.startsWith("--model="));
  const model = modelArg ? modelArg.slice("--model=".length) : "Fable";
  if (!MODEL_ALIASES.has(model)) {
    throw new Error("Calibration model must be one of: Opus, Fable, Sonnet, Haiku");
  }
  const priorReservedArg = argv.find((arg) => arg.startsWith("--prior-reserved-usd="));
  const priorPaidCallsArg = argv.find((arg) => arg.startsWith("--prior-paid-calls="));
  const priorReservedUsd = priorReservedArg
    ? Number(priorReservedArg.slice("--prior-reserved-usd=".length))
    : 0;
  const priorPaidCalls = priorPaidCallsArg
    ? Number(priorPaidCallsArg.slice("--prior-paid-calls=".length))
    : 0;
  if (!Number.isFinite(priorReservedUsd) || priorReservedUsd < 0) {
    throw new Error("--prior-reserved-usd must be a non-negative number");
  }
  if (!Number.isInteger(priorPaidCalls) || priorPaidCalls < 0) {
    throw new Error("--prior-paid-calls must be a non-negative integer");
  }
  return {
    mode: dryRun ? "dry-run" : "paid",
    model,
    keepWorkspaces: argv.includes("--keep-workspaces"),
    priorReservedUsd,
    priorPaidCalls,
  };
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const report = await runCalibration(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.errorCode) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  await main();
}
