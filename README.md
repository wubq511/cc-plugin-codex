# Claude Code Companion — Codex Plugin

> 在 Codex 中分派编码任务给 Claude Code，完成后自动返回结果供 Codex 审查。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 这是什么

一个 [Codex](https://codex.openai.com/) 插件，实现 **Codex → Claude Code** 方向的集成。让你在 Codex 里把编码任务交给 Claude Code 执行，完成后自动返回结果，并可以对产出做标准审查或对抗审查。

与 OpenAI 官方的 `codex-plugin-cc`（Claude Code → Codex）方向相反，互为补充。

## 功能

- **分派任务** — 把编码任务交给 Claude Code，可选传入任意模型标识和推理强度
- **动态模型路由** — 支持 inherited/alias/native 三种选择器意图；每次任务直接调用原生 Claude Code，不读取任何外部路由配置
- **Provider 无关** — 默认继承用户当前 Claude Code 配置的 Provider 和模型，无需手动选择
- **自动等待完成** — 所有任务保持一次 pending 调用，完成后自动返回，不需要轮询
- **任务隐私** — 任务通过 stdin 传递，不出现在任何进程命令行中
- **状态追踪** — 实时查看任务进度、阶段、耗时、成本，区分请求模型、路由快照、执行记录和用量 key
- **失败诊断** — 私有、脱敏、有大小限制的 failure envelope，MCP 输出只返回安全摘要和错误分类
- **代码审查** — 标准审查（找 bug）或对抗审查（质疑实现选择、攻击面分析）
- **有界上下文续作** — 审查修复默认开新会话并传递精炼交接包；仍支持显式恢复指定 Claude Code 会话
- **Job 管理** — 前缀匹配、会话过滤、取消运行中的任务
- **实时面板** — 任务执行期间在本机 127.0.0.1 起一个只读 dashboard，首次 delegate 自动在浏览器打开（可关闭），浏览器实时查看 Claude 的每一步动作（assistant 文本、tool_use、tool_result）；事件只进内存不落盘，URL 带随机 token 鉴权

## 快速开始

### 前置条件

- [Codex](https://codex.openai.com/) 已安装
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 已安装并认证：`npm install -g @anthropic-ai/claude-code`
- Node.js >= 18

### 安装

```bash
# 1. 添加本仓库作为 marketplace
codex plugin marketplace add wubq511/cc-plugin-codex

# 2. 安装插件
codex plugin add cc-plugin-codex
```

验证安装：

```
/claude:setup
```

### 更新

```bash
# 更新 marketplace 缓存（拉取最新代码）
codex plugin marketplace update wubq511/cc-plugin-codex

# 重新安装以应用更新
codex plugin add cc-plugin-codex
```

## 使用

### 分派任务

```
/claude:delegate
```

默认继承当前 Claude Code 配置的 Provider 和模型，无需手动选择。也可以通过 `model` 参数指定模型：

- **inherited**（默认）：省略 `model`，不传 `--model`
- **alias**：`Opus` / `Fable` / `Sonnet` / `Haiku`（大小写无关），标准化为 Claude CLI alias
- **native**：如 `deepseek-v4-pro` / `glm-5.2`，原样透传
- 不明确的模型家族描述会被拒绝（fail closed），不猜测不 fallback

插件不读取、不写入、也不调用任何外部配置管理工具。未指定 `model` 时，它不传 `--model`，完全继承原生 Claude Code 的当前配置；指定 `Opus`、`Fable`、`Sonnet` 或 `Haiku` 时只把规范化别名原样传给 `claude --model`；指定 `deepseek-v4-pro`、`glm-5.2` 等合法原生 ID 时直接透传。插件不会猜测别名实际指向的 Provider 模型，真实执行模型只以 Claude transcript 证据为准。

通过 `effort` 参数指定推理强度。使用 `cc_resolve_route` 可在不发起模型调用的前提下预览模型路由解析结果。

### 查看状态

```
/claude:status        # 最新任务
/claude:status --all  # 所有任务
```

默认 delegate 会一直等待 Claude Code 完成，期间 MCP server 仍可响应取消请求。等待时不应通过 `sleep`、重复状态查询或周期性“仍在运行”消息制造额外模型回合，也不得在工具缺失时用 shell/PTY 手工启动 companion 来模拟 delegation。`background=true` 已废弃并被拒绝。

### 审查产出

```
/claude:review              # 标准审查
/claude:review --adversarial  # 对抗审查
```

**标准审查**：检查正确性、bug、安全、性能、可维护性。

**对抗审查**：质疑实现选择，分析攻击面（认证/数据丢失/竞态条件/可观测性缺口），要求每个发现都有具体代码位置和修复建议。

### 审查后的继续修复

审查发现问题后再次分派时，插件默认开启新的 Claude Code 会话。Codex 只交接当前目标、可执行的审查发现、仍有效的约束和验收命令，并要求 Claude Code 从当前工作区与 git diff 核对真实状态。它不会把完整旧会话、完整 diff 或冗长日志重复塞入新上下文。

这能保留任务连续性，同时避免多轮审查和修复把同一个 Claude 会话越堆越大。只有你明确要求“继续同一个 Claude Code 会话”或指定 session ID 时，Codex 才会使用 resume。

### 在终端继续插件会话

插件通过 `claude -p`（print 模式）执行任务，这类会话不会出现在交互式 `/resume` 列表中（这是 Claude Code 的官方行为，无法让插件会话进入 picker）。要继续某个插件会话，需按 session ID 恢复。

每次任务返回（成功、失败、取消）以及 `cc_check` 单任务输出里，只要该 job 持有 `claudeSessionId`，就会附带一节「### 在终端继续此会话」，内含一条可复制的命令：

```
claude --resume <sessionId>
```

在 workspace 根目录运行即可。session ID 也可在 `cc_check` 的任务详情中找到。

### 实时面板

任务执行期间，插件在本机 `127.0.0.1` 随机端口启动一个只读 dashboard 页面。由于 delegation 是 foreground 阻塞调用（MCP 返回只能在任务结束后到达），面板通过带外渠道送达：

- **首次 delegate 自动打开** — Claude 启动前，插件会在你的默认浏览器打开面板页（每个 server 进程只打开一次）。浏览器保持该标签页即可，之后所有任务实时可见
- **`/claude:setup` 显示 URL** — 输出中包含 `**实时面板：** <url>?token=<token>`，可收藏备用
- **`cc_delegate` / `cc_check` 返回附带 URL** — 任务结束后返回里也有同一行

面板（浅色主题）以降噪时间线实时渲染 Claude 的每一步动作：

- **assistant 文本块** — Claude 的叙述是主信号；思考过程折叠为可展开的一行指示
- **工具卡** — tool_use 与 tool_result 配对成一张卡：参数摘要 + 耗时，成功输出折叠、错误输出自动展开并高亮
- **系统事件** — 会话开始等渲染为分隔行；`thinking_tokens` 等高频噪音事件直接丢弃（server 进 buffer 前 + 客户端各一层）
- **最终 result** — 任务完成时的汇总卡（费用、耗时、轮数）

顶栏第二行的状态区显示当前动作（已剥掉 markdown 符号）、阶段、已耗时、轮数、工具调用数和费用（终值），区内的「resume」按钮一键复制 `claude --resume <sessionId>` 命令——这是恢复入口的确定性来源，不依赖模型转述。右上角「切换任务」在多个任务间切换。时间线在底部自动跟随最新事件，向上滚动暂停、点「回到最新」恢复；面板图标为 Claude 标志，任务完成时标签页标题加完成前缀、favicon 叠加绿/红状态点，可选提示音。

面板是纯只读观察者：不改动取消/租约/foreground 任何契约。事件只存在于内存 ring buffer（≤500 事件/≤1MB 每 job），永不落盘。dashboard 绑定 `127.0.0.1`（不监听外部接口），URL 带随机 token 鉴权，无 token 请求一律 403。

开关：设 `CC_COMPANION_DASHBOARD_OPEN=off` 关闭自动打开（CI 与无显示器的 Linux 环境自动关闭）；设 `CC_COMPANION_DASHBOARD=off` 完全禁用面板。

### 取消任务

```
/claude:cancel
```

取消状态机为 `running → cancelling → cancelled`。`cc_cancel` 会在 `cancelling` 状态落盘后发送信号，然后等待 watchdog/Claude 进程树退出、状态收口、writer lease 释放后才返回。无 live handle 时如实报告；同步 finalizer 临界区与 per-job 终态缓存共同防止 completed-vs-cancelled 竞态。

### 自动压缩与会话恢复

`cc_delegate` 的 `autoCompact` 参数支持按 delegation/session/task 临时配置自动压缩，通过 Claude CLI 内联 `--settings <json>` 注入两个 env 键，不修改 `~/.claude/**`、项目 `.claude/` 或父 `process.env`。

```json
{ "contextWindowTokens": 256000, "targetTokens": 230000, "scope": "delegation" }
```

- `contextWindowTokens`：用户声明的窗口大小（正安全整数，不验证、不从模型推断）
- `targetTokens`：名义目标（正安全整数，必须 ≤ `floor(context × 0.9)`，否则 spawn 前拒绝）
- `scope`：`delegation`（默认，仅当前进程）/ `session`（绑定会话，resume 时重放）/ `task`（覆盖同一 Codex 任务的所有 delegation，通过 `taskScopeId` 继承）
- `taskScopeId`：task scope 的唯一继承标识，必须是 UUID。首次完整 task policy 省略时自动生成并返回；后续用 `{ "scope": "task", "taskScopeId": "..." }` 继承，禁止按 cwd/提示词猜测归属。未知或已清除的 ID 在 spawn 前失败，不会静默无策略执行。
- 首次 task delegation 即使失败或被取消，也会在 delegation 结果和 `cc_check` 中返回生成的 `taskScopeId`，便于新 session 继续继承。
- 清除：恢复某个 session 时传 `autoCompact:null` 会为该 session 写入清除标记；task policy 用 `{ "scope": "task", "taskScopeId": "...", "clear": true }` 清除。`taskScopeId:null` 无法指明目标任务，因此拒绝。

优先级：本次显式值 > session > task > 无。

新 delegation 启动前生成 Claude UUID，同时作为 provisional `claudeSessionId` 立即落盘并用 `--session-id`；resume 的 session ID 也在 spawn 前落盘，CLI 只用 `--resume`，二者不并存。取消后仍可用同一 `claudeSessionId` 主动 compact、再 resume。

输出区分 `target`（名义）、`effectiveWindow`（计算值 `ceil(target/0.9)`）、`observedBoundary`（transcript 实测，可能为 null）。Claude Code 会把 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 封顶到模型真实窗口，百分比 override 也只能把内建阈值调低；因此当自定义 Provider 实际窗口更小、模型内建阈值更早或 managed policy 覆盖时，插件不能保证精确命中用户声明值。

### 主动压缩已停止的会话

```
/claude:compact
```

`cc_compact` 对已停止的 Claude Code 会话运行只读前台 `/compact`。调用前先记录 transcript 文件游标；只有本次调用后新增的 canonical `compact_boundary` 才 `compacted:true`，历史 boundary 与 `isCompactSummary` 都不算。按 job 或显式 session 选择时都会拒绝 active/cancelling；session/task 临时策略会重放，delegation 策略不会。消息不足或证据读取失败返回 `false` + 原因，`observedBoundary` 未观察到时为 null。

### 延续规划（三选一）

```
/claude:delegate  →  cc_plan_continuation  →  cc_delegate / cc_compact
```

`cc_plan_continuation` 是只读工具（零模型调用），基于上一轮的内存 token 用量证据，在
`resume`、`compact_resume`、`fresh_handoff` 三种延续策略中选择，并返回一次性 `planId`。
计划和上下文遥测仅存在于当前 MCP 进程中，不写入 state/artifact/log。进程重启后旧
`planId` 失效；但显式 `same_session` 可以通过持久化 job 找回 canonical session，
重新生成一个可执行的 Resume 计划。

决策优先级：显式 `fresh` → Fresh；显式 `same_session` 永不 Fresh；`auto` 下根据
`relationship`、`contextValue`、`correctionCount`、drift、会话污染和上下文压力
（`≥ 75%` 且 `cache_read > 0` → Compact+Resume）决定。插件会自行核对 workspace、
Claude CLI 版本和 write/tool profile 漂移，并与调用者提供的 drift 信号合并。压力使用
上一轮最后一次可用 API 迭代的 token 用量及 Provider 报告的 `contextWindow`；多轮累计
账单用量不会冒充当前上下文。证据不完整时不猜 Compact。将 `planId` 作为
`continuationPlan` 传给 `cc_delegate` 或 `cc_compact` 即可执行所选动作并防止重放。

仓库提供独立校准器，只通过 source MCP 执行三条策略，不直接启动 Claude：

```bash
# 零费用：必须让 PATH 中的 claude 指向测试 fake
node plugins/cc-plugin-codex/scripts/calibrate-continuation.mjs --dry-run

# 真实付费：累计授权硬上限 $4.90，不自动重试
node plugins/cc-plugin-codex/scripts/calibrate-continuation.mjs --confirm-paid-calibration --model=Haiku
```

干净运行使用 6 次受限调用（2 个 seed、3 个 follow-up、1 个 compact）；Fresh 从
post-seed 文件快照启动但没有旧 Claude session。每次调用在发出前预留 $0.70，失败也
不退还预留；中断后续跑必须显式传入 `--prior-reserved-usd` 与
`--prior-paid-calls`，确保跨进程仍不突破总上限。一次校准只能作为方向性证据，不能
单独重设 75% pressure 阈值。

### 环境检查

```
/claude:setup
```

### 真实 Provider 连通性检查（会产生费用）

`cc_setup` 默认只做零成本静态检查。只有在你明确授权时，才传入
`livenessProbe: true`、正整数 `timeoutSeconds` 和正数 `maxBudgetUsd`；插件会先
验证 Claude CLI 的 `--max-budget-usd` 支持，再执行一次最小模型调用。可选 `model`
与 delegation 使用相同的 alias/native 语义，例如 `Opus` 或 `glm-5.2`。

失败会保留私有、脱敏的 probe 制品，并只返回安全 stage/reason；`rate_limited`
等 Provider 限制不是成功，也不会触发自动重试或静默 fallback。不要在 CI 中启用
liveness probe。

## MCP 工具

插件通过 MCP server 暴露 9 个工具，供 Codex 直接调用：

| 工具 | 说明 |
|------|------|
| `cc_delegate` | 分派编码任务给 Claude Code（默认继承 Provider 配置，支持 alias/native 模型路由、autoCompact 临时压缩策略、continuationPlan 延续计划） |
| `cc_resolve_route` | 只读模型路由解析器（不发起模型调用，不枚举 Provider 模型） |
| `cc_list_models` | 报告模型解析行为和最近完成任务的模型证据信息 |
| `cc_check` | 查看任务状态/结果 |
| `cc_cancel` | 取消运行中的任务（running→cancelling→cancelled，异步确认进程树退出和 lease 释放） |
| `cc_review` | 审查代码变更 |
| `cc_setup` | 环境检查（静态零模型调用 + 可选付费 liveness probe） |
| `cc_compact` | 对已停止的 Claude Code 会话运行只读 /compact，诚实报告是否跨越压缩边界 |
| `cc_plan_continuation` | 只读证据延续规划器（零模型调用，基于上一轮 token 用量选择 resume/compact_resume/fresh_handoff） |

## 项目结构

```
├── marketplace.json               # Marketplace 清单（支持 Git URL 安装）
├── package.json                   # 测试入口
└── plugins/cc-plugin-codex/
    ├── .codex-plugin/plugin.json  # Codex 插件清单
    ├── .mcp.json                  # MCP server 声明（stdio）
    ├── scripts/
    │   ├── cc-companion.mjs         # MCP server 主进程
    │   └── lib/
    │       ├── claude-runner.mjs  # watchdog 调用封装
    │       ├── watchdog.mjs       # Claude 监督运行器（print-mode JSON 协议）
    │       ├── routing.mjs        # 动态模型路由（selector 分类、route snapshot、child env）
    │       ├── route-status.mjs   # 路由状态计算（resolved/unverified/drift/rejected）
    │       ├── diagnostics.mjs    # 失败诊断 envelope（脱敏、有界、stage 分类）
    │       ├── git.mjs            # Git 集成（diff、review context）
    │       ├── job-log.mjs        # Job 日志和阶段追踪
    │       ├── process.mjs        # 进程管理
    │       ├── state.mjs          # Job 状态、writer lease 与保留策略（schema v8）
    │       ├── model-evidence.mjs # 模型证据模块统一出口
    │       ├── model-evidence-collector.mjs # 有界 transcript 采集
    │       ├── model-evidence-formatter.mjs # 统一安全展示
    │       ├── model-evidence-migration.mjs # 模型证据迁移（状态 schema 迁移由 state.mjs 管理）
    │       ├── model-evidence-shared.mjs # 常量与规范化
    │       ├── autocompact.mjs    # 自动压缩策略验证、内联 settings 注入、scope 解析
    │       ├── compact-boundary.mjs # 压缩边界采集（有界 transcript 读取）
    │       └── workspace.mjs      # 工作区解析
    ├── skills/                    # Codex skill 定义
    │   ├── delegate/SKILL.md
    │   ├── compact/SKILL.md
    │   ├── status/SKILL.md
    │   ├── review/SKILL.md
    │   ├── cancel/SKILL.md
    │   └── setup/SKILL.md
    ├── tests/                     # 测试套件
    └── schemas/
        └── review-output.schema.json  # 审查输出 JSON Schema
```

## 审查输出格式

所有审查结果遵循 `schemas/review-output.schema.json`：

```json
{
  "verdict": "approve|needs-attention|request_changes|reject",
  "summary": "ship/no-ship 评估",
  "findings": [{
    "severity": "critical|high|medium|low",
    "title": "问题标题",
    "body": "详细描述",
    "file": "src/foo.ts",
    "line_start": 42,
    "line_end": 45,
    "confidence": 0.9,
    "recommendation": "具体修复建议"
  }],
  "next_steps": ["修复 X", "补充 Y 的测试"]
}
```

## 本地验证

```bash
npm test
npm run verify:source
```

完整本地发布验证使用 `npm run verify`：它会检查源码、更新 cachebuster、重新安装插件、比对 source/cache 并运行 installed-cache tests。重新安装后需打开新的 Codex 任务加载新版本。

## 与 codex-plugin-cc 的对比

| 维度 | codex-plugin-cc | 本插件 |
|------|-----------------|--------|
| 方向 | Claude Code → Codex | Codex → Claude Code |
| 通信 | codex app-server JSON-RPC | claude --print --output-format json |
| 插件系统 | Claude Code 插件 | Codex 插件 |
| 任务执行 | Codex app-server turn | claude --print 子进程 |
| 审查 | Codex 内置 reviewer | Codex 自身审查 diff |

## License

MIT
