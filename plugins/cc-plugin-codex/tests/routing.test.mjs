/**
 * Tests for routing.mjs — native Claude selector classification.
 *
 * Covers:
 *   - classifySelector (inherited/alias/native/ambiguous/secret-like)
 *   - Native ID validation (control chars, whitespace, overlong, disallowed chars)
 *   - buildRouteSnapshot (no secrets)
 *   - buildChildEnv (parent pass-through)
 *   - resolveRoute / resolveRouteForDisplay
 *   - getClaudeVersion (best-effort)
 *   - KNOWN_ALIASES
 *
 * Acceptance criteria from design doc:
 *   1. All selector paths are tested without a paid model call.
 *   2. Route snapshots contain only a bounded native-Claude request record.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KNOWN_ALIASES,
  classifySelector,
  AmbiguousSelectorError,
  buildRouteSnapshot,
  buildChildEnv,
  resolveRoute,
  resolveRouteForDisplay,
  getClaudeVersion,
} from "../scripts/lib/routing.mjs";

// ─── §1: Selector classification (no filesystem) ────────────────────────────────

test("inherited selector: null/empty/whitespace → inherited", () => {
  for (const input of [null, undefined, "", "  ", "\t"]) {
    const result = classifySelector(input);
    assert.strictEqual(result.kind, "inherited");
    assert.strictEqual(result.requestedValue, null);
    assert.strictEqual(result.cliArg, null);
    assert.strictEqual(result.canonicalAlias, null);
    assert.strictEqual(result.resolvedFrom, null);
  }
});

test("alias selectors are case-insensitive and normalized to lowercase", () => {
  const cases = [
    { input: "Opus", expected: "opus" },
    { input: "OPUS", expected: "opus" },
    { input: "opus", expected: "opus" },
    { input: "Fable", expected: "fable" },
    { input: "FABLE", expected: "fable" },
    { input: "fable", expected: "fable" },
    { input: "Sonnet", expected: "sonnet" },
    { input: "SONNET", expected: "sonnet" },
    { input: "sonnet", expected: "sonnet" },
    { input: "Haiku", expected: "haiku" },
    { input: "HAIKU", expected: "haiku" },
    { input: "haiku", expected: "haiku" },
  ];
  for (const { input, expected } of cases) {
    const result = classifySelector(input);
    assert.strictEqual(result.kind, "alias");
    assert.strictEqual(result.requestedValue, input); // preserved as-entered
    assert.strictEqual(result.cliArg, expected);       // normalized lowercase
    assert.strictEqual(result.canonicalAlias, expected);
    assert.strictEqual(result.resolvedFrom, "known-alias");
  }
});

test("KNOWN_ALIASES contains exactly opus, fable, sonnet, haiku", () => {
  assert.strictEqual(KNOWN_ALIASES.size, 4);
  for (const alias of ["opus", "fable", "sonnet", "haiku"]) {
    assert.strictEqual(KNOWN_ALIASES.has(alias), true);
  }
});

test("native IDs are passed through unchanged (heuristic)", () => {
  const ids = ["deepseek-v4-pro", "glm-5.2", "anthropic/claude-opus-4", "kimi:k2.6", "model_v2.1"];
  for (const id of ids) {
    const result = classifySelector(id);
    assert.strictEqual(result.kind, "native");
    assert.strictEqual(result.requestedValue, id);
    assert.strictEqual(result.cliArg, id);
    assert.strictEqual(result.canonicalAlias, null);
    assert.strictEqual(result.resolvedFrom, "heuristic-native");
  }
});

test("ambiguous selectors fail closed with AmbiguousSelectorError", () => {
  const ambiguous = ["opus-max", "deepseek", "some random model", "claude", "GLM"];
  for (const input of ambiguous) {
    assert.throws(() => classifySelector(input), AmbiguousSelectorError);
  }
});

test("ambiguous selector error message guides the user", () => {
  try {
    classifySelector("unknown-model");
  } catch (err) {
    assert.ok(err instanceof AmbiguousSelectorError);
    const msg = err.message.toLowerCase();
    assert.ok(msg.includes("alias"));
    assert.ok(msg.includes("native model id"));
    // Req 5: never echo raw selector in error message
    assert.ok(!msg.includes("unknown-model"), "must not echo raw selector in message");
  }
});

test("secret-like user-supplied selectors fail closed and are never echoed", () => {
  const secrets = ["sk-ant-api03-abc123", "sk-test-key-0123456789abcdef", "Bearer abc123"];
  for (const input of secrets) {
    let threw = false;
    try {
      classifySelector(input);
    } catch (err) {
      threw = true;
      assert.ok(err instanceof AmbiguousSelectorError);
      assert.ok(!err.message.includes(input), `must not echo ${input}`);
    }
    assert.ok(threw, `expected ${input} to throw`);
  }
});

// ─── §2: Native selector validation ──────────────────────────────────────────────

test("valid native IDs with slash, colon, dot, underscore, hyphen pass validation", () => {
  const valid = [
    "deepseek-v4-pro", "glm-5.2", "anthropic/claude-opus-4",
    "kimi:k2.6", "model_v2.1", "provider/model:1.0",
  ];
  for (const id of valid) {
    const result = classifySelector(id);
    assert.strictEqual(result.kind, "native");
  }
});

test("native selector with control character is rejected", () => {
  assert.throws(() => classifySelector("model-\x00-v1"), AmbiguousSelectorError);
  assert.throws(() => classifySelector("model-\x1b-v1"), AmbiguousSelectorError);
});

test("native selector with whitespace is rejected", () => {
  assert.throws(() => classifySelector("model rm -rf v1"), AmbiguousSelectorError);
  assert.throws(() => classifySelector("model\tv1"), AmbiguousSelectorError);
});

test("overlong native selector is rejected", () => {
  const long = "a".repeat(129);
  assert.throws(() => classifySelector(long), AmbiguousSelectorError);
});

test("native selector with disallowed characters is rejected", () => {
  const bad = ["model;exit", "model|cat", "`command`", "$(whoami)", "model<script>"];
  for (const input of bad) {
    assert.throws(() => classifySelector(input), AmbiguousSelectorError);
  }
});

test("selector must contain a digit to classify as native (heuristic)", () => {
  // "deepseek" (no digit) is ambiguous, "deepseek-v4-pro" (has digit) is native
  assert.throws(() => classifySelector("deepseek"), AmbiguousSelectorError);
  const result = classifySelector("deepseek-v4-pro");
  assert.strictEqual(result.kind, "native");
});

// ─── §3: buildRouteSnapshot (bounded, non-secret fields) ─────────────────────────

test("buildRouteSnapshot for inherited selector has only the fixed snapshot fields", () => {
  const selector = classifySelector(null);
  const snapshot = buildRouteSnapshot({ selector, cliVersion: "1.0.0" });
  assert.strictEqual(snapshot.selectorKind, "inherited");
  assert.strictEqual(snapshot.requestedValue, null);
  assert.strictEqual(snapshot.cliArg, null);
  assert.strictEqual(snapshot.canonicalAlias, null);
  assert.strictEqual(snapshot.cliVersion, "1.0.0");
  assert.ok(snapshot.timestamp, "should have timestamp");
  assert.deepStrictEqual(Object.keys(snapshot).sort(), [
    "canonicalAlias", "cliArg", "cliVersion", "requestedValue", "selectorKind", "timestamp",
  ]);
});

test("buildRouteSnapshot for alias has canonicalAlias", () => {
  const selector = classifySelector("Opus");
  const snapshot = buildRouteSnapshot({ selector, cliVersion: null });
  assert.strictEqual(snapshot.selectorKind, "alias");
  assert.strictEqual(snapshot.requestedValue, "Opus");
  assert.strictEqual(snapshot.cliArg, "opus");
  assert.strictEqual(snapshot.canonicalAlias, "opus");
});

test("buildRouteSnapshot for native has no canonicalAlias", () => {
  const selector = classifySelector("deepseek-v4-pro");
  const snapshot = buildRouteSnapshot({ selector, cliVersion: null });
  assert.strictEqual(snapshot.selectorKind, "native");
  assert.strictEqual(snapshot.requestedValue, "deepseek-v4-pro");
  assert.strictEqual(snapshot.cliArg, "deepseek-v4-pro");
  assert.strictEqual(snapshot.canonicalAlias, null);
});

test("buildRouteSnapshot does not contain secrets", () => {
  const selector = classifySelector("Opus");
  const snapshot = buildRouteSnapshot({ selector, cliVersion: null });
  const json = JSON.stringify(snapshot);
  assert.ok(!json.includes("sk-"), "no secret-like keys in snapshot");
  assert.ok(!json.includes("Bearer"), "no bearer tokens in snapshot");
});

// ─── §4: buildChildEnv (parent pass-through) ─────────────────────────────────────

test("buildChildEnv passes parent env through unchanged", () => {
  const parentEnv = { HOME: "/home/user", PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-test-123", MY_VAR: "hello" };
  const childEnv = buildChildEnv(parentEnv);
  assert.deepStrictEqual(childEnv, parentEnv);
});

test("buildChildEnv creates a shallow copy, not the same reference", () => {
  const parentEnv = { FOO: "bar" };
  const childEnv = buildChildEnv(parentEnv);
  assert.notStrictEqual(childEnv, parentEnv);
  childEnv.BAZ = "qux";
  assert.strictEqual(parentEnv.BAZ, undefined, "must not mutate original");
});

test("buildChildEnv does not apply special handling to inherited variables", () => {
  const parentEnv = { HOME: "/home", CUSTOM_PARENT_VARIABLE: "preserved" };
  const childEnv = buildChildEnv(parentEnv);
  assert.strictEqual(childEnv.CUSTOM_PARENT_VARIABLE, "preserved");
  assert.strictEqual(childEnv.HOME, "/home");
});

// ─── §5: resolveRoute (full resolution) ──────────────────────────────────────────

test("resolveRoute returns selector, snapshot, and childEnv", () => {
  const result = resolveRoute({
    selectorInput: "Opus",
    cliVersion: "1.0.0",
    parentEnv: { HOME: "/home" },
  });
  assert.ok(result.selector);
  assert.strictEqual(result.selector.kind, "alias");
  assert.ok(result.snapshot);
  assert.strictEqual(result.snapshot.selectorKind, "alias");
  assert.ok(result.childEnv);
  assert.strictEqual(result.childEnv.HOME, "/home");
});

test("resolveRoute for inherited has null cliArg", () => {
  const result = resolveRoute({
    selectorInput: null,
    cliVersion: null,
    parentEnv: { FOO: "bar" },
  });
  assert.strictEqual(result.selector.kind, "inherited");
  assert.strictEqual(result.selector.cliArg, null);
});

test("resolveRoute fails closed on ambiguous selector", () => {
  assert.throws(() => {
    resolveRoute({
      selectorInput: "deepseek",
      cliVersion: null,
      parentEnv: process.env,
    });
  }, AmbiguousSelectorError);
});

test("resolveRoute fails closed on secret-like selector", () => {
  assert.throws(() => {
    resolveRoute({
      selectorInput: "sk-ant-api03-abc123",
      cliVersion: null,
      parentEnv: process.env,
    });
  }, AmbiguousSelectorError);
});

test("resolveRoute child env inherits parent env including Anthropic vars", () => {
  const parentEnv = { ANTHROPIC_API_KEY: "sk-test", ANTHROPIC_BASE_URL: "https://api.example.com", HOME: "/home" };
  const result = resolveRoute({
    selectorInput: "sonnet",
    cliVersion: null,
    parentEnv,
  });
  // All parent vars pass through unchanged — no stripping of ANTHROPIC_* vars
  assert.strictEqual(result.childEnv.ANTHROPIC_API_KEY, "sk-test");
  assert.strictEqual(result.childEnv.ANTHROPIC_BASE_URL, "https://api.example.com");
  assert.strictEqual(result.childEnv.HOME, "/home");
});

// ─── §6: resolveRouteForDisplay (read-only display) ──────────────────────────────

test("resolveRouteForDisplay returns expected fields for alias selector", () => {
  const result = resolveRouteForDisplay({
    selectorInput: "Opus",
    cliVersion: "1.0.0",
  });
  assert.strictEqual(result.selectorKind, "alias");
  assert.strictEqual(result.requestedValue, "Opus");
  assert.strictEqual(result.cliArg, "opus");
  assert.strictEqual(result.canonicalAlias, "opus");
  assert.strictEqual(result.resolvedFrom, "known-alias");
  assert.strictEqual(result.cliVersion, "1.0.0");
  assert.ok(result.note, "should have note about execution proof");
  assert.ok(result.structuredContent);
  // structuredContent must use the fixed bounded shape.
  assert.deepStrictEqual(Object.keys(result.structuredContent).sort(), [
    "canonicalAlias", "cliArg", "cliVersion", "notExecutionProof", "requestedValue", "selectorKind",
  ]);
});

test("resolveRouteForDisplay for inherited returns inherited kind", () => {
  const result = resolveRouteForDisplay({
    selectorInput: null,
    cliVersion: null,
  });
  assert.strictEqual(result.selectorKind, "inherited");
  assert.strictEqual(result.requestedValue, null);
  assert.strictEqual(result.cliArg, null);
  assert.strictEqual(result.canonicalAlias, null);
  assert.ok(result.structuredContent.notExecutionProof);
});

test("resolveRouteForDisplay for native ID passes through unchanged", () => {
  const result = resolveRouteForDisplay({
    selectorInput: "glm-5.2",
    cliVersion: null,
  });
  assert.strictEqual(result.selectorKind, "native");
  assert.strictEqual(result.requestedValue, "glm-5.2");
  assert.strictEqual(result.cliArg, "glm-5.2");
  assert.strictEqual(result.resolvedFrom, "heuristic-native");
});

test("resolveRouteForDisplay for ambiguous selector throws", () => {
  assert.throws(() => {
    resolveRouteForDisplay({
      selectorInput: "unknown-model-name",
      cliVersion: null,
    });
  }, AmbiguousSelectorError);
});

test("resolveRouteForDisplay structuredContent has no secret-bearing fields", () => {
  const result = resolveRouteForDisplay({
    selectorInput: "sonnet",
    cliVersion: null,
  });
  const json = JSON.stringify(result.structuredContent);
  assert.ok(!json.includes("sk-"), "no secrets in structuredContent");
  assert.ok(!json.includes("Bearer"), "no bearer tokens in structuredContent");
});

// ─── §7: getClaudeVersion (best-effort) ──────────────────────────────────────────

test("getClaudeVersion is callable and returns string or null", () => {
  const version = getClaudeVersion(process.cwd());
  assert.ok(version === null || typeof version === "string");
});
