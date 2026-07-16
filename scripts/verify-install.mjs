#!/usr/bin/env node

/**
 * Verify & Install — single repo-owned entrypoint for source verification
 * and plugin install verification.
 *
 * Usage:
 *   node scripts/verify-install.mjs              # Full verify + install
 *   node scripts/verify-install.mjs --source-only # Source verification only (no codex)
 *   node scripts/verify-install.mjs --ci          # CI mode (source-only + auto cachebuster)
 *
 * Steps (sequential, fail-fast):
 *   1. npm test
 *   2. Syntax check (all .mjs files)
 *   3. Manifest validation (plugin.json)
 *   4. Schema validation (.mcp.json)
 *   5. Diff check (uncommitted changes warning)
 *   6. Cachebuster update (--ci mode: auto; else: prompt)
 *   7. codex plugin add (skip in --source-only/--ci)
 *   8. Active source/version/tool_timeout verification
 *   9. Recursive source-cache equality
 *  10. Installed-cache tests (skip in --source-only/--ci)
 *  11. Print reload guidance (only after all steps pass)
 *
 * Does NOT depend on untracked .agents/plugin-creator files for core validation.
 */

import { execSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveActiveCache,
  compareSourceCache,
} from "../plugins/cc-plugin-codex/scripts/lib/install-cache.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const pluginDir = path.join(repoRoot, "plugins", "cc-plugin-codex");
const pluginJsonPath = path.join(pluginDir, ".codex-plugin", "plugin.json");
const mcpJsonPath = path.join(pluginDir, ".mcp.json");

const args = process.argv.slice(2);
const SOURCE_ONLY = args.includes("--source-only") || args.includes("--ci");
const CI_MODE = args.includes("--ci");

// ─── Helpers ─────────────────────────────────────────────────────────────

function step(n, name) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Step ${n}: ${name}`);
  console.log("─".repeat(60));
}

function pass(msg) {
  console.log(`  ✅ ${msg}`);
}

function fail(msg) {
  console.error(`\n  ❌ FAIL: ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.log(`  ⚠️  ${msg}`);
}

/**
 * Run a shell command. Returns trimmed stdout.
 * Throws on failure unless opts.allowFail is true.
 * NOTE: Does NOT call fail() — callers decide how to handle errors.
 */
function run(cmd, opts = {}) {
  try {
    const result = execSync(cmd, {
      cwd: opts.cwd || repoRoot,
      encoding: "utf8",
      timeout: opts.timeout || 120000,
      stdio: opts.stdio || "pipe",
      env: { ...process.env, ...opts.env }
    });
    return (result || "").trim();
  } catch (err) {
    if (opts.allowFail) return (err.stdout || "").trim();
    throw new Error(`Command failed: ${cmd}\n${err.stderr || err.message}`);
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(`Cannot read ${filePath}: ${err.message}`);
    return {}; // unreachable — fail() exits
  }
}

function hashFile(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

function hashDir(dirPath) {
  const hashes = {};
  function walk(current, prefix = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(abs, rel);
      } else if (entry.isFile()) {
        hashes[rel] = hashFile(abs);
      }
    }
  }
  walk(dirPath);
  return hashes;
}

// ─── Step 1: Tests ──────────────────────────────────────────────────────

step(1, "Run tests");
run("npm test", { stdio: "inherit", timeout: 120000 });
pass("All tests passed");

// ─── Step 2: Syntax check ───────────────────────────────────────────────

step(2, "Syntax check all .mjs files");
const mjsFiles = [];
function findMjs(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      findMjs(full);
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      mjsFiles.push(full);
    }
  }
}
findMjs(pluginDir);

// Also check repo-root scripts
if (fs.existsSync(path.join(repoRoot, "scripts"))) {
  findMjs(path.join(repoRoot, "scripts"));
}

