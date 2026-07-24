import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isValidSessionId,
  normalizeModelIdForStorage,
  escapeModelIdForMarkdown,
  sanitizeModelId,
  extractUsageModelKeys,
  collectModelEvidence,
  parseTranscriptModels,
  formatModelEvidence,
  formatModelCompact,
  formatWarnings,
  migrateV3ModelFields,
  WARNINGS,
  MAX_LINE_BYTES,
  MAX_MAIN_TRANSCRIPT_BYTES,
  MAX_MODEL_ID_BYTES,
} from "../scripts/lib/model-evidence.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// ─── Session ID Validation ──────────────────────────────────────────────────

test("valid session IDs are accepted", () => {
  assert.equal(isValidSessionId("abc123"), true);
  assert.equal(isValidSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(isValidSessionId("session-abc-123"), true);
  assert.equal(isValidSessionId("a"), true);
});

test("invalid session IDs are rejected", () => {
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId(null), false);
  assert.equal(isValidSessionId(undefined), false);
  assert.equal(isValidSessionId(123), false);
  // Path traversal
  assert.equal(isValidSessionId("../etc/passwd"), false);
  assert.equal(isValidSessionId("foo/bar"), false);
  assert.equal(isValidSessionId("foo\\bar"), false);
  assert.equal(isValidSessionId(".."), false);
  // Control characters
  assert.equal(isValidSessionId("abc\x00def"), false);
  assert.equal(isValidSessionId("abc\x1bdef"), false);
  // NUL
  assert.equal(isValidSessionId("abc\0def"), false);
});

// ─── Model ID Sanitization ──────────────────────────────────────────────────

test("sanitizeModelId strips control characters", () => {
  assert.equal(sanitizeModelId("mimo-v2.5-pro"), "mimo-v2.5-pro");
  assert.equal(sanitizeModelId("model\x00name"), "modelname");
  assert.equal(sanitizeModelId("model\x1bname"), "modelname");
  // LF/CR/Tab must also be stripped (prevents Markdown injection)
  assert.equal(sanitizeModelId("safe\n**Injected**\rnext"), "safe**Injected**next");
  assert.equal(sanitizeModelId("model\twith\ttabs"), "modelwithtabs");
});

test("sanitizeModelId escapes Markdown pipe and backtick", () => {
  assert.equal(sanitizeModelId("model|name"), "model\\|name");
  assert.equal(sanitizeModelId("model`name"), "model\\`name");
});

test("sanitizeModelId truncates to 256 bytes", () => {
  const long = "x".repeat(300);
  const sanitized = sanitizeModelId(long);
  assert.ok(Buffer.byteLength(sanitized, "utf8") <= 256);
  assert.ok(sanitized.length < 300);
});

test("sanitizeModelId handles null/undefined/empty", () => {
  assert.equal(sanitizeModelId(null), null);
  assert.equal(sanitizeModelId(undefined), null);
  assert.equal(sanitizeModelId(""), null);
});

// ─── normalizeModelIdForStorage ────────────────────────────────────────────

test("normalizeModelIdForStorage strips control chars but preserves pipe/backslash", () => {
  assert.equal(normalizeModelIdForStorage("mimo-v2.5-pro"), "mimo-v2.5-pro");
  assert.equal(normalizeModelIdForStorage("safe\n**X**\rnext"), "safe**X**next");
  assert.equal(normalizeModelIdForStorage("model\twith\ttabs"), "modelwithtabs");
  // Pipe and backslash are NOT stripped (no Markdown escaping here)
  assert.equal(normalizeModelIdForStorage("a|b"), "a|b");
  assert.equal(normalizeModelIdForStorage("org\\model-pro"), "org\\model-pro");
});

// ─── escapeModelIdForMarkdown ──────────────────────────────────────────────

test("escapeModelIdForMarkdown: pipe and backtick escaping rules", () => {
  // Unescaped → escape
  assert.equal(escapeModelIdForMarkdown("a|b"), "a\\|b");
  assert.equal(escapeModelIdForMarkdown("a`b"), "a\\`b");
  // Already escaped (odd backslashes before) → unchanged
  assert.equal(escapeModelIdForMarkdown("a\\|b"), "a\\|b");
  assert.equal(escapeModelIdForMarkdown("a\\`b"), "a\\`b");
  // Even backslashes before = unescaped → add escape
  assert.equal(escapeModelIdForMarkdown("a\\\\|b"), "a\\\\\\|b");
  // Backslash before non-special → unchanged
  assert.equal(escapeModelIdForMarkdown("org\\model-pro"), "org\\model-pro");
});

