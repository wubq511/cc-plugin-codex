/**
 * Dynamic model routing — selector classification, route snapshots, child env.
 *
 * This module owns:
 *   - Active-profile discovery (allowlisted routing projection only)
 *   - Selector normalization (inherited / alias / native)
 *   - Non-secret route snapshot construction (persistable, displayable)
 *   - Child environment construction (strip stale ANTHROPIC_*, inject profile)
 *
 * Security boundaries:
 *   - Secrets (envVars) exist only in the child environment, never in snapshots.
 *   - Profile fingerprints are computed from non-secret fields only.
 *   - No profile is cached across jobs — each job gets a fresh snapshot.
 *   - Ambiguous selectors fail closed.
 *   - Native IDs are never rewritten.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeModelIdForStorage } from "./model-evidence-shared.mjs";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Canonical Claude CLI aliases. These are the only strings treated as aliases.
 * Case-insensitive on input; normalized to lowercase for the CLI argument.
 */
export const KNOWN_ALIASES = Object.freeze(new Set(["opus", "fable", "sonnet", "haiku"]));

/**
 * Default ANTHROPIC_* env vars to strip when a profile is active but does not
 * specify its own stripInherited list. These are model-routing/auth variables
 * that a long-lived Codex process may have inherited from a prior profile.
 */
const DEFAULT_STRIP_INHERITED = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
]);

const ACTIVE_PROFILE_FILENAME = "active-profile.json";

// ─── Config Root Resolution ──────────────────────────────────────────────────

/**
 * Resolve the Claude configuration directory.
 * Priority: CLAUDE_CONFIG_DIR env var > ~/.claude
 */
