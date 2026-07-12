# PRD: Claude Code Companion — Codex Plugin

> 在 Codex 中分派编码任务给 Claude Code，完成后自动返回让 Codex 审查。

## 1. 背景

OpenAI 的 `codex-plugin-cc` 实现了 **Claude Code → Codex** 方向的集成（在 Claude Code 里调 Codex 做审查/任务）。本插件实现反向：**Codex → Claude Code**，让用户在 Codex 里把编码任务分派给 Claude Code，完成后自动返回结果触发 Codex 审查。

### 参考实现

- `codex-plugin-cc` v1.0.5：Claude Code 插件，通过 `codex app-server` JSON-RPC 协议与 Codex 通信
- Codex 插件生态：github, superpowers 等，使用 skill + MCP server 架构
- MCP 规范：2025-03-26 版，stdio 传输，JSON-RPC 消息格式

## 2. 目标用户

在 Codex 中工作、同时拥有 Claude Code 访问权限的开发者。典型场景：

1. 在 Codex 里构思方案，让 Claude Code 执行编码
2. Claude Code 完成后自动通知 Codex，触发代码审查
3. 对审查发现的问题，可以再次分派给 Claude Code 修复

## 3. 插件架构

### 3.1 整体结构

```
cc-plugin-codex/
├── .codex-plugin/
│   └── plugin.json              # Codex 插件清单
├── .mcp.json                    # MCP server 声明（stdio）
├── scripts/
│   ├── cc-companion.mjs         # MCP server 主进程
│   └── lib/
│       ├── claude-runner.mjs    # claude CLI 调用封装
│       ├── watchdog.mjs         # 监督、捕获与进程树终止
│       ├── state.mjs            # job 状态、lease 与保留策略
│       ├── model-evidence*.mjs  # 模型证据采集、展示与迁移
│       ├── git.mjs              # Git/review context 与 workspace fingerprint
│       ├── job-log.mjs          # 有界 lifecycle 日志
│       ├── process.mjs          # 进程管理
│       └── workspace.mjs        # 工作区解析
├── skills/
│   ├── delegate/SKILL.md        # 分派编码任务
│   ├── status/SKILL.md          # 查看执行状态
│   ├── review/SKILL.md          # 审查 Claude Code 产出
│   ├── cancel/SKILL.md          # 取消正在执行的任务
│   └── setup/SKILL.md           # 检测环境可用性
└── schemas/
    └── delegate-output.schema.json
```

### 3.2 通信方式

- **MCP Server（stdio）**：Codex 作为 MCP client，启动 `cc-companion.mjs` 作为子进程
- **Claude CLI 调用**：MCP server 通过 `claude -p` 非交互模式调用 Claude Code
- **Job 追踪**：schema v4 以原子 per-job 文件持久化到 `${os.tmpdir()}/cc-companion/<workspace-slug-hash>/jobs/`，目录和文件分别限制为 `0700`/`0600`

### 3.3 Codex 插件清单（plugin.json）

```json
{
  "name": "cc-plugin-codex",
  "version": "0.3.0+codex.<cachebuster>",
  "description": "Delegate coding tasks to Claude Code from Codex, then review the results.",
  "author": { "name": "Robert Wu" },
  "license": "MIT",
  "keywords": ["claude", "claude-code", "delegate", "review"],
  "skills": "./skills/",
  "mcpServers": "./.mcp.json",
  "interface": {
    "displayName": "Claude Code",
    "shortDescription": "Delegate coding tasks to Claude Code and review results",
    "longDescription": "Use Claude Code as a coding companion from within Codex. Delegate implementation tasks, check execution status, review changes with adversarial mode, and manage running jobs.",
    "category": "Developer Tools",
    "capabilities": ["Interactive", "Write"],
    "defaultPrompt": ["Delegate a coding task to Claude Code"]
  }
}
```

### 3.4 MCP Server 声明（.mcp.json）

```json
{
  "mcpServers": {
    "cc-plugin-codex": {
      "type": "stdio",
      "command": "node",
      "args": ["./scripts/cc-companion.mjs"],
      "cwd": ".",
      "tool_timeout_sec": 604800
    }
  }
}
```

## 4. MCP 工具定义

所有会读取或修改 job/workspace 状态的工具（`cc_delegate`、`cc_check`、`cc_cancel`、`cc_review`、`cc_setup`）都必须接收当前用户工作区的绝对路径 `cwd`。MCP server 自身运行在插件安装 cache 中，不能用 `process.cwd()` 推断用户项目；缺失、相对或无效的 `cwd` 必须直接报错，不能静默回退到 cache。`cc_review` 在没有历史 job 时仍可审查显式指定的 working-tree/branch target，并使用合成的审查任务标签。

