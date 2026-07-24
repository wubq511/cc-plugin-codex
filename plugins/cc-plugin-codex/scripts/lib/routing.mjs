/**
 * Dynamic model routing — active-authority resolution, selector classification,
 * route snapshots, and child-env construction.
 *
 * Authority model (remediation contract):
 *   The default active authority is cc-profile-switch:
 *     ${CC_PROFILE_SWITCH_HOME:-~/.cc-profile-switch}/config.json
 *       -> lastUsedProfile
 *       -> profiles/<safe-name>/claude-home/settings.json
 *       +  (common) api-settings.json
 *     The profile's claude-home becomes the child-only CLAUDE_CONFIG_DIR.
 *   When cc-profile-switch is absent, a Claude-settings adapter may read
 *     <CLAUDE_CONFIG_DIR>/settings.json, and an explicit active-profile.json
 *     fixture adapter remains available for tests/legacy. None of these is
 *   cached across jobs — every cc_delegate / cc_resolve_route / liveness
 *   probe re-reads the authority fresh.
 *
 * Security boundaries:
 *   - Secrets (env values) exist only in the child environment, never in
 *     snapshots, fingerprints, state, diagnostics, or MCP output.
 *   - Profile fingerprints are computed from non-secret fields only:
 *     canonical alias/display mapping + source identity + profile identity +
 *     effective routing policy + injected KEY NAMES (never values).
 *   - The child-env strip list is FIXED (all ANTHROPIC_* + Bedrock/Vertex
 *     flags). A JSON profile may never supply its own strip list, PATH,
 *     NODE_OPTIONS, or arbitrary process-env keys.
 *   - Ambiguous selectors fail closed. Native IDs are never rewritten.
 *   - All paths resolve under the configured app home; traversal and symlink
 *     escape fail at the configuration stage before Claude is spawned.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeModelIdForStorage } from "./model-evidence-shared.mjs";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Canonical Claude CLI aliases. Case-insensitive on input; normalized to
 * lowercase for the CLI argument and for storage.
 */
export const KNOWN_ALIASES = Object.freeze(new Set(["opus", "fable", "sonnet", "haiku"]));

/**
 * Mapping of canonical alias → the ANTHROPIC_DEFAULT_<NAME>_MODEL env key
 * that declares its native ID under cc-profile-switch / Claude settings.
 */
const ALIAS_TO_MODEL_ENV_KEY = Object.freeze({
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  fable: "ANTHROPIC_DEFAULT_FABLE_MODEL",
});

/**
 * Allowlist for env vars injected from a selected profile configuration.
 * Only these keys may enter the child env from profile JSON; everything else
 * is rejected (configuration-stage failure). Values are never persisted.
 *
 * - ANTHROPIC_[A-Z0-9_]+ : provider routing/auth (string values only)
 * - CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX : routing flags
 * - CLAUDE_CODE_ATTRIBUTION_HEADER / DISABLE_AUTOUPDATER : safe Claude flags
 */
const ALLOWED_INJECTED_PREFIX_RE = /^ANTHROPIC_[A-Z0-9_]+$/;
const ALLOWED_INJECTED_EXACT = Object.freeze(new Set([
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_ATTRIBUTION_HEADER",
  "DISABLE_AUTOUPDATER",
]));

/** Keys that must NEVER be accepted from profile JSON. */
const FORBIDDEN_INJECTED = Object.freeze(new Set([
  "PATH",
  "NODE_OPTIONS",
  "CLAUDE_CONFIG_DIR", // set explicitly from the profile claude-home, never from env
  "HOME",
  "USER",
  "SHELL",
]));

const ACTIVE_PROFILE_FILENAME = "active-profile.json";
const CC_PROFILE_SWITCH_DEFAULT_DIRNAME = ".cc-profile-switch";

// Bounding limits for validated fields.
const MAX_PROFILE_NAME_LEN = 128;
const MAX_ENV_KEY_LEN = 128;
const MAX_ENV_VAL_LEN = 8192;
const MAX_ENV_ENTRIES = 128;

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Raised when a model selector cannot be safely resolved to an alias, a
 * declared display name, or a native ID. Fail closed — no fallback model.
 */
export class AmbiguousSelectorError extends Error {
  constructor(selector) {
    super(
      `Ambiguous model selector "${selector}". ` +
      `Use a Claude alias (opus, fable, sonnet, haiku), ` +
      `a full native model ID (e.g., deepseek-v4-pro, glm-5.2), ` +
      `or a display name declared in the active profile. ` +
      `Bare family names without version are not accepted.`
    );
    this.name = "AmbiguousSelectorError";
    this.selector = selector;
  }
}

