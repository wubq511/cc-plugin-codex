/**
 * Model routing — selector classification, route snapshots, and child-env
 * construction. No filesystem dependency or external configuration resolution.
 *
 * The plugin supervises a native Claude Code CLI child process. Claude Code
 * owns its configuration; the plugin does not read, write, or modify any
 * configuration file.
 *
 * Selector contract:
 *   null/empty  → inherited (no --model flag)
 *   Opus/Fable/Sonnet/Haiku (case-insensitive) → CLI alias, normalized lowercase
 *   valid native ID (letters, digits, _, -, ., :, /, with a version digit, no spaces)
 *     → forwarded unchanged after strict syntax validation
 *   ambiguous/unsafe → AmbiguousSelectorError before spawn
 *
 * Actual model identity is determined only from Claude's post-run execution
 * evidence. A requested selector is never execution proof.
 */

import { spawnSync } from "node:child_process";

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Canonical Claude CLI aliases. Case-insensitive on input; normalized to
 * lowercase for the CLI argument and for storage.
 */
export const KNOWN_ALIASES = Object.freeze(new Set(["opus", "fable", "sonnet", "haiku"]));

/**
 * Allowed characters for a native model selector: letters, digits,
 * underscore, hyphen, dot, colon, slash. Rejects control characters,
 * whitespace, and any other character class before the value enters
 * snapshot, structuredContent, or CLI argv.
 */
const NATIVE_SELECTOR_RE = /^[a-zA-Z0-9_\-.:/]+$/;

/** Maximum length for a native model selector. */
const MAX_NATIVE_SELECTOR_LEN = 128;

/**
 * Secret-like value detector. A user or caller that mistakenly places a
 * credential (e.g. an API key) into a model selector field must fail closed
 * before the value enters a snapshot, error, or MCP output. No legitimate
 * native model ID starts with `sk-` or `Bearer `.
 */
const SECRET_LIKE_RE = /^(sk-[a-zA-Z0-9_\-]{8,}|Bearer\s+\S)/i;

// ─── Errors ──────────────────────────────────────────────────────────────────

/**
 * Raised when a model selector cannot be safely resolved to an alias or a
 * native ID. Fail closed — no fallback model.
 *
 * The error message is intentionally generic and never echoes the raw
 * selector value: the selector may be secret-like, contain control
 * characters, or be an arbitrary untrusted string. The raw value is
 * preserved on the `selector` property for internal logging only and
 * must never enter state, diagnostics, or MCP output.
 */
