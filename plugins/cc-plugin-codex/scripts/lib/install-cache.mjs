/**
 * Install-cache resolution and comparison.
 *
 * Pure functions with dependency injection so tests can supply
 * fake fs/exec implementations without touching the real user cache.
 *
 * Resolution strategy (in priority order):
 *   1. Parse `codex mcp get <pluginName>` → cwd field (the active cache path)
 *   2. Parse `codex plugin list` → version for the plugin
 *   3. Filesystem fallback: $CODEX_HOME/plugins/cache/<pluginName>/<pluginName>/<version>/
 *
 * Exported for verify-install.mjs and tests.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Parse `codex mcp get <pluginName>` output.
 * @param {string} output - stdout from `codex mcp get <name>`
 * @param {string} pluginName
 * @returns {{ activePath: string|null, version: string|null, toolTimeoutSec: number|null }}
 */
export function parseMcpGetOutput(output, pluginName) {
  const result = { activePath: null, version: null, toolTimeoutSec: null };
  if (!output) return result;

  const lines = output.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    // "cwd: /path/to/cache/<pluginName>/<version>/."
    if (trimmed.startsWith("cwd:")) {
      const raw = trimmed.slice("cwd:".length).trim();
      if (raw && raw !== "-") {
        // Strip trailing /.
        result.activePath = raw.replace(/[\\/]\.$/, "");
        // Extract version from path: .../<pluginName>/<version>
        const parts = result.activePath.replace(/[\\/]$/, "").split(/[\\/]/);
        // Look for the version segment after the pluginName segment
        const nameIdx = parts.lastIndexOf(pluginName);
        if (nameIdx >= 0 && nameIdx < parts.length - 1) {
          result.version = parts[nameIdx + 1];
        }
      }
    }
    // "tool_timeout_sec: 604800"
    if (trimmed.startsWith("tool_timeout_sec:")) {
      const val = trimmed.slice("tool_timeout_sec:".length).trim();
      if (val && val !== "-") {
        result.toolTimeoutSec = Number(val);
      }
    }
  }
  return result;
}

/**
 * Parse `codex plugin list` output to extract version for a specific plugin.
 * Lines look like: "cc-plugin-codex@marketplace  installed, enabled  0.3.0+codex.xxx  /path"
 * @param {string} output
 * @param {string} pluginName
 * @returns {string|null} version string or null
 */
export function parsePluginListVersion(output, pluginName) {
  if (!output) return null;
  for (const line of output.split("\n")) {
    // Lines look like: cc-plugin-codex@marketplace  installed, enabled  0.3.0+codex.xxx  /path
    const parts = line.trim().split(/\s+/);
    if (parts[0] && parts[0].startsWith(`${pluginName}@`) && parts.length >= 3) {
      // Find the version field (matches X.Y.Z+codex.TIMESTAMP pattern)
      for (let i = 1; i < parts.length; i++) {
        if (/^\d+\.\d+\.\d+\+codex\.\d{14,}$/.test(parts[i])) {
          return parts[i];
        }
      }
    }
  }
  return null;
}

/**
 * Find the versioned cache directory on the filesystem.
 * Layout: <codexHome>/plugins/cache/<pluginName>/<pluginName>/<version>/
 * @param {string} codexHome - e.g. ~/.codex
 * @param {string} pluginName
 * @param {string} version
 * @param {object} [deps]
 * @param {typeof fs} [deps.fs]
 * @returns {string|null} absolute path or null
 */
export function findVersionedCacheDir(codexHome, pluginName, version, deps = {}) {
  const _fs = deps.fs || fs;
  const candidate = path.join(codexHome, "plugins", "cache", pluginName, pluginName, version);
  try {
    const stat = _fs.statSync(candidate);
    if (stat.isDirectory()) return candidate;
  } catch {
    // not found
  }
  return null;
}