/**
 * Raised when the active authority exists but cannot be safely resolved.
 * This is a configuration-stage failure: never fall back to a prior route
 * or stale inherited ANTHROPIC_* state.
 */
export class ProfileResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProfileResolutionError";
  }
}

function configError(message) {
  return new ProfileResolutionError(message);
}

// ─── Config Root Resolution ──────────────────────────────────────────────────

/**
 * Resolve the cc-profile-switch application home directory.
 * Priority: CC_PROFILE_SWITCH_HOME env var > ~/.cc-profile-switch
 */
export function resolveCcProfileSwitchHome(env = process.env) {
  const configured = env?.CC_PROFILE_SWITCH_HOME;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(os.homedir(), CC_PROFILE_SWITCH_DEFAULT_DIRNAME);
}

/**
 * Resolve the Claude configuration directory.
 * Priority: CLAUDE_CONFIG_DIR env var > ~/.claude
 */
export function resolveClaudeConfigDir(env = process.env) {
  const configured = env?.CLAUDE_CONFIG_DIR;
  if (typeof configured === "string" && configured.trim()) {
    return path.resolve(configured.trim());
  }
  return path.join(os.homedir(), ".claude");
}

// ─── CLI Version ─────────────────────────────────────────────────────────────

/**
 * Get the Claude CLI version string (best-effort, zero model calls).
 * @returns {string|null}
 */
export function getClaudeVersion(cwd, { command = "claude" } = {}) {
  try {
    const result = spawnSync(command, ["--version"], {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      timeout: 5000,
      stdio: "pipe",
    });
    if (result.status === 0) {
      const version = (result.stdout || "").trim();
      if (version) return version;
    }
  } catch {
    // best effort
  }
  return null;
}

// ─── Path Safety Helpers ─────────────────────────────────────────────────────

function pathExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read and JSON.parse a file, throwing a ProfileResolutionError on any failure.
 */
function readJsonFile(filePath, label) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    throw configError(`${label} exists but is unreadable: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw configError(`${label} is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw configError(`${label} must be a JSON object`);
  }
  return parsed;
}

/**
 * Verify that `target` resolves to a path inside `root` (no traversal escape).
 */
function assertContained(target, root) {
  const resolvedTarget = path.resolve(target);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolvedTarget);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw configError(`Path "${target}" escapes the authority root "${root}"`);
  }
}

/**
 * Verify a directory exists, is a real directory, and (via realpath) does not
 * symlink-escape `root`. Symlinks inside the tree are allowed only if their
 * real path remains under root.
 */
function assertDirSafe(dirPath, root, label) {
  let stat;
  try {
    stat = fs.lstatSync(dirPath);
  } catch {
    throw configError(`${label} not found: ${dirPath}`);
  }
  if (stat.isSymbolicLink()) {
    // A symlink at the authority boundary is unsafe — the real target may
    // live outside the app home. Resolve and re-check.
    let real;
    try {
      real = fs.realpathSync(dirPath);
    } catch (err) {
      throw configError(`${label} is a broken symlink: ${err.message}`);
    }
    assertContained(real, root);
    try {
      const realStat = fs.statSync(real);
      if (!realStat.isDirectory()) {
        throw configError(`${label} is not a directory (symlink target)`);
      }
    } catch (err) {
      if (err instanceof ProfileResolutionError) throw err;
      throw configError(`${label} symlink target unreadable: ${err.message}`);
    }
  } else if (!stat.isDirectory()) {
    throw configError(`${label} is not a directory: ${dirPath}`);
  }
}

/**
 * Verify a file path is contained under root and (if a symlink) does not
 * symlink-escape root. Used for JSON config files inside the authority tree.
 */
function assertFileSafe(filePath, root, label) {
  assertContained(filePath, root);
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) {
      let real;
      try {
        real = fs.realpathSync(filePath);
      } catch (err) {
        throw configError(`${label} is a broken symlink: ${err.message}`);
      }
      assertContained(real, root);
    }
  } catch (err) {
    if (err instanceof ProfileResolutionError) throw err;
    // Missing files (ENOENT) are acceptable — callers check pathExists
    // before reading. Only rethrow genuine I/O errors.
    if (err.code === "ENOENT") return;
    throw configError(`${label} unreadable: ${err.message}`);
  }
}

// ─── Env Allowlist / Validation ──────────────────────────────────────────────

