# PROGRESS — Compact Auto-Compact & Session Resume Upgrade

## Kickoff Receipt (2026-07-29)
- Baseline: 331 tests/0 skipped, verify:source green, worktree clean.
- Spec: docs/superpowers/specs/compact-auto-compact-and-session-resume.md (adversarial-reviewed).
- Key decisions: inline --settings JSON (file-or-json, zero writes), centralized synchronous finalizeJob critical section + terminal cache, cancelling status, crypto.randomUUID pre-alloc, taskScopeId as sole inheritance key.
- Task order: 1(cancel fix) → 2(autoCompact+taskScopeId) → 3(UUID+cc_compact+boundary) → 4(schema v8+docs+skills) → 5(verify).

## Task 0 — DONE
- [x] npm test 331 pass / 0 skipped
- [x] npm run verify:source green
- [x] Read companion/watchdog/state/routing/route-status/model-evidence/skills/tests
- [x] Verified CLI flags: --session-id <uuid>, --resume, --settings <file-or-json>, /compact
- [x] Wrote spec + adversarial review

## Task 1 — DONE: Cancellation fix
- [x] Red tests: cancelling status, async cc_cancel, race, lease, shutdown
- [x] Centralized synchronous finalizeJob critical section + finalizingJobs terminal cache
- [x] cc_cancel async confirm: cancelling → signal → await completionPromise → return
- [x] handleDelegate result path: try/finally with completionResolve
- [x] gracefulShutdown: mark cancelling → signal → await drain → release lease → finalize
- [x] Fixed test design: removed FAKE_CLAUDE_MODE env override (was making ALL delegations hang); now uses stdin mode via task text
- [x] hang-slow mode added to fake-claude.mjs for observable cancelling status
- [x] All 337 tests pass, 0 skipped, verify:source green

## Task 2 — DONE: autoCompact + taskScopeId
- [x] Red tests: validation (illegal fields, >90%, 256K/250K reject, 300K→333334, 230K→255556)
- [x] Red tests: inline --settings (two env keys only, parent env unchanged, HOME settings untouched)
- [x] Red tests: three scope inheritance/override/clear, taskScopeId isolation
- [x] Implement autocompact.mjs: validateAutoCompact, computeEffectiveWindow, buildInlineSettings, resolveScope, generateTaskScopeId, buildAutoCompactAudit
- [x] Implement inline --settings JSON injection in handleDelegate
- [x] Implement scope resolution + taskScopeId generation/inheritance (this-call > session > task > none)
- [x] watchdog.mjs accepts inlineSettings + sessionId params
- [x] 379 tests pass, 0 skipped

## Task 3 — DONE: UUID + cc_compact + boundary
- [x] Red tests: UUID pre-alloc before spawn, resume has no --session-id, cancel preserves IDs
- [x] Red tests: cc_compact rejects active/cancelling, boundary true/false, observedBoundary null if not observed
- [x] claude-runner.mjs passes sessionId to watchdog config
- [x] handleDelegate generates claudeSessionUuid, persists before spawn, passes to runClaude
- [x] Implement cc_compact tool (8th tool) — handleCompact with session locate/reject/compact/boundary
- [x] Implement compact-boundary.mjs (path-contained transcript reader, symlink escape rejection)
- [x] Auto-compact deviation recording (observedBoundary, compactTrigger) in handleDelegate success path
- [x] 396 tests pass, 0 skipped (17 new tests in compact-session.test.mjs)

## Task 4 — DONE: schema v8 + README + skills + cache
- [x] State schema v8: STATE_VERSION=8, v7→v8 migration (additive: claudeSessionUuid, autoCompact, compactResult, cancelling)
- [x] README: document cc_compact, autoCompact, --session-id, --resume, cancelling status
- [x] AGENTS.md: architecture + key decisions updated (8 tools, cancelling state machine, autoCompact, cc_compact)
- [x] Skills: delegate skill (autoCompact/taskScopeId) updated; compact skill created
- [x] cc_compact registered in HANDLERS and TOOLS (8 tools total)
- [x] Install cache: cachebuster updated to 0.3.0+codex.20260729051324

## Task 5 — DONE: final verification (R1)
- [x] npm test: 396 pass / 0 skipped / 0 fail
- [x] npm run verify:source: green
- [x] python3 validate_plugin.py: passed
- [x] npm run verify: FULLY INSTALLED green

## R2 — Fix round (user review rejected R1)

### P0-1 FIXED: compact-boundary parser used self-invented structure
- Real transcript: `{type:"system", subtype:"compact_boundary", compactMetadata:{preTokens, trigger}}`
- Old parser tested `{type:"compact_boundary", preTokens, compactTrigger}` (never matches real transcripts)
- Fix: parseTranscriptForBoundary now detects `type:"system" + subtype:"compact_boundary"` and extracts from `compactMetadata.preTokens`/`compactMetadata.trigger`. Legacy markers kept defensively.
- Tests updated to real structure; red→green confirmed.

### P0-2 FIXED: cc_compact ignored claudeSessionUuid for cancelled new sessions
- Cancelled new jobs have claudeSessionUuid (pre-allocated) but null claudeSessionId.
- handleCompact only read job.claudeSessionId → "No stopped session" for cancelled jobs.
- Fix: handleCompact falls back to claudeSessionId || claudeSessionUuid (both for job lookup and latest-stopped-job search).
- Red test: cancel new job → cc_compact(job) locates session via UUID. Green confirmed.

### P1-1 FIXED: task inheritance/clear contract unfulfilled
- Schema required contextWindowTokens+targetTokens (blocked taskScopeId-only inheritance) and type:"object" (blocked autoCompact:null).
- taskScopeId:null generated a new ID instead of clearing (validateAutoCompact normalized undefined→null).
- resolveScope never called in production code.
- Fix: schema type:["object","null"], removed required; validateAutoCompact preserves undefined/null/string distinction and supports inheritanceMode; cc-companion uses resolveScope for session-scope replay; taskScopeId:undefined generates, null clears, string inherits.
- Red tests: taskScopeId:null clears (not generate), taskScopeId:undefined generates. Green confirmed.