### 4.1 `cc_delegate` — 分派编码任务

分派一个编码任务给 Claude Code。Claude Code 在独立进程中执行，完成后自动返回结果。

**输入 Schema：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `cwd` | string | ✅ | — | 用户当前工作区的绝对路径 |
| `task` | string | ✅ | — | 要执行的任务描述 |
| `write` | boolean | ❌ | `true` | 是否允许 Claude Code 写文件（`false` 严格限制为 Read/Glob/Grep） |
| `background` | boolean | ❌ | `false` | DEPRECATED AND REJECTED — 不再支持，设置为 `true` 会报错 |
| `model` | string | ❌ | — | 显式模型覆盖（自由格式，不验证）。省略时 Claude Code 继承当前 Provider 配置 |
| `effort` | string | ❌ | — | 推理努力度：`low`, `medium`, `high`, `xhigh`, `max` |
| `timeoutSeconds` | integer | ❌ | — | 可选硬超时（秒，1..604800）。省略时任务运行直到完成、失败、取消或服务器关闭 |
| `dangerouslySkipPermissions` | boolean | ❌ | `false` | 跳过权限确认（仅在显式传入 `true` 时开启） |

**行为：**

1. 生成 job ID，记录到 state
2. 构建 `claude` 命令（任务通过 stdin 传递，不出现在进程命令行中）：
   ```
   claude --output-format json \
     [--dangerously-skip-permissions] \
     [--model <model>] \
     [--effort <effort>] \
     [--allowedTools <tools>]
   ```
   - 若 `write=false`：`--allowedTools Read,Glob,Grep`（严格禁止 Bash）
   - 仅当 `dangerouslySkipPermissions=true` 时加 `--dangerously-skip-permissions`
   - 仅当 `model` 非空时加 `--model`，值原样传递不验证
   - 仅当 `timeoutSeconds` 为 1..604800 范围内的正整数时创建内部超时计时器；省略时不创建计时器
3. 前台执行（默认，唯一模式）：
   - 通过 watchdog 子进程执行，watchdog 通过 fd3 控制管道与 companion 通信
   - 任务通过 watchdog stdin → Claude stdin 传递，不出现在任何进程 argv 中
   - 保持同一次 `tools/call` pending；默认无内部超时，任务运行直到完成、失败、取消或服务器关闭
   - MCP server 在等待期间仍可处理 `cc_cancel` 等其他请求
   - MCP client 发出 `notifications/cancelled` 时，将 request ID 映射回对应 job，通过控制管道通知 watchdog 终止 Claude
   - companion 退出时，控制管道 EOF 触发 watchdog 终止 Claude
   - 解析 JSON 输出，提取 result、cost、touched files
   - 更新 job 状态为 completed
   - **自动返回结果**，包含摘要和修改的文件列表
4. `background=true`：已废弃并拒绝。不再支持 detached 模式。

**输出（前台完成时）：**

```json
{
  "content": [{
    "type": "text",
    "text": "## Task Completed\n\n**Job ID:** cc-abc123\n**Duration:** 12.3s\n**Cost:** $0.05\n**Requested model:** mimo-v2.5-pro\n**Claude-recorded execution model:** mimo-v2.5-pro\n**Provider usage key:** mimo-v2.5\n\n### Result\n<claude output>\n\n### Files Changed\n- src/foo.ts (modified)\n- src/bar.ts (created)\n\n---\n💡 Run `/claude:review` to review the changes, or `/claude:review --adversarial` for an adversarial review."
  }]
}
```

### 4.2 `cc_list_models` — 兼容性工具

兼容性工具：报告模型解析行为由 Claude Code 的 Provider 配置决定，说明可选的自由格式模型覆盖参数，并在有最近完成的本地任务时分开展示请求模型、Claude transcript 执行证据和 Provider usage key。不枚举、验证或维护模型目录。

**输入 Schema：** 可选 `cwd`。省略时只查看当前 MCP server 已记住的工作区；提供时必须是存在的绝对目录，并直接读取该工作区历史。

**输出：**