function validateEnvValue(key, value, label) {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_ENV_KEY_LEN) {
    throw configError(`${label} has an invalid env key`);
  }
  if (typeof value !== "string" || value.length > MAX_ENV_VAL_LEN) {
    throw configError(`${label} env key "${key}" must have a string value`);
  }
}

/**
 * Extract and validate the `env` object from a parsed JSON config document.
 * Returns a raw (still-unallowlisted) map of string→string. Throws on any
 * non-string value, oversized key/value, or non-object env.
 */
function extractEnvBlock(doc, label) {
  if (doc.env === undefined || doc.env === null) return {};
  if (typeof doc.env !== "object" || Array.isArray(doc.env)) {
    throw configError(`${label} field "env" must be an object`);
  }
  const out = {};
  let count = 0;
  for (const [key, value] of Object.entries(doc.env)) {
    if (count >= MAX_ENV_ENTRIES) {
      throw configError(`${label} field "env" exceeds ${MAX_ENV_ENTRIES} entries`);
    }
    validateEnvValue(key, value, label);
    out[key] = value;
    count++;
  }
  return out;
}

/**
 * Split a raw env map into allowlisted and rejected keys. Returns
 * { allowed, rejected }. Rejected keys are any that are forbidden or not on
 * the allowlist. Callers fail closed when `rejected` is non-empty.
 */
function filterAllowedEnv(rawEnv) {
  const allowed = {};
  const rejected = [];
  for (const [key, value] of Object.entries(rawEnv)) {
    if (FORBIDDEN_INJECTED.has(key)) {
      rejected.push(key);
      continue;
    }
    if (ALLOWED_INJECTED_EXACT.has(key) || ALLOWED_INJECTED_PREFIX_RE.test(key)) {
      allowed[key] = value;
    } else {
      rejected.push(key);
    }
  }
  return { allowed, rejected };
}

// ─── Alias / Display-Name Derivation ─────────────────────────────────────────

/**
 * Derive the non-secret alias→native and display-name→native projections
 * from the allowlisted injected env. Alias keys are canonical lowercase;
 * display-name keys are canonicalized (lowercased) and case-fold collisions
 * are rejected.
 *
 *   ANTHROPIC_DEFAULT_OPUS_MODEL = "kimi-k2.6"   -> alias opus -> kimi-k2.6
 *   ANTHROPIC_DEFAULT_OPUS_MODEL_NAME = "Kimi"   -> display "kimi" -> kimi-k2.6
 *
 * @returns {{ aliasMappings: object, nativeDisplayNames: object, knownNativeIds: Set }}
 */
function deriveAliasMappings(env) {
  const aliasMappings = {};
  const nativeDisplayNames = {};
  const knownNativeIds = new Set();

  for (const [alias, modelKey] of Object.entries(ALIAS_TO_MODEL_ENV_KEY)) {
    const modelVal = env[modelKey];
    if (typeof modelVal === "string" && modelVal.trim()) {
      aliasMappings[alias] = modelVal;
      knownNativeIds.add(modelVal);
    }
    const nameKey = `${modelKey}_NAME`;
    const nameVal = env[nameKey];
    if (typeof nameVal === "string" && nameVal.trim() && typeof modelVal === "string" && modelVal.trim()) {
      const canon = nameVal.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(nativeDisplayNames, canon)) {
        throw configError(
          `Display-name case-fold collision: "${nameVal}" canonicalizes to a name already declared`
        );
      }
      nativeDisplayNames[canon] = modelVal;
    }
  }

  return { aliasMappings, nativeDisplayNames, knownNativeIds };
}

// ─── Fingerprint ─────────────────────────────────────────────────────────────

/**
 * Compute a non-secret profile fingerprint from the canonical mapping,
 * source/profile identity, effective routing policy, and injected KEY NAMES
 * (never values). The fingerprint changes whenever any effective non-secret
 * routing input changes.
 */
function computeProfileFingerprint(input) {
  const fingerprintInput = JSON.stringify({
    sourceKind: input.sourceKind,
    sourceIdentity: input.sourceIdentity,
    profileIdentity: input.profileIdentity,
    aliasMappings: input.aliasMappings,
    nativeDisplayNames: input.nativeDisplayNames,
    routingPolicy: input.routingPolicy,
    injectedKeyNames: input.injectedKeyNames,
  });
  return "sha256:" + createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 16);
}

// ─── Authority Adapters ──────────────────────────────────────────────────────