test("escapeModelIdForMarkdown is idempotent", () => {
  const cases = ["a|b", "a\\|b", "a\\\\|b", "org\\model-pro", "a`b", "a\\`b"];
  for (const c of cases) {
    const once = escapeModelIdForMarkdown(c);
    const twice = escapeModelIdForMarkdown(once);
    assert.equal(once, twice, `idempotent for ${JSON.stringify(c)}: ${once} vs ${twice}`);
  }
});

// ─── Usage Key Extraction ───────────────────────────────────────────────────

test("extractUsageModelKeys returns all keys from modelUsage", () => {
  assert.deepEqual(extractUsageModelKeys({ "mimo-v2.5": {}, "glm-5.1": {} }), ["mimo-v2.5", "glm-5.1"]);
});

test("extractUsageModelKeys returns empty for missing/invalid modelUsage", () => {
  assert.deepEqual(extractUsageModelKeys(null), []);
  assert.deepEqual(extractUsageModelKeys(undefined), []);
  assert.deepEqual(extractUsageModelKeys([]), []);
  assert.deepEqual(extractUsageModelKeys("string"), []);
  assert.deepEqual(extractUsageModelKeys({}), []);
});

test("extractUsageModelKeys deduplicates and limits to 16", () => {
  const obj = {};
  for (let i = 0; i < 20; i++) obj[`model-${i}`] = {};
  const keys = extractUsageModelKeys(obj);
  assert.equal(keys.length, 16);
});

test("extractUsageModelKeys sanitizes keys", () => {
  assert.deepEqual(extractUsageModelKeys({ "model|pipe": {} }), ["model|pipe"]);
});

// ─── Transcript Collector ───────────────────────────────────────────────────

test("collector returns unavailable for invalid sessionId", async () => {
  const result = await collectModelEvidence({
    sessionId: "../etc/passwd",
    usageModelKeys: ["mimo-v2.5"],
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.executedModels.length, 0);
  assert.deepEqual(result.usageModelKeys, ["mimo-v2.5"]);
  assert.ok(result.warnings.includes("invalid-session-id"));
});

test("collector returns unavailable when transcript not found", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-model-evidence-"));
  try {
    const result = await collectModelEvidence({
      sessionId: "nonexistent-session-id",
      usageModelKeys: ["mimo-v2.5"],
      claudeConfigDir: tmpDir,
      deadlineMs: 200,
    });
    assert.equal(result.status, "unavailable");
    assert.equal(result.executedModels.length, 0);
    assert.deepEqual(result.usageModelKeys, ["mimo-v2.5"]);
    assert.ok(result.warnings.includes("transcript-not-found"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collector rejects a projects root symlink that escapes config root", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-projects-root-"));
  const escapeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-projects-escape-"));
  try {
    const projectDir = path.join(escapeDir, "external-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "root-symlink-session";
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "must-not-be-read" } }) + "\n"
    );
    fs.symlinkSync(escapeDir, path.join(tmpDir, "projects"));

    const result = await collectModelEvidence({
      sessionId,
      claudeConfigDir: tmpDir,
      deadlineMs: 1000,
    });
    assert.equal(result.status, "unavailable");
    assert.deepEqual(result.executedModels, []);
    assert.ok(result.warnings.includes(WARNINGS.SYMLINK_ESCAPE));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(escapeDir, { recursive: true, force: true });
  }
});

