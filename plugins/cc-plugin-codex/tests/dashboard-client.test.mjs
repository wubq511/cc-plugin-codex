import test from "node:test";
import assert from "node:assert/strict";

import {
  esc, truncate, actionLabel, formatElapsed, formatClock,
  summarizeToolUse, createTimelineReducer, followReducer, completionNotice,
  faviconHref,
} from "../scripts/lib/dashboard-client.mjs";

// ── Pure helpers ─────────────────────────────────────────────────────────────

test("esc escapes HTML-significant characters", () => {
  assert.equal(esc('<a href="x">&</a>'), '&lt;a href="x"&gt;&amp;&lt;/a&gt;');
  assert.equal(esc(null), "");
});

test("truncate appends ellipsis beyond n chars", () => {
  assert.equal(truncate("abcdef", 3), "abc…");
  assert.equal(truncate("ab", 3), "ab");
});

test("actionLabel strips markdown emphasis/backticks and collapses whitespace", () => {
  assert.equal(actionLabel("**完成报告：** 已有 `outputs/` 文件夹"), "完成报告： 已有 outputs/ 文件夹");
  assert.equal(actionLabel("多\n行\t  空白"), "多 行 空白");
});

test("formatElapsed renders seconds, minutes, hours", () => {
  assert.equal(formatElapsed(42_000), "42 秒");
  assert.equal(formatElapsed(4 * 60_000 + 5_000), "4 分 05 秒");
  assert.equal(formatElapsed(63 * 60_000), "1 小时 3 分");
  assert.equal(formatElapsed(null), "—");
});

test("formatClock renders HH:MM:SS", () => {
  assert.equal(formatClock(new Date(2026, 0, 1, 9, 5, 3)), "09:05:03");
});

// ── summarizeToolUse ─────────────────────────────────────────────────────────

test("summarizeToolUse gives Edit a path and +/- line counts", () => {
  const { verb, summary } = summarizeToolUse("Edit", {
    file_path: "src/a.ts",
    old_string: "one\ntwo",
    new_string: "one\ntwo\nthree",
  });
  assert.equal(verb, "编辑");
  assert.equal(summary, "src/a.ts · +3 −2");
});

test("summarizeToolUse gives Bash only the first command line", () => {
  const { verb, summary } = summarizeToolUse("Bash", { command: "npm test\nnpm run build" });
  assert.equal(verb, "运行");
  assert.equal(summary, "npm test");
});

test("summarizeToolUse handles Read, Grep, and unknown tools", () => {
  assert.deepEqual(summarizeToolUse("Read", { file_path: "x.mjs" }), { verb: "读取", summary: "x.mjs" });
  assert.deepEqual(summarizeToolUse("Grep", { pattern: "foo", path: "src" }), { verb: "搜索", summary: "foo · src" });
  const unknown = summarizeToolUse("CustomTool", { anything: "value" });
  assert.equal(unknown.verb, "使用");
  assert.equal(unknown.summary, "value");
});

// ── Timeline reducer ─────────────────────────────────────────────────────────

const T0 = 1_700_000_000_000;

function assistantText(text) {
  return { type: "assistant", message: { content: [{ type: "text", text }] } };
}
function assistantToolUse(id, name, input) {
  return { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } };
}
function userToolResult(toolUseId, content, isError = false) {
  return { type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] } };
}

test("reducer renders assistant text as a msg card and counts the turn", () => {
  const r = createTimelineReducer();
  const ops = r.ingest(assistantText("我先看一下代码。"), T0);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, "append");
  assert.equal(ops[0].card.kind, "msg");
  assert.deepEqual(r.metrics, { turns: 1, toolCalls: 0 });
  assert.equal(r.lastAction.label, "我先看一下代码。");
});

test("reducer pairs tool_use with its tool_result into one card", () => {
  const r = createTimelineReducer();
  const useOps = r.ingest(assistantToolUse("tu_1", "Bash", { command: "npm test" }), T0);
  assert.equal(useOps[0].card.kind, "tool");
  assert.equal(useOps[0].card.state, "run");
  assert.equal(r.lastAction.label, "正在运行 npm test");

  const resultOps = r.ingest(userToolResult("tu_1", "all passed"), T0 + 8_600);
  assert.equal(resultOps.length, 1, "a paired result emits exactly one update op, no new card");
  assert.equal(resultOps[0].op, "update");
  assert.equal(resultOps[0].patch.state, "ok");
  assert.equal(resultOps[0].patch.output, "all passed");
  assert.equal(resultOps[0].patch.durationMs, 8_600);
  assert.equal(r.cards.length, 1);
  assert.deepEqual(r.metrics, { turns: 1, toolCalls: 1 });
});

test("reducer flags error results for auto-expand rendering", () => {
  const r = createTimelineReducer();
  r.ingest(assistantToolUse("tu_1", "Bash", { command: "npm test" }), T0);
  const ops = r.ingest(userToolResult("tu_1", "1 failed", true), T0 + 1000);
  assert.equal(ops[0].patch.state, "err");
  assert.equal(ops[0].patch.isError, true);
  assert.equal(r.cards[0].state, "err");
});