### P1-2 FIXED: cancellation race not sealed
- finalizingJobs.set() never called — Map always empty, lock never acquired.
- Success/failure paths called updateJob directly, bypassing finalizeJob.
- Fix: finalizeJob now writes Map (caches result); success/failure paths route through finalizeJob; finally block clears Map entry. First writer wins; cancelling always takes priority.
- BLOCKED.md: quick_validate.py exists in cc-profile-switch profiles — both skills pass. Removed false blocker.

## Task 5 (R2) — DONE: final verification
- [x] npm test: 399 pass / 0 skipped / 0 fail
- [x] npm run verify:source: green
- [x] python3 validate_plugin.py: passed
- [x] delegate/compact quick_validate: both pass (quick_validate.py from cc-profile-switch)
- [x] npm run verify: FULLY INSTALLED green (cache 0.3.0+codex.20260729054830 matches source)
- [x] MCP=8 tools, tests≥331 (399), skipped=0
- [x] Zero-drift: git diff .claude/ empty, parent env no compact keys
- [x] BLOCKED.md: 无

## R3 — Independent completion audit and repair

R2's 399 green tests did not prove the complete contract. The independent
audit found and repaired these additional gaps:

- [x] Manual compact now snapshots transcript device/inode/size before
  invocation and only accepts a canonical boundary appended after that cursor.
  Historical boundaries and `isCompactSummary` no longer produce false success.
- [x] Auto-compact observation on resumed sessions uses the same pre-run cursor,
  so an older boundary is not attributed to the current delegation.
- [x] Explicit `resumeSession` is matched against all active local job session
  identifiers and cannot bypass the active/cancelling guard.
- [x] `cc_compact` replays stored session/task inline settings and never replays
  delegation-only settings.
- [x] New/resumed canonical `claudeSessionId` is persisted before spawn; the
  cancelled-new-session workflow is now genuinely cancel → compact → same-ID
  resume.
- [x] Task IDs are UUIDs. Unknown/cleared task inheritance fails before spawn.
  Session/task clears persist tombstones; policy ordering uses immutable
  creation time so later compactResult updates cannot resurrect older policy.
- [x] Cancellation during post-result evidence collection returns cancelled
  consistently in state, `cc_cancel`, and the pending `cc_delegate` response.
  Cancel finalization preserves cancelled route/error semantics.
- [x] A controller is registered before pre-spawn transcript scanning. Cancel
  requests in that window settle as cancelled without spawning Claude; spawn
  failures no longer leave a persisted running job.
- [x] Unsafe-range token integers are rejected. Compact evidence collection
  fails closed when the pre-invocation cursor scan was uncertain, and
  `compactResult.reason` is persisted alongside the response.
- [x] Canonical spec, README, AGENTS.md, delegate skill, and compact skill
  updated before final verification.
- [x] Final full test/source/plugin/skill/install verification and zero-drift
  audit.

### R3 final verification

- `npm test`: 416 pass / 0 skipped / 0 fail.
- `npm run verify:source`: green; 416 tests, 32 `.mjs` files clean, 40 source
  files hashed, manifest and MCP config valid.
- Plugin validator: passed.
- Delegate and compact `quick_validate.py`: both passed.
- Real local transcript dark test: canonical boundary parsed as
  `preTokens=168390`, `trigger=auto`, `warning=null`.
- `npm run verify`: FULLY INSTALLED green; source/cache recursive diff empty,
  installed-cache tests passed, version
  `0.3.0+codex.20260729063834`.
- Installed MCP black-box `tools/list`: 8 tools including `cc_compact`.
- Zero drift: user `~/.claude/settings.json` digest and mtime unchanged;
  both permanent compact keys absent; parent compact env keys absent; project
  `.claude/` has no git diff; `scripts/verify-install.mjs` and
  `.agents/plugins/marketplace.json` untouched.
- Final standards/spec review: pass. No remaining actionable finding.

## R4 — Knowledge closeout and release handoff

- [x] Reconciled `AGENTS.md`, `CLAUDE.md`, `PRD.md`, `README.md`, the canonical
  compact spec, and the delegate/setup/compact skills against the schema-v8
  runtime and eight-tool MCP surface.
- [x] Removed stale current-state claims for seven tools, schema v7, five
  skills, immediate cancellation, and missing compact/session policy behavior.
  The compact spec retains its seven-tool/schema-v7 sentence only as the
  explicitly labelled pre-upgrade baseline.
- [x] Rechecked remote divergence before publication: local `main` and
  `origin/main` were even before the closeout commit.
- [x] Refreshed cachebuster and reinstalled the plugin. Final version:
  `0.3.0+codex.20260729071934`.
- [x] Final local gates: 416 pass / 0 skipped / 0 fail; source verification,
  plugin validator, delegate/setup/compact skill validation, full installed
  verification, and recursive source/cache comparison all green.
- [x] Published implementation commit `41659ff`. CI #12 passed Linux/macOS but
  exposed Windows-only failures: filesystem paths passed directly to ESM
  `import()`, a running-state/cancel-handle publication race, and a POSIX-only
  SIGTERM assumption in a graceful-shutdown test.
- [x] Replaced dynamic test imports with a static module import, registered the
  cancel handle before persisting `running`, used stdin EOF for the Windows
  graceful-shutdown path, and made `cc_setup` report the exported schema-v8
  constant instead of stale hard-coded v7 text.
