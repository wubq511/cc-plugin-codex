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