/**
 * Read the cc-profile-switch active profile. Fail closed (throw) if the
 * authority exists but cannot be safely resolved. Never fall back.
 *
 * Topology:
 *   <home>/config.json -> lastUsedProfile
 *   <home>/profiles/<name>/claude-home/  -> child CLAUDE_CONFIG_DIR
 *   <home>/api-settings.json             -> common env (lower precedence)
 *   <home>/profiles/<name>/claude-home/settings.json -> profile env (higher)
 */
function readCcProfileSwitch(home) {
  const configPath = path.join(home, "config.json");
  assertFileSafe(configPath, home, "cc-profile-switch config.json");
  if (!pathExists(configPath)) {
    // config.json missing => cc-profile-switch not initialized here. Treat
    // as "absent" so the caller falls back to the next authority.
    return null;
  }
  const config = readJsonFile(configPath, "cc-profile-switch config.json");

  const lastUsedProfile = config.lastUsedProfile;
  if (typeof lastUsedProfile !== "string" || !lastUsedProfile.trim()) {
    throw configError("cc-profile-switch config.json has no string lastUsedProfile");
  }
  validateProfileName(lastUsedProfile);

  const profileDir = path.join(home, "profiles", lastUsedProfile);
  assertContained(profileDir, home);
  assertDirSafe(profileDir, home, "cc-profile-switch profile directory");

  const claudeHome = path.join(profileDir, "claude-home");
  assertContained(claudeHome, home);
  assertDirSafe(claudeHome, home, "cc-profile-switch profile claude-home");

  // Common api-settings.json (optional, lower precedence).
  let commonEnv = {};
  const commonApiPath = path.join(home, "api-settings.json");
  assertFileSafe(commonApiPath, home, "cc-profile-switch common api-settings.json");
  if (pathExists(commonApiPath)) {
    const commonDoc = readJsonFile(commonApiPath, "cc-profile-switch common api-settings.json");
    commonEnv = extractEnvBlock(commonDoc, "cc-profile-switch common api-settings.json");
  }

  // Profile claude-home/settings.json (optional, higher precedence).
  let profileEnv = {};
  const profileSettingsPath = path.join(claudeHome, "settings.json");
  assertFileSafe(profileSettingsPath, home, "cc-profile-switch profile settings.json");
  if (pathExists(profileSettingsPath)) {
    const profileDoc = readJsonFile(profileSettingsPath, "cc-profile-switch profile settings.json");
    profileEnv = extractEnvBlock(profileDoc, "cc-profile-switch profile settings.json");
    // Profile JSON must never declare its own strip list.
    if (profileDoc.stripInherited !== undefined && profileDoc.stripInherited !== null) {
      throw configError("cc-profile-switch profile settings.json must not declare stripInherited");
    }
  }

  // Merge: common < profile (profile wins on conflict).
  const mergedRawEnv = { ...commonEnv, ...profileEnv };

  // Allowlist filter — reject forbidden / arbitrary keys.
  const { allowed: injectedEnv, rejected } = filterAllowedEnv(mergedRawEnv);
  if (rejected.length > 0) {
    throw configError(
      `cc-profile-switch env contains non-allowlisted keys: ${rejected.sort().join(", ")}`
    );
  }

  const { aliasMappings, nativeDisplayNames } = deriveAliasMappings(injectedEnv);
  const injectedKeyNames = Object.keys(injectedEnv).sort();
  const routingPolicy = {
    bedrock: injectedEnv.CLAUDE_CODE_USE_BEDROCK === "1" || injectedEnv.CLAUDE_CODE_USE_BEDROCK === "true",
    vertex: injectedEnv.CLAUDE_CODE_USE_VERTEX === "1" || injectedEnv.CLAUDE_CODE_USE_VERTEX === "true",
  };
  const profileFingerprint = computeProfileFingerprint({
    sourceKind: "cc-profile-switch",
    sourceIdentity: home,
    profileIdentity: lastUsedProfile,
    aliasMappings,
    nativeDisplayNames,
    routingPolicy,
    injectedKeyNames,
  });

  return {
    sourceKind: "cc-profile-switch",
    childClaudeConfigDir: claudeHome,
    projection: {
      sourceKind: "cc-profile-switch",
      sourceIdentity: "cc-profile-switch",
      profileIdentity: lastUsedProfile,
      profileFingerprint,
      aliasMappings,
      nativeDisplayNames,
      injectedKeyNames,
      routingPolicy,
    },
    secrets: { envVars: injectedEnv },
  };
}

/**
 * Read the Claude-settings adapter: <claudeConfigDir>/settings.json env block.
 * Same child-env rules as cc-profile-switch. Used only when cc-profile-switch
 * is absent. Obeys the same allowlist.
 */