export function resolveClaudeConfigDir(env = process.env) {
  const configured = env?.CLAUDE_CONFIG_DIR;
  if (configured && typeof configured === "string" && configured.trim()) {
    return configured;
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

// ─── Active Profile Reading ──────────────────────────────────────────────────

/**
 * Read the active-profile.json from the Claude config directory.
 *
 * Returns { projection, secrets, exists } or null if no profile file exists.
 * Throws if the file exists but is corrupt or violates the allowlisted schema.
 *
 * projection (non-secret, safe to persist/display):
 *   - profileIdentity: string
 *   - profileFingerprint: string (sha256 of non-secret fields)
 *   - aliasMappings: { alias → nativeId }
 *   - nativeDisplayNames: { displayName → nativeId }
 *   - stripInherited: string[] (env var names to strip)
 *
 * secrets (NEVER persisted, displayed, or used as fingerprint input):
 *   - envVars: { name → value } (injected into child env only)
 */
export function readActiveProfile(claudeConfigDir) {
  if (!claudeConfigDir) return null;

  const profilePath = path.join(claudeConfigDir, ACTIVE_PROFILE_FILENAME);

  let exists = false;
  try {
    exists = fs.statSync(profilePath).isFile();
  } catch {
    // File doesn't exist — bare inherit mode
    return null;
  }

  if (!exists) return null;

  let raw;
  try {
    raw = fs.readFileSync(profilePath, "utf8");
  } catch (err) {
    throw new Error(`active-profile.json exists but is unreadable: ${err.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`active-profile.json is not valid JSON: ${err.message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("active-profile.json must be a JSON object");
  }

  // Validate and extract allowlisted fields
  const profileIdentity = validateStringField(parsed, "profileIdentity");
  const aliasMappings = validateStringMap(parsed, "aliasMappings");
  const nativeDisplayNames = validateStringMap(parsed, "nativeDisplayNames");
  const stripInherited = validateStringArray(parsed, "stripInherited");
  const envVars = validateStringMap(parsed, "envVars");

  // Compute fingerprint from non-secret fields only
  const fingerprintInput = JSON.stringify({
    profileIdentity,
    aliasMappings,
    nativeDisplayNames,
  });
  const profileFingerprint = "sha256:" + createHash("sha256").update(fingerprintInput).digest("hex").slice(0, 16);

  return {
    exists: true,
    projection: {
      profileIdentity,
      profileFingerprint,
      aliasMappings,
      nativeDisplayNames,
      stripInherited: stripInherited || null,
    },
    secrets: {
      envVars: envVars || {},
    },
  };
}

function validateStringField(obj, name) {
  const val = obj[name];
  if (val === undefined || val === null) return null;
  if (typeof val !== "string") throw new Error(`active-profile.json field "${name}" must be a string`);
  if (val.length > 256) throw new Error(`active-profile.json field "${name}" exceeds 256 characters`);
  return val;
}

function validateStringMap(obj, name) {
  const val = obj[name];
  if (val === undefined || val === null) return null;
  if (typeof val !== "object" || Array.isArray(val)) {
    throw new Error(`active-profile.json field "${name}" must be an object`);
  }
  const result = {};
  let count = 0;
  for (const [key, value] of Object.entries(val)) {
    if (count >= 64) throw new Error(`active-profile.json field "${name}" exceeds 64 entries`);
    if (typeof key !== "string" || key.length > 256) {
      throw new Error(`active-profile.json field "${name}" has an invalid key`);
    }
    if (typeof value !== "string" || value.length > 256) {
      throw new Error(`active-profile.json field "${name}"["${key}"] must be a string`);
    }
    result[key] = value;
    count++;
  }
  return result;
}

function validateStringArray(obj, name) {
  const val = obj[name];
  if (val === undefined || val === null) return null;
  if (!Array.isArray(val)) {
    throw new Error(`active-profile.json field "${name}" must be an array`);
  }
  if (val.length > 64) throw new Error(`active-profile.json field "${name}" exceeds 64 entries`);
  return val.filter((v) => typeof v === "string" && v.length > 0 && v.length <= 256);
}

// ─── Selector Classification ─────────────────────────────────────────────────

/**
 * Classify a model selector input.
 *
 * @param {string|null} input - The user-supplied model string (null = inherited)
 * @param {object|null} projection - Non-secret profile projection (or null for bare inherit)
 * @returns {{ kind: "inherited"|"alias"|"native", requestedValue: string|null, cliArg: string|null, canonicalAlias: string|null, resolvedFrom: string|null }}
 * @throws {Error} If the selector is ambiguous or unknown
 */
export function classifySelector(input, projection = null) {
  // Inherited: no model specified
  if (input === null || input === undefined || (typeof input === "string" && !input.trim())) {
    return {
      kind: "inherited",
      requestedValue: null,
      cliArg: null,
      canonicalAlias: null,
      resolvedFrom: null,
    };
  }

  const trimmed = String(input).trim();
  if (!trimmed) {
    return {
      kind: "inherited",
      requestedValue: null,
      cliArg: null,
      canonicalAlias: null,
      resolvedFrom: null,
    };
  }

  const lower = trimmed.toLowerCase();

  // Check known aliases (case-insensitive)
  if (KNOWN_ALIASES.has(lower)) {
    return {
      kind: "alias",
      requestedValue: trimmed,
      cliArg: lower, // Canonical alias is lowercase
      canonicalAlias: lower,
      resolvedFrom: "known-alias",
    };
  }

  // If we have a profile projection, check display names and known native IDs
  if (projection) {
    // Check display name mappings (case-insensitive match on display name)
    if (projection.nativeDisplayNames) {
      for (const [displayName, nativeId] of Object.entries(projection.nativeDisplayNames)) {
        if (displayName.toLowerCase() === lower) {
          return {
            kind: "native",
            requestedValue: trimmed,
            cliArg: nativeId, // Pass through the native ID
            canonicalAlias: null,
            resolvedFrom: "display-name",
          };
        }
      }
    }

    // Check if the input is an exact native ID known to the profile
    if (projection.aliasMappings) {
      const knownNativeIds = new Set(Object.values(projection.aliasMappings));
      if (projection.nativeDisplayNames) {
        for (const nid of Object.values(projection.nativeDisplayNames)) {
          knownNativeIds.add(nid);
        }
      }
      if (knownNativeIds.has(trimmed)) {
        return {
          kind: "native",
          requestedValue: trimmed,
          cliArg: trimmed, // Pass through unchanged
          canonicalAlias: null,
          resolvedFrom: "profile-known-native",
        };
      }
    }
  }

  // Heuristic: does this look like a native ID?
  // Native IDs contain at least one digit (version indicator) and have no spaces.
  if (looksLikeNativeId(trimmed)) {
    return {
      kind: "native",
      requestedValue: trimmed,
      cliArg: trimmed, // Pass through unchanged
      canonicalAlias: null,
      resolvedFrom: "heuristic-native",
    };
  }

  // Ambiguous: not an alias, not a known native ID, not a display name
  throw new AmbiguousSelectorError(trimmed);
}

/**
 * Heuristic: does this string look like a provider-native model ID?
 * Conservative: must contain a digit (version indicator) and must not contain spaces.
 */
function looksLikeNativeId(input) {
  if (!input || typeof input !== "string") return false;
  if (input.includes(" ")) return false;
  if (!/\d/.test(input)) return false;
  return true;
}

/**
 * Custom error for ambiguous selectors.
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

// ─── Route Snapshot Construction ─────────────────────────────────────────────

/**
 * Build a non-secret route snapshot for persistence and display.
 *
 * The snapshot is evidence of the configuration used to launch the job,
 * NOT proof that the Provider honoured it.
 *
 * @param {object} options
 * @param {object} options.selector - Result of classifySelector()
 * @param {object|null} options.projection - Non-secret profile projection
 * @param {string|null} options.cliVersion - Claude CLI version string
 * @returns {object} Non-secret route snapshot
 */
export function buildRouteSnapshot({ selector, projection, cliVersion }) {
  const snapshot = {
    selectorKind: selector.kind,
    requestedValue: selector.requestedValue,
    cliArg: selector.cliArg,
    canonicalAlias: selector.canonicalAlias,
    profileIdentity: projection?.profileIdentity || null,
    profileFingerprint: projection?.profileFingerprint || null,
    aliasClaim: null,
    cliVersion: cliVersion || null,
    timestamp: new Date().toISOString(),
  };

  // For aliases, record the non-secret declared alias→native mapping (if available)
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
 * Build the child process environment from the parent env and active profile.
 *
 * When a profile is active:
 *   1. Strip stale inherited vars (stripInherited or DEFAULT_STRIP_INHERITED)
 *   2. Inject profile envVars (secrets exist only here, never persisted)
 *
 * When no profile exists (bare inherit):
 *   - Pass parent env unchanged (no stripping)
 *
 * @param {object} parentEnv - The parent process environment (process.env)
 * @param {object|null} profile - Result of readActiveProfile() (or null)
 * @returns {object} Child process environment
 */
export function buildChildEnv(parentEnv, profile) {
  if (!profile) {
    // Bare inherit: pass parent env unchanged
    return { ...parentEnv };
  }

  const env = { ...parentEnv };

  // Determine which vars to strip
  const stripList = profile.projection.stripInherited && profile.projection.stripInherited.length > 0
    ? profile.projection.stripInherited
    : DEFAULT_STRIP_INHERITED;

  // Strip stale inherited vars
  for (const varName of stripList) {
    delete env[varName];
  }

  // Also strip any remaining ANTHROPIC_* vars not in the strip list
  // to prevent stale auth/routing leakage when a profile is active
  for (const key of Object.keys(env)) {
    if (key.startsWith("ANTHROPIC_") && !profile.secrets.envVars[key]) {
      delete env[key];
    }
  }

  // Inject profile envVars (secrets enter the child env here)
  for (const [key, value] of Object.entries(profile.secrets.envVars)) {
    env[key] = value;
  }

  return env;
}

// ─── Full Route Resolution ───────────────────────────────────────────────────

/**
 * Resolve a complete route: read profile, classify selector, build snapshot + env.
 *
 * This is the main entry point for the companion. Each job calls this fresh —
 * no route snapshot is reused across jobs.
 *
 * @param {object} options
 * @param {string} options.claudeConfigDir - Claude config directory
 * @param {string|null} options.selectorInput - User-supplied model string (null = inherited)
 * @param {string|null} options.cliVersion - Claude CLI version string
 * @param {object} options.parentEnv - Parent process environment
 * @returns {{ selector, snapshot, childEnv, profile }}
 * @throws {AmbiguousSelectorError} If the selector is ambiguous
 * @throws {Error} If the active profile is corrupt
 */
export function resolveRoute({ claudeConfigDir, selectorInput, cliVersion, parentEnv }) {
  // Read active profile (null if no file exists, throws if corrupt)
  const profile = readActiveProfile(claudeConfigDir);

  // Classify the selector using the profile projection
  const selector = classifySelector(selectorInput, profile?.projection || null);

  // Build the non-secret route snapshot
  const snapshot = buildRouteSnapshot({
    selector,
    projection: profile?.projection || null,
    cliVersion,
  });

  // Build the child environment
  const childEnv = buildChildEnv(parentEnv, profile);

  return {
    selector,
    snapshot,
    childEnv,
    profile,
  };
}

/**
 * Resolve a route for the cc_resolve_route tool (read-only, no execution).
 *
 * Returns bounded JSON for MCP presentation. Does not include secrets.
 *
 * @param {object} options
 * @param {string} options.claudeConfigDir - Claude config directory
 * @param {string} options.selectorInput - User-supplied model string
 * @param {string|null} options.cliVersion - Claude CLI version string
 * @returns {object} Bounded route resolution result
 * @throws {AmbiguousSelectorError} If the selector is ambiguous
 * @throws {Error} If the active profile is corrupt
 */
export function resolveRouteForDisplay({ claudeConfigDir, selectorInput, cliVersion }) {
  const profile = readActiveProfile(claudeConfigDir);
  const selector = classifySelector(selectorInput, profile?.projection || null);
  const snapshot = buildRouteSnapshot({
    selector,
    projection: profile?.projection || null,
    cliVersion,
  });

  return {
    selectorKind: selector.kind,
    requestedValue: selector.requestedValue,
    cliArg: selector.cliArg,
    canonicalAlias: selector.canonicalAlias,
    resolvedFrom: selector.resolvedFrom,
    profileIdentity: snapshot.profileIdentity,
    profileFingerprint: snapshot.profileFingerprint,
    aliasClaim: snapshot.aliasClaim,
    cliVersion: snapshot.cliVersion,
    note: "This is a configuration claim, not execution proof. Live execution evidence is still required after delegation.",
  };
}