let syntaxErrors = 0;
for (const file of mjsFiles) {
  try {
    execSync(`node -c "${file}"`, { encoding: "utf8", timeout: 10000, stdio: "pipe" });
  } catch (err) {
    console.error(`  Syntax error in ${path.relative(repoRoot, file)}: ${err.stderr?.trim()}`);
    syntaxErrors++;
  }
}
if (syntaxErrors > 0) fail(`${syntaxErrors} file(s) have syntax errors`);
pass(`${mjsFiles.length} .mjs files checked`);

// ─── Step 3: Manifest validation ────────────────────────────────────────

step(3, "Validate plugin manifest (plugin.json)");
const pluginJson = readJson(pluginJsonPath);

const requiredFields = ["name", "version", "description"];
for (const field of requiredFields) {
  if (!pluginJson[field]) fail(`plugin.json missing required field: ${field}`);
}

// Version format check: X.Y.Z+codex.TIMESTAMP
const versionMatch = pluginJson.version.match(/^(\d+\.\d+\.\d+)\+codex\.(\d{14,})$/);
if (!versionMatch) {
  fail(`Invalid version format: "${pluginJson.version}". Expected: X.Y.Z+codex.TIMESTAMP`);
}
const baseVersion = versionMatch[1];
const cachebuster = versionMatch[2];
pass(`Version: ${pluginJson.version}`);

// Check name matches directory
if (pluginJson.name !== "cc-plugin-codex") {
  fail(`plugin.json name "${pluginJson.name}" does not match expected "cc-plugin-codex"`);
}
pass(`Name: ${pluginJson.name}`);

// Check required plugin fields
if (!pluginJson.skills) fail("plugin.json missing skills field");
if (!pluginJson.mcpServers) fail("plugin.json missing mcpServers field");
pass("All required manifest fields present");

// ─── Step 4: Schema validation (.mcp.json) ──────────────────────────────

step(4, "Validate MCP config (.mcp.json)");
const mcpJson = readJson(mcpJsonPath);

if (!mcpJson.mcpServers) fail(".mcp.json missing mcpServers field");
const server = mcpJson.mcpServers["cc-plugin-codex"];
if (!server) fail('.mcp.json missing cc-plugin-codex server entry');

if (server.command !== "node") fail(`Expected command "node", got "${server.command}"`);
if (!server.args?.includes("./scripts/cc-companion.mjs")) {
  fail("Expected args to include ./scripts/cc-companion.mjs");
}
if (server.tool_timeout_sec !== 604800) {
  fail(`Expected tool_timeout_sec 604800, got ${server.tool_timeout_sec}`);
}
pass("MCP config valid: command=node, tool_timeout_sec=604800");

// ─── Step 5: Diff check ─────────────────────────────────────────────────

step(5, "Check for uncommitted changes");
const gitStatus = run("git status --porcelain", { allowFail: true });
if (gitStatus) {
  warn("Uncommitted changes detected (informational):");
  const lines = gitStatus.split("\n").slice(0, 10);
  for (const line of lines) console.log(`    ${line}`);
  if (gitStatus.split("\n").length > 10) console.log("    ...");
} else {
  pass("Working tree clean");
}

// ─── Step 6: Cachebuster update ─────────────────────────────────────────

step(6, "Update cachebuster");
const now = new Date();
const newCachebuster = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
const newVersion = `${baseVersion}+codex.${newCachebuster}`;

if (CI_MODE) {
  // Auto-update in CI mode
  pluginJson.version = newVersion;
  fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + "\n");
  pass(`Cachebuster updated to ${newVersion} (CI auto-mode)`);
} else if (SOURCE_ONLY) {
  // Source-only mode: just report current
  pass(`Current cachebuster: ${pluginJson.version} (source-only mode, not updating)`);
} else {
  // Full mode: update cachebuster
  pluginJson.version = newVersion;
  fs.writeFileSync(pluginJsonPath, JSON.stringify(pluginJson, null, 2) + "\n");
  pass(`Cachebuster updated to ${newVersion}`);
}

// ─── Step 7: Plugin install (skip in source-only mode) ──────────────────

