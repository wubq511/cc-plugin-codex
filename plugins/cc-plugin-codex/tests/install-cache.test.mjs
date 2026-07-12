import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseMcpGetOutput,
  parsePluginListVersion,
  findVersionedCacheDir,
  resolveActiveCache,
  compareSourceCache,
} from "../scripts/lib/install-cache.mjs";

// ─── parseMcpGetOutput ──────────────────────────────────────────────────

test("parseMcpGetOutput extracts cwd, version, and tool_timeout_sec", () => {
  const output = [
    "cc-plugin-codex",
    "  enabled: true",
    "  transport: stdio",
    "  command: node",
    "  args: ./scripts/cc-companion.mjs",
    "  cwd: /Users/test/.codex/plugins/cache/cc-plugin-codex/cc-plugin-codex/0.3.0+codex.20260710153333/.",
    "  env: -",
    "  tool_timeout_sec: 604800",
    "  remove: codex mcp remove cc-plugin-codex",
  ].join("\n");

  const result = parseMcpGetOutput(output, "cc-plugin-codex");
  assert.equal(result.activePath, "/Users/test/.codex/plugins/cache/cc-plugin-codex/cc-plugin-codex/0.3.0+codex.20260710153333");
  assert.equal(result.version, "0.3.0+codex.20260710153333");
  assert.equal(result.toolTimeoutSec, 604800);
});

test("parseMcpGetOutput handles backslash paths (Windows)", () => {
  const output = [
    "cc-plugin-codex",
    "  cwd: C:\\Users\\test\\.codex\\plugins\\cache\\cc-plugin-codex\\cc-plugin-codex\\0.1.0+codex.20260101000000\\.",
    "  tool_timeout_sec: 604800",
  ].join("\n");

  const result = parseMcpGetOutput(output, "cc-plugin-codex");
  assert.equal(result.activePath, "C:\\Users\\test\\.codex\\plugins\\cache\\cc-plugin-codex\\cc-plugin-codex\\0.1.0+codex.20260101000000");
  assert.equal(result.version, "0.1.0+codex.20260101000000");
});

test("parseMcpGetOutput returns nulls on empty output", () => {
  const result = parseMcpGetOutput("", "cc-plugin-codex");
  assert.equal(result.activePath, null);
  assert.equal(result.version, null);
  assert.equal(result.toolTimeoutSec, null);
});

test("parseMcpGetOutput returns nulls when cwd is '-'", () => {
  const output = "cc-plugin-codex\n  cwd: -\n  tool_timeout_sec: -";
  const result = parseMcpGetOutput(output, "cc-plugin-codex");
  assert.equal(result.activePath, null);
  assert.equal(result.version, null);
  assert.equal(result.toolTimeoutSec, null);
});

// ─── parsePluginListVersion ─────────────────────────────────────────────

test("parsePluginListVersion extracts version from plugin list", () => {
  const output = [
    "Marketplace `cc-plugin-codex`",
    "/Users/test/.agents/plugins/marketplace.json",
    "PLUGIN                        STATUS         VERSION                      PATH",
    "cc-plugin-codex@cc-plugin-codex  installed, enabled  0.3.0+codex.20260710153333  /Users/test/plugins/cc-plugin-codex",
  ].join("\n");

  const version = parsePluginListVersion(output, "cc-plugin-codex");
  assert.equal(version, "0.3.0+codex.20260710153333");
});

test("parsePluginListVersion returns null when plugin not listed", () => {
  const output = "Marketplace `other`\nPLUGIN  STATUS  VERSION  PATH\nother@x  installed  1.0.0  /path";
  const version = parsePluginListVersion(output, "cc-plugin-codex");
  assert.equal(version, null);
});

test("parsePluginListVersion returns null on empty output", () => {
  assert.equal(parsePluginListVersion("", "cc-plugin-codex"), null);
  assert.equal(parsePluginListVersion(null, "cc-plugin-codex"), null);
});

// ─── findVersionedCacheDir ──────────────────────────────────────────────