/**
 * Resolve the active installed cache path for a plugin.
 *
 * Strategy:
 *   1. Run `codex mcp get <pluginName>`, parse cwd → versioned cache path
 *   2. If mcp get fails, run `codex plugin list`, parse version, then
 *      find on filesystem under $CODEX_HOME
 *   3. Return { activePath, version, toolTimeoutSec } — any field may be null
 *
 * @param {string} pluginName
 * @param {object} [deps]
 * @param {function} [deps.execFn] - (cmd) => string (throws on failure)
 * @param {typeof fs} [deps.fs]
 * @param {string} [deps.homeDir] - override $HOME
 * @param {string} [deps.codexHome] - override CODEX_HOME (default: $CODEX_HOME or $HOME/.codex)
 * @returns {{ activePath: string|null, version: string|null, toolTimeoutSec: number|null }}
 */
export function resolveActiveCache(pluginName, deps = {}) {
  const execFn = deps.execFn;
  const _fs = deps.fs || fs;
  const home = deps.homeDir || process.env.HOME || "";
  const codexHome = deps.codexHome || process.env.CODEX_HOME || path.join(home, ".codex");

  // Strategy 1: codex mcp get
  if (execFn) {
    try {
      const mcpOut = execFn(`codex mcp get ${pluginName}`);
      const parsed = parseMcpGetOutput(mcpOut, pluginName);
      if (parsed.activePath && parsed.version) {
        return parsed;
      }
    } catch {
      // mcp get failed — fall through
    }

    // Strategy 2: codex plugin list → version → filesystem
    try {
      const listOut = execFn("codex plugin list");
      const version = parsePluginListVersion(listOut, pluginName);
      if (version) {
        const cachePath = findVersionedCacheDir(codexHome, pluginName, version, { fs: _fs });
        return {
          activePath: cachePath,
          version,
          toolTimeoutSec: null,
        };
      }
    } catch {
      // plugin list failed — fall through
    }
  }

  // Strategy 3: filesystem scan for any version under the cache root
  const cacheRoot = path.join(codexHome, "plugins", "cache", pluginName, pluginName);
  try {
    const entries = _fs.readdirSync(cacheRoot, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (versions.length > 0) {
      const latest = versions[versions.length - 1];
      return {
        activePath: path.join(cacheRoot, latest),
        version: latest,
        toolTimeoutSec: null,
      };
    }
  } catch {
    // cache root doesn't exist
  }

  return { activePath: null, version: null, toolTimeoutSec: null };
}

/**
 * Compare source directory against cache directory.
 * @param {string} sourceDir
 * @param {string} cacheDir
 * @param {object} [deps]
 * @param {function} [deps.hashDirFn] - (dir) => { relPath: sha256 }
 * @returns {{ diffs: number, sourceFileCount: number, cacheFileCount: number, diffDetails: string[] }}
 */
export function compareSourceCache(sourceDir, cacheDir, deps = {}) {
  // Default hashDirFn uses the same logic as verify-install.mjs
  const hashDirFn = deps.hashDirFn || defaultHashDir;
  const sourceHashes = hashDirFn(sourceDir);
  const cacheHashes = hashDirFn(cacheDir);
  const diffDetails = [];
  let diffs = 0;

  for (const [file, hash] of Object.entries(sourceHashes)) {
    if (cacheHashes[file] !== hash) {
      diffDetails.push(`diff: ${file}`);
      diffs++;
    }
  }
  for (const file of Object.keys(cacheHashes)) {
    if (!sourceHashes[file]) {
      diffDetails.push(`extra-in-cache: ${file}`);
      diffs++;
    }
  }

  return {
    diffs,
    sourceFileCount: Object.keys(sourceHashes).length,
    cacheFileCount: Object.keys(cacheHashes).length,
    diffDetails,
  };
}

import crypto from "node:crypto";

function defaultHashDir(dirPath) {
  const hashes = {};
  function walk(current, prefix = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(abs, rel);
      } else if (entry.isFile()) {
        const content = fs.readFileSync(abs);
        hashes[rel] = crypto.createHash("sha256").update(content).digest("hex");
      }
    }
  }
  walk(dirPath);
  return hashes;
}