- [x] Published CI repair commit `c2babfd`. CI #13 passed five jobs; Windows
  Node 24 reached 415/416 and exposed one remaining test-only timing dependency:
  the cancelling-state guard test polled a 20ms transient status.
- [x] Made the guard test deterministic by letting the server finish startup
  reconciliation, then persisting a valid `cancelling` record and directly
  verifying that `cc_compact` rejects it. Dedicated cancellation E2E tests
  continue to cover the real running→cancelling→cancelled lifecycle.
- [x] Published deterministic-test follow-up `f3b778d`. CI #14 completed green:
  Ubuntu, macOS, and Windows on Node 22/24 all passed (six of six jobs).

## Continuation Planner — Kickoff Receipt (2026-07-29)

- Baseline reconfirmed: `npm test` 416 pass / 0 fail / 0 skipped;
  `npm run verify:source` green (32 files clean); `git status --short` only
  untracked `BLOCKED.md`. 8 tools, schema v8, runner/watchdog already support
  internal `maxBudgetUsd`.
- Goal: let Codex pick Resume / Compact+Resume / Fresh+handoff with evidence,
  cutting repeat exploration and context cost.
- Order: 0(baseline) → 1(AGENTS.md protocol + red tests) → 2a(planner module)
  → 2b(watchdog usage extraction + runner passthrough) → 2c(cc-companion:
  9th tool + maxBudgetUsd + continuationPlan + budget guard + evidence/plan
  wiring) → 3(docs/skills + zero-cost verify).
- Max risk: budget-guard fail-closed must not regress existing delegate/compact
  paths when `maxBudgetUsd` is omitted; in-memory telemetry must never leak into
  state/artifact/log; compact lifecycle ordering must resist replay.

## Task 1 — DONE: AGENTS.md protocol + red tests

- [x] Updated AGENTS.md: architecture (9 tools, continuation-planner.mjs),
      key decisions (three-way choice, decision priority, evidence layers,
      budget guard).
- [x] Red tests written: continuation-planner.test.mjs (53 tests covering
      decision matrix, unknown-value fail-closed, TTL/cap, plan lifecycle,
      compact two-phase ordering) and continuation-mcp.test.mjs (18 tests
      covering tools/list=9, plan consumption, replay rejection, budget
      guard fail-closed/passthrough, compact lifecycle).
- [x] All red tests confirmed failing before implementation.

## Task 2a — DONE: continuation-planner.mjs

- [x] `computePressure`, `classifyEvidenceState` pure functions.
- [x] `createPlanner` factory with in-memory plans/evidence maps.
- [x] `planContinuation` decision matrix: explicit fresh/same_session/auto,
      drift detection, session pollution, pressure threshold (0.75),
      warm/cold cache, correction count, relationship/contextValue.
- [x] `consumeDelegatePlan` (Resume/Fresh single-use, Compact+Resume after
      compacted), `startCompact`/`completeCompact` lifecycle.
- [x] Plan TTL (15 min), capacity cap (256), binding enforcement
      (cwd/model/write/parentSession).
- [x] Bounded handoff template, compact focus, resume guidance.
- [x] 53 planner unit tests pass.

## Task 2b — DONE: watchdog usage extraction + runner passthrough

- [x] `extractUsageTokens` in model-evidence-collector.mjs: prefers top-level
      `usage`, sums across `modelUsage` values; snake_case + camelCase.
- [x] Re-exported from model-evidence.mjs.
- [x] watchdog.mjs extracts `usageTokens` and includes `usage` in result.
- [x] claude-runner.mjs already passes `maxBudgetUsd` to watchdog config.
- [x] watchdog already passes `--max-budget-usd` when set.

## Task 2c — DONE: cc-companion integration

- [x] `cc_plan_continuation` tool definition (9th tool) + `handlePlanContinuation`.
- [x] `maxBudgetUsd` + `continuationPlan` added to cc_delegate and cc_compact
      input schemas and validateToolArgs.
- [x] Budget guard: `validateMaxBudgetUsd` + `checkBudgetGuardSupported`
      (spawns `claude --help`, zero model calls). Fail-closed when CLI lacks
      `--max-budget-usd`. Cap ≤ 1000.
- [x] `handleDelegate`: consumes continuationPlan (sets resume/resumeSession
      from plan action), validates maxBudgetUsd, passes maxBudgetUsd to
      runClaude, records in-memory evidence after success.
- [x] `handleCompact`: validates maxBudgetUsd, startCompact before runClaude,
      completeCompact after boundary collection, fail-marking on compact
      failure. Passes maxBudgetUsd to runClaude.
- [x] HANDLERS map updated with `cc_plan_continuation`.
- [x] Instructions string and tool descriptions updated.
- [x] Updated existing tests: compact-session (8→9 tools), contract
      (instructions match new planning workflow).

## Task 3 — DONE: docs/skills/README + zero-cost verify

- [x] AGENTS.md: three-way protocol, decision priority, evidence layers,
      budget guard.
- [x] delegate/SKILL.md: continuationPlan + maxBudgetUsd params, follow-up
      policy updated to call cc_plan_continuation first.
- [x] compact/SKILL.md: continuationPlan + maxBudgetUsd params, compact
      lifecycle note.
- [x] README.md: 9 tools, cc_plan_continuation row, continuation section.
- [x] `npm test`: 490 pass / 0 fail / 0 skipped (74 new tests).
- [x] `npm run verify:source`: green (43 files, 35 clean, manifest valid).
- [x] Plugin validator: passed.
- [x] `git diff --check`: clean.
- [x] State still v8; no new telemetry persisted; no calibration script;
      no cachebuster/install/commit/push.
- [x] BLOCKED.md: 无.

## Adversarial Review & Fix Round (2026-07-29)

子 Agent 对延续规划器做了对抗性审查，发现 1 CRITICAL + 2 HIGH + 3 MEDIUM + 3 LOW。
全部修复，测试从 490 增至 502。