function readClaudeSettingsAdapter(claudeConfigDir) {
  const settingsPath = path.join(claudeConfigDir, "settings.json");
  if (!pathExists(settingsPath)) return null;
  let stat;
  try {
    stat = fs.lstatSync(settingsPath);
  } catch {
    return null;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) return null;

  const doc = readJsonFile(settingsPath, "Claude settings.json");
  if (doc.stripInherited !== undefined && doc.stripInherited !== null) {
    throw configError("Claude settings.json must not declare stripInherited");
  }
  const rawEnv = extractEnvBlock(doc, "Claude settings.json");
  const { allowed: injectedEnv, rejected } = filterAllowedEnv(rawEnv);
  if (rejected.length > 0) {
    throw configError(
      `Claude settings.json env contains non-allowlisted keys: ${rejected.sort().join(", ")}`
    );
  }
  if (Object.keys(injectedEnv).length === 0) return null; // no routing env => bare inherit

  const { aliasMappings, nativeDisplayNames } = deriveAliasMappings(injectedEnv);
  const injectedKeyNames = Object.keys(injectedEnv).sort();
  const routingPolicy = {
    bedrock: injectedEnv.CLAUDE_CODE_USE_BEDROCK === "1" || injectedEnv.CLAUDE_CODE_USE_BEDROCK === "true",
    vertex: injectedEnv.CLAUDE_CODE_USE_VERTEX === "1" || injectedEnv.CLAUDE_CODE_USE_VERTEX === "true",
  };
  const profileFingerprint = computeProfileFingerprint({
    sourceKind: "claude-settings",
    sourceIdentity: claudeConfigDir,
    profileIdentity: null,
    aliasMappings,
    nativeDisplayNames,
    routingPolicy,
    injectedKeyNames,
  });

  return {
    sourceKind: "claude-settings",
    childClaudeConfigDir: null, // inherit CLAUDE_CONFIG_DIR from parent
    projection: {
      sourceKind: "claude-settings",
      sourceIdentity: "claude-settings",
      profileIdentity: null,
      profileFingerprint,
      aliasMappings,
      nativeDisplayNames,
      injectedKeyNames,
      routingPolicy,
    },
    secrets: { envVars: injectedEnv },
  };
}

/**
 * Read the legacy active-profile.json fixture adapter. This is NOT the
 * production authority when cc-profile-switch exists; it remains available as
 * an explicit test fixture / compatibility adapter only. It obeys the same
 * child-env allowlist rules (stripInherited from the fixture is ignored;
 * envVars must be allowlisted).
 */
function readActiveProfileFixture(claudeConfigDir) {
  const profilePath = path.join(claudeConfigDir, ACTIVE_PROFILE_FILENAME);
  if (!pathExists(profilePath)) return null;
  const parsed = readJsonFile(profilePath, "active-profile.json");

  const profileIdentity = validateStringField(parsed, "profileIdentity");
  const fixtureAliasMappings = validateStringMap(parsed, "aliasMappings");
  const fixtureNativeDisplayNames = validateStringMap(parsed, "nativeDisplayNames");
  const rawEnvVars = validateStringMap(parsed, "envVars");

  // stripInherited is explicitly ignored — the strip list is fixed. If
  // present, we do not honor it; the fixed strip always applies.
  const { allowed: injectedEnv, rejected } = filterAllowedEnv(rawEnvVars || {});
  if (rejected.length > 0) {
    throw configError(
      `active-profile.json envVars contains non-allowlisted keys: ${rejected.sort().join(", ")}`
    );
  }

  // Canonicalize display names and reject case-fold collisions.
  const nativeDisplayNames = {};
  if (fixtureNativeDisplayNames) {
    for (const [displayName, nativeId] of Object.entries(fixtureNativeDisplayNames)) {
      const canon = displayName.trim().toLowerCase();
      if (Object.prototype.hasOwnProperty.call(nativeDisplayNames, canon)) {
        throw configError(
          `active-profile.json display-name case-fold collision on "${displayName}"`
        );
      }
      nativeDisplayNames[canon] = nativeId;
    }
  }
  const aliasMappings = fixtureAliasMappings || {};

  const injectedKeyNames = Object.keys(injectedEnv).sort();
  const routingPolicy = {
    bedrock: injectedEnv.CLAUDE_CODE_USE_BEDROCK === "1" || injectedEnv.CLAUDE_CODE_USE_BEDROCK === "true",
    vertex: injectedEnv.CLAUDE_CODE_USE_VERTEX === "1" || injectedEnv.CLAUDE_CODE_USE_VERTEX === "true",
  };
  const profileFingerprint = computeProfileFingerprint({
    sourceKind: "active-profile-fixture",
    sourceIdentity: claudeConfigDir,
    profileIdentity,
    aliasMappings,
    nativeDisplayNames,
    routingPolicy,
    injectedKeyNames,
  });

  return {
    sourceKind: "active-profile-fixture",
    childClaudeConfigDir: null,
    projection: {
      sourceKind: "active-profile-fixture",
      sourceIdentity: "active-profile-fixture",
      profileIdentity,
      profileFingerprint,
      aliasMappings,
      nativeDisplayNames,
      injectedKeyNames,
      routingPolicy,
    },
    secrets: { envVars: injectedEnv },
  };
}