```json
{
  "content": [{
    "type": "text",
    "text": "## Model Configuration\n\nModel resolution is owned by Claude Code and its configured Provider...\n\n### Default Behavior\nWhen `model` is omitted from `cc_delegate`, Claude Code uses its current configured default...\n\n### Explicit Override\nSupply any non-empty `model` identifier to `cc_delegate`...\n\n### Latest Completed Job\n- **Job ID:** cc-abc123\n- **Requested model:** mimo-v2.5-pro\n- **Claude-recorded execution model:** mimo-v2.5-pro\n- **Provider usage key:** mimo-v2.5\n\n_Model evidence is historical from a past run, not a guarantee of current availability._"
  }]
}
```

实现方式：不维护硬编码模型目录，不查询 Provider 配置（避免暴露凭据），仅从本地 job 状态中读取分层模型证据。

### 4.3 `cc_check` — 查看任务状态/结果

**输入 Schema：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `cwd` | string | ✅ | — | 用户当前工作区的绝对路径 |
| `job` | string | ❌ | 最新 job | Job ID |
| `all` | boolean | ❌ | `false` | 列出所有 job |
| `wait` | boolean | ❌ | `false` | 等待完成（仅对 running job 有效） |
| `session` | boolean | ❌ | `false` | 只返回当前 MCP session 的 job |

**行为：**

- `all=true`：返回所有 job 的摘要表格
- `all=false` + 无 `job`：返回**最新一个 job** 的详情
- `all=false` + 有 `job`：返回指定 job 的详情
- `wait=true`：轮询直到 job 完成（超时 4 分钟），然后返回完整结果

**输出（单个 job 详情）：**

```json
{
  "content": [{
    "type": "text",
    "text": "## Job: cc-abc123\n\n**Status:** completed\n**Task:** Implement user auth middleware\n**Requested model:** mimo-v2.5-pro\n**Claude-recorded execution model:** mimo-v2.5-pro\n**Provider usage key:** mimo-v2.5\n**Effort:** high\n**Duration:** 12.3s\n**Cost:** $0.05\n**Started:** 2026-07-06T10:00:00Z\n**Completed:** 2026-07-06T10:00:12Z\n\n### Result\n<full output>\n\n### Files Changed\n- src/auth.ts\n- tests/auth.test.ts"
  }]
}
```

**输出（all=true 摘要表格）：**

```
| Job ID | Status | Task | Model Evidence | Duration |
|--------|--------|------|----------------|----------|
| cc-abc123 | completed | Implement auth | mimo-v2.5-pro | 12.3s |
| cc-def456 | running | Fix CSS bug | inherited | — |
```

### 4.4 `cc_cancel` — 取消任务

**输入 Schema：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `cwd` | string | ✅ | — | 用户当前工作区的绝对路径 |
| `job` | string | ❌ | 最新活跃 job | Job ID |

**行为：**

- 无 `job`：找到最新的 `running`/`queued` job 并取消
- 有 `job`：取消指定 job
- 终止 claude 子进程树
- 更新 job 状态为 `cancelled`

### 4.5 `cc_review` — 审查 Claude Code 产出

**输入 Schema：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `cwd` | string | ✅ | — | 用户当前工作区的绝对路径 |
| `job` | string | ❌ | 最新已完成 job | Job ID |
| `adversarial` | boolean | ❌ | `false` | 对抗审查模式 |
| `focus` | string | ❌ | — | 审查关注点 |
| `base` | string | ❌ | `HEAD~1` | Git diff 基准 |
| `scope` | string | ❌ | `auto` | 审查范围：`auto`、`working-tree`、`branch` |

**行为：**

1. 找到目标 job（默认最新的 completed job）
2. 获取该 job 修改的文件列表（从 job 记录或 `git diff --name-only`）
3. 构建审查 prompt：
   - 普通模式：审查代码正确性、风格、潜在问题
   - 对抗模式（`adversarial=true`）：质疑实现选择、设计假设、边界条件、失败模式
4. 返回审查结果，Codex 自行决定是否需要修复

**注意：** 这个工具返回审查 prompt 和 diff 内容，由 Codex 自身执行审查（Codex 是审查者，不是调 Claude Code 审查）。

### 4.6 `cc_setup` — 环境检测

**输入 Schema：** 必填 `cwd`（用户当前工作区的绝对路径）

**行为：**

1. 检测 `claude` CLI 是否可用（`claude --version`）
2. 检测 Claude Code 版本
3. 检测 `node` 是否可用
4. 返回环境状态

**输出：**

