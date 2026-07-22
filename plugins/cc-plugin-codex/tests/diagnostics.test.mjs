import assert from "node:assert/strict";
import test from "node:test";

import {
  FAILURE_STAGES,
  redactText,
  classifyFailureStage,
  buildFailureEnvelope,
  buildSafeErrorSummary,
  buildSafeErrorMessage,
  isValidStage,
} from "../scripts/lib/diagnostics.mjs";

// ─── Failure Stage Enum ──────────────────────────────────────────────────────

test("FAILURE_STAGES contains the 8 defined stages", () => {
  const stages = Object.values(FAILURE_STAGES);
  assert.equal(stages.length, 8);
  assert.equal(FAILURE_STAGES.SPAWN, "spawn");
  assert.equal(FAILURE_STAGES.CLI_CONTRACT, "cli_contract");
  assert.equal(FAILURE_STAGES.CONFIGURATION, "configuration");
  assert.equal(FAILURE_STAGES.PROVIDER_HANDSHAKE, "provider_handshake");
  assert.equal(FAILURE_STAGES.PROVIDER_RESPONSE, "provider_response");
  assert.equal(FAILURE_STAGES.JSON_PROTOCOL, "json_protocol");
  assert.equal(FAILURE_STAGES.TIMEOUT, "timeout");
  assert.equal(FAILURE_STAGES.CANCELLED, "cancelled");
});

test("isValidStage accepts known stages and rejects unknown ones", () => {
  for (const stage of Object.values(FAILURE_STAGES)) {
    assert.ok(isValidStage(stage), `${stage} should be valid`);
  }
  assert.ok(!isValidStage("unknown"));
  assert.ok(!isValidStage(""));
  assert.ok(!isValidStage(null));
});

// ─── Redaction ───────────────────────────────────────────────────────────────

test("redactText redacts API keys (sk-...)", () => {
  const input = "Error: invalid API key sk-ant-abc123def456ghi789";
  const redacted = redactText(input);
  assert.doesNotMatch(redacted, /sk-ant-abc123def456ghi789/);
  assert.match(redacted, /sk-\[REDACTED\]/);
});

