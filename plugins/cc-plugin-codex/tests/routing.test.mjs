/**
 * Dynamic model routing tests — cc-profile-switch authority, selector
 * classification, route snapshots, child-env construction, and structured
 * route resolution.
 *
 * Every test isolates CC_PROFILE_SWITCH_HOME and CLAUDE_CONFIG_DIR from the
 * real user environment so tests never read ~/.cc-profile-switch or ~/.claude.
 *
 * Covers the nine required test categories from the remediation contract:
 *   1. lastUsedProfile switch changes next job snapshot + child env
 *   2. api-settings + profile settings precedence; stale ANTHROPIC vars / Bedrock / Vertex stripped
 *   3. Malformed config / invalid name / traversal / symlink escape / missing profile fail closed
 *   4. Arbitrary env keys + strip lists rejected; secrets not in outputs
 *   5. Alias/native/display/ambiguous/case-fold collision
 *   6. Fingerprints change on mapping/identity/policy/key-set change
 *   7. cc_resolve_route bounded structuredContent, no secrets
 *   8. (cc_setup source/cache + liveness budget-guard — in hardening.test.mjs)
 *   9. (Existing protocol regression — in mcp-foreground + hardening)
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  KNOWN_ALIASES,
  resolveClaudeConfigDir,
  resolveCcProfileSwitchHome,
  readActiveAuthority,
  readActiveProfile,
  classifySelector,
  AmbiguousSelectorError,
  ProfileResolutionError,
  buildRouteSnapshot,
  buildChildEnv,
  resolveRoute,
  resolveRouteForDisplay,
} from "../scripts/lib/routing.mjs";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cc-routing-test-"));
}

/**
 * Build an isolated env object with CC_PROFILE_SWITCH_HOME and CLAUDE_CONFIG_DIR
 * pointed at temp dirs so tests never read the real user configuration.
 */
function isolatedEnv(ccpsHome, claudeConfigDir) {
  return {
    ...process.env,
    CC_PROFILE_SWITCH_HOME: ccpsHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
  };
}

/**
 * Create a cc-profile-switch home directory structure.
 *
 *   <home>/config.json                            { lastUsedProfile }
 *   <home>/api-settings.json                      (optional, common env — lower precedence)
 *   <home>/profiles/<name>/claude-home/
 *   <home>/profiles/<name>/claude-home/settings.json  (optional, profile env — higher precedence)
 */
function makeCcpsHome(home, { lastUsedProfile, commonEnv, profileEnv } = {}) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ lastUsedProfile }),
    "utf8"
  );
  if (commonEnv) {
    fs.writeFileSync(
      path.join(home, "api-settings.json"),
      JSON.stringify({ env: commonEnv }),
      "utf8"
    );
  }
  const profileDir = path.join(home, "profiles", lastUsedProfile);
  const claudeHome = path.join(profileDir, "claude-home");
  fs.mkdirSync(claudeHome, { recursive: true });
  if (profileEnv) {
    fs.writeFileSync(
      path.join(claudeHome, "settings.json"),
      JSON.stringify({ env: profileEnv }),
      "utf8"
    );
  }
  return home;
}

/** Write a config.json with arbitrary content (for fail-closed tests). */
function writeCcpsConfig(home, obj) {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(obj), "utf8");
}

/** Write raw content to config.json (for corrupt-JSON tests). */
function writeCcpsConfigRaw(home, raw) {
  fs.writeFileSync(path.join(home, "config.json"), raw, "utf8");
}

/** Write an active-profile.json fixture (legacy/compat adapter). */
function writeActiveProfileFixture(dir, profile) {
  fs.writeFileSync(path.join(dir, "active-profile.json"), JSON.stringify(profile), "utf8");
}

// Standard test profile envs for cc-profile-switch profiles.

const PROFILE_ALPHA_ENV = {
  ANTHROPIC_API_KEY: "sk-alpha-secret-123",
  ANTHROPIC_BASE_URL: "https://alpha.api.example.com",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "deepseek-v4-pro",
  ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "DeepSeek V4 Pro",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2",
  ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "GLM 5.2",
  ANTHROPIC_DEFAULT_HAIKU_MODEL: "qwen-3.0",
  ANTHROPIC_DEFAULT_FABLE_MODEL: "kimi-k2.6",
};

const PROFILE_BETA_ENV = {
  ANTHROPIC_API_KEY: "sk-beta-secret-456",
  ANTHROPIC_BASE_URL: "https://beta.api.example.com",
  ANTHROPIC_DEFAULT_OPUS_MODEL: "mimo-v2.5",
  ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "Mimo V2.5",
  ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.1",
  ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "GLM 5.1",
};

const STALE_PARENT_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/user",
  ANTHROPIC_API_KEY: "sk-stale-inherited",
  ANTHROPIC_BASE_URL: "https://stale.anthropic.com",
  ANTHROPIC_AUTH_TOKEN: "stale-token-value",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "true",
};