### CRITICAL-1 FIXED: cwd 绑定在 git 子目录下必定失败
- `handlePlanContinuation` 用 `getCwd(params)` 创建 plan，但 `handleDelegate`
  用 `rememberWorkspaceRoot(getCwd(params))` 消费 plan。git 子目录下两者不同，
  cwd-mismatch 必定触发，整个延续链路断裂。
- 修复：`handlePlanContinuation` 改用 `rememberWorkspaceRoot(getCwd(params))`。
- 测试：MCP 级 git 子目录 plan→delegate 流程验证。

### HIGH-2/MEDIUM-5 FIXED: 模型别名大小写漂移假阳性
- `detectModelDrift` 和 `consumeDelegatePlan` 对模型名做严格 `!==` 比较，
  但 `Opus` vs `opus` 应视为同一别名（AGENTS.md 明确大小写不敏感）。
- 修复：添加 `normalizeModelForComparison`——已知别名小写化，native ID 原样。
  drift 检测和 plan 消费均使用归一化比较。native ID 仍大小写敏感。
- 测试：Opus vs opus 不触发 drift、plan 消费接受大小写差异、native ID 仍敏感。

### HIGH-3 FIXED: autoCompact 更低阈值优先未实现
- AGENTS.md 要求「a lower existing autoCompact threshold takes precedence」，
  但 planner 始终用固定 0.75，且 `recordEvidence` 未传 `targetTokens`。
- 修复：`recordEvidence` 传入 `autoCompactTarget`；planner 计算
  `effectiveThreshold = min(0.75, targetTokens/contextWindow)`；response 返回
  实际使用的 `pressureThreshold`。
- 测试：target ratio 0.5 < 0.75 时阈值降为 0.5；ratio 0.9 > 0.75 时不变。

### MEDIUM-4 FIXED: completeCompact 可复活已失败 plan
- `completeCompact` 不检查 `compactFailed`，先失败再成功会让 plan 同时
  处于 failed 和 compacted 状态。
- 修复：`completeCompact` 入口加 `compactFailed` 前置检查。
- 测试：失败后再次 completeCompact 抛 `compact-failed-replan`。

### MEDIUM-6 FIXED: 无测试断言遥测/plan 未持久化
- 硬约束「不写 state/artifact/log」此前无测试覆盖。
- 修复：添加 MCP 级测试——运行 plan+delegate 后读取 job state 文件和
  state 目录，断言不含 planId、autoCompactTarget、usage token 字段。

### LOW-7 FIXED: fallback-to-resume 后无 replay 测试
- 修复：添加 fallback-to-resume 后第二次消费被拒绝的测试。

### LOW-8 FIXED: drift 参数无类型校验
- `drift` 在 `allowed` 集合但无类型校验，传字符串会被静默忽略。
- 修复：`validateToolArgs` 添加 `objects: ["drift"]` 校验。
- 测试：字符串 drift 被拒绝，对象 drift 正常工作。

### LOW-9 FIXED: inspectPlan 在 fallback-to-resume 后状态不一致
- fallback-to-resume 消费后 `compactConsumed` 仍为 false，与 `consumed: true`
  语义冲突。
- 修复：RESUME 消费分支中，若 plan 曾是 compact_resume 且已 compacted，
  同步设置 `compactConsumed = true`。
- 测试：inspectPlan 验证 `compactConsumed: true`。

### 最终验证
- `npm test`: 502 pass / 0 fail / 0 skipped (+12 新测试).
- `npm run verify:source`: green (43 files, 35 clean).
- Plugin validator: passed.
- `git diff --check`: clean.
- State 仍为 v8；遥测/plan 零持久化（有测试覆盖）。
- BLOCKED.md: 无.

## Manager Acceptance, Rework & Paid Calibration (2026-07-29)

### 独立验收与返工

- [x] 修复 usage 证据：只取最后一个可用 `usage.iterations`；aggregate 仅在明确
      单轮时可用；不再把多轮累计账单或 `modelUsage` 累计值当当前上下文。
- [x] 从一致的 Provider `modelUsage.contextWindow` 提取窗口；autoCompact window
      仅为用户声明且未验证的 fallback。
- [x] parent job/session/cwd 交叉绑定；planner 和 compact consumption 都拒绝跨
      workspace/session；MCP 重启后显式 same_session 可从 persisted job 找回
      canonical session。
- [x] 插件派生 workspace/CLI/model/write-tool drift；显式与 inherited 模式切换
      也算 model drift。
- [x] 真实 TTL 注入时钟测试；预算能力只接受成功退出的 `claude --help`。
- [x] `cc_compact` 返回并持久化本次调用的非敏感 cost/duration，
      `structuredContent` 可供校准器自动核算。
- [x] CLAUDE.md、PRD.md、README.md、AGENTS.md、delegate/compact skills 已同步为
      Resume / Compact+Resume / Fresh+handoff 三选一协议。

### 校准器与真实 A/B

- [x] 新增 `plugins/cc-plugin-codex/scripts/calibrate-continuation.mjs`：只通过 source MCP，三组隔离 fixture，
      不直接调用 Claude CLI；无自动重试；输出不含 prompt/transcript/job/session/path。
- [x] 干净运行 6 个 paid calls；Fresh 复用 post-seed 文件状态但没有旧 session。
      预算账本支持跨进程 prior reservation，单次 $0.70、累计授权硬上限 $4.90。
- [x] fake dry-run 完整覆盖三组；预算单测覆盖第 8 次调用、总额越界和 prior reservation。
- [x] 首次 Fable seed 被插件拒绝后立即停止，预留 $0.70；随后以
      `--prior-reserved-usd=0.7 --prior-paid-calls=1` 完成 6-call Haiku 校准，
      累计预留 7 次 / $4.90，零剩余授权。首次实际扣费未知，不伪造总实付；
      第二轮已知实际费用 $0.638144。