test("collector marks subagent permission failures as partial evidence", async (t) => {
  if (process.platform === "win32") return;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-subagent-eacces-"));
  const projectDir = path.join(tmpDir, "projects", "project");
  const sessionId = "subagent-eacces-session";
  const subagentsDir = path.join(projectDir, sessionId, "subagents");
  fs.mkdirSync(subagentsDir, { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: "assistant", message: { role: "assistant", model: "main-model" } }) + "\n"
  );
  const deniedFile = path.join(subagentsDir, "denied.jsonl");
  fs.writeFileSync(deniedFile, "{}\n");
  fs.chmodSync(deniedFile, 0o000);
  t.after(() => {
    try { fs.chmodSync(deniedFile, 0o600); } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const result = await collectModelEvidence({
    sessionId,
    claudeConfigDir: tmpDir,
    deadlineMs: 1000,
  });
  assert.equal(result.status, "partial");
  assert.ok(result.warnings.includes(WARNINGS.READ_ERROR));
  assert.equal(result.executedModels[0].id, "main-model");
});

test("collector reads main transcript and extracts models", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-model-evidence-"));
  try {
    const projectsDir = path.join(tmpDir, "projects");
    const projectDir = path.join(projectsDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = "test-session-12345";
    const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);

    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "mimo-v2.5-pro", id: "msg-1" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "mimo-v2.5-pro", id: "msg-2" } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "glm-5.1", id: "msg-3" } }),
    ];
    fs.writeFileSync(transcriptFile, lines.join("\n") + "\n");

    const result = await collectModelEvidence({
      sessionId,
      usageModelKeys: ["mimo-v2.5"],
      claudeConfigDir: tmpDir,
      deadlineMs: 2000,
    });

    assert.equal(result.status, "complete");
    assert.equal(result.executedModels.length, 2);
    assert.equal(result.executedModels[0].id, "mimo-v2.5-pro");
    assert.deepEqual(result.executedModels[0].scopes, ["main"]);
    assert.equal(result.executedModels[1].id, "glm-5.1");
    assert.deepEqual(result.executedModels[1].scopes, ["main"]);
    assert.deepEqual(result.usageModelKeys, ["mimo-v2.5"]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collector handles bad JSON lines gracefully", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-model-evidence-"));
  try {
    const projectsDir = path.join(tmpDir, "projects");
    const projectDir = path.join(projectsDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = "bad-json-session";
    const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);

    const lines = [
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "mimo-v2.5-pro", id: "msg-1" } }),
      "this is not valid json{{{",
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "glm-5.1", id: "msg-2" } }),
    ];
    fs.writeFileSync(transcriptFile, lines.join("\n") + "\n");

    const result = await collectModelEvidence({
      sessionId,
      usageModelKeys: ["mimo-v2.5"],
      claudeConfigDir: tmpDir,
      deadlineMs: 2000,
    });

    assert.equal(result.status, "partial");
    assert.equal(result.executedModels.length, 2);
    assert.ok(result.warnings.includes("invalid-json-lines"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collector handles empty transcript file", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-model-evidence-"));
  try {
    const projectsDir = path.join(tmpDir, "projects");
    const projectDir = path.join(projectsDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = "empty-session";
    const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptFile, "");

    const result = await collectModelEvidence({
      sessionId,
      usageModelKeys: ["mimo-v2.5"],
      claudeConfigDir: tmpDir,
      deadlineMs: 200,
    });

    assert.equal(result.status, "unavailable");
    assert.equal(result.executedModels.length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collector rejects symlink that escapes config root", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-model-evidence-"));
  const escapeDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-escape-"));
  try {
    const projectsDir = path.join(tmpDir, "projects");
    const projectDir = path.join(projectsDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const externalFile = path.join(escapeDir, "evil.jsonl");
    fs.writeFileSync(externalFile, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "evil-model" } }) + "\n");

    const sessionId = "symlink-session";
    const symlinkPath = path.join(projectDir, `${sessionId}.jsonl`);
    try {
      fs.symlinkSync(externalFile, symlinkPath);
    } catch {
      return; // Symlinks may not be supported
    }

    const result = await collectModelEvidence({
      sessionId,
      usageModelKeys: ["mimo-v2.5"],
      claudeConfigDir: tmpDir,
      deadlineMs: 200,
    });

    assert.equal(result.status, "unavailable");
    assert.equal(result.executedModels.length, 0);
    assert.ok(result.warnings.includes(WARNINGS.SYMLINK_ESCAPE));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(escapeDir, { recursive: true, force: true });
  }
});

