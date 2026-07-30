# BLOCKED — 终端恢复入口与文案中文化

无。

注：calibrate-continuation.mjs 不在白名单内，其用 `/Budget guard supported/i` 检测 cc_setup 输出判断 CLI 预算保护能力。中文化时在 cc_setup 预算保护行保留了 `Budget guard supported` 英文标记（`✅ 预算保护已支持（Budget guard supported，已识别 --max-budget-usd）`），既保持中文优先又兼容校准脚本，无需越界修改。

> 已解决并移除（2026-07-30）：「工作树遗留非白名单改动」随 dashboard 提交一并入库；「cc_setup 未加 dashboard URL 行」已被面板可达性修复反转；「真实 stream-json 探测未成功」已在 2026-07-30 用真实成功调用补验（详见 PROGRESS.md 对应条目）。