```json
{
  "content": [{
    "type": "text",
    "text": "## Claude Code Companion Setup\n\n✅ Claude Code: v2.1.201\n✅ Node.js: v22.x\n✅ Plugin ready\n\nNo issues found. Use `/claude:delegate` to start delegating tasks."
  }]
}
```

## 5. Skills 定义

### 5.1 `delegate` — 分派编码任务

**触发：** 用户要求把编码任务交给 Claude Code

**工作流：**

1. 调用 `cc_delegate`，传入 task（model 和 effort 可选）
   - 默认不传 model，Claude Code 继承当前 Provider 配置
   - 用户明确指定模型时，传入任意 model 标识（自由格式，不验证）
   - effort 与 model 独立，不耦合
2. 等待结果返回
3. 向用户展示结果摘要（分开标注请求模型、Claude-recorded execution model 和 Provider usage key）
4. **自动提示**：任务已完成，建议运行 `/claude:review` 审查

### 5.2 `status` — 查看执行状态

**触发：** 用户想看 Claude Code 任务的状态

**工作流：**

1. 调用 `cc_check`
   - 用户指定 job ID → 传 `job` 参数
   - 用户说"所有"/"全部" → 传 `all=true`
   - 始终传当前工作区的绝对 `cwd`
   - 默认只传 `cwd`（返回最新 job）

### 5.3 `review` — 审查产出

**触发：** 用户要求审查 Claude Code 的代码产出

**工作流：**

1. 确定审查模式：
   - 用户说"对抗"/"adversarial"/"质疑" → `adversarial=true`
   - 默认 → 普通审查
2. 调用 `cc_review`，传入参数
3. Codex 根据审查结果决定下一步

### 5.4 `cancel` — 取消任务

**触发：** 用户要取消正在运行的 Claude Code 任务

**工作流：**

1. 调用 `cc_cancel`
   - 用户指定 job ID → 传 `job` 参数
   - 始终传当前工作区的绝对 `cwd`
   - 默认只传 `cwd`（取消最新活跃 job）

### 5.5 `setup` — 环境检测

**触发：** 用户首次使用或遇到问题

**工作流：**

1. 调用 `cc_setup`
2. 如果 Claude Code 不可用，提示安装：`npm install -g @anthropic-ai/claude-code`

## 6. MCP Server 实现

### 6.1 协议实现

`cc-companion.mjs` 实现 MCP stdio 传输：

1. 从 stdin 读取 JSON-RPC 消息（换行分隔）
2. 处理 `initialize` → 返回 capabilities（tools）
3. 处理 `initialized` 通知
4. 处理 `tools/list` → 返回 6 个工具定义
5. 处理 `tools/call` → Promise-aware 路由到对应 handler；pending delegate 不阻塞后续消息
6. 处理 `notifications/cancelled` → 取消对应 pending job 与进程树，并抑制迟到的正常响应
7. 结果写入 stdout（JSON-RPC response）
8. 日志写入 stderr

### 6.2 Claude CLI 调用（claude-runner.mjs）

`claude-runner.mjs` 启动独立 watchdog。companion 通过 watchdog stdin 发送一次性配置，并用 IPC channel 保持取消/父进程死亡信号；watchdog 再把任务写入 Claude stdin。模型参数只有在用户显式提供时才以独立 argv 传入；`write=false` 固定为 `Read,Glob,Grep`。watchdog 对 stdout/stderr 共享 8 MiB 捕获预算，并在 POSIX/Windows 上终止完整 Claude 进程树。

### 6.3 Job 状态管理（state.mjs）

Job 记录结构：

```json
{
  "id": "cc-abc123",
  "status": "running",
  "phase": "executing",
  "taskPreview": "Implement user auth",
  "taskHash": "sha256...",
  "requestedModel": "mimo-v2.5-pro",
  "requestMode": "explicit",
  "modelEvidence": {
    "status": "complete",
    "executedModels": [{"id": "mimo-v2.5-pro", "source": "claude-transcript", "scopes": ["main"]}],
    "usageModelKeys": ["mimo-v2.5"],
    "usageSource": "claude-result-modelUsage",
    "warnings": []
  },
  "effort": "high",
  "write": true,
  "ownerServerId": "session-...",
  "claudeSessionId": null,
  "pid": 12345,
  "createdAt": "2026-07-06T10:00:00Z",
  "updatedAt": "2026-07-06T10:00:00Z",
  "completedAt": null,
  "result": null,
  "cost": null,
  "duration": null,
  "touchedFiles": [],
  "errorMessage": null
}
```