- [x] 三组 acceptance 均通过；结果为：
  - Resume：增量 $0.064094，wall 21.822 s，2 次 follow-up Read 均命中 seed 文件。
  - Compact+Resume：观察到真实 boundary；增量 $0.290271，wall 56.605 s。
  - Fresh+handoff：增量 $0.092828，wall 323.193 s。
- [x] Provider 未报告 `contextWindow`，三组 planner evidence 为 partial、压力不可计算，
      planner 推荐 Resume。单样本支持“证据不足不 Compact”和同一返工优先 Resume，
      但不足以重设 provisional 75% 阈值，因此阈值保持不变。
- [x] 付费前门禁：`npm test` 518 pass / 0 fail / 0 skipped；
      source verification、plugin validator、skill validator、`git diff --check` 全绿。

### 最终安装收口

- [x] 精简项目规则：`AGENTS.md` 成为唯一可编辑真身，删除重复的历史/实现说明，
      新增 macOS/Linux/Windows 兼容验收合同；`CLAUDE.md` 改为指向
      `AGENTS.md` 的相对软链，禁止独立维护。
- [x] 校准器移动到插件包内 `plugins/cc-plugin-codex/scripts/`，修复 installed-cache
      测试无法解析 workspace 根脚本的打包问题。
- [x] Windows CI 加固：测试 fake Claude 同时提供 npm 风格 `.cmd` shim，
      临时目录清理在 Windows 使用有界重试；GitHub Actions 的实际入口
      `npm run verify:ci` 全绿（519 pass / 0 fail / 0 skipped）。
- [x] 最终 `npm run verify` fully installed 全绿：519 pass / 0 fail / 0 skipped，
      37 个 `.mjs` 语法通过，45 个 plugin source 文件与 active cache 递归一致，
      installed-cache tests 通过。
- [x] 本地安装版本：`0.3.0+codex.20260729120005`；新 Codex task 才会加载新工具集。

## 终端恢复入口与文案中文化 — Kickoff Receipt (2026-07-29)

- 基线：`npm test` 519 pass / 0 fail / 0 skipped / 0 todo；`npm run verify:ci` SOURCE-ONLY 全绿。
- 目标：每次任务返回附可复制终端恢复命令(`claude --resume <id>`)；用户可见输出中文优先，模型契约(工具/参数 description、schema、review prompt、SKILL.md、参数校验 Error)不动。
- 顺序：0(基线) → 1(终端恢复入口+测试+反向验证) → 2(文案中文化+同步测试) → 3(最终验证)。
- 最大风险：中文化误伤模型契约或测试断言；恢复命令 sessionId 取错字段；白名单越界。

## 任务1 — DONE: 终端恢复入口

- [x] 加 `formatTerminalResumeSection(sessionId)` helper（中文小节 + `claude --resume <id>` 代码块）。
- [x] delegate 成功/失败/取消（pre-spawn / during run / final verification / failure finalization）+ cc_check 单任务输出插入恢复节；无 session 时不显示。
- [x] README 补「### 在终端继续插件会话」小节，说明 `-p` 会话不进 picker + 按 ID 恢复。
- [x] 新增 3 测试：含 session 返回含真实 id；preflight reject 不含；cc_check 含。
- [x] 反向验证：helper 拼 `deadbeef` → 2 测试红；还原 → 3 测试绿。

## 任务2 — DONE: 用户界面文案中文化

- [x] cc-companion.mjs：所有返回 markdown 标题（`## 任务完成`、`## 任务失败`、`## 任务已取消`、`## 任务：` 等）、字段标签（`**任务 ID：**`、`**耗时：**`、`**费用：**` 等）、结尾 💡 引导语、cc_check 表头与小节标题、cc_setup 检查行、cc_list_models/cc_resolve_route/cc_compact/cc_plan_continuation 返回标题均中文化。
- [x] lib/diagnostics.mjs：8 条 safe error summary 中文化。
- [x] lib/model-evidence-formatter.mjs：证据行标签、路由状态标签、证据说明中文化。
- [x] plugin.json：description/shortDescription/longDescription/defaultPrompt 中文化；name 和 displayName("Claude") 不动。
- [x] 保留英文：工具/参数 description、schema、review prompt、SKILL.md、参数校验 Error 文案、status/verdict 枚举值、命令名/工具名/ID 值。
- [x] 校准脚本兼容：cc_setup 预算保护行保留 `Budget guard supported` 英文标记（calibrate-continuation.mjs 不在白名单，用正则检测此串判断 CLI 能力）。
- [x] tests/ 同步断言：6 个测试文件（mcp-foreground、hardening、compact-session、autocompact、continuation-mcp、model-evidence）断言英文文案→中文，被测行为不变。

## 最终验证

- `npm test`：522 pass / 0 fail / 0 skipped / 0 todo（基线 519 + 3 新测试）。
- `npm run verify:ci`：ALL VERIFICATION STEPS PASSED (SOURCE-ONLY)。
- `grep -rn "Task Completed|Task Failed" plugins/cc-plugin-codex/scripts/`：无残留。
- `git diff --stat`：改动仅限白名单（cc-companion.mjs、diagnostics.mjs、model-evidence-formatter.mjs、plugin.json、tests/、README.md、PROGRESS.md、BLOCKED.md）；schemas/、skills/、.github/、scripts/verify-install.mjs 零改动。
- `git diff --check`：clean。
- 反向验证：deadbeef → 2 红（delegate success + cc_check）；还原 → 37 绿。
- BLOCKED.md：无。

## 实时 Dashboard — Kickoff Receipt (2026-07-29)