if (!SOURCE_ONLY) {
  step(7, "Install plugin via codex");
  try {
    run("codex plugin add cc-plugin-codex@cc-plugin-codex", { timeout: 30000 });
    pass("Plugin installed via codex");
  } catch (err) {
    fail(`Plugin install failed:\n${err.message}`);
  }
} else {
  step(7, "Plugin install (skipped in source-only mode)");
  pass("Skipped");
}

// ─── Step 8: Active source/version/tool_timeout verification ────────────

step(8, "Verify active source, version, and tool_timeout");

// Re-read plugin.json (cachebuster may have been updated)
const currentPluginJson = readJson(pluginJsonPath);
const currentVersion = currentPluginJson.version;

// Verify server entrypoint is parseable
try {
  execSync(`node -c "${path.join(pluginDir, "scripts", "cc-companion.mjs")}"`, {
    encoding: "utf8", timeout: 10000, stdio: "pipe"
  });
  pass("Server entrypoint syntax OK");
} catch (err) {
  fail(`Server entrypoint syntax error: ${err.stderr?.trim()}`);
}

// Verify version is embedded in server source
const serverSource = fs.readFileSync(path.join(pluginDir, "scripts", "cc-companion.mjs"), "utf8");
const versionInSource = serverSource.match(/SERVER_VERSION\s*=\s*"([^"]+)"/);
if (versionInSource) {
  pass(`Server source version: ${versionInSource[1]}`);
} else {
  warn("Could not extract SERVER_VERSION from source");
}

// Verify watchdog syntax
try {
  execSync(`node -c "${path.join(pluginDir, "scripts", "lib", "watchdog.mjs")}"`, {
    encoding: "utf8", timeout: 10000, stdio: "pipe"
  });
  pass("Watchdog syntax OK");
} catch (err) {
  fail(`Watchdog syntax error: ${err.stderr?.trim()}`);
}

// Verify MCP transport config
const currentMcpJson = readJson(mcpJsonPath);
const currentServer = currentMcpJson.mcpServers?.["cc-plugin-codex"];
if (currentServer?.tool_timeout_sec === 604800) {
  pass(`tool_timeout_sec: ${currentServer.tool_timeout_sec}`);
} else {
  fail(`tool_timeout_sec mismatch: expected 604800, got ${currentServer?.tool_timeout_sec}`);
}

// ─── Step 9: Source self-consistency ────────────────────────────────────

step(9, "Verify source files are self-consistent");

// Check that all referenced files exist
const referencedFiles = [
  "scripts/cc-companion.mjs",
  "scripts/lib/watchdog.mjs",
  "scripts/lib/claude-runner.mjs",
  "scripts/lib/state.mjs",
  "scripts/lib/process.mjs",
  "scripts/lib/git.mjs",
  "scripts/lib/job-log.mjs",
  "scripts/lib/workspace.mjs",
  "scripts/lib/install-cache.mjs",
  ".codex-plugin/plugin.json",
  ".mcp.json"
];

let missingFiles = 0;
for (const file of referencedFiles) {
  const fullPath = path.join(pluginDir, file);
  if (!fs.existsSync(fullPath)) {
    console.error(`  Missing referenced file: ${file}`);
    missingFiles++;
  }
}
if (missingFiles > 0) fail(`${missingFiles} referenced file(s) missing`);
pass(`${referencedFiles.length} referenced files verified`);

// Hash the source directory for cache equality checks
const sourceHashes = hashDir(pluginDir);
const sourceFileCount = Object.keys(sourceHashes).length;
pass(`Source directory: ${sourceFileCount} files hashed`);

// ─── Step 10: Installed-cache tests (skip in source-only mode) ──────────