状态：`queued` → `running` → `completed` | `failed` | `cancelled` | `orphaned`。单个 metadata 文件最大 64 KiB；完整结果进入独立 artifact。写任务通过原子 writer lease 串行化，lease 每 60 秒续约。

### 6.4 进程管理（process.mjs）

- `terminateProcessTree(pid)` — POSIX 终止 Claude 独立进程组，Windows 使用 `taskkill /T /F`
- `binaryAvailable(command)` — 检测 CLI 可用性

## 7. 自动返回机制

**前台 delegate 完成后自动返回：**

MCP 工具 `cc_delegate` 默认在同一次 pending 工具调用中等待 Claude Code 子进程完成，解析输出后只返回一次结果。Codex 作为 MCP client 收到工具返回值后自然继续执行；普通任务和长任务都不需要外层 `sleep`、重复 `cc_check` 或周期性“仍在运行” commentary。Codex 必须直接调用已注册的 `cc_delegate`；若工具未注册，应进入 setup/restart 排障，不得通过 shell/PTY 手工启动 server 并模拟轮询等待。

**后台模式已废弃：**

`background=true` 在此版本中被拒绝。所有任务以前台模式运行，通过 watchdog 进程管理 Claude 的生命周期。watchdog 通过控制管道（fd3）与 companion 通信，companion 退出时自动终止 Claude。

**delegate skill 的完整工作流：**

```
用户: "让 Claude Code 实现 auth middleware"
  → Codex 调用 cc_delegate(task="...")
  → MCP server 启动 claude -p "..." （不传 --model，继承 Provider 配置）
  → Claude Code 执行任务
  → MCP server 解析输出，返回分层模型证据
  → Codex 展示摘要 + 提示 "Run /claude:review to review"
```

## 8. 对抗审查模式

`cc_review` 的 `adversarial=true` 模式与普通审查的区别：

| 维度 | 普通审查 | 对抗审查 |
|------|----------|----------|
| 目标 | 找 bug、风格问题 | 质疑实现选择和设计假设 |
| 视角 | "这段代码有什么问题？" | "这个方案为什么是对的？在什么条件下会失败？" |
| 关注 | 正确性、可读性 | 架构权衡、边界条件、失败模式、替代方案 |
| 输出 | bug 列表 + 修复建议 | 风险分析 + 假设列表 + 替代方案 |

实现：`cc_review` 工具返回 diff + 审查 prompt，Codex 自身执行审查逻辑。对抗模式的 prompt 模板：

```
You are reviewing code changes made by Claude Code. Challenge the implementation approach:

1. What assumptions does this implementation depend on? Are they valid?
2. Under what conditions would this approach fail or degrade?
3. Are there simpler alternative approaches that were not considered?
4. Does this create any technical debt or maintenance burden?
5. Are the edge cases handled correctly?

Changes:
<diff>

Focus: <focus or "general">
```

## 9. 与 codex-plugin-cc 的对比

| 维度 | codex-plugin-cc（原插件） | 本插件（反向） |
|------|--------------------------|----------------|
| 方向 | Claude Code → Codex | Codex → Claude Code |
| 通信协议 | codex app-server JSON-RPC | claude -p CLI |
| 插件系统 | Claude Code 插件 | Codex 插件 |
| Hook | SessionStart/End/Stop | 无（Codex 插件无 hook） |
| 任务执行 | Codex app-server turn | claude -p 子进程 |
| 审查 | Codex 内置 reviewer | Codex 自身审查 diff |
| Broker | 有（共享 app-server） | 无（直接 spawn） |

## 10. 非目标

- 不实现 session transfer（Claude Code → Codex 的迁移）
- 不实现 stop-time review gate hook（Codex 插件不支持 hook）
- 不实现 Claude Code 的 app-server 协议（Claude Code 没有这个）
- 不做 Codex 内置 review 的替代品（审查由 Codex 自身执行）

## 11. 实现顺序

1. **MCP server 骨架**：cc-companion.mjs + JSON-RPC 协议处理
2. **lib 模块**：claude-runner, state, process, workspace
3. **cc_setup**：最简单，先跑通 MCP 通信
4. **cc_delegate**：核心功能，前台模式优先
5. **cc_list_models**：辅助工具
6. **cc_check**：状态查询
7. **cc_cancel**：进程终止
8. **cc_review**：审查 + 对抗模式
9. **Skills**：5 个 SKILL.md
10. **测试**：本地 marketplace 安装 + 端到端验证