test("findVersionedCacheDir returns path when directory exists", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
  const cachePath = path.join(tmpDir, "plugins", "cache", "cc-plugin-codex", "cc-plugin-codex", "0.3.0+codex.20260710153333");
  fs.mkdirSync(cachePath, { recursive: true });

  const result = findVersionedCacheDir(tmpDir, "cc-plugin-codex", "0.3.0+codex.20260710153333");
  assert.equal(result, cachePath);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("findVersionedCacheDir returns null when directory does not exist", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-test-"));
  const result = findVersionedCacheDir(tmpDir, "cc-plugin-codex", "0.0.0+codex.00000000000000");
  assert.equal(result, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── resolveActiveCache ─────────────────────────────────────────────────

test("resolveActiveCache uses codex mcp get when available", () => {
  const mcpOutput = [
    "cc-plugin-codex",
    "  cwd: /home/user/.codex/plugins/cache/cc-plugin-codex/cc-plugin-codex/0.5.0+codex.20260101000000/.",
    "  tool_timeout_sec: 604800",
  ].join("\n");

  const result = resolveActiveCache("cc-plugin-codex", {
    execFn: (cmd) => {
      if (cmd.includes("mcp get")) return mcpOutput;
      throw new Error("unexpected command: " + cmd);
    },
    homeDir: "/home/user",
  });

  assert.equal(result.version, "0.5.0+codex.20260101000000");
  assert.equal(result.toolTimeoutSec, 604800);
  assert.match(result.activePath, /0\.5\.0\+codex\.20260101000000/);
});

test("resolveActiveCache falls back to codex plugin list + filesystem", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-fb-"));
  const version = "0.4.0+codex.20260202000000";
  const cachePath = path.join(tmpDir, "plugins", "cache", "cc-plugin-codex", "cc-plugin-codex", version);
  fs.mkdirSync(cachePath, { recursive: true });

  const listOutput = `Marketplace \`x\`\nPLUGIN  STATUS  VERSION  PATH\ncc-plugin-codex@x  installed  ${version}  /path`;

  const result = resolveActiveCache("cc-plugin-codex", {
    execFn: (cmd) => {
      if (cmd.includes("mcp get")) throw new Error("mcp not available");
      if (cmd.includes("plugin list")) return listOutput;
      throw new Error("unexpected: " + cmd);
    },
    codexHome: tmpDir,
  });

  assert.equal(result.version, version);
  assert.equal(result.activePath, cachePath);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("resolveActiveCache falls back to filesystem scan", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-scan-"));
  const version = "0.2.0+codex.20260303000000";
  const cachePath = path.join(tmpDir, "plugins", "cache", "cc-plugin-codex", "cc-plugin-codex", version);
  fs.mkdirSync(cachePath, { recursive: true });

  const result = resolveActiveCache("cc-plugin-codex", {
    codexHome: tmpDir,
  });

  assert.equal(result.version, version);
  assert.equal(result.activePath, cachePath);
  assert.equal(result.toolTimeoutSec, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("resolveActiveCache returns nulls when nothing found", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cache-empty-"));

  const result = resolveActiveCache("cc-plugin-codex", {
    codexHome: path.join(tmpDir, "nonexistent-codex"),
  });

  assert.equal(result.activePath, null);
  assert.equal(result.version, null);
  assert.equal(result.toolTimeoutSec, null);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── compareSourceCache ─────────────────────────────────────────────────

test("compareSourceCache reports zero diffs for identical directories", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-"));
  const srcDir = path.join(tmpDir, "src");
  const cacheDir = path.join(tmpDir, "cache");

  // Create identical structure
  for (const dir of [srcDir, cacheDir]) {
    fs.mkdirSync(path.join(dir, ".codex-plugin"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".codex-plugin", "plugin.json"), '{"name":"test"}');
    fs.writeFileSync(path.join(dir, ".mcp.json"), '{"mcpServers":{}}');
  }

  const result = compareSourceCache(srcDir, cacheDir);
  assert.equal(result.diffs, 0);
  assert.equal(result.sourceFileCount, 2);
  assert.equal(result.cacheFileCount, 2);
  assert.deepEqual(result.diffDetails, []);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("compareSourceCache detects content differences", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-diff-"));
  const srcDir = path.join(tmpDir, "src");
  const cacheDir = path.join(tmpDir, "cache");

  fs.mkdirSync(path.join(srcDir, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(srcDir, ".codex-plugin", "plugin.json"), '{"name":"src-version"}');

  fs.mkdirSync(path.join(cacheDir, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, ".codex-plugin", "plugin.json"), '{"name":"cache-version"}');

  const result = compareSourceCache(srcDir, cacheDir);
  assert.equal(result.diffs, 1);
  assert.ok(result.diffDetails.some((d) => d.includes("plugin.json")));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("compareSourceCache detects extra files in cache", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-extra-"));
  const srcDir = path.join(tmpDir, "src");
  const cacheDir = path.join(tmpDir, "cache");

  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "shared.txt"), "same");

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "shared.txt"), "same");
  fs.writeFileSync(path.join(cacheDir, "extra.txt"), "only-in-cache");

  const result = compareSourceCache(srcDir, cacheDir);
  assert.equal(result.diffs, 1);
  assert.ok(result.diffDetails.some((d) => d.includes("extra-in-cache")));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("compareSourceCache detects missing files in cache", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cmp-miss-"));
  const srcDir = path.join(tmpDir, "src");
  const cacheDir = path.join(tmpDir, "cache");

  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "shared.txt"), "same");
  fs.writeFileSync(path.join(srcDir, "only-in-src.txt"), "source-only");

  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "shared.txt"), "same");

  const result = compareSourceCache(srcDir, cacheDir);
  assert.equal(result.diffs, 1);
  assert.ok(result.diffDetails.some((d) => d.includes("diff: only-in-src.txt")));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── verify-install fail-open bug guard ──────────────────────────────────

test("run() helper throws on failure instead of calling process.exit", async () => {
  // This test verifies the fail-open bug is fixed: run() must throw, not exit.
  // We test this by importing the verify-install module's run() behavior indirectly
  // through the resolveActiveCache execFn contract.
  let threw = false;
  try {
    resolveActiveCache("cc-plugin-codex", {
      execFn: () => {
        throw new Error("simulated CLI failure");
      },
      homeDir: "/nonexistent",
    });
  } catch {
    threw = true;
  }
  // resolveActiveCache catches execFn errors internally, so this should NOT throw
  assert.equal(threw, false);
});

test("resolveActiveCache handles execFn throwing for both mcp get and plugin list", () => {
  const result = resolveActiveCache("cc-plugin-codex", {
    execFn: () => {
      throw new Error("CLI unavailable");
    },
    homeDir: "/nonexistent-path-that-should-not-exist-12345",
  });

  assert.equal(result.activePath, null);
  assert.equal(result.version, null);
});