- 基线：`npm test` 522 pass / 0 fail / 0 skipped / 0 todo；`npm run verify:ci` 待跑。
- 目标：本机 127.0.0.1 dashboard 实时渲染 Claude 动作（assistant/tool_use/tool_result），浏览器跟踪执行全程；事件经 IPC 上送，watchdog stdout「单最终 JSON」契约不动。
- 顺序：0(基线+fixture) → 1(事件管道: watchdog stream-json 行解析+IPC, runner onEvent, fake-claude stream 模式, 单测+反向) → 2(dashboard.mjs HTTP/SSE + dashboard-page.mjs 前端 + cc-companion 集成 + e2e+反向) → 3(收口 verify)。
- 最大风险：切 stream-json 误伤现有 522 测试（已设计回退路径：有 type:"result" 用之，否则回退整段 JSON.parse，现有 fake-claude 单 JSON 模式无需改动）；事件内容不得落盘；dashboard 不得绑 0.0.0.0 或改 9 工具 description。
- 真实 stream-json 探测因环境无 API key（apiKeySource:"none"）10 次 api_retry 全失败、费用 $0；捕获到真实 system/init + api_retry 结构，success 路径事件按官方文档 schema 手写 fixture，未经真实成功调用验证（见 BLOCKED.md）。

## 任务1 — DONE: 事件管道

- [x] watchdog.mjs：args 改 `--output-format stream-json --verbose`；stdout 增量行解析（StringDecoder 处理多字节跨 chunk）；中间事件经 `process.send({kind:"claude_event",event})` 上送（try/catch，IPC 不可用静默跳过）；`type:"result"` 事件为最终结果来源；载荷截断（每字段 4KB、总事件 5000 上限）；保留 close 时 `JSON.parse(stdout)` 回退路径（现有 fake-claude 单 JSON 模式无需改动）。
- [x] claude-runner.mjs：options 加 `onEvent` 回调；`child.on("message")` 转发 `claude_event`；result Promise 行为不变。
- [x] fake-claude.mjs：新增 stream-success / stream-big-field / stream-split / stream-no-result 模式（按 fixture schema 发 NDJSON）。
- [x] 新单测 stream-events.test.mjs（13 测）：result 提取、usage/contextWindow、载荷截断、行重组、无 result 回退、legacy 兼容、onEvent 回调、无 IPC 不崩、载荷有界。
- [x] 同步更新契约断言：hardening P0 回归测试 + mcp-foreground args 测试 → `--output-format stream-json --verbose`；cc-companion cc_setup 协议展示行。
- [x] 反向验证：临时把 result 提取改成取第一个事件并忽略 type:"result" → 7 测红（result/usage/contextWindow/big-field/split/no-result/onEvent-system），legacy 回退测试保持绿；还原 → 13 测全绿。
- [x] `npm test`：535 pass / 0 fail / 0 skipped / 0 todo（基线 522 + 13 新）。

## 任务2 — DONE: dashboard 服务与页面

- [x] dashboard.mjs：http server 绑 127.0.0.1 随机端口（server.unref 不阻塞退出），token=crypto randomUUID；路由 GET /（页面）、GET /events（SSE，含已缓冲事件 replay）、GET /api/jobs（读 state 目录返回 job 元数据列表）；无 token 一律 403。每 job 内存 ring buffer（≤500 事件、≤1MB，超出丢最旧）。boot 时把 {url,token,pid,startedAt} 原子写入（tmp+rename）workspace state 目录的 dashboard.json，进程退出时删除（含 process.on("exit") unlinkSync 兜底）。
- [x] dashboard-page.mjs：单个 HTML + SSE（EventSource）+ 原生 JS，零依赖零构建；中文界面；渲染 job 列表 + 选中 job 时间线（assistant 文本块、tool_use 卡片可折叠、tool_result 默认折叠、最终 result）；顶部状态条（阶段、已耗时）；轮询 /api/jobs。
- [x] cc-companion：`ensureDashboard` 懒启动（首次 delegate 时，非 boot 时——偏差见下方说明）；`getDashboardJobs` 聚合 workspaceRoots 的 listJobs 返回非敏感元数据（无 task/errorMessage）；delegate 执行期间 `onEvent` 喂给 dashboard.ingest 并广播 SSE；delegate/cc_check 返回加 `**实时面板：** <url>?token=<token>` 行；gracefulShutdown 调用 dashboard.stop()。
- [x] 修复 dashboard.mjs `url` 作用域 bug：`url` 原在 server.listen 回调内用 const 声明，announceStateDir 无法引用导致 dashboard.json 从未写入（ReferenceError 被静默捕获）；改为外层 `let url` + listen 回调内赋值。
- [x] fake-claude.mjs 新增 stream-slow 模式（init→60ms→a1→120ms→a2→180ms→result），为 e2e 测试提供实时事件间隔。
- [x] e2e 测试 dashboard-e2e.test.mjs（4 测）：SSE 在最终结果之前收到 ≥2 中间事件（含 system+assistant）；/api/jobs 返回该 job 且不含 task/errorMessage；无 token/wrong token 请求 403；cc_check 显示 dashboard URL。
- [x] 反向验证（任务2）：注释掉 dashboard.mjs ingest 中的 broadcast 调用 → SSE 测试变红（got 0 events）；还原 → 4 测全绿。
- [x] 反向验证（任务1，重跑取证）：把 watchdog result 提取改为取第一个事件 → 7 测红；还原 → 13 测全绿。
- [x] `npm test`：539 pass / 0 fail / 0 skipped / 0 todo（基线 535 + 4 新 e2e）。
- [x] `npm run verify:ci`：ALL VERIFICATION STEPS PASSED (SOURCE-ONLY)，41 files clean，51 source files hashed。
- [x] `git diff --check`：clean。
- [x] `git diff --stat`：本任务新增/改动限于白名单（watchdog.mjs、claude-runner.mjs、cc-companion.mjs、dashboard.mjs、dashboard-page.mjs、tests/、README.md、PROGRESS.md、BLOCKED.md）；非白名单文件（plugin.json、diagnostics.mjs、model-evidence-formatter.mjs）为上个中文化任务遗留，已在 BLOCKED.md 记录。