function validateStringField(obj, name) {
  const val = obj[name];
  if (val === undefined || val === null) return null;
  if (typeof val !== "string") throw configError(`active-profile.json field "${name}" must be a string`);
  if (val.length > 256) throw configError(`active-profile.json field "${name}" exceeds 256 characters`);
  return val;
}

function validateStringMap(obj, name) {
  const val = obj[name];
  if (val === undefined || val === null) return null;
  if (typeof val !== "object" || Array.isArray(val)) {
    throw configError(`active-profile.json field "${name}" must be an object`);
  }
  const result = {};
  let count = 0;
  for (const [key, value] of Object.entries(val)) {
    if (count >= 64) throw configError(`active-profile.json field "${name}" exceeds 64 entries`);
    if (typeof key !== "string" || key.length > 256) {
      throw configError(`active-profile.json field "${name}" has an invalid key`);
    }
    if (typeof value !== "string" || value.length > 256) {
      throw configError(`active-profile.json field "${name}"["${key}"] must be a string`);
    }
    result[key] = value;
    count++;
  }
  return result;
}

/**
 * Validate a cc-profile-switch profile name. Must be a safe relative path
 * segment: no separators, no traversal, no leading dot. This prevents
 * `../escape` and absolute-name injection.
 */
function validateProfileName(name) {
  if (typeof name !== "string" || !name.length || name.length > MAX_PROFILE_NAME_LEN) {
    throw configError(`Invalid cc-profile-switch profile name: ${JSON.stringify(name)}`);
  }
  if (/[\\/\0]/.test(name)) {
    throw configError(`cc-profile-switch profile name must not contain path separators: ${JSON.stringify(name)}`);
  }
  if (name === "." || name === ".." || name.startsWith(".")) {
    throw configError(`cc-profile-switch profile name must not be a dot-relative segment: ${JSON.stringify(name)}`);
  }
}

// ─── Authority Dispatcher ────────────────────────────────────────────────────

/**
 * Resolve the active authority fresh (no caching). Selection order:
 *   1. cc-profile-switch (if its config.json exists) — fail closed if broken
 *   2. active-profile.json fixture (explicit test/legacy compat)
 *   3. Claude settings.json adapter
 *   4. bare inherit (null)
 *
 * @param {object} options
 * @param {object} [options.env] - environment (defaults to process.env)
 * @param {string} [options.claudeConfigDir] - override CLAUDE_CONFIG_DIR
 * @returns {object|null} profile descriptor or null for bare inherit
 * @throws {ProfileResolutionError} when an authority exists but is unsafe
 */
export function readActiveAuthority({ env = process.env, claudeConfigDir } = {}) {
  const configDir = claudeConfigDir || resolveClaudeConfigDir(env);

  // 1. cc-profile-switch is the default authority.
  const ccpsHome = resolveCcProfileSwitchHome(env);
  const ccpsConfigPath = path.join(ccpsHome, "config.json");
  if (pathExists(ccpsConfigPath)) {
    // cc-profile-switch exists — it MUST resolve safely or fail closed.
    // (readCcProfileSwitch returns null only when config.json is absent,
    //  which we have already ruled out; any other failure throws.)
    return readCcProfileSwitch(ccpsHome);
  }

  // 2. active-profile.json fixture (explicit test/legacy compat).
  const fixturePath = path.join(configDir, ACTIVE_PROFILE_FILENAME);
  if (pathExists(fixturePath)) {
    return readActiveProfileFixture(configDir);
  }

  // 3. Claude settings.json adapter.
  return readClaudeSettingsAdapter(configDir);
}

/**
 * @deprecated Use readActiveAuthority(). Kept for backward-compatible test
 * imports; reads only the active-profile.json fixture under claudeConfigDir.
 */