test("reducer buffers a result that arrives before its tool_use", () => {
  const r = createTimelineReducer();
  const early = r.ingest(userToolResult("tu_1", "late-bound output"), T0);
  assert.equal(early.length, 0, "an unpairable result renders nothing loose");

  const useOps = r.ingest(assistantToolUse("tu_1", "Read", { file_path: "a.ts" }), T0 + 500);
  const update = useOps.find((op) => op.op === "update");
  assert.ok(update, "the buffered result applies when its tool_use arrives");
  assert.equal(update.patch.output, "late-bound output");
  assert.equal(r.cards.length, 1, "still exactly one card");
});

test("reducer drops results without a tool_use_id and unknown events", () => {
  const r = createTimelineReducer();
  assert.equal(r.ingest(userToolResult(undefined, "orphan"), T0).length, 0);
  assert.equal(r.ingest({ type: "rate_limit", retry_ms: 1000 }, T0).length, 0);
  assert.equal(r.ingest(null, T0).length, 0);
  assert.equal(r.cards.length, 0);
});

test("reducer renders system init as a divider and thinking as an indicator", () => {
  const r = createTimelineReducer();
  const div = r.ingest({ type: "system", subtype: "init" }, T0);
  assert.equal(div[0].card.kind, "divider");
  assert.equal(div[0].card.text, "会话开始");

  const think = r.ingest({ type: "assistant", message: { content: [{ type: "thinking", thinking: "…" }] } }, T0);
  assert.equal(think[0].card.kind, "think");
  assert.equal(r.lastAction.label, "正在思考");
});

test("reducer drops thinking_tokens noise but keeps informative system events", () => {
  const r = createTimelineReducer();
  const ops = r.ingest({ type: "system", subtype: "thinking_tokens", estimated_tokens: 7 }, T0);
  assert.equal(ops.length, 0);
  assert.equal(r.cards.length, 0);
  // Informative subtypes still render as dividers.
  const div = r.ingest({ type: "system", subtype: "compact_boundary" }, T0);
  assert.equal(div[0].card.kind, "divider");
});

test("reducer strips markdown noise from the current-action label", () => {
  const r = createTimelineReducer();
  r.ingest(assistantText("**完成报告：** 已创建 `outputs/` 文件夹"), T0);
  assert.equal(r.lastAction.label, "完成报告： 已创建 outputs/ 文件夹");
});

test("reducer captures the final result and completion state", () => {
  const r = createTimelineReducer();
  r.ingest(assistantText("做完了。"), T0);
  const ops = r.ingest({
    type: "result", subtype: "success", is_error: false,
    result: "完成", total_cost_usd: 0.41, duration_ms: 252_000, num_turns: 6,
  }, T0 + 1000);
  assert.equal(ops[0].card.kind, "result");
  assert.equal(ops[0].card.state, "ok");
  assert.deepEqual(r.result, {
    ok: true, text: "完成", costUsd: 0.41, durationMs: 252_000, numTurns: 6,
  });
  assert.equal(r.lastAction.label, "已完成");
});

// ── Follow mode ──────────────────────────────────────────────────────────────

test("followReducer pauses on user scroll-up and resumes on back-to-latest", () => {
  let s = { following: true, pending: 0 };
  s = followReducer(s, { type: "user-scroll", nearBottom: false });
  assert.equal(s.following, false);

  s = followReducer(s, { type: "event-appended" });
  s = followReducer(s, { type: "event-appended" });
  assert.equal(s.pending, 2);

  s = followReducer(s, { type: "back-to-latest" });
  assert.deepEqual(s, { following: true, pending: 0 });
});

test("followReducer user returning to bottom clears pending", () => {
  let s = { following: false, pending: 3 };
  s = followReducer(s, { type: "user-scroll", nearBottom: true });
  assert.deepEqual(s, { following: true, pending: 0 });
});

// ── Completion notice ────────────────────────────────────────────────────────

test("completionNotice maps result state to title prefix and favicon color", () => {
  assert.deepEqual(completionNotice({ ok: true }), {
    titlePrefix: "✅ 完成 · ", faviconColor: "#388a34", ok: true,
  });
  assert.deepEqual(completionNotice({ ok: false }), {
    titlePrefix: "❌ 失败 · ", faviconColor: "#c72e2e", ok: false,
  });
});

// ── Favicon ─────────────────────────────────────────────────────────────────

test("faviconHref embeds the Claude starburst and adds a status dot only with a color", () => {
  const base = faviconHref(null);
  assert.ok(base.startsWith("data:image/svg+xml,"));
  const baseSvg = decodeURIComponent(base.slice("data:image/svg+xml,".length));
  assert.ok(baseSvg.includes("#D97757"), "base icon is the Claude orange starburst");
  assert.ok(!baseSvg.includes("<circle"), "base icon has no status dot");
  const doneSvg = decodeURIComponent(faviconHref("#388a34").slice("data:image/svg+xml,".length));
  assert.ok(doneSvg.includes("<circle"), "completion state overlays a status dot");
  assert.ok(doneSvg.includes("#388a34"));
});