export class AmbiguousSelectorError extends Error {
  constructor(selector) {
    super(
      `Ambiguous model selector. ` +
      `Use a Claude alias (opus, fable, sonnet, haiku), ` +
      `or a full native model ID with version (e.g., deepseek-v4-pro, glm-5.2). ` +
      `Bare family names without version are not accepted. ` +
      `Omit the selector entirely for inherited (default) behavior.`
    );
    this.name = "AmbiguousSelectorError";
    this.selector = selector;
  }
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

// ─── Selector Classification ─────────────────────────────────────────────────

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

/**
 * Validate a native model selector before it enters a route snapshot,
 * structuredContent, or CLI argv. Rejects control characters, whitespace,
 * overlong values, characters outside the allowlist, and secret-like values.
 *
 * @param {string} selector - The native selector to validate
 * @throws {AmbiguousSelectorError} when the selector is invalid
 */
function validateNativeSelector(selector) {
  if (typeof selector !== "string" || selector.length === 0) {
    throw new AmbiguousSelectorError(String(selector));
  }
  if (selector.length > MAX_NATIVE_SELECTOR_LEN) {
    throw new AmbiguousSelectorError(selector);
  }
  if (/[\x00-\x1f\x7f]/.test(selector)) {
    throw new AmbiguousSelectorError(selector);
  }
  if (/\s/.test(selector)) {
    throw new AmbiguousSelectorError(selector);
  }
  if (!NATIVE_SELECTOR_RE.test(selector)) {
    throw new AmbiguousSelectorError(selector);
  }
  // Secret-like selectors (e.g. a pasted API key) must fail closed before
  // being echoed in requestedValue, cliArg, snapshot, or MCP output.
  if (SECRET_LIKE_RE.test(selector)) {
    throw new AmbiguousSelectorError(selector);
  }
}

/**
 * Classify a model selector input. No filesystem access — pure classification.
 *
 * @param {string|null} input - user-supplied model string (null = inherited)
 * @returns {{ kind: "inherited"|"alias"|"native", requestedValue: string|null, cliArg: string|null, canonicalAlias: string|null, resolvedFrom: string|null }}
 * @throws {AmbiguousSelectorError} if the selector is ambiguous
 */
export function classifySelector(input) {
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

  // 2. Heuristic native ID: contains a digit (version indicator), no spaces,
  //    valid syntax, not secret-like.
  if (looksLikeNativeId(trimmed)) {
    validateNativeSelector(trimmed);
    return { kind: "native", requestedValue: trimmed, cliArg: trimmed, canonicalAlias: null, resolvedFrom: "heuristic-native" };
  }

  // 3. Ambiguous: bare family name or unknown token. Fail closed.
  throw new AmbiguousSelectorError(trimmed);
}

// ─── Route Snapshot Construction ─────────────────────────────────────────────

/**
 * Build a non-secret route snapshot for persistence and display. The snapshot
 * records what CLI argument was forwarded — it is NOT proof that the Provider
 * honoured it. No external-configuration fields are included.
 */
export function buildRouteSnapshot({ selector, cliVersion }) {
  return {
    selectorKind: selector.kind,
    requestedValue: selector.requestedValue,
    cliArg: selector.cliArg,
    canonicalAlias: selector.canonicalAlias,
    cliVersion: cliVersion || null,
    timestamp: new Date().toISOString(),
  };
}

// ─── Child Environment Construction ──────────────────────────────────────────

/**
 * Build the child process environment. The plugin no longer strips or injects
 * any environment variables — the parent process environment is passed through
 * unchanged. Claude Code owns its own configuration.
 */
export function buildChildEnv(parentEnv) {
  return { ...parentEnv };
}

// ─── Full Route Resolution ───────────────────────────────────────────────────

/**
 * Resolve a complete route: classify selector, build snapshot, build child env.
 * No filesystem access or external configuration reading. Each job calls this fresh.
 *
 * @returns {{ selector, snapshot, childEnv }}
 * @throws {AmbiguousSelectorError} if the selector is ambiguous
 */
export function resolveRoute({ selectorInput, cliVersion, parentEnv }) {
  const selector = classifySelector(selectorInput);
  const snapshot = buildRouteSnapshot({ selector, cliVersion });
  const childEnv = buildChildEnv(parentEnv);
  return { selector, snapshot, childEnv };
}

/**
 * Resolve a route for the cc_resolve_route tool (read-only, no execution).
 * Returns a human-readable summary and bounded structuredContent.
 *
 * @returns {{ selectorKind, requestedValue, cliArg, canonicalAlias, resolvedFrom, cliVersion, note, structuredContent }}
 * @throws {AmbiguousSelectorError} if the selector is ambiguous
 */
export function resolveRouteForDisplay({ selectorInput, cliVersion }) {
  const selector = classifySelector(selectorInput);
  const snapshot = buildRouteSnapshot({ selector, cliVersion });

  const structuredContent = {
    selectorKind: snapshot.selectorKind,
    requestedValue: snapshot.requestedValue,
    cliArg: snapshot.cliArg,
    canonicalAlias: snapshot.canonicalAlias,
    cliVersion: snapshot.cliVersion,
    notExecutionProof: true,
  };

  return {
    selectorKind: snapshot.selectorKind,
    requestedValue: snapshot.requestedValue,
    cliArg: snapshot.cliArg,
    canonicalAlias: snapshot.canonicalAlias,
    resolvedFrom: selector.resolvedFrom,
    cliVersion: snapshot.cliVersion,
    note: "This is a configuration claim, not execution proof. Live execution evidence is still required after delegation. The plugin does not know which Provider model each alias resolves to — that is owned by Claude Code's native configuration.",
    structuredContent,
  };
}