export function readActiveProfile(claudeConfigDir) {
  const profile = readActiveProfileFixture(claudeConfigDir);
  // Match the historical return shape for legacy callers.
  if (!profile) return null;
  return {
    exists: true,
    projection: profile.projection,
    secrets: profile.secrets,
  };
}

// ─── Selector Classification ─────────────────────────────────────────────────

/**
 * Classify a model selector input.
 *
 * @param {string|null} input - user-supplied model string (null = inherited)
 * @param {object|null} projection - non-secret profile projection
 * @returns {{ kind: "inherited"|"alias"|"native", requestedValue: string|null, cliArg: string|null, canonicalAlias: string|null, resolvedFrom: string|null }}
 * @throws {AmbiguousSelectorError} if the selector is ambiguous
 */
export function classifySelector(input, projection = null) {
  if (input === null || input === undefined || (typeof input === "string" && !input.trim())) {
    return { kind: "inherited", requestedValue: null, cliArg: null, canonicalAlias: null, resolvedFrom: null };
  }

  const trimmed = String(input).trim();
  if (!trimmed) {
    return { kind: "inherited", requestedValue: null, cliArg: null, canonicalAlias: null, resolvedFrom: null };
  }

  const lower = trimmed.toLowerCase();

  // 1. Known aliases (case-insensitive, normalized to lowercase).
  if (KNOWN_ALIASES.has(lower)) {
    return { kind: "alias", requestedValue: trimmed, cliArg: lower, canonicalAlias: lower, resolvedFrom: "known-alias" };
  }

  // 2. Display-name match (canonicalized, case-insensitive).
  if (projection?.nativeDisplayNames) {
    const nativeId = projection.nativeDisplayNames[lower];
    if (nativeId !== undefined) {
      return { kind: "native", requestedValue: trimmed, cliArg: nativeId, canonicalAlias: null, resolvedFrom: "display-name" };
    }
  }

  // 3. Exact native ID known to the profile (case-sensitive exact match).
  if (projection?.aliasMappings) {
    const knownIds = new Set(Object.values(projection.aliasMappings));
    if (projection.nativeDisplayNames) {
      for (const nid of Object.values(projection.nativeDisplayNames)) knownIds.add(nid);
    }
    if (knownIds.has(trimmed)) {
      return { kind: "native", requestedValue: trimmed, cliArg: trimmed, canonicalAlias: null, resolvedFrom: "profile-known-native" };
    }
  }

  // 4. Heuristic native ID: contains a digit (version indicator), no spaces.
  if (looksLikeNativeId(trimmed)) {
    return { kind: "native", requestedValue: trimmed, cliArg: trimmed, canonicalAlias: null, resolvedFrom: "heuristic-native" };
  }

  // 5. Ambiguous: bare family name or unknown token. Fail closed.
  throw new AmbiguousSelectorError(trimmed);
}

/**
 * Heuristic: does this string look like a provider-native model ID?
 * Conservative: must contain a digit (version indicator) and no spaces.
 */
function looksLikeNativeId(input) {
  if (!input || typeof input !== "string") return false;
  if (input.includes(" ")) return false;
  if (!/\d/.test(input)) return false;
  return true;
}

// ─── Route Snapshot Construction ─────────────────────────────────────────────

/**
 * Build a non-secret route snapshot for persistence and display. The snapshot
 * is evidence of the configuration used to launch the job, NOT proof that the
 * Provider honoured it. Secrets never appear here.
 */
export function buildRouteSnapshot({ selector, profile, cliVersion }) {
  const projection = profile?.projection || null;
  const snapshot = {
    selectorKind: selector.kind,
    requestedValue: selector.requestedValue,
    cliArg: selector.cliArg,
    canonicalAlias: selector.canonicalAlias,
    sourceKind: profile?.sourceKind || null,
    profileIdentity: projection?.profileIdentity || null,
    profileFingerprint: projection?.profileFingerprint || null,
    aliasClaim: null,
    injectedKeyNames: projection?.injectedKeyNames || null,
    routingPolicy: projection?.routingPolicy || null,
    cliVersion: cliVersion || null,
    timestamp: new Date().toISOString(),
  };

  if (selector.kind === "alias" && projection?.aliasMappings) {
    const nativeId = projection.aliasMappings[selector.canonicalAlias];
    if (nativeId) {
      snapshot.aliasClaim = {
        alias: selector.canonicalAlias,
        nativeId: normalizeModelIdForStorage(nativeId) || nativeId,
      };
    }
  }

  return snapshot;
}