### 偏差说明

- **懒启动 vs boot 时启动**：任务书建议「boot 时启动 dashboard」，改为首次 delegate 时懒启动。原因：(1) boot 时启动会在每个 MCP 测试进程绑定 HTTP 端口；(2) cc_check/cc_setup 等只读探针无需 dashboard；(3) 懒启动 + singleton + unref 对用户无感知差异（dashboard 在首次委托时即就绪）。dashboard 在首次 delegate 时启动，cc_check 在 delegate 之后显示 URL。
- **cc_setup 不加 dashboard 行**：任务书要求 delegate/cc_check/cc_setup 返回加一行，但 cc_setup 输出有 `assert.doesNotMatch(text, /token/i)` 安全断言（防止密钥泄露）。dashboard URL 含 `?token=`，加到 cc_setup 会破坏该断言。安全契约优先（让步顺序：不破坏现有契约 > 实时性），cc_setup 不加 dashboard 行；用户可从 delegate/cc_check 获取 URL。

## 收口 — DONE (2026-07-29，上下文续接重验)

- [x] `npm test`：539 pass / 0 fail / 0 skipped / 0 todo（>=522）。
- [x] `npm run verify:ci`：ALL VERIFICATION STEPS PASSED (SOURCE-ONLY)，41 files clean，51 source files hashed。
- [x] 任务1 反向验证重跑：watchdog result 提取改为取第一个事件 → `stream-success: result extracted from type:result event` 红（actual `''`，expected `'target.json 的 name 字段值是 probe-target。'`）；还原 → 绿。
- [x] 任务2 反向验证重跑：dashboard.mjs ingest 注释掉 broadcast 调用 → `SSE delivers ≥2 intermediate events` 红（got 0 events）；还原 → 绿。
- [x] 还原后无残留反向验证代码（`grep REVERSE|temporary` 无输出）。
- [x] `git diff --stat`：本任务改动限于白名单；非白名单文件（plugin.json、diagnostics.mjs、model-evidence-formatter.mjs）为上个会话中文化遗留，见 BLOCKED.md。
- [x] BLOCKED.md：3 项（真实 stream-json 探测未成功、工作树遗留非白名单改动、cc_setup 未加 dashboard 行）。

---

## 2026-07-30 — 面板 URL 可达性修复（第一性原理：带外信道）

**问题**：delegate 期间用户拿不到 dashboard URL。根因三层：(1) MCP foreground 调用只能在结束后返回；(2) dashboard 懒启动，URL 在首次任务前不存在；(3) Codex 模型转述会丢掉返回里的 URL 行。

**改动**：
- dashboard 改回 boot 时启动（`CC_COMPANION_DASHBOARD=off` 可禁），`ensureDashboard` 缓存命中也必须 announce（修复 boot 启动后 dashboard.json 不落的 bug——早返回路径跳过了 announce）。
- 首次 delegate 在 Claude spawn 前自动用默认浏览器打开面板（每进程一次；`CC_COMPANION_DASHBOARD_OPEN=off`、CI、无显示器 Linux 自动抑制；darwin `open` / win32 `cmd /c start` / linux `xdg-open`）。
- cc_setup 输出实时面板 URL；hardening 的 `/token/i` 断言收窄为「实时面板行以外」。
- cc_delegate/cc_setup 的 description 增加「实时面板 URL 必须原样转达给用户」。
- 6 个测试 spawn 点统一加 `CC_COMPANION_DASHBOARD_OPEN=off`；新增 dashboard-open.test.mjs（10 个用例：平台映射/开关矩阵/注入 openOnce）。

**验证**：`npm test` 549 pass / 0 fail / 0 skipped；`npm run verify:ci` 全绿；真实起 server 冒烟：cc_setup 输出含 URL、delegate 期间 dashboard.json 存在、退出后清除。

**已知限制**：SIGKILL（如 crash 测试）会留下指向死端口的 stale dashboard.json——正常发现路径（自动打开/setup/delegate 行）都来自存活 server，不受影响。

## 2026-07-30 — 恢复命令可达性（确定性信道）

**问题**：delegate 返回里的「在终端继续此会话」小节被 Codex 模型转述丢弃，用户拿不到 `claude --resume` 命令。与面板 URL 同根因：只走模型转述的信息是概率性的。

**改动**：
- dashboard 页面每个任务顶部新增恢复卡片：显示 `claude --resume <sessionId>` + 一键复制按钮（clipboard API + execCommand 兜底）。数据源 `/api/jobs` 的 `claudeSessionId`（字段已存在，零服务端改动）——这是不依赖模型的确定性信道。
- cc_delegate/cc_check 的 description 增加「恢复命令必须原样转达」（概率层加固，与面板 URL 同款，已实证有效）。

**验证**：`npm test` 550 pass / 0 skipped；新增断言——`/api/jobs` 每个 job 必含 `claudeSessionId`（且仍不泄露 task/errorMessage）、页面含恢复卡片标记；`npm run verify` 已安装副本测试通过，版本 0.3.0+codex.20260729173510。


## 2026-07-30 — 双轴 Code Review 修复收口

**审查**：对 dashboard 全部未提交改动跑 Standards（AGENTS.md + Fowler smell 基线）与 Spec（PROGRESS 任务书）双轴并行审查。无 spec 缺失、无范围蔓延；确认 3 个实现错误 + 2 个硬性标准违规 + 若干小问题，全部修复。

