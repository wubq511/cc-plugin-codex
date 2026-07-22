import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  KNOWN_ALIASES,
  resolveClaudeConfigDir,
  readActiveProfile,
  classifySelector,
  AmbiguousSelectorError,
  buildRouteSnapshot,
  buildChildEnv,
  resolveRoute,
  resolveRouteForDisplay,
} from "../scripts/lib/routing.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-routing-test-"));
}

function writeProfile(dir, profile) {
  fs.writeFileSync(path.join(dir, "active-profile.json"), JSON.stringify(profile), "utf8");
}

const SAMPLE_PROFILE = {
  profileIdentity: "test-profile",
  aliasMappings: { opus: "anthropic-opus-4", fable: "anthropic-fable-1", sonnet: "anthropic-sonnet-4", haiku: "anthropic-haiku-4" },
  nativeDisplayNames: { "DeepSeek V4 Pro": "deepseek-v4-pro", "GLM 5.2": "glm-5.2" },
  stripInherited: ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"],
  envVars: { ANTHROPIC_API_KEY: "sk-test-secret-key", ANTHROPIC_BASE_URL: "https://api.test.example.com" },
};

// ─── Selector Classification ─────────────────────────────────────────────────

test("inherited selector: null/empty/whitespace → inherited", () => {
  for (const input of [null, undefined, "", "   "]) {
    const result = classifySelector(input, null);
    assert.equal(result.kind, "inherited");
    assert.equal(result.cliArg, null);
    assert.equal(result.canonicalAlias, null);
  }
});

test("alias selectors are case-insensitive and normalized to lowercase", () => {
  for (const input of ["Opus", "OPUS", "opus", "OpUs"]) {
    const result = classifySelector(input, null);
    assert.equal(result.kind, "alias");
    assert.equal(result.cliArg, "opus");
    assert.equal(result.canonicalAlias, "opus");
    assert.equal(result.resolvedFrom, "known-alias");
  }
  for (const input of ["Fable", "FABLE", "fable"]) {
    const result = classifySelector(input, null);
    assert.equal(result.kind, "alias");
    assert.equal(result.cliArg, "fable");
  }
  for (const input of ["Sonnet", "sonnet", "HAIKU", "haiku"]) {
    const result = classifySelector(input, null);
    assert.equal(result.kind, "alias");
  }
});

test("known aliases set contains exactly opus, fable, sonnet, haiku", () => {
  assert.equal(KNOWN_ALIASES.size, 4);
  assert.ok(KNOWN_ALIASES.has("opus"));
  assert.ok(KNOWN_ALIASES.has("fable"));
  assert.ok(KNOWN_ALIASES.has("sonnet"));
  assert.ok(KNOWN_ALIASES.has("haiku"));
});

test("native IDs are passed through unchanged (heuristic)", () => {
  for (const input of ["deepseek-v4-pro", "glm-5.2", "claude-sonnet-4-20250514", "gpt-4o-mini"]) {
    const result = classifySelector(input, null);
    assert.equal(result.kind, "native");
    assert.equal(result.cliArg, input);
    assert.equal(result.canonicalAlias, null);
    assert.equal(result.resolvedFrom, "heuristic-native");
  }
});

test("native IDs resolved from profile display names", () => {
  const projection = {
    profileIdentity: "test",
    profileFingerprint: "sha256:abc",
    aliasMappings: SAMPLE_PROFILE.aliasMappings,
    nativeDisplayNames: SAMPLE_PROFILE.nativeDisplayNames,
    stripInherited: null,
  };
  const result = classifySelector("DeepSeek V4 Pro", projection);
  assert.equal(result.kind, "native");
  assert.equal(result.cliArg, "deepseek-v4-pro");
  assert.equal(result.resolvedFrom, "display-name");
});

test("native IDs resolved from profile display names are case-insensitive", () => {
  const projection = {
    profileIdentity: "test",
    profileFingerprint: "sha256:abc",
    aliasMappings: SAMPLE_PROFILE.aliasMappings,
    nativeDisplayNames: SAMPLE_PROFILE.nativeDisplayNames,
    stripInherited: null,
  };
  const result = classifySelector("glm 5.2", projection);
  assert.equal(result.kind, "native");
  assert.equal(result.cliArg, "glm-5.2");
});