test("redactText redacts Bearer tokens", () => {
  const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test";
  const redacted = redactText(input);
  assert.doesNotMatch(redacted, /eyJhbGciOiJIUzI1NiJ9\.test/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("redactText redacts Authorization headers", () => {
  const input = "Authorization: secret-auth-header-value";
  const redacted = redactText(input);
  assert.doesNotMatch(redacted, /secret-auth-header-value/);
});

test("redactText redacts x-api-key headers", () => {
  const input = "x-api-key: sk-ant-test123456789";
  const redacted = redactText(input);
  assert.doesNotMatch(redacted, /sk-ant-test123456789/);
});

test("redactText redacts passwords", () => {
  const input = "password=supersecret123";
  const redacted = redactText(input);
  assert.doesNotMatch(redacted, /supersecret123/);
});

test("redactText redacts URLs with embedded credentials", () => {
  const input = "https://user:pass@api.example.com/v1";
  const redacted = redactText(input);
  assert.doesNotMatch(redacted, /user:pass/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("redactText redacts ANTHROPIC_API_KEY values", () => {
  const input = "ANTHROPIC_API_KEY=sk-ant-secret-key-value";
  const redacted = redactText(input);
  assert.doesNotMatch(redacted, /sk-ant-secret-key-value/);
  assert.match(redacted, /\[REDACTED\]/);
});

test("redactText bounds output to 2 KiB", () => {
  // Use non-secret content that won't be redacted, to test size bounding
  const input = "A".repeat(5000);
  const redacted = redactText(input);
  assert.ok(Buffer.byteLength(redacted, "utf8") <= 2200); // 2 KiB + truncation suffix
  assert.match(redacted, /redacted tail/);
});

test("redactText handles empty/null input", () => {
  assert.equal(redactText(""), "");
  assert.equal(redactText(null), "");
  assert.equal(redactText(undefined), "");
});

test("redactText does not redact task content (no prompt leakage in redaction)", () => {
  const taskContent = "Fix the bug in src/index.js line 42 where the loop goes out of bounds";
  const redacted = redactText(taskContent);
  // The task content itself should survive redaction (it's not a secret)
  assert.match(redacted, /Fix the bug/);
  assert.match(redacted, /src\/index\.js/);
});

// ─── Failure Stage Classification ────────────────────────────────────────────

test("classifyFailureStage returns CANCELLED for cancelled termination", () => {
  const stage = classifyFailureStage({ terminationReason: "cancelled" });
  assert.equal(stage, FAILURE_STAGES.CANCELLED);
});

test("classifyFailureStage returns TIMEOUT for timeout termination", () => {
  const stage = classifyFailureStage({ terminationReason: "timeout" });
  assert.equal(stage, FAILURE_STAGES.TIMEOUT);
});

test("classifyFailureStage returns CONFIGURATION for config errors", () => {
  const stage = classifyFailureStage({ configError: "profile corrupt" });
  assert.equal(stage, FAILURE_STAGES.CONFIGURATION);
});

test("classifyFailureStage returns SPAWN for spawn errors", () => {
  const stage = classifyFailureStage({ spawnError: true, stdout: "", stderr: "" });
  assert.equal(stage, FAILURE_STAGES.SPAWN);
});

test("classifyFailureStage returns CLI_CONTRACT for --print errors", () => {
  const stage = classifyFailureStage({
    stdout: "",
    stderr: "error: --output-format json requires --print mode",
  });
  assert.equal(stage, FAILURE_STAGES.CLI_CONTRACT);
});

test("classifyFailureStage returns CLI_CONTRACT for unknown option errors", () => {
  const stage = classifyFailureStage({
    stdout: "",
    stderr: "error: unknown option: --some-flag",
  });
  assert.equal(stage, FAILURE_STAGES.CLI_CONTRACT);
});

test("classifyFailureStage returns PROVIDER_HANDSHAKE for 401 errors", () => {
  const stage = classifyFailureStage({
    stdout: "",
    stderr: "HTTP 401 Unauthorized: invalid API key",
  });
  assert.equal(stage, FAILURE_STAGES.PROVIDER_HANDSHAKE);
});

test("classifyFailureStage returns PROVIDER_HANDSHAKE for 403 errors", () => {
  const stage = classifyFailureStage({
    stdout: "",
    stderr: "HTTP 403 Forbidden",
  });
  assert.equal(stage, FAILURE_STAGES.PROVIDER_HANDSHAKE);
});

test("classifyFailureStage returns PROVIDER_RESPONSE for 429 rate limit", () => {
  const stage = classifyFailureStage({
    stdout: "",
    stderr: "HTTP 429 Too Many Requests: rate limit exceeded",
  });
  assert.equal(stage, FAILURE_STAGES.PROVIDER_RESPONSE);
});

test("classifyFailureStage returns PROVIDER_RESPONSE for model not found", () => {
  const stage = classifyFailureStage({
    stdout: "",
    stderr: "Error: model not found",
  });
  assert.equal(stage, FAILURE_STAGES.PROVIDER_RESPONSE);
});

test("classifyFailureStage returns JSON_PROTOCOL for non-JSON stdout on non-zero exit", () => {
  const stage = classifyFailureStage({
    stdout: "some plain text error",
    stderr: "",
  });
  assert.equal(stage, FAILURE_STAGES.JSON_PROTOCOL);
});

test("classifyFailureStage returns PROVIDER_RESPONSE as default for unknown non-zero exit", () => {
  const stage = classifyFailureStage({
    stdout: "",
    stderr: "",
  });
  assert.equal(stage, FAILURE_STAGES.PROVIDER_RESPONSE);
});

test("classifyFailureStage inspects structured errors for auth indicators", () => {
  const stage = classifyFailureStage({
    stdout: "",
    stderr: "",
    structuredError: true,
    parsedError: { error: "authentication failed", code: 401 },
  });
  assert.equal(stage, FAILURE_STAGES.PROVIDER_HANDSHAKE);
});

test("classifyFailureStage inspects structured errors for model indicators", () => {
  const stage = classifyFailureStage({
    stdout: "",
    stderr: "",
    structuredError: true,
    parsedError: { error: "model not available", code: 503 },
  });
  assert.equal(stage, FAILURE_STAGES.PROVIDER_RESPONSE);
});

// ─── Failure Envelope Construction ───────────────────────────────────────────

test("buildFailureEnvelope produces bounded, redacted envelope", () => {
  const envelope = buildFailureEnvelope({
    stage: FAILURE_STAGES.PROVIDER_RESPONSE,
    requestedSelector: { kind: "native", value: "deepseek-v4-pro" },
    effort: "high",
    cliVersion: "2.1.208",
    exitCode: 1,
    signal: null,
    durationMs: 5000,
    structuredError: false,
    sessionId: null,
    usageKey: null,
    transcriptFound: false,
    stdout: "some output with sk-ant-secret-key",
    stderr: "error with ANTHROPIC_API_KEY=sk-ant-another-secret",
  });
  assert.equal(envelope.stage, "provider_response");
  assert.equal(envelope.exitCode, 1);
  assert.equal(envelope.durationMs, 5000);
  assert.equal(envelope.cliVersion, "2.1.208");
  assert.deepEqual(envelope.requestedSelector, { kind: "native", value: "deepseek-v4-pro" });
  assert.doesNotMatch(envelope.stdoutTail, /sk-ant-secret-key/);
  assert.doesNotMatch(envelope.stderrTail, /sk-ant-another-secret/);
  assert.ok(envelope.timestamp);
});

test("buildFailureEnvelope falls back to PROVIDER_RESPONSE for unknown stage", () => {
  const envelope = buildFailureEnvelope({
    stage: "unknown_stage",
    stdout: "",
    stderr: "",
  });
  assert.equal(envelope.stage, "provider_response");
});

test("buildFailureEnvelope does not leak secrets in task content", () => {
  const taskContent = "Fix the authentication bug. API key: sk-ant-leaked-key-123456789. password=secret123";
  const envelope = buildFailureEnvelope({
    stage: FAILURE_STAGES.PROVIDER_RESPONSE,
    stdout: taskContent,
    stderr: "error occurred",
  });
  // Secrets within task content must be redacted
  assert.doesNotMatch(envelope.stdoutTail, /sk-ant-leaked-key-123456789/);
  assert.doesNotMatch(envelope.stdoutTail, /secret123/);
  // Non-secret task text survives
  assert.match(envelope.stdoutTail, /Fix the authentication bug/);
});

// ─── Safe Error Messages ─────────────────────────────────────────────────────

test("buildSafeErrorSummary returns safe messages for each stage", () => {
  for (const stage of Object.values(FAILURE_STAGES)) {
    const summary = buildSafeErrorSummary(stage, "fallback");
    assert.ok(summary);
    assert.ok(summary.length > 0);
  }
});

test("buildSafeErrorSummary does not include raw error details", () => {
  const summary = buildSafeErrorSummary(FAILURE_STAGES.PROVIDER_HANDSHAKE, "sk-ant-secret-key leaked");
  assert.doesNotMatch(summary, /sk-ant-secret-key/);
});

test("buildSafeErrorMessage includes stage prefix and redacts raw error", () => {
  const msg = buildSafeErrorMessage(FAILURE_STAGES.SPAWN, "ENOENT: claude not found. API key: sk-ant-test123456");
  assert.match(msg, /^\[spawn\]/);
  assert.doesNotMatch(msg, /sk-ant-test123456/);
});

test("buildSafeErrorMessage for cancelled returns cancelled message", () => {
  const msg = buildSafeErrorMessage(FAILURE_STAGES.CANCELLED, "task was cancelled");
  assert.match(msg, /^\[cancelled\]/);
  assert.match(msg, /cancelled/i);
});
