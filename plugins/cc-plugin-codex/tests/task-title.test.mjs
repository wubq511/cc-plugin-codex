import test from "node:test";
import assert from "node:assert/strict";

import { deriveTaskTitle } from "../scripts/lib/task-title.mjs";

test("deriveTaskTitle collapses whitespace and newlines to single spaces", () => {
  assert.equal(deriveTaskTitle("  给 dashboard\n\n  做浅色   重构  "), "给 dashboard 做浅色 重构");
});

test("deriveTaskTitle returns empty string for empty or non-string input", () => {
  assert.equal(deriveTaskTitle(""), "");
  assert.equal(deriveTaskTitle("   \n  "), "");
  assert.equal(deriveTaskTitle(null), "");
  assert.equal(deriveTaskTitle(undefined), "");
  assert.equal(deriveTaskTitle(42), "");
});

test("deriveTaskTitle redacts credential patterns from task text", () => {
  assert.equal(
    deriveTaskTitle("用这个 key sk-ant-api03-AbCdEfGhIj 修一下登录"),
    "用这个 key sk-[REDACTED] 修一下登录"
  );
  assert.equal(
    deriveTaskTitle("配置 password=hunter2 然后重试"),
    "配置 password=[REDACTED] 然后重试"
  );
});

test("deriveTaskTitle bounds to 80 code points with an ellipsis", () => {
  const title = deriveTaskTitle("给".repeat(200));
  assert.equal([...title].length, 81);
  assert.ok(title.endsWith("…"));
  assert.ok(!title.includes("redacted tail"), "UI titles must not carry diagnostic truncation markers");
});

test("deriveTaskTitle honors a smaller custom bound", () => {
  assert.equal(deriveTaskTitle("x".repeat(1000), 10), "xxxxxxxxxx…");
  assert.equal(deriveTaskTitle("短任务", 10), "短任务");
});