test("collector reads subagent transcripts", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-model-evidence-"));
  try {
    const projectsDir = path.join(tmpDir, "projects");
    const projectDir = path.join(projectsDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = "subagent-session";
    const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptFile, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "mimo-v2.5-pro", id: "msg-1" } }) + "\n");

    const subagentsDir = path.join(projectDir, sessionId, "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(path.join(subagentsDir, "sub-1.jsonl"), JSON.stringify({ type: "assistant", message: { role: "assistant", model: "glm-5.1", id: "sub-msg-1" } }) + "\n");

    const result = await collectModelEvidence({
      sessionId,
      usageModelKeys: ["mimo-v2.5"],
      claudeConfigDir: tmpDir,
      deadlineMs: 2000,
    });

    assert.equal(result.status, "complete");
    const mainModel = result.executedModels.find((m) => m.id === "mimo-v2.5-pro");
    assert.ok(mainModel);
    assert.ok(mainModel.scopes.includes("main"));
    const subModel = result.executedModels.find((m) => m.id === "glm-5.1");
    assert.ok(subModel);
    assert.ok(subModel.scopes.includes("subagent"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("collector bounds subagent discovery at 256 files and reports truncation", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-subagent-limit-"));
  try {
    const projectDir = path.join(tmpDir, "projects", "project");
    const sessionId = "subagent-limit-session";
    const subagentsDir = path.join(projectDir, sessionId, "subagents");
    fs.mkdirSync(subagentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: "assistant", message: { role: "assistant", model: "main-model" } }) + "\n"
    );
    for (let i = 0; i < 257; i++) {
      fs.writeFileSync(
        path.join(subagentsDir, `sub-${String(i).padStart(3, "0")}.jsonl`),
        JSON.stringify({ type: "assistant", message: { role: "assistant", model: "sub-model" } }) + "\n"
      );
    }

    const result = await collectModelEvidence({
      sessionId,
      claudeConfigDir: tmpDir,
      deadlineMs: 5000,
    });
    assert.equal(result.status, "partial");
    assert.ok(result.warnings.includes(WARNINGS.TOO_MANY_SUBAGENTS));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── Regression Fixture: mimo-v2.5 vs mimo-v2.5-pro ────────────────────────

test("REGRESSION: usage key mimo-v2.5 is NOT treated as execution model", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-model-evidence-"));
  try {
    const projectsDir = path.join(tmpDir, "projects");
    const projectDir = path.join(projectsDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = "regression-session";
    const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptFile, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "mimo-v2.5-pro", id: "msg-1" } }) + "\n");

    const result = await collectModelEvidence({
      sessionId,
      usageModelKeys: ["mimo-v2.5"],
      claudeConfigDir: tmpDir,
      deadlineMs: 2000,
    });

    assert.equal(result.executedModels.length, 1);
    assert.equal(result.executedModels[0].id, "mimo-v2.5-pro");
    assert.deepEqual(result.executedModels[0].scopes, ["main"]);
    assert.deepEqual(result.usageModelKeys, ["mimo-v2.5"]);
    assert.notEqual(result.executedModels[0].id, result.usageModelKeys[0]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ─── V3 → V4 Migration ──────────────────────────────────────────────────────

test("v3 observedModel migrates to usageModelKeys, NOT executedModels", () => {
  const v3Job = {
    id: "cc-test-v3",
    version: 3,
    requestedModel: "custom-model",
    observedModel: "mimo-v2.5",
    status: "completed",
  };

  const migrated = migrateV3ModelFields(v3Job);

  assert.equal(migrated.version, 4);
  assert.equal(migrated.requestedModel, "custom-model");
  assert.equal(migrated.requestMode, "explicit");
  assert.ok(migrated.modelEvidence);
  assert.deepEqual(migrated.modelEvidence.usageModelKeys, ["mimo-v2.5"]);
  assert.equal(migrated.modelEvidence.executedModels.length, 0);
  assert.equal(migrated.modelEvidence.status, "unavailable");
  assert.ok(migrated.modelEvidence.warnings.includes("legacy-observed-model-reclassified-as-usage-key"));
  assert.equal(migrated.observedModel, undefined);
});

test("v3 job without observedModel migrates cleanly", () => {
  const v3Job = {
    id: "cc-test-v3-no-obs",
    version: 3,
    requestedModel: null,
    status: "completed",
  };

  const migrated = migrateV3ModelFields(v3Job);
  assert.equal(migrated.version, 4);
  assert.equal(migrated.requestMode, "inherited");
  assert.deepEqual(migrated.modelEvidence.usageModelKeys, []);
  assert.equal(migrated.modelEvidence.executedModels.length, 0);
});

test("v4 job passes through migration unchanged", () => {
  const v4Job = {
    id: "cc-test-v4",
    version: 4,
    requestedModel: "test",
    requestMode: "explicit",
    modelEvidence: {
      status: "complete",
      executedModels: [{ id: "mimo-v2.5-pro", source: "claude-transcript", scopes: ["main"] }],
      usageModelKeys: ["mimo-v2.5"],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
  };

  const migrated = migrateV3ModelFields(v4Job);
  assert.equal(migrated, v4Job);
});

test("migration is idempotent", () => {
  const v3Job = {
    id: "cc-test-idempotent",
    version: 3,
    requestedModel: null,
    observedModel: "mimo-v2.5",
    status: "completed",
  };

  const first = migrateV3ModelFields(v3Job);
  const second = migrateV3ModelFields(first);
  assert.deepEqual(first.modelEvidence, second.modelEvidence);
  assert.equal(second.version, 4);
});

// ─── Unified Formatter ──────────────────────────────────────────────────────

test("formatModelEvidence: inherited mode with complete evidence", () => {
  const text = formatModelEvidence({
    requestedModel: null,
    requestMode: "inherited",
    modelEvidence: {
      status: "complete",
      executedModels: [{ id: "mimo-v2.5-pro", source: "claude-transcript", scopes: ["main"] }],
      usageModelKeys: ["mimo-v2.5"],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
  });

  assert.match(text, /inherited from Claude Code configuration/);
  assert.match(text, /mimo-v2\.5-pro/);
  assert.match(text, /Provider usage key.*mimo-v2\.5/);
  assert.match(text, /execution labels and usage keys have different semantics/);
  assert.doesNotMatch(text, /Observed Model/);
  assert.doesNotMatch(text, /\*\*Model:\*\* mimo-v2\.5$/m);
});

test("formatModelEvidence: explicit model override", () => {
  const text = formatModelEvidence({
    requestedModel: "custom-provider/model-pro",
    requestMode: "explicit",
    modelEvidence: {
      status: "complete",
      executedModels: [{ id: "custom-provider/model-pro-v202607", source: "claude-transcript", scopes: ["main"] }],
      usageModelKeys: ["model-pro", "cache-tier-a"],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
  });

  assert.match(text, /Requested model.*custom-provider\/model-pro/);
  assert.match(text, /custom-provider\/model-pro-v202607/);
  assert.match(text, /Provider usage keys.*model-pro, cache-tier-a/);
});

test("formatModelEvidence: transcript unavailable", () => {
  const text = formatModelEvidence({
    requestedModel: null,
    requestMode: "inherited",
    modelEvidence: {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: ["mimo-v2.5"],
      usageSource: "claude-result-modelUsage",
      warnings: ["transcript-not-found"],
    },
  });

  assert.match(text, /unavailable/);
  assert.match(text, /not treated as an execution model/);
  assert.doesNotMatch(text, /execution model.*mimo-v2\.5/);
});

test("formatModelEvidence: multi-model task", () => {
  const text = formatModelEvidence({
    requestedModel: null,
    requestMode: "inherited",
    modelEvidence: {
      status: "complete",
      executedModels: [
        { id: "mimo-v2.5-pro", source: "claude-transcript", scopes: ["main", "subagent"] },
        { id: "glm-5.1", source: "claude-transcript", scopes: ["subagent"] },
      ],
      usageModelKeys: ["mimo-v2.5", "glm-5.1"],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
  });

  assert.match(text, /execution models/);
  assert.match(text, /mimo-v2\.5-pro \(main, subagent\)/);
  assert.match(text, /glm-5\.1 \(subagent\)/);
});

test("formatModelCompact: shows main execution model", () => {
  const text = formatModelCompact({
    requestedModel: null,
    requestMode: "inherited",
    modelEvidence: {
      status: "complete",
      executedModels: [{ id: "mimo-v2.5-pro", source: "claude-transcript", scopes: ["main"] }],
      usageModelKeys: ["mimo-v2.5"],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
  });

  assert.equal(text, "mimo-v2.5-pro");
  assert.notEqual(text, "mimo-v2.5");
});

test("formatModelCompact: falls back to inherited when no evidence", () => {
  const text = formatModelCompact({
    requestedModel: null,
    requestMode: "inherited",
    modelEvidence: {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: ["mimo-v2.5"],
      usageSource: "claude-result-modelUsage",
      warnings: ["transcript-not-found"],
    },
  });

  assert.match(text, /inherited/);
  assert.doesNotMatch(text, /^mimo-v2\.5$/);
});

test("formatModelCompact: shows explicit model when no transcript evidence", () => {
  const text = formatModelCompact({
    requestedModel: "custom-model",
    requestMode: "explicit",
    modelEvidence: {
      status: "unavailable",
      executedModels: [],
      usageModelKeys: [],
      usageSource: "claude-result-modelUsage",
      warnings: ["transcript-not-found"],
    },
  });

  assert.equal(text, "custom-model");
});

// ─── Watchdog Output Contract ───────────────────────────────────────────────

test("extractUsageModelKeys: mimo-v2.5 single key returns array not first-key string", () => {
  const keys = extractUsageModelKeys({ "mimo-v2.5": {} });
  assert.ok(Array.isArray(keys));
  assert.deepEqual(keys, ["mimo-v2.5"]);
  assert.equal(typeof keys, "object");
});

test("extractUsageModelKeys: multiple keys all preserved", () => {
  const keys = extractUsageModelKeys({ "mimo-v2.5": {}, "glm-5.1": {}, "cache-tier": {} });
  assert.deepEqual(keys, ["mimo-v2.5", "glm-5.1", "cache-tier"]);
  assert.equal(keys.length, 3);
});

// ─── Formatter Security Tests ────────────────────────────────────────────────

test("SECURITY: unknown persisted route status is rendered as a safe placeholder", () => {
  const text = formatModelEvidence({
    requestedModel: "Opus",
    requestMode: "explicit",
    selectorKind: "alias",
    routeStatus: "unknown\n#injected",
    modelEvidence: { status: "complete", executedModels: [], usageModelKeys: [], usageSource: "claude-result-modelUsage", warnings: [] },
  });
  assert.match(text, /Route status:\*\* unavailable/);
  assert.doesNotMatch(text, /#injected/);
});

test("SECURITY: full control chars in requested model → no injection, never raw", () => {
  const text = formatModelEvidence({
    requestedModel: "evil\n#injected\rmodel",
    requestMode: "explicit",
    modelEvidence: { status: "complete", executedModels: [], usageModelKeys: [], usageSource: "claude-result-modelUsage", warnings: [] },
  });
  assert.doesNotMatch(text, /\n#injected/);
  assert.doesNotMatch(text, /evil\n/);
  const text2 = formatModelEvidence({
    requestedModel: "\n\r\t",
    requestMode: "explicit",
    modelEvidence: { status: "complete", executedModels: [], usageModelKeys: [], usageSource: "claude-result-modelUsage", warnings: [] },
  });
  assert.match(text2, /\(invalid\)/);
});

test("SECURITY: tampered executedModels[].id with LF/CR/Markdown → no injection", () => {
  const text = formatModelEvidence({
    requestedModel: null,
    requestMode: "inherited",
    modelEvidence: {
      status: "complete",
      executedModels: [{ id: "safe\n#injected", source: "claude-transcript", scopes: ["main"] }],
      usageModelKeys: ["bucket\n#injected-usage"],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
  });
  assert.doesNotMatch(text, /\n#injected/);
  assert.doesNotMatch(text, /safe\n/);
  assert.doesNotMatch(text, /bucket\n/);
});

test("SECURITY: unknown scope → unknown-scope", () => {
  const text = formatModelEvidence({
    requestedModel: null,
    requestMode: "inherited",
    modelEvidence: {
      status: "complete",
      executedModels: [
        { id: "model-a", source: "claude-transcript", scopes: ["main"] },
        { id: "model-b", source: "claude-transcript", scopes: ["malicious-scope"] },
      ],
      usageModelKeys: [],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
  });
  assert.match(text, /unknown-scope/);
  assert.doesNotMatch(text, /malicious-scope/);
});

test("SECURITY: unknown status → unknown", () => {
  const text = formatModelCompact({
    requestedModel: null,
    requestMode: "inherited",
    modelEvidence: {
      status: "hacked-status",
      executedModels: [],
      usageModelKeys: [],
      usageSource: "claude-result-modelUsage",
      warnings: [],
    },
  });
  assert.doesNotMatch(text, /hacked-status/);
});

test("SECURITY: unknown warning code → (unknown-warning), not raw value", () => {
  const evilWarning = "evil" + String.fromCharCode(10) + "#injected-warning";
  const text = formatWarnings(["transcript-not-found", evilWarning]);
  assert.match(text, /transcript not found/);
  assert.match(text, /\(unknown-warning\)/);
  assert.doesNotMatch(text, /#injected-warning/);
});

test("SECURITY: malformed persisted model evidence cannot crash formatters", () => {
  const malformed = {
    requestedModel: null,
    requestMode: "inherited",
    modelEvidence: {
      status: "complete",
      executedModels: [null, { id: "safe-model", scopes: "main" }],
      usageModelKeys: { injected: true },
      warnings: "read-error",
    },
  };
  assert.doesNotThrow(() => formatModelEvidence(malformed));
  assert.doesNotThrow(() => formatModelCompact(malformed));
  assert.match(formatModelEvidence(malformed), /safe-model/);
});

test("SECURITY: escapeModelIdForMarkdown idempotent on already-escaped values", () => {
  const alreadyEscaped = "model\\|name";
  const once = escapeModelIdForMarkdown(alreadyEscaped);
  const twice = escapeModelIdForMarkdown(once);
  assert.equal(once, twice, "must be idempotent");
  assert.equal(once, "model\\|name", "already escaped stays the same");
});

test("SECURITY: legitimate backslash in model ID not damaged", () => {
  const result = escapeModelIdForMarkdown("org\\model-pro");
  assert.equal(result, "org\\model-pro");
  const result2 = escapeModelIdForMarkdown("a\\\\|b");
  assert.equal(result2, "a\\\\\\|b");
});

// ─── parseTranscriptModels — Real Boundary Tests ────────────────────────────

test("line-too-long: line exceeding maxLineBytes is discarded with warning", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-line-long-${Date.now()}.jsonl`);
  try {
    const validLine = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-a", id: "1" } });
    // Long line must exceed maxLineBytes but valid lines must fit
    const validLineBytes = Buffer.byteLength(validLine, "utf8");
    const maxLineBytes = validLineBytes + 10; // Valid lines fit, long line does not
    const longLine = "x".repeat(maxLineBytes + 50);
    const validLine2 = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-b", id: "2" } });
    fs.writeFileSync(tmpFile, [validLine, longLine, validLine2].join("\n") + "\n");

    const result = await parseTranscriptModels(tmpFile, "main", {
      maxLineBytes,
      maxBytes: 1024 * 1024,
      deadlineMs: 5000,
    });

    assert.ok(result.models.has("model-a"), "model-a before long line must be found");
    assert.ok(result.models.has("model-b"), "model-b after long line must be found (DISCARDING→READING recovery)");
    assert.ok(result.warnings.includes(WARNINGS.LINE_TOO_LONG), "must have line-too-long warning");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("size-limit: byte budget exceeded stops parsing with warning", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-size-limit-${Date.now()}.jsonl`);
  try {
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-x", id: "1" } });
    const lineBytes = Buffer.byteLength(line + "\n", "utf8");
    // Set maxBytes smaller than total file but larger than one line
    // Note: with highWaterMark=64KB, a small file may be read in one chunk,
    // so the model may not be found if the entire file exceeds maxBytes.
    // The key assertion is that size-limit warning is produced.
    const maxBytes = lineBytes * 2;
    const content = (line + "\n").repeat(10);
    fs.writeFileSync(tmpFile, content);

    const result = await parseTranscriptModels(tmpFile, "main", {
      maxBytes,
      maxLineBytes: 1024 * 1024,
      deadlineMs: 5000,
    });

    assert.ok(result.warnings.includes(WARNINGS.SIZE_LIMIT), "must have size-limit warning");
    assert.ok(result.bytesRead > 0, "bytesRead must be > 0");
    // If models were found before size limit, that's a bonus
    // (depends on chunk boundaries which vary by OS/Node version)
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("deadline: parseTranscriptModels with deadlineMs=1 returns without hanging", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-deadline-${Date.now()}.jsonl`);
  try {
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-d", id: "1" } });
    fs.writeFileSync(tmpFile, (line + "\n").repeat(100));

    // deadlineMs=1 — must return within 300ms (previously hung permanently)
    const result = await Promise.race([
      parseTranscriptModels(tmpFile, "main", { deadlineMs: 1, maxBytes: 1024 * 1024, maxLineBytes: 1024 * 1024 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("collector hung for 300ms")), 300)),
    ]);

    // Must return something — not hang
    assert.ok(result, "parseTranscriptModels must return, not hang");
    assert.ok(typeof result.models === "object", "result must have models Map");
    assert.ok(Array.isArray(result.warnings), "result must have warnings array");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("deadline: stalled transcript stream is destroyed and settles with scan-deadline", async () => {
  let stream;
  const result = await Promise.race([
    parseTranscriptModels("unused", "main", {
      deadlineMs: 20,
      streamFactory: () => {
        stream = new PassThrough();
        return stream;
      },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("stalled stream did not settle")), 300)),
  ]);
  assert.ok(stream.destroyed, "deadline must destroy the stalled stream");
  assert.ok(result.warnings.includes(WARNINGS.SCAN_DEADLINE));
});

test("deadline: collectModelEvidence with deadlineMs=0 returns without hanging", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-deadline-collect-"));
  try {
    const projectsDir = path.join(tmpDir, "projects");
    const projectDir = path.join(projectsDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });
    const sessionId = "deadline-session";
    const transcriptFile = path.join(projectDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptFile, JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-a", id: "1" } }) + "\n");

    // deadlineMs=0 — must return within 300ms
    const result = await Promise.race([
      collectModelEvidence({ sessionId, usageModelKeys: [], claudeConfigDir: tmpDir, deadlineMs: 0 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("collectModelEvidence hung for 300ms")), 300)),
    ]);

    assert.ok(result, "collectModelEvidence must return, not hang");
    assert.ok(Array.isArray(result.warnings), "result must have warnings");
    assert.equal(result.status, "unavailable");
    assert.ok(result.warnings.includes(WARNINGS.SCAN_DEADLINE));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("EOF without trailing newline processes last line", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-no-newline-${Date.now()}.jsonl`);
  try {
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-eof", id: "1" } });
    fs.writeFileSync(tmpFile, line);

    const result = await parseTranscriptModels(tmpFile, "main", { deadlineMs: 5000 });

    assert.ok(result.models.has("model-eof"), "last line without newline must be parsed");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("CRLF line endings handled correctly", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-crlf-${Date.now()}.jsonl`);
  try {
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-crlf", id: "1" } });
    fs.writeFileSync(tmpFile, line + "\r\n");

    const result = await parseTranscriptModels(tmpFile, "main", { deadlineMs: 5000 });

    assert.ok(result.models.has("model-crlf"), "CRLF line must be parsed");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("cross-chunk: multi-chunk file parses all models correctly", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-cross-chunk-${Date.now()}.jsonl`);
  try {
    // Create a file larger than highWaterMark (64KB) to guarantee multiple chunks
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "chunk-model", id: "1" } });
    // Each line is ~80 bytes. Need >64KB = ~800+ lines
    const count = 900;
    fs.writeFileSync(tmpFile, (line + "\n").repeat(count));

    const result = await parseTranscriptModels(tmpFile, "main", { deadlineMs: 10000 });

    assert.ok(result.models.has("chunk-model"), "model from multi-chunk file must be found");
    assert.equal(result.linesParsed, count, `all ${count} lines must be parsed`);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("DISCARDING state recovery: multiple long lines don't break subsequent valid lines", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-discard-recovery-${Date.now()}.jsonl`);
  try {
    const valid1 = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "before-discard", id: "1" } });
    const valid1Bytes = Buffer.byteLength(valid1, "utf8");
    const maxLineBytes = valid1Bytes + 10;
    const longLine1 = "y".repeat(maxLineBytes + 50);
    const longLine2 = "z".repeat(maxLineBytes + 100);
    const valid2 = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "after-discard", id: "2" } });
    fs.writeFileSync(tmpFile, [valid1, longLine1, longLine2, valid2].join("\n") + "\n");

    const result = await parseTranscriptModels(tmpFile, "main", {
      maxLineBytes,
      maxBytes: 1024 * 1024,
      deadlineMs: 5000,
    });

    assert.ok(result.models.has("before-discard"), "model before long lines must be found");
    assert.ok(result.models.has("after-discard"), "model after multiple long lines must be found (DISCARDING recovery)");
    assert.ok(result.warnings.includes(WARNINGS.LINE_TOO_LONG), "must have line-too-long warning");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("TOO_MANY_MODELS: stream is destroyed, not left reading to EOF", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-too-many-models-${Date.now()}.jsonl`);
  try {
    // Create 20 different models (exceeds MAX_UNIQUE_MODELS=16)
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(JSON.stringify({ type: "assistant", message: { role: "assistant", model: `model-${i}`, id: `msg-${i}` } }));
    }
    fs.writeFileSync(tmpFile, lines.join("\n") + "\n");

    const startTime = Date.now();
    const result = await parseTranscriptModels(tmpFile, "main", { deadlineMs: 5000 });
    const elapsed = Date.now() - startTime;

    assert.ok(result.warnings.includes(WARNINGS.TOO_MANY_MODELS), "must have too-many-models warning");
    assert.equal(result.models.size, 16, "must cap at 16 unique models");
    // Must return quickly — if stream wasn't destroyed, it would read all 20 lines
    assert.ok(elapsed < 2000, `must return quickly (took ${elapsed}ms), not read to EOF`);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("bytesRead is tracked and returned", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-bytes-read-${Date.now()}.jsonl`);
  try {
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-a", id: "1" } });
    const content = (line + "\n").repeat(3);
    fs.writeFileSync(tmpFile, content);

    const result = await parseTranscriptModels(tmpFile, "main", { deadlineMs: 5000 });

    assert.ok(result.bytesRead > 0, "bytesRead must be > 0");
    assert.ok(result.bytesRead >= Buffer.byteLength(content, "utf8"), "bytesRead should be at least file size");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

test("model-id-truncated: model ID exceeding 256 bytes triggers warning", async () => {
  const tmpFile = path.join(os.tmpdir(), `cc-truncated-${Date.now()}.jsonl`);
  try {
    // Model ID longer than 256 bytes
    const longModelId = "x".repeat(300);
    const line = JSON.stringify({ type: "assistant", message: { role: "assistant", model: longModelId, id: "1" } });
    fs.writeFileSync(tmpFile, line + "\n");

    const result = await parseTranscriptModels(tmpFile, "main", { deadlineMs: 5000 });

    assert.equal(result.models.size, 1, "model must be recorded (truncated)");
    const storedId = [...result.models.keys()][0];
    assert.ok(Buffer.byteLength(storedId, "utf8") <= MAX_MODEL_ID_BYTES, "stored ID must be within byte limit");
    assert.ok(result.warnings.includes(WARNINGS.MODEL_ID_TRUNCATED), "must have model-id-truncated warning");
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
});

// ─── Chunk Parser via collectModelEvidence (integration) ────────────────────

test("chunk parser integration: line too long via collectModelEvidence", async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-chunk-integ-"));
  try {
    const projectsDir = path.join(tmpDir, "projects");
    const projectDir = path.join(projectsDir, "test-project");
    fs.mkdirSync(projectDir, { recursive: true });

    const sessionId = "chunk-integ-session";
    const transcriptFile = path.join(projectDir, sessionId + ".jsonl");
    const validLine = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-a", id: "1" } });
    // Line exceeding 1 MiB (MAX_LINE_BYTES) — very long garbage line
    const longLine = "x".repeat(MAX_LINE_BYTES + 100);
    const validLine2 = JSON.stringify({ type: "assistant", message: { role: "assistant", model: "model-b", id: "2" } });
    fs.writeFileSync(transcriptFile, [validLine, longLine, validLine2].join("\n") + "\n");

    const result = await collectModelEvidence({
      sessionId,
      usageModelKeys: [],
      claudeConfigDir: tmpDir,
      deadlineMs: 5000,
    });

    assert.ok(result.executedModels.find((m) => m.id === "model-a"), "model-a before long line must be found");
    assert.ok(result.executedModels.find((m) => m.id === "model-b"), "model-b after long line must be found");
    assert.ok(result.warnings.includes("line-too-long"), "must have line-too-long warning");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