// ─── §1  Selector Classification (profile-independent) ───────────────────────

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

test("native IDs are passed through unchanged (heuristic, no profile)", () => {
  for (const input of ["deepseek-v4-pro", "glm-5.2", "claude-sonnet-4-20250514", "gpt-4o-mini"]) {
    const result = classifySelector(input, null);
    assert.equal(result.kind, "native");
    assert.equal(result.cliArg, input);
    assert.equal(result.canonicalAlias, null);
    assert.equal(result.resolvedFrom, "heuristic-native");
  }
});

test("ambiguous selectors fail closed with AmbiguousSelectorError", () => {
  for (const input of ["opus-max", "deepseek", "some random model", "claude", "GLM"]) {
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

// ─── §2  cc-profile-switch Authority: Profile Switch ─────────────────────────
// Remediation test #1: switching lastUsedProfile changes next job snapshot + child env

test("profile switch changes next job snapshot and child env without restart", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    // Create two profiles
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    // Create beta profile dir + settings
    const betaDir = path.join(home, "profiles", "beta", "claude-home");
    fs.mkdirSync(betaDir, { recursive: true });
    fs.writeFileSync(
      path.join(betaDir, "settings.json"),
      JSON.stringify({ env: PROFILE_BETA_ENV }),
      "utf8"
    );

    const env = isolatedEnv(home, configDir);

    // First resolution: alpha
    const r1 = resolveRoute({
      selectorInput: "Opus",
      cliVersion: "2.1.208",
      parentEnv: STALE_PARENT_ENV,
      env,
    });
    assert.equal(r1.snapshot.profileIdentity, "alpha");
    assert.equal(r1.childEnv.ANTHROPIC_API_KEY, "sk-alpha-secret-123");
    assert.equal(r1.childEnv.CLAUDE_CONFIG_DIR, path.join(home, "profiles", "alpha", "claude-home"));

    // Switch lastUsedProfile to beta (no restart, no cache)
    writeCcpsConfig(home, { lastUsedProfile: "beta" });

    const r2 = resolveRoute({
      selectorInput: "Opus",
      cliVersion: "2.1.208",
      parentEnv: STALE_PARENT_ENV,
      env,
    });
    assert.equal(r2.snapshot.profileIdentity, "beta");
    assert.equal(r2.childEnv.ANTHROPIC_API_KEY, "sk-beta-secret-456");
    assert.equal(r2.childEnv.CLAUDE_CONFIG_DIR, path.join(home, "profiles", "beta", "claude-home"));

    // Fingerprints must differ (different profile identity + alias mappings)
    assert.notEqual(r1.snapshot.profileFingerprint, r2.snapshot.profileFingerprint);
    // Alias claims differ: alpha opus → deepseek-v4-pro, beta opus → mimo-v2.5
    assert.equal(r1.snapshot.aliasClaim.nativeId, "deepseek-v4-pro");
    assert.equal(r2.snapshot.aliasClaim.nativeId, "mimo-v2.5");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ─── §3  Precedence + Stale Strip ─────────────────────────────────────────────
// Remediation test #2: api-settings < profile settings precedence; stale vars stripped

test("profile settings env overrides common api-settings env (precedence)", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, {
      lastUsedProfile: "alpha",
      commonEnv: {
        ANTHROPIC_API_KEY: "sk-common-value",
        ANTHROPIC_BASE_URL: "https://common.api.example.com",
      },
      profileEnv: {
        ANTHROPIC_API_KEY: "sk-profile-overrides-common",
      },
    });

    const result = resolveRoute({
      selectorInput: null,
      cliVersion: null,
      parentEnv: {},
      env: isolatedEnv(home, configDir),
    });

    // Profile wins over common
    assert.equal(result.childEnv.ANTHROPIC_API_KEY, "sk-profile-overrides-common");
    // Common value preserved when profile doesn't override
    assert.equal(result.childEnv.ANTHROPIC_BASE_URL, "https://common.api.example.com");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("stale inherited ANTHROPIC_* / Bedrock / Vertex never survive into child env", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });

    const result = resolveRoute({
      selectorInput: null,
      cliVersion: null,
      parentEnv: STALE_PARENT_ENV,
      env: isolatedEnv(home, configDir),
    });

    // Stale ANTHROPIC_AUTH_TOKEN was NOT in the profile → must be gone
    assert.ok(!result.childEnv.ANTHROPIC_AUTH_TOKEN, "stale ANTHROPIC_AUTH_TOKEN must be stripped");
    // Stale Bedrock/Vertex flags were NOT in the profile → must be gone
    assert.ok(!result.childEnv.CLAUDE_CODE_USE_BEDROCK, "stale Bedrock flag must be stripped");
    assert.ok(!result.childEnv.CLAUDE_CODE_USE_VERTEX, "stale Vertex flag must be stripped");
    // Profile values override stale inherited values
    assert.equal(result.childEnv.ANTHROPIC_API_KEY, "sk-alpha-secret-123");
    assert.equal(result.childEnv.ANTHROPIC_BASE_URL, "https://alpha.api.example.com");
    // Non-Anthropic parent vars preserved
    assert.equal(result.childEnv.PATH, "/usr/bin");
    assert.equal(result.childEnv.HOME, "/home/user");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("all inherited ANTHROPIC_* vars stripped even if not in profile envVars", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });

    const parentEnv = {
      ...STALE_PARENT_ENV,
      ANTHROPIC_CUSTOM_VAR: "custom-stale-value",
      ANTHROPIC_MODEL: "old-model-id",
    };

    const result = resolveRoute({
      selectorInput: null,
      cliVersion: null,
      parentEnv,
      env: isolatedEnv(home, configDir),
    });

    assert.ok(!result.childEnv.ANTHROPIC_CUSTOM_VAR);
    assert.ok(!result.childEnv.ANTHROPIC_MODEL);
    // Profile value injected
    assert.equal(result.childEnv.ANTHROPIC_API_KEY, "sk-alpha-secret-123");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("bare inherit (no authority) passes parent env unchanged including stale vars", () => {
  const home = makeTempDir(); // empty — no config.json
  const configDir = makeTempDir(); // empty — no settings.json or fixture
  try {
    const result = resolveRoute({
      selectorInput: null,
      cliVersion: null,
      parentEnv: STALE_PARENT_ENV,
      env: isolatedEnv(home, configDir),
    });
    // No profile → bare inherit, no stripping
    assert.equal(result.childEnv.ANTHROPIC_API_KEY, "sk-stale-inherited");
    assert.equal(result.childEnv.CLAUDE_CODE_USE_BEDROCK, "1");
    assert.equal(result.profile, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ─── §4  Fail-Closed: Corrupt / Traversal / Symlink / Missing ─────────────────
// Remediation test #3: malformed config, invalid name, traversal, symlink, missing → fail

test("corrupt config.json fails closed with ProfileResolutionError", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    writeCcpsConfigRaw(home, "not valid json{");
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      ProfileResolutionError
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("non-object config.json fails closed", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    writeCcpsConfigRaw(home, "[1, 2, 3]");
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /must be a JSON object/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("missing lastUsedProfile in config.json fails closed", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    writeCcpsConfig(home, { someOtherField: "value" });
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /no string lastUsedProfile/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("profile name with path separator fails closed", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    writeCcpsConfig(home, { lastUsedProfile: "../escape" });
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /path separators/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("profile name starting with dot fails closed", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    writeCcpsConfig(home, { lastUsedProfile: ".hidden" });
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /dot-relative/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("missing profile directory fails closed", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    writeCcpsConfig(home, { lastUsedProfile: "nonexistent" });
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      ProfileResolutionError
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("symlink-escaping claude-home fails closed", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  const escapeTarget = makeTempDir(); // outside the ccps home
  try {
    writeCcpsConfig(home, { lastUsedProfile: "symlinked" });
    const profileDir = path.join(home, "profiles", "symlinked");
    fs.mkdirSync(profileDir, { recursive: true });
    // claude-home is a symlink pointing outside home
    fs.symlinkSync(escapeTarget, path.join(profileDir, "claude-home"));

    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /escapes the authority root|not a directory|symlink/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(escapeTarget, { recursive: true, force: true });
  }
});

// ─── §5  Arbitrary Keys / Strip Lists Rejected; Secrets Not in Outputs ───────
// Remediation test #4

test("arbitrary env keys (PATH, NODE_OPTIONS, FOO) are rejected", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, {
      lastUsedProfile: "alpha",
      profileEnv: {
        ...PROFILE_ALPHA_ENV,
        PATH: "/malicious/path",
        NODE_OPTIONS: "--inspect-brk",
        FOO: "bar",
      },
    });
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /non-allowlisted keys/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("stripInherited in profile settings.json is rejected", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    writeCcpsConfig(home, { lastUsedProfile: "alpha" });
    const claudeHome = path.join(home, "profiles", "alpha", "claude-home");
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(
      path.join(claudeHome, "settings.json"),
      JSON.stringify({ env: PROFILE_ALPHA_ENV, stripInherited: ["ANTHROPIC_API_KEY"] }),
      "utf8"
    );
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /must not declare stripInherited/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("HOME, USER, SHELL are rejected from profile env", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, {
      lastUsedProfile: "alpha",
      profileEnv: {
        ...PROFILE_ALPHA_ENV,
        HOME: "/malicious/home",
        USER: "attacker",
        SHELL: "/bin/dash",
      },
    });
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /non-allowlisted keys/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("secrets do not appear in route snapshot", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const result = resolveRoute({
      selectorInput: "Opus",
      cliVersion: "2.1.208",
      parentEnv: {},
      env: isolatedEnv(home, configDir),
    });
    const snapStr = JSON.stringify(result.snapshot);
    assert.doesNotMatch(snapStr, /sk-alpha-secret-123/);
    assert.doesNotMatch(snapStr, /alpha\.api\.example\.com/);
    assert.doesNotMatch(snapStr, /envVars/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("secrets do not appear in resolveRouteForDisplay result or structuredContent", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const result = resolveRouteForDisplay({
      selectorInput: "Opus",
      cliVersion: "2.1.208",
      env: isolatedEnv(home, configDir),
    });
    const fullStr = JSON.stringify(result);
    assert.doesNotMatch(fullStr, /sk-alpha-secret-123/);
    assert.doesNotMatch(fullStr, /alpha\.api\.example\.com/);
    // structuredContent present and also secret-free
    assert.ok(result.structuredContent);
    const scStr = JSON.stringify(result.structuredContent);
    assert.doesNotMatch(scStr, /sk-alpha-secret-123/);
    assert.doesNotMatch(scStr, /alpha\.api\.example\.com/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ─── §6  Alias / Native / Display / Ambiguous / Case-Fold ─────────────────────
// Remediation test #5

test("Opus and Fable are case-insensitive aliases mapped to current profile", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const env = isolatedEnv(home, configDir);

    // Opus → alias opus → claims deepseek-v4-pro from alpha profile
    const opusResult = resolveRouteForDisplay({ selectorInput: "Opus", cliVersion: null, env });
    assert.equal(opusResult.selectorKind, "alias");
    assert.equal(opusResult.cliArg, "opus");
    assert.equal(opusResult.aliasClaim.alias, "opus");
    assert.equal(opusResult.aliasClaim.nativeId, "deepseek-v4-pro");

    // FABLE → alias fable → claims kimi-k2.6
    const fableResult = resolveRouteForDisplay({ selectorInput: "FABLE", cliVersion: null, env });
    assert.equal(fableResult.selectorKind, "alias");
    assert.equal(fableResult.cliArg, "fable");
    assert.equal(fableResult.aliasClaim.nativeId, "kimi-k2.6");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("exact native IDs pass through unchanged", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const env = isolatedEnv(home, configDir);

    for (const input of ["deepseek-v4-pro", "glm-5.2"]) {
      const result = resolveRouteForDisplay({ selectorInput: input, cliVersion: null, env });
      assert.equal(result.selectorKind, "native");
      assert.equal(result.cliArg, input);
      assert.equal(result.aliasClaim, null);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("exact display name resolves to native via profile", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const env = isolatedEnv(home, configDir);

    // Display name "DeepSeek V4 Pro" → native deepseek-v4-pro
    const result = resolveRouteForDisplay({ selectorInput: "DeepSeek V4 Pro", cliVersion: null, env });
    assert.equal(result.selectorKind, "native");
    assert.equal(result.cliArg, "deepseek-v4-pro");
    assert.equal(result.resolvedFrom, "display-name");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("display name match is case-insensitive", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const env = isolatedEnv(home, configDir);

    const result = resolveRouteForDisplay({ selectorInput: "glm 5.2", cliVersion: null, env });
    assert.equal(result.selectorKind, "native");
    assert.equal(result.cliArg, "glm-5.2");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("ambiguous bare family names (DeepSeek, GLM) fail closed", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const env = isolatedEnv(home, configDir);

    for (const input of ["DeepSeek", "GLM", "Qwen"]) {
      assert.throws(
        () => resolveRouteForDisplay({ selectorInput: input, cliVersion: null, env }),
        AmbiguousSelectorError
      );
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("display-name case-fold collision fails closed at config stage", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    // Two display names that canonicalize to the same lowercase form
    makeCcpsHome(home, {
      lastUsedProfile: "alpha",
      profileEnv: {
        ANTHROPIC_DEFAULT_OPUS_MODEL: "model-a",
        ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: "GLM 5.2",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "model-b",
        ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: "glm 5.2",
      },
    });
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /case-fold collision/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("no implicit Opus → fallback when profile has no opus mapping", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    // Profile with only sonnet mapping, no opus
    makeCcpsHome(home, {
      lastUsedProfile: "alpha",
      profileEnv: {
        ANTHROPIC_API_KEY: "sk-alpha-secret-123",
        ANTHROPIC_DEFAULT_SONNET_MODEL: "glm-5.2",
      },
    });
    const env = isolatedEnv(home, configDir);

    // Opus is still a valid alias — it just has no alias claim
    const result = resolveRouteForDisplay({ selectorInput: "Opus", cliVersion: null, env });
    assert.equal(result.selectorKind, "alias");
    assert.equal(result.cliArg, "opus");
    assert.equal(result.aliasClaim, null); // no native ID claimed
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ─── §7  Fingerprints ─────────────────────────────────────────────────────────
// Remediation test #6: fingerprints change on mapping/identity/policy/key-set change

test("fingerprint changes when alias mapping value changes", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const env = isolatedEnv(home, configDir);
    const r1 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    // Change the opus model mapping
    const betaDir = path.join(home, "profiles", "alpha", "claude-home");
    fs.writeFileSync(
      path.join(betaDir, "settings.json"),
      JSON.stringify({ env: { ...PROFILE_ALPHA_ENV, ANTHROPIC_DEFAULT_OPUS_MODEL: "different-model-v1" } }),
      "utf8"
    );
    const r2 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    assert.notEqual(r1.profileFingerprint, r2.profileFingerprint);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("fingerprint changes when profile identity changes", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    // Create beta profile with same env
    const betaDir = path.join(home, "profiles", "beta", "claude-home");
    fs.mkdirSync(betaDir, { recursive: true });
    fs.writeFileSync(
      path.join(betaDir, "settings.json"),
      JSON.stringify({ env: PROFILE_ALPHA_ENV }),
      "utf8"
    );

    const env = isolatedEnv(home, configDir);
    const r1 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    writeCcpsConfig(home, { lastUsedProfile: "beta" });
    const r2 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    assert.notEqual(r1.profileFingerprint, r2.profileFingerprint);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("fingerprint changes when routing policy changes (add Bedrock)", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const env = isolatedEnv(home, configDir);
    const r1 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    // Add Bedrock flag
    const settingsPath = path.join(home, "profiles", "alpha", "claude-home", "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ env: { ...PROFILE_ALPHA_ENV, CLAUDE_CODE_USE_BEDROCK: "1" } }),
      "utf8"
    );
    const r2 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    assert.notEqual(r1.profileFingerprint, r2.profileFingerprint);
    assert.equal(r2.routingPolicy.bedrock, true);
    assert.equal(r1.routingPolicy.bedrock, false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("fingerprint changes when injected key set changes", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const env = isolatedEnv(home, configDir);
    const r1 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    // Add a new allowlisted key
    const settingsPath = path.join(home, "profiles", "alpha", "claude-home", "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ env: { ...PROFILE_ALPHA_ENV, ANTHROPIC_CUSTOM_KEY: "custom-val" } }),
      "utf8"
    );
    const r2 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    assert.notEqual(r1.profileFingerprint, r2.profileFingerprint);
    assert.ok(r2.injectedKeyNames.includes("ANTHROPIC_CUSTOM_KEY"));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("fingerprint stays same when only secret values change", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const env = isolatedEnv(home, configDir);
    const r1 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    // Change only the API key value (key name stays same)
    const settingsPath = path.join(home, "profiles", "alpha", "claude-home", "settings.json");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({ env: { ...PROFILE_ALPHA_ENV, ANTHROPIC_API_KEY: "sk-different-secret-789" } }),
      "utf8"
    );
    const r2 = resolveRouteForDisplay({ selectorInput: null, cliVersion: null, env });

    assert.equal(r1.profileFingerprint, r2.profileFingerprint);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ─── §8  cc_resolve_route Bounded structuredContent ───────────────────────────
// Remediation test #7

test("resolveRouteForDisplay returns bounded structuredContent with expected fields", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const result = resolveRouteForDisplay({
      selectorInput: "Opus",
      cliVersion: "2.1.208",
      env: isolatedEnv(home, configDir),
    });

    const sc = result.structuredContent;
    assert.ok(sc, "structuredContent must be present");
    // Required fields from the remediation contract
    assert.equal(sc.selectorKind, "alias");
    assert.equal(sc.requestedValue, "Opus");
    assert.equal(sc.cliArg, "opus");
    assert.equal(sc.canonicalAlias, "opus");
    assert.equal(sc.sourceKind, "cc-profile-switch");
    assert.equal(sc.profileIdentity, "alpha");
    assert.ok(sc.profileFingerprint);
    assert.ok(sc.aliasClaim);
    assert.equal(sc.aliasClaim.alias, "opus");
    assert.equal(sc.aliasClaim.nativeId, "deepseek-v4-pro");
    assert.ok(Array.isArray(sc.injectedKeyNames));
    assert.ok(sc.routingPolicy);
    assert.equal(sc.cliVersion, "2.1.208");
    assert.equal(sc.notExecutionProof, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("structuredContent for inherited selector has null cliArg and no alias claim", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const result = resolveRouteForDisplay({
      selectorInput: null,
      cliVersion: null,
      env: isolatedEnv(home, configDir),
    });

    const sc = result.structuredContent;
    assert.equal(sc.selectorKind, "inherited");
    assert.equal(sc.cliArg, null);
    assert.equal(sc.aliasClaim, null);
    assert.equal(sc.notExecutionProof, true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("structuredContent has no secret-bearing fields", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const result = resolveRouteForDisplay({
      selectorInput: "Sonnet",
      cliVersion: null,
      env: isolatedEnv(home, configDir),
    });

    const scStr = JSON.stringify(result.structuredContent);
    assert.doesNotMatch(scStr, /sk-alpha-secret-123/);
    assert.doesNotMatch(scStr, /alpha\.api\.example\.com/);
    // injectedKeyNames contains key NAMES only, never values
    assert.ok(result.structuredContent.injectedKeyNames.includes("ANTHROPIC_API_KEY"));
    // The key NAME is fine; the VALUE must not appear
    assert.doesNotMatch(scStr, /sk-/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ─── §9  Active-Authority Fallback (claude-settings adapter) ──────────────────

test("claude-settings adapter reads env from settings.json when cc-profile-switch absent", () => {
  const home = makeTempDir(); // empty — no cc-profile-switch config.json
  const configDir = makeTempDir();
  try {
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ env: PROFILE_ALPHA_ENV }),
      "utf8"
    );
    const profile = readActiveAuthority({ env: isolatedEnv(home, configDir) });
    assert.ok(profile);
    assert.equal(profile.projection.sourceKind, "claude-settings");
    assert.equal(profile.projection.profileIdentity, null);
    assert.equal(profile.secrets.envVars.ANTHROPIC_API_KEY, "sk-alpha-secret-123");
    // claude-settings adapter does NOT set childClaudeConfigDir (inherits from parent)
    assert.equal(profile.childClaudeConfigDir, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("claude-settings adapter rejects arbitrary env keys", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ env: { ...PROFILE_ALPHA_ENV, PATH: "/evil", FOO: "bar" } }),
      "utf8"
    );
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /non-allowlisted keys/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("claude-settings adapter rejects stripInherited", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ env: PROFILE_ALPHA_ENV, stripInherited: ["ANTHROPIC_API_KEY"] }),
      "utf8"
    );
    assert.throws(
      () => readActiveAuthority({ env: isolatedEnv(home, configDir) }),
      /must not declare stripInherited/i
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("claude-settings adapter returns null for empty env (bare inherit)", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    fs.writeFileSync(
      path.join(configDir, "settings.json"),
      JSON.stringify({ someOtherField: "value" }),
      "utf8"
    );
    const profile = readActiveAuthority({ env: isolatedEnv(home, configDir) });
    assert.equal(profile, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ─── §10  Active-Profile Fixture Compat (legacy/test adapter) ─────────────────

const SAMPLE_FIXTURE = {
  profileIdentity: "test-profile",
  aliasMappings: { opus: "anthropic-opus-4", fable: "anthropic-fable-1", sonnet: "anthropic-sonnet-4", haiku: "anthropic-haiku-4" },
  nativeDisplayNames: { "DeepSeek V4 Pro": "deepseek-v4-pro", "GLM 5.2": "glm-5.2" },
  stripInherited: ["ANTHROPIC_API_KEY"], // ignored — strip list is fixed
  envVars: { ANTHROPIC_API_KEY: "sk-test-secret-key", ANTHROPIC_BASE_URL: "https://api.test.example.com" },
};

test("readActiveProfile returns null when no fixture file exists", () => {
  const dir = makeTempDir();
  try {
    assert.equal(readActiveProfile(dir), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveProfile returns projection and secrets when fixture exists", () => {
  const dir = makeTempDir();
  try {
    writeActiveProfileFixture(dir, SAMPLE_FIXTURE);
    const result = readActiveProfile(dir);
    assert.ok(result);
    assert.equal(result.exists, true);
    assert.equal(result.projection.profileIdentity, "test-profile");
    assert.ok(result.projection.profileFingerprint);
    assert.match(result.projection.profileFingerprint, /^sha256:/);
    assert.deepEqual(result.projection.aliasMappings, SAMPLE_FIXTURE.aliasMappings);
    assert.equal(result.secrets.envVars.ANTHROPIC_API_KEY, "sk-test-secret-key");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveProfile throws on corrupt JSON", () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, "active-profile.json"), "not json{", "utf8");
    assert.throws(() => readActiveProfile(dir), /not valid JSON/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveProfile throws on non-object JSON", () => {
  const dir = makeTempDir();
  try {
    fs.writeFileSync(path.join(dir, "active-profile.json"), "[1,2,3]", "utf8");
    assert.throws(() => readActiveProfile(dir), /must be a JSON object/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveProfile fixture with non-allowlisted envVars fails closed", () => {
  const dir = makeTempDir();
  try {
    writeActiveProfileFixture(dir, {
      ...SAMPLE_FIXTURE,
      envVars: { ANTHROPIC_API_KEY: "sk-test", PATH: "/evil" },
    });
    assert.throws(() => readActiveProfile(dir), /non-allowlisted keys/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readActiveAuthority falls back to fixture when cc-profile-switch absent", () => {
  const home = makeTempDir(); // empty — no cc-profile-switch
  const configDir = makeTempDir();
  try {
    writeActiveProfileFixture(configDir, SAMPLE_FIXTURE);
    const profile = readActiveAuthority({ env: isolatedEnv(home, configDir) });
    assert.ok(profile);
    assert.equal(profile.projection.sourceKind, "active-profile-fixture");
    assert.equal(profile.projection.profileIdentity, "test-profile");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("readActiveAuthority returns null when no authority exists (bare inherit)", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    const profile = readActiveAuthority({ env: isolatedEnv(home, configDir) });
    assert.equal(profile, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ─── §11  Route Snapshot + Child Env (unit, with mock profile) ────────────────

function mockProfile(overrides = {}) {
  return {
    sourceKind: "cc-profile-switch",
    childClaudeConfigDir: "/mock/claude-home",
    projection: {
      sourceKind: "cc-profile-switch",
      sourceIdentity: "cc-profile-switch",
      profileIdentity: "mock-profile",
      profileFingerprint: "sha256:mockfingerprint",
      aliasMappings: { opus: "deepseek-v4-pro" },
      nativeDisplayNames: { "deepseek v4 pro": "deepseek-v4-pro" },
      injectedKeyNames: ["ANTHROPIC_API_KEY"],
      routingPolicy: { bedrock: false, vertex: false },
    },
    secrets: { envVars: { ANTHROPIC_API_KEY: "sk-mock-secret" } },
    ...overrides,
  };
}

test("buildRouteSnapshot for inherited selector has no alias claim", () => {
  const selector = classifySelector(null, null);
  const snapshot = buildRouteSnapshot({ selector, profile: mockProfile(), cliVersion: "1.0.0" });
  assert.equal(snapshot.selectorKind, "inherited");
  assert.equal(snapshot.cliArg, null);
  assert.equal(snapshot.aliasClaim, null);
  assert.equal(snapshot.cliVersion, "1.0.0");
  assert.ok(snapshot.timestamp);
});

test("buildRouteSnapshot for alias includes alias claim when profile has mapping", () => {
  const profile = mockProfile();
  const selector = classifySelector("Opus", profile.projection);
  const snapshot = buildRouteSnapshot({ selector, profile, cliVersion: "1.0.0" });
  assert.equal(snapshot.selectorKind, "alias");
  assert.equal(snapshot.cliArg, "opus");
  assert.ok(snapshot.aliasClaim);
  assert.equal(snapshot.aliasClaim.alias, "opus");
  assert.equal(snapshot.aliasClaim.nativeId, "deepseek-v4-pro");
  assert.equal(snapshot.profileIdentity, "mock-profile");
  assert.equal(snapshot.profileFingerprint, "sha256:mockfingerprint");
});

test("buildRouteSnapshot for native selector has no alias claim", () => {
  const selector = classifySelector("deepseek-v4-pro", null);
  const snapshot = buildRouteSnapshot({ selector, profile: null, cliVersion: null });
  assert.equal(snapshot.selectorKind, "native");
  assert.equal(snapshot.cliArg, "deepseek-v4-pro");
  assert.equal(snapshot.aliasClaim, null);
  assert.equal(snapshot.profileIdentity, null);
});

test("buildRouteSnapshot does not contain secrets", () => {
  const profile = mockProfile();
  const selector = classifySelector("Opus", profile.projection);
  const snapshot = buildRouteSnapshot({ selector, profile, cliVersion: "1.0.0" });
  const snapStr = JSON.stringify(snapshot);
  assert.doesNotMatch(snapStr, /sk-mock-secret/);
  assert.doesNotMatch(snapStr, /envVars/);
});

test("buildChildEnv passes parent env unchanged when no profile (bare inherit)", () => {
  const parentEnv = { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-old", HOME: "/home/user" };
  const childEnv = buildChildEnv(parentEnv, null);
  assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-old");
  assert.equal(childEnv.PATH, "/usr/bin");
  assert.equal(childEnv.HOME, "/home/user");
});

test("buildChildEnv strips stale ANTHROPIC_* and injects profile secrets", () => {
  const parentEnv = {
    PATH: "/usr/bin",
    ANTHROPIC_API_KEY: "sk-old-stale",
    ANTHROPIC_AUTH_TOKEN: "old-token",
    HOME: "/home/user",
  };
  const childEnv = buildChildEnv(parentEnv, mockProfile());
  assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-mock-secret"); // injected from profile
  assert.ok(!childEnv.ANTHROPIC_AUTH_TOKEN); // stripped (not in profile)
  assert.equal(childEnv.HOME, "/home/user"); // preserved
  assert.equal(childEnv.PATH, "/usr/bin"); // preserved
  assert.equal(childEnv.CLAUDE_CONFIG_DIR, "/mock/claude-home"); // set from profile
});

test("old inherited environment does not override active profile", () => {
  const parentEnv = {
    ANTHROPIC_API_KEY: "sk-stale-inherited",
    ANTHROPIC_BASE_URL: "https://stale.anthropic.com",
  };
  const childEnv = buildChildEnv(parentEnv, mockProfile({
    secrets: { envVars: { ANTHROPIC_API_KEY: "sk-fresh-profile", ANTHROPIC_BASE_URL: "https://fresh.api.example.com" } },
  }));
  assert.equal(childEnv.ANTHROPIC_API_KEY, "sk-fresh-profile");
  assert.equal(childEnv.ANTHROPIC_BASE_URL, "https://fresh.api.example.com");
});

// ─── §12  Full Route Resolution ───────────────────────────────────────────────

test("resolveRoute returns selector, snapshot, childEnv, and profile", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const result = resolveRoute({
      selectorInput: "Opus",
      cliVersion: "2.1.208",
      parentEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-stale" },
      env: isolatedEnv(home, configDir),
    });
    assert.equal(result.selector.kind, "alias");
    assert.equal(result.selector.cliArg, "opus");
    assert.ok(result.snapshot);
    assert.equal(result.snapshot.selectorKind, "alias");
    assert.ok(result.childEnv);
    assert.equal(result.childEnv.ANTHROPIC_API_KEY, "sk-alpha-secret-123");
    assert.ok(result.profile);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("resolveRoute fail-closed on ambiguous selector", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    assert.throws(
      () => resolveRoute({
        selectorInput: "deepseek",
        cliVersion: null,
        parentEnv: {},
        env: isolatedEnv(home, configDir),
      }),
      AmbiguousSelectorError
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("resolveRoute fail-closed on corrupt cc-profile-switch config", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    writeCcpsConfigRaw(home, "corrupt{");
    assert.throws(
      () => resolveRoute({
        selectorInput: null,
        cliVersion: null,
        parentEnv: {},
        env: isolatedEnv(home, configDir),
      }),
      ProfileResolutionError
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("resolveRouteForDisplay for inherited returns inherited kind", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const result = resolveRouteForDisplay({
      selectorInput: null,
      cliVersion: null,
      env: isolatedEnv(home, configDir),
    });
    assert.equal(result.selectorKind, "inherited");
    assert.equal(result.cliArg, null);
    assert.equal(result.profileIdentity, "alpha");
    assert.ok(result.note);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("resolveRouteForDisplay for native ID passes through unchanged", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const result = resolveRouteForDisplay({
      selectorInput: "glm-5.2",
      cliVersion: null,
      env: isolatedEnv(home, configDir),
    });
    assert.equal(result.selectorKind, "native");
    assert.equal(result.cliArg, "glm-5.2");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("resolveRouteForDisplay for ambiguous selector throws", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    assert.throws(
      () => resolveRouteForDisplay({
        selectorInput: "unknown-model-name",
        cliVersion: null,
        env: isolatedEnv(home, configDir),
      }),
      AmbiguousSelectorError
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("resolveRouteForDisplay includes routing policy and injected key names in text", () => {
  const home = makeTempDir();
  const configDir = makeTempDir();
  try {
    makeCcpsHome(home, { lastUsedProfile: "alpha", profileEnv: PROFILE_ALPHA_ENV });
    const result = resolveRouteForDisplay({
      selectorInput: "Opus",
      cliVersion: null,
      env: isolatedEnv(home, configDir),
    });
    // The result object includes these non-secret fields
    assert.ok(result.injectedKeyNames);
    assert.ok(result.injectedKeyNames.includes("ANTHROPIC_API_KEY"));
    assert.ok(result.routingPolicy);
    assert.equal(result.routingPolicy.bedrock, false);
    assert.equal(result.routingPolicy.vertex, false);
    assert.equal(result.sourceKind, "cc-profile-switch");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

// ─── §13  Config Dir / Ccps Home Resolution ───────────────────────────────────

test("resolveClaudeConfigDir respects CLAUDE_CONFIG_DIR env var", () => {
  const customDir = "/custom/claude/config";
  assert.equal(resolveClaudeConfigDir({ CLAUDE_CONFIG_DIR: customDir }), customDir);
});

test("resolveClaudeConfigDir falls back to ~/.claude when env not set", () => {
  const result = resolveClaudeConfigDir({});
  assert.ok(result.endsWith(".claude"));
});

test("resolveCcProfileSwitchHome respects CC_PROFILE_SWITCH_HOME env var", () => {
  const customDir = "/custom/ccps/home";
  assert.equal(resolveCcProfileSwitchHome({ CC_PROFILE_SWITCH_HOME: customDir }), customDir);
});

test("resolveCcProfileSwitchHome falls back to ~/.cc-profile-switch when env not set", () => {
  const result = resolveCcProfileSwitchHome({});
  assert.ok(result.endsWith(".cc-profile-switch"));
});