if (!SOURCE_ONLY) {
  step(10, "Verify installed cache matches source");

  // Resolve the active cache using codex CLI, with filesystem fallback
  const activeCache = resolveActiveCache("cc-plugin-codex", {
    execFn: (cmd) => run(cmd, { timeout: 15000 }),
    fs,
    homeDir: process.env.HOME || "",
  });

  if (!activeCache.activePath) {
    fail(
      "Installed cache not found. Expected: ~/.codex/plugins/cache/cc-plugin-codex/cc-plugin-codex/<version>/\n" +
      "  Run: codex plugin add cc-plugin-codex@cc-plugin-codex"
    );
  }
  pass(`Active cache path: ${activeCache.activePath}`);

  // Verify the cache directory actually contains a plugin manifest
  const cacheManifestPath = path.join(activeCache.activePath, ".codex-plugin", "plugin.json");
  if (!fs.existsSync(cacheManifestPath)) {
    fail(`Cache missing plugin manifest: ${cacheManifestPath}`);
  }

  // Verify version matches source
  if (activeCache.version !== currentVersion) {
    fail(
      `Active cache version mismatch: cache has "${activeCache.version}", source has "${currentVersion}".\n` +
      "  Run: codex plugin add cc-plugin-codex@cc-plugin-codex"
    );
  }
  pass(`Active cache version matches source: ${currentVersion}`);

  // Verify tool_timeout_sec in cache matches source
  const cacheMcpPath = path.join(activeCache.activePath, ".mcp.json");
  if (fs.existsSync(cacheMcpPath)) {
    const cacheMcp = readJson(cacheMcpPath);
    const cacheTimeout = cacheMcp.mcpServers?.["cc-plugin-codex"]?.tool_timeout_sec;
    if (cacheTimeout !== 604800) {
      fail(`Cache tool_timeout_sec mismatch: expected 604800, got ${cacheTimeout}`);
    }
    pass(`Cache tool_timeout_sec: ${cacheTimeout}`);
  } else {
    warn("Cache .mcp.json not found — skipping tool_timeout_sec check");
  }

  // Recursive source-cache equality
  const comparison = compareSourceCache(pluginDir, activeCache.activePath, {
    hashDirFn: hashDir,
  });

  if (comparison.diffs > 0) {
    for (const detail of comparison.diffDetails.slice(0, 10)) {
      console.log(`    ${detail}`);
    }
    if (comparison.diffDetails.length > 10) console.log("    ...");
    fail(
      `Source/cache mismatch: ${comparison.diffs} file(s) differ ` +
      `(source: ${comparison.sourceFileCount}, cache: ${comparison.cacheFileCount}).\n` +
      "  Run: codex plugin add cc-plugin-codex@cc-plugin-codex"
    );
  }
  pass(`Cache matches source (${comparison.cacheFileCount} files, recursive diff empty)`);

  // Run installed-cache tests (npm test against the cache copy)
  try {
    const testDir = path.join(activeCache.activePath, "tests");
    if (fs.existsSync(testDir)) {
      run(`node --test "${testDir}"${path.sep}*.test.mjs`, { timeout: 60000, cwd: activeCache.activePath });
      pass("Installed-cache tests passed");
    } else {
      warn("No tests/ directory in cache — skipping installed-cache tests");
    }
  } catch (err) {
    fail(`Installed-cache tests failed:\n${err.message}`);
  }
} else {
  step(10, "Installed-cache verification (skipped in source-only mode)");
  pass("Skipped — source-only mode does not verify installed cache");
}

// ─── Step 11: Final report ──────────────────────────────────────────────

const verificationType = SOURCE_ONLY ? "SOURCE-ONLY" : "FULLY INSTALLED";

console.log(`\n${"═".repeat(60)}`);
console.log(`  ALL VERIFICATION STEPS PASSED (${verificationType})`);
console.log("═".repeat(60));

console.log(`
  Verification mode: ${verificationType}
  Plugin version:    ${currentVersion}
  Source files:       ${sourceFileCount}
  Tests:              passed
  Syntax:             ${mjsFiles.length} files clean
  Manifest:           valid
  MCP config:         valid (tool_timeout=604800)`);

if (!SOURCE_ONLY) {
  console.log(`  Cache verified:     ${currentVersion} matches source`);
  console.log(`  Installed tests:    passed`);
}

console.log(`
  Next steps:
    1. Open a NEW Codex task (existing tasks use the old cached plugin)
    2. Verify: codex plugin list shows ${currentVersion}
    3. Run /claude:setup to confirm plugin health
`);

process.exit(0);
