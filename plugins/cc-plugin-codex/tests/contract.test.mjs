import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");

test("MCP transport uses a seven-day ceiling as an orphan-safety boundary, not a task-duration estimate", () => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8"));
  const server = config.mcpServers["cc-plugin-codex"];
  assert.equal(server.command, "node");
  assert.deepEqual(server.args, ["./scripts/cc-companion.mjs"]);
  assert.equal(server.cwd, ".");
  assert.equal(server.tool_timeout_sec, 604800);
});

test("delegate skill rejects background=true and keeps tasks pending", () => {
  const skill = fs.readFileSync(path.join(pluginRoot, "skills", "delegate", "SKILL.md"), "utf8");
  assert.match(skill, /DEPRECATED AND REJECTED/);
  assert.match(skill, /Do not run outer `sleep` commands or repeatedly call `cc_check`/);
  assert.match(skill, /remain silent while it is pending/);
  assert.match(skill, /Do not manually start `cc-companion\.mjs`, wrap it in a shell\/PTY/);
  assert.match(skill, /never emulate delegation with a polling fallback/);
  assert.doesNotMatch(skill, /For long-running tasks, use `background=true`/);
  assert.match(skill, /stdin.*never argv/);
});

test("MCP guidance forbids periodic commentary and manual polling fallbacks", () => {
  const server = fs.readFileSync(path.join(pluginRoot, "scripts", "cc-companion.mjs"), "utf8");
  assert.match(server, /do not manually launch the MCP server, poll, or emit periodic 'still running' commentary/);
  assert.match(server, /Do not emulate it through shell\/PTY, poll it, or emit periodic waiting commentary/);
});

test("every stateful skill supplies the required absolute workspace cwd", () => {
  for (const skillName of ["delegate", "status", "cancel", "review", "setup"]) {
    const skill = fs.readFileSync(path.join(pluginRoot, "skills", skillName, "SKILL.md"), "utf8");
    assert.match(skill, /cwd/, `${skillName} must mention cwd`);
    assert.match(skill, /absolute/, `${skillName} must require an absolute path`);
    assert.doesNotMatch(skill, /no (?:parameters|arguments) needed/i);
  }
});

test("delegate skill does not instruct calling cc_list_models before delegation", () => {
  const skill = fs.readFileSync(path.join(pluginRoot, "skills", "delegate", "SKILL.md"), "utf8");
  // The skill should not say "call cc_list_models" as an instruction (positive)
  // It may say "Do not call cc_list_models" (negative guidance is fine)
  assert.doesNotMatch(skill, /(?:^|\n)\s*\d*\.*\s*Call `cc_list_models`/);
  assert.doesNotMatch(skill, /先调用.*cc_list_models/);
});

test("delegate skill describes inherited configuration as the default, not a model catalogue", () => {
  const skill = fs.readFileSync(path.join(pluginRoot, "skills", "delegate", "SKILL.md"), "utf8");
  assert.match(skill, /inherited/i);
  assert.match(skill, /Provider/i);
  assert.doesNotMatch(skill, /fable.*opus.*sonnet.*haiku/);
  assert.doesNotMatch(skill, /Simple bug fix.*haiku/);
});

test("delegate tool schema uses free-form model without enum", () => {
  const server = fs.readFileSync(path.join(pluginRoot, "scripts", "cc-companion.mjs"), "utf8");
  // The model field should not have an enum restriction
  assert.doesNotMatch(server, /enum.*fable.*opus.*sonnet.*haiku/);
  // The model description should mention free-form or inherited
  assert.match(server, /free-form|inherited|does not validate/i);
});

test("cc_list_models tool description is provider-agnostic", () => {
  const server = fs.readFileSync(path.join(pluginRoot, "scripts", "cc-companion.mjs"), "utf8");
  assert.match(server, /provider-agnostic|does not enumerate|does not maintain/i);
  assert.doesNotMatch(server, /List available Claude models with recommended effort levels/);
});

test("companion does not use observedModel in new job creation", () => {
  const server = fs.readFileSync(path.join(pluginRoot, "scripts", "cc-companion.mjs"), "utf8");
  // New jobs should use requestMode and modelEvidence, not observedModel
  assert.doesNotMatch(server, /observedModel:\s*null/);
  assert.match(server, /requestMode/);
  assert.match(server, /modelEvidence/);
});

test("watchdog does not extract first modelUsage key as observedModel", () => {
  const watchdog = fs.readFileSync(path.join(pluginRoot, "scripts", "lib", "watchdog.mjs"), "utf8");
  assert.doesNotMatch(watchdog, /observedModel/);
  assert.doesNotMatch(watchdog, /Object\.keys\(parsed\.modelUsage\)\[0\]/);
  assert.match(watchdog, /usageModelKeys/);
  assert.match(watchdog, /extractUsageModelKeys/);
});