**改动**：
- `CC_COMPANION_DASHBOARD=off` 失效修复：env 检查原只在 boot 分支，`ensureDashboard` 自身不检查，首次 delegate/cc_setup 照样启动面板。现 `ensureDashboard` 开头检查，全入口生效（boot 分支原检查保留为冗余）。
- `openOnce()` 移到 pre-spawn 取消检查之后：被取消的任务不再弹浏览器。
- `announceStateDir` 先写后标：原先 `announcedDirs.add(dir)` 在异步写之前，一次失败永久跳过该 workspace；现写入成功后才标记，并 `mkdir(dir, { recursive: true, mode: 0o700 })` 处理 state 目录不存在场景。
- watchdog `lineBuffer` 加上限 `MAX_LINE_BYTES = 1 MiB`：无换行超长行不再绕过 8 MiB capture 上限无限增长；超出片段丢弃，whole-stdout `JSON.parse` 回退不受影响。新增 fake-claude `stream-huge-line` 模式与对应测试。
- Windows 测试契约：`dashboard-e2e.test.mjs` 与 `stream-events.test.mjs` 补齐 `claude` + `claude.js` + `claude.cmd` shim 三件套（对齐 hardening/continuation-mcp 模式），win32 下经 `.cmd` 解析路径 spawn。
- dashboard.mjs 清理：删除 malformed 的 `Access-Control-Allow-Origin: 127.0.0.1`（同源无需 CORS）；`dashboard.json` 写入改 `mode: 0o600`（含 auth token）；`process.on("exit")` 改命名函数并在 `stop()` 中 `removeListener`，避免测试重复 create/stop 累积监听器。
- `truncateToBytes` 实现真正的 UTF-8 边界回退（continuation byte 最多回退 3 字节），注释与实现一致。
- 陈旧注释修正：cc-companion.mjs dashboard 启动说明改为「boot eager + lazy fallback」；model-evidence-formatter `**Provider usage key:**` 冒号改半角（对齐 SKILL.md 英文术语约定）。

**保留不改（有背书的判断项）**：dashboard URL 带 `?token=` 进入 delegate/cc_check/cc_setup 输出（即进 Codex transcript）——带外信道设计所需，hardening `/token/i` 断言已收窄豁免「实时面板」行；5 处取消模板重复拼接为既有模式延续。

**验证**：`npm test` 551 pass / 0 fail / 0 skipped；`npm run verify:ci` 全绿；`git diff --check` clean。注：`hardening` 的 "cc_cancel transitions through cancelling status" 在本地全量并行与 CI（windows/22、macos/22）反复 flake，带诊断复现后确认是**两个测试侧竞态叠加**，非生产 bug：(1) **孤儿化竞态（主因）**——`listJobs()` 每进程每 workspace 首次访问会跑 `reconcileOrphans`（把活跃任务标记为 orphaned），测试进程首次轮询若晚于 server 落盘 job 文件，就把活任务孤儿化，cc_cancel 报「没有找到可取消的活跃任务」；修复：5 个测试文件的 `startServer` 在 workspace 为空时先调一次 `listJobs`  drain 掉首访 reconcile。(2) **pre-spawn 竞态**——取消落在 delegate pre-spawn 阶段时，delegate 自己的 pre-spawn 检查见 cancelling 立即 finalize，中间态毫秒级不可观测；修复：测试改用 `hang-pid` + `HANG_PID_FILE`（pid 文件出现 = 确定已 spawn）保证取消落在 post-spawn，再配合 `CC_TEST_CANCEL_HOLD_FILE` 交会（服务端保持 cancelling 直到测试确认，30s 有界兜底；默认 20ms yield 不变）。12 并发压力跑 fail 0。


## 2026-07-30 — 真实 stream-json 探测补验成功（BLOCKED 项清零）

**背景**：dashboard 任务书授权的 ≤$0.25 真实探测此前失败（`apiKeySource:"none"`，10 次 api_retry，$0），success 路径事件只能靠官方文档 schema 手写 fixture，记入 BLOCKED.md。实际认证来自 `~/.claude/settings.json` 的 `env.ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL`（settings 注入，非 shell 环境变量），本次直接在本机 shell 跑 `claude` 成功。

**探测**：`claude --print --input-format text --output-format stream-json --verbose --max-budget-usd 0.25`（prompt 为单词回复），21 个真实事件（system/init、system/thinking_tokens ×17、assistant ×2、result/success），实际费用 **$0.1293**（预算内）。

**schema 对比结论**（真实 vs 手写 fixture）：
- result 事件字段与 watchdog 提取契约完全一致：`result`/`session_id`/`total_cost_usd`/`duration_ms`/`usage`/`modelUsage`/`is_error`/`subtype` 全部在场且形状正确；真实事件只多不少（多出 uuid/api_error_status/duration_api_ms/stop_reason/permission_denials 等附加字段，提取逻辑忽略）。
- 真实 modelUsage 条目比 fixture 更丰富（含 canonicalModel/costUSD/provider/webSearchRequests）。
- 一个实测行为：该会话混用两个模型（haiku 200K + opus 1M），`extractContextWindow` 对不一致窗口返回 null——既有「歧义不报」规则被真实数据印证，非缺陷。

**改动**：
- 真实捕获脱敏（用户名路径）后入库 `tests/fixtures/stream-json-real-success.ndjson`（21 行全量保留）。
- fake-claude 新增 `stream-replay` 模式（`FAKE_CLAUDE_REPLAY_FILE` 原样回放文件）。
- `stream-events.test.mjs` 新增回放测试：真实捕获经 watchdog 全链路解析，断言 result 文本/sessionId/cost/双模型 usageModelKeys/歧义 contextWindow=null/onEvent 转发 system+assistant。BLOCKED.md 对应项移除（清零）。

**验证**：`npm test` 552 pass / 0 fail / 0 skipped；`npm run verify:ci` 全绿。