test("exact native ID known to profile is resolved as native", () => {
  const projection = {
    profileIdentity: "test",
    profileFingerprint: "sha256:abc",
    aliasMappings: SAMPLE_PROFILE.aliasMappings,
    nativeDisplayNames: SAMPLE_PROFILE.nativeDisplayNames,
    stripInherited: null,
  };
  const result = classifySelector("deepseek-v4-pro", projection);
  assert.equal(result.kind, "native");
  assert.equal(result.cliArg, "deepseek-v4-pro");
  assert.equal(result.resolvedFrom, "profile-known-native");
});

test("ambiguous selectors fail closed with AmbiguousSelectorError", () => {
  for (const input of ["opus-max", "deepseek", "some random model", "claude"]) {
    assert.throws(
      () => classifySelector(input, null),
      (err) => err instanceof AmbiguousSelectorError && err.selector === input
    );
  }
});

test("ambiguous selector error message guides the user", () => {
  try {
    classifySelector("deepseek", null);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof AmbiguousSelectorError);
    assert.match(err.message, /alias/i);
    assert.match(err.message, /native model ID/i);
    assert.match(err.message, /display name/i);
  }
});

// ─── Active Profile Reading ──────────────────────────────────────────────────

test("readActiveProfile returns null when no profile file exists", () => {
  const dir = makeTempDir();
  try {
    const result = readActiveProfile(dir);
    assert.equal(result, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveProfile returns projection and secrets when profile exists", () => {
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const result = readActiveProfile(dir);
    assert.ok(result);
    assert.equal(result.exists, true);
    assert.equal(result.projection.profileIdentity, "test-profile");
    assert.ok(result.projection.profileFingerprint);
    assert.match(result.projection.profileFingerprint, /^sha256:/);
    assert.deepEqual(result.projection.aliasMappings, SAMPLE_PROFILE.aliasMappings);
    assert.equal(result.secrets.envVars.ANTHROPIC_API_KEY, "sk-test-secret-key");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveProfile throws on corrupt JSON", () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, "active-profile.json"), "not json{", "utf8");
    assert.throws(
      () => readActiveProfile(dir),
      /not valid JSON/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveProfile throws on non-object JSON", () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, "active-profile.json"), "[1,2,3]", "utf8");
    assert.throws(
      () => readActiveProfile(dir),
      /must be a JSON object/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveProfile fingerprint is computed from non-secret fields only", () => {
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const result1 = readActiveProfile(dir);

    // Change secrets but keep non-secret fields the same
    writeProfile(dir, { ...SAMPLE_PROFILE, envVars: { ANTHROPIC_API_KEY: "sk-different-secret" } });
    const result2 = readActiveProfile(dir);

    assert.equal(result1.projection.profileFingerprint, result2.projection.profileFingerprint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveProfile fingerprint changes when non-secret fields change", () => {
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const result1 = readActiveProfile(dir);

    writeProfile(dir, { ...SAMPLE_PROFILE, profileIdentity: "different-profile" });
    const result2 = readActiveProfile(dir);

    assert.notEqual(result1.projection.profileFingerprint, result2.projection.profileFingerprint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Route Snapshot Construction ─────────────────────────────────────────────

test("buildRouteSnapshot for inherited selector has no alias claim", () => {
  const selector = classifySelector(null, null);
  const snapshot = buildRouteSnapshot({ selector, projection: null, cliVersion: "1.0.0" });
  assert.equal(snapshot.selectorKind, "inherited");
  assert.equal(snapshot.cliArg, null);
  assert.equal(snapshot.aliasClaim, null);
  assert.equal(snapshot.cliVersion, "1.0.0");
  assert.ok(snapshot.timestamp);
});

test("buildRouteSnapshot for alias includes alias claim when profile has mapping", () => {
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const profile = readActiveProfile(dir);
    const selector = classifySelector("Opus", profile.projection);
    const snapshot = buildRouteSnapshot({ selector, projection: profile.projection, cliVersion: "1.0.0" });
    assert.equal(snapshot.selectorKind, "alias");
    assert.equal(snapshot.cliArg, "opus");
    assert.ok(snapshot.aliasClaim);
    assert.equal(snapshot.aliasClaim.alias, "opus");
    assert.equal(snapshot.aliasClaim.nativeId, "anthropic-opus-4");
    assert.equal(snapshot.profileIdentity, "test-profile");
    assert.ok(snapshot.profileFingerprint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRouteSnapshot for native selector has no alias claim", () => {
  const selector = classifySelector("deepseek-v4-pro", null);
  const snapshot = buildRouteSnapshot({ selector, projection: null, cliVersion: null });
  assert.equal(snapshot.selectorKind, "native");
  assert.equal(snapshot.cliArg, "deepseek-v4-pro");
  assert.equal(snapshot.aliasClaim, null);
  assert.equal(snapshot.profileIdentity, null);
});

test("route snapshot does not contain secrets", () => {
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const profile = readActiveProfile(dir);
    const selector = classifySelector("Opus", profile.projection);
    const snapshot = buildRouteSnapshot({ selector, projection: profile.projection, cliVersion: "1.0.0" });
    const snapshotStr = JSON.stringify(snapshot);
    assert.doesNotMatch(snapshotStr, /sk-test-secret-key/);
    assert.doesNotMatch(snapshotStr, /api\.test\.example\.com/);
    assert.doesNotMatch(snapshotStr, /envVars/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Child Environment Construction ──────────────────────────────────────────

test("buildChildEnv passes parent env unchanged when no profile (bare inherit)", () => {
  const parentEnv = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-old", HOME: "/home/user" };
  const childEnv = buildChildEnv(parentEnv, null);
  assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-old");
  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.HOME, "/home/user");
});

test("buildChildEnv strips stale ANTHROPIC_* vars when profile is active", () => {
  const parentEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-old-stale",
    ANTHROPIC_BASE_URL: "https://old.anthropic.com",
    ANTHROPIC_AUTH_TOKEN: "old-token",
    HOME: "/home/user",
  };
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const profile = readActiveProfile(dir);
    const childEnv = buildChildEnv(parentEnv, profile);
    assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-test-secret-key"); // injected from profile
    assert.equal(childEnv.ANTHROPIC_BASE_URL, "https://api.test.example.com"); // injected from profile
    assert.equal(childEnv.HOME, "/home/user"); // preserved
    assert.equal(childEnv.PATH, "/usr/bin"); // preserved
    assert.ok(!childEnv.ANTHROPIC_AUTH_TOKEN); // stripped (not in profile envVars)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("buildChildEnv strips all ANTHROPIC_* vars not in profile envVars", () => {
  const parentEnv = {
    ANTHROPIC_API_KEY: "sk-old",
    ANTHROPIC_CUSTOM_VAR: "custom-value",
    ANTHROPIC_MODEL: "old-model",
    PATH: "/usr/bin",
  };
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const profile = readActiveProfile(dir);
    const childEnv = buildChildEnv(parentEnv, profile);
    assert.ok(!childEnv.ANTHROPIC_CUSTOM_VAR);
    assert.ok(!childEnv.ANTHROPIC_MODEL);
    assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-test-secret-key"); // profile value
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("old inherited environment does not override active profile", () => {
  const parentEnv = {
    ANTHROPIC_API_KEY: "sk-stale-inherited",
    ANTHROPIC_BASE_URL: "https://stale.anthropic.com",
  };
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const profile = readActiveProfile(dir);
    const childEnv = buildChildEnv(parentEnv, profile);
    // Profile values must override stale inherited values
    assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-test-secret-key");
    assert.equal(childEnv.ANTHROPIC_BASE_URL, "https://api.test.example.com");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Full Route Resolution ───────────────────────────────────────────────────

test("resolveRoute returns selector, snapshot, childEnv, and profile", () => {
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const result = resolveRoute({
      claudeConfigDir: dir,
      selectorInput: "Opus",
      cliVersion: "2.1.208",
      parentEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-stale" },
    });
    assert.equal(result.selector.kind, "alias");
    assert.equal(result.selector.cliArg, "opus");
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.selectorKind, "alias");
    assert.ok(result.childEnv);
    assert.equal(result.childEnv.ANTHROPIC_API_KEY, "sk-test-secret-key");
    assert.ok(result.profile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRoute fail-closed on ambiguous selector", () => {
  const dir = makeTempDir();
  try {
    assert.throws(
      () => resolveRoute({
        claudeConfigDir: dir,
        selectorInput: "deepseek",
        cliVersion: null,
        parentEnv: {},
      }),
      AmbiguousSelectorError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRoute fail-closed on corrupt profile", () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, "active-profile.json"), "corrupt{", "utf8");
    assert.throws(
      () => resolveRoute({
        claudeConfigDir: dir,
        selectorInput: null,
        cliVersion: null,
        parentEnv: {},
      }),
      /not valid JSON/i
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRouteForDisplay returns bounded JSON without secrets", () => {
  const dir = makeTempDir();
  try {
    writeProfile(dir, SAMPLE_PROFILE);
    const result = resolveRouteForDisplay({
      claudeConfigDir: dir,
      selectorInput: "Fable",
      cliVersion: "2.1.208",
    });
    assert.equal(result.selectorKind, "alias");
    assert.equal(result.cliArg, "fable");
    assert.equal(result.canonicalAlias, "fable");
    assert.equal(result.profileIdentity, "test-profile");
    assert.ok(result.profileFingerprint);
    assert.ok(result.aliasClaim);
    assert.equal(result.aliasClaim.alias, "fable");
    assert.equal(result.aliasClaim.nativeId, "anthropic-fable-1");
    assert.ok(result.note);

    // No secrets in the display result
    const str = JSON.stringify(result);
    assert.doesNotMatch(str, /sk-test-secret-key/);
    assert.doesNotMatch(str, /api\.test\.example\.com/);
    assert.doesNotMatch(str, /envVars/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRouteForDisplay for inherited returns inherited kind", () => {
  const dir = makeTempDir();
  try {
    const result = resolveRouteForDisplay({
      claudeConfigDir: dir,
      selectorInput: null,
      cliVersion: null,
    });
    assert.equal(result.selectorKind, "inherited");
    assert.equal(result.cliArg, null);
    assert.equal(result.profileIdentity, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRouteForDisplay for native ID passes through unchanged", () => {
  const dir = makeTempDir();
  try {
    const result = resolveRouteForDisplay({
      claudeConfigDir: dir,
      selectorInput: "glm-5.2",
      cliVersion: null,
    });
    assert.equal(result.selectorKind, "native");
    assert.equal(result.cliArg, "glm-5.2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveRouteForDisplay for ambiguous selector throws", () => {
  const dir = makeTempDir();
  try {
    assert.throws(
      () => resolveRouteForDisplay({
        claudeConfigDir: dir,
        selectorInput: "unknown-model-name",
        cliVersion: null,
      }),
      AmbiguousSelectorError
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Per-Job Fresh Profile (no caching) ──────────────────────────────────────

test("active profile is re-read per job (no cross-job caching)", () => {
  const dir = makeTempDir();
  try {
    // First read: profile A
    writeProfile(dir, { ...SAMPLE_PROFILE, profileIdentity: "profile-A" });
    const result1 = resolveRoute({
      claudeConfigDir: dir,
      selectorInput: null,
      cliVersion: null,
      parentEnv: {},
    });
    assert.equal(result1.snapshot.profileIdentity, "profile-A");

    // Switch profile: profile B
    writeProfile(dir, { ...SAMPLE_PROFILE, profileIdentity: "profile-B" });
    const result2 = resolveRoute({
      claudeConfigDir: dir,
      selectorInput: null,
      cliVersion: null,
      parentEnv: {},
    });
    assert.equal(result2.snapshot.profileIdentity, "profile-B");
    assert.notEqual(result1.snapshot.profileFingerprint, result2.snapshot.profileFingerprint);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ─── Native ID not aliased when rejected ─────────────────────────────────────

test("native ID is not silently aliased to a fallback when Provider rejects it", () => {
  // A native ID like "deepseek-v4-pro" must be classified as native,
  // not silently mapped to an alias like "opus" as a fallback.
  const result = classifySelector("deepseek-v4-pro", null);
  assert.equal(result.kind, "native");
  assert.equal(result.cliArg, "deepseek-v4-pro");
  assert.equal(result.canonicalAlias, null);
});

test("no implicit Opus → Fable auto-downgrade in classification", () => {
  // Opus stays opus, Fable stays fable — no auto-substitution
  const opus = classifySelector("Opus", null);
  assert.equal(opus.cliArg, "opus");
  const fable = classifySelector("Fable", null);
  assert.equal(fable.cliArg, "fable");
});

// ─── Config Dir Resolution ───────────────────────────────────────────────────

test("resolveClaudeConfigDir respects CLAUDE_CONFIG_DIR env var", () => {
  const customDir = "/custom/claude/config";
  const result = resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: customDir });
  assert.equal(result, customDir);
});

test("resolveClaudeConfigDir falls back to ~/.claude when env not set", () => {
  const result = resolveClaudeConfigDir({});
  assert.ok(result.endsWith(".claude"));
});
