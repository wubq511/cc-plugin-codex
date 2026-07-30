# BLOCKED — 终端恢复入口与文案中文化

无。

注：calibrate-continuation.mjs 不在白名单内，其用 `/Budget guard supported/i` 检测 cc_setup 输出判断 CLI 预算保护能力。中文化时在 cc_setup 预算保护行保留了 `Budget guard supported` 英文标记（`✅ 预算保护已支持（Budget guard supported，已识别 --max-budget-usd）`），既保持中文优先又兼容校准脚本，无需越界修改。

## 实时 Dashboard (2026-07-29)

### 真实 stream-json 探测未成功——success 路径事件未经真实调用验证

- 任务0 授权最多 $0.25 跑一次真实 `claude --print --input-format text --output-format stream-json --verbose --max-budget-usd 0.25` 探测。本机 claude CLI（2.1.218）`apiKeySource:"none"`（无可用 API key），10 次 `system/api_retry`（error:"unknown"）后流结束，**未产生任何 assistant/tool_use/tool_result/result 事件，实际费用 $0**。
- 捕获到真实的 `system/init` 与 `system/api_retry` 事件结构（存于 `tests/fixtures/stream-json-real-events.ndjson`），作为 system 事件的真实证据。
- `assistant`/`user`/`result` 事件结构改用官方文档（https://code.claude.com/docs/en/headless#stream-responses 及非官方协议分析）schema 手写 fixture（`tests/fixtures/stream-json-success-sample.ndjson`）。**未经真实成功调用验证**。
- 缓解：result 事件字段（result/session_id/total_cost_usd/duration_ms/usage/modelUsage/is_error/subtype）与非 stream JSON 输出一致（官方文档：「最后一行 result 消息含最终文本、cost、session 元数据」），watchdog 复用既有提取逻辑；fake-claude stream 模式按同一 schema 发 NDJSON，单测与 e2e 覆盖。若真实 CLI 的 result 事件字段有偏差（如 result 双编码），需后续真实调用校验。

> 已解决并移除（2026-07-30）：「工作树遗留非白名单改动」随本次提交一并入库；「cc_setup 未加 dashboard URL 行」已被 2026-07-30 面板可达性修复反转——cc_setup 现输出实时面板 URL，hardening 的 `/token/i` 断言收窄为豁免「实时面板」行（见 PROGRESS.md 2026-07-30 条目）。