// ─── Child Environment Construction ──────────────────────────────────────────

/**
 * Build the child process environment from the parent env and the active
 * profile. The strip list is FIXED: every inherited ANTHROPIC_* var plus
 * CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX is removed, then only the
 * allowlisted, validated current-profile env is injected. The profile's
 * claude-home becomes the child-only CLAUDE_CONFIG_DIR.
 *
 * When no profile is selected (bare inherit), the parent env is passed
 * unchanged — no stripping, no injection.
 */
export function buildChildEnv(parentEnv, profile) {
  if (!profile) {
    return { ...parentEnv };
  }

  const env = { ...parentEnv };

  // Fixed strip: remove ALL inherited ANTHROPIC_* + routing flags so stale
  // values from a long-lived Codex process can never survive.
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_")) delete env[key];
  }
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;

  // Inject only the allowlisted, validated profile env (secrets enter here).
  for (const [key, value] of Object.entries(profile.secrets.envVars)) {
    env[key] = value;
  }

  // The profile's claude-home is the child-only CLAUDE_CONFIG_DIR.
  if (profile.childClaudeConfigDir) {
    env.CLAUDE_CONFIG_DIR = profile.childClaudeConfigDir;
  }

  return env;
}

// ─── Full Route Resolution ───────────────────────────────────────────────────

/**
 * Resolve a complete route fresh: read authority, classify selector, build
 * snapshot + child env. The main entry point for cc_delegate. Each job calls
 * this fresh — no route snapshot is reused across jobs.
 *
 * @returns {{ selector, snapshot, childEnv, profile }}
 * @throws {AmbiguousSelectorError} if the selector is ambiguous
 * @throws {ProfileResolutionError} if the active authority is unsafe
 */
export function resolveRoute({ claudeConfigDir, selectorInput, cliVersion, parentEnv, env }) {
  const profile = readActiveAuthority({ env, claudeConfigDir });
  const selector = classifySelector(selectorInput, profile?.projection || null);
  const snapshot = buildRouteSnapshot({ selector, profile, cliVersion });
  const childEnv = buildChildEnv(parentEnv, profile);
  return { selector, snapshot, childEnv, profile };
}

/**
 * Resolve a route for the cc_resolve_route tool (read-only, no execution).
 * Returns bounded JSON for MCP presentation plus a bounded structuredContent.
 * Does not include secrets.
 *
 * @returns {{ selectorKind, requestedValue, cliArg, canonicalAlias, resolvedFrom, sourceKind, profileIdentity, profileFingerprint, aliasClaim, injectedKeyNames, routingPolicy, cliVersion, note, structuredContent }}
 * @throws {AmbiguousSelectorError} if the selector is ambiguous
 * @throws {ProfileResolutionError} if the active authority is unsafe
 */
export function resolveRouteForDisplay({ claudeConfigDir, selectorInput, cliVersion, env }) {
  const profile = readActiveAuthority({ env, claudeConfigDir });
  const selector = classifySelector(selectorInput, profile?.projection || null);
  const snapshot = buildRouteSnapshot({ selector, profile, cliVersion });

  const structuredContent = {
    selectorKind: snapshot.selectorKind,
    requestedValue: snapshot.requestedValue,
    cliArg: snapshot.cliArg,
    canonicalAlias: snapshot.canonicalAlias,
    sourceKind: snapshot.sourceKind,
    profileIdentity: snapshot.profileIdentity,
    profileFingerprint: snapshot.profileFingerprint,
    aliasClaim: snapshot.aliasClaim,
    injectedKeyNames: snapshot.injectedKeyNames,
    routingPolicy: snapshot.routingPolicy,
    cliVersion: snapshot.cliVersion,
    notExecutionProof: true,
  };

  return {
    selectorKind: snapshot.selectorKind,
    requestedValue: snapshot.requestedValue,
    cliArg: snapshot.cliArg,
    canonicalAlias: snapshot.canonicalAlias,
    resolvedFrom: selector.resolvedFrom,
    sourceKind: snapshot.sourceKind,
    profileIdentity: snapshot.profileIdentity,
    profileFingerprint: snapshot.profileFingerprint,
    aliasClaim: snapshot.aliasClaim,
    injectedKeyNames: snapshot.injectedKeyNames,
    routingPolicy: snapshot.routingPolicy,
    cliVersion: snapshot.cliVersion,
    note: "This is a configuration claim, not execution proof. Live execution evidence is still required after delegation.",
    structuredContent,
  };
}
