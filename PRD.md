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
│       ├── state.mjs            # job 状态持久化
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
- **Job 追踪**：状态持久化到 `${os.tmpdir()}/cc-companion/<workspace-slug-hash>/state.json`

### 3.3 Codex 插件清单（plugin.json）

```json
{
  "name": "claude-code",
  "version": "0.1.0",
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
    "claude-code": {
      "type": "stdio",
      "command": "node",
      "args": ["${PLUGIN_DIR}/scripts/cc-companion.mjs"]
    }
  }
}
```

## 4. MCP 工具定义

### 4.1 `cc_delegate` — 分派编码任务

分派一个编码任务给 Claude Code。Claude Code 在独立进程中执行，完成后自动返回结果。

**输入 Schema：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `task` | string | ✅ | — | 要执行的任务描述 |
| `write` | boolean | ❌ | `true` | 是否允许 Claude Code 写文件 |
| `background` | boolean | ❌ | `false` | 是否后台执行（立即返回 job ID） |
| `model` | string | ❌ | — | Claude 模型别名：`fable`, `opus`, `sonnet`, `haiku` |
| `effort` | string | ❌ | — | 推理努力度：`low`, `medium`, `high`, `xhigh`, `max` |
| `dangerouslySkipPermissions` | boolean | ❌ | `true` | 跳过权限确认（默认开启以让任务跑通） |

**行为：**

1. 生成 job ID，记录到 state
2. 构建 `claude -p` 命令：
   ```
   claude -p "<task>" \
     --output-format json \
     --dangerously-skip-permissions \
     [--model <model>] \
     [--effort <effort>] \
     [--allowedTools <tools>]
   ```
   - 若 `write=false`：加 `--allowedTools "Read,Glob,Grep,Bash(git*)"` 限制为只读
   - 若 `dangerouslySkipPermissions=false`：去掉 `--dangerously-skip-permissions`
3. 若 `background=false`（前台）：
   - 同步执行，等待完成
   - 解析 JSON 输出，提取 result、cost、touched files
   - 更新 job 状态为 completed
   - **自动返回结果**，包含摘要和修改的文件列表
   - 返回内容中包含提示：`"Task completed. Run /claude-code:review to review the changes."`
4. 若 `background=true`：
   - detached spawn，立即返回 `{ jobId, status: "running" }`
   - 子进程完成后更新 state

**输出（前台完成时）：**

```json
{
  "content": [{
    "type": "text",
    "text": "## Task Completed\n\n**Job ID:** cc-abc123\n**Duration:** 12.3s\n**Cost:** $0.05\n**Model:** claude-fable-5\n\n### Result\n<claude output>\n\n### Files Changed\n- src/foo.ts (modified)\n- src/bar.ts (created)\n\n---\n💡 Run `/claude-code:review` to review the changes, or `/claude-code:review --adversarial` for an adversarial review."
  }]
}
```

### 4.2 `cc_list_models` — 列出可用模型

返回 Claude Code 可用模型列表，供 Codex 根据任务难度选择合适的 model 和 effort。

**输入 Schema：** 无参数

**输出：**

```json
{
  "content": [{
    "type": "text",
    "text": "## Available Claude Models\n\n| Alias | Full Model ID | Best For | Recommended Effort |\n|-------|---------------|----------|--------------------|\n| fable | claude-fable-5 | Complex architecture, multi-step reasoning | high, xhigh, max |\n| opus | claude-opus-4-8 | Deep analysis, careful reasoning | high, xhigh |\n| sonnet | claude-sonnet-5 | Balanced speed and quality | medium, high |\n| haiku | claude-haiku-4-5-20251001 | Quick tasks, simple changes | low, medium |\n\n### Selection Guide\n- **Simple bug fix / typo**: haiku + low\n- **Feature implementation**: sonnet + medium\n- **Complex refactor / architecture**: opus + high\n- **Multi-file redesign / critical path**: fable + xhigh"
  }]
}
```

实现方式：硬编码已知模型信息（Claude 模型列表相对稳定），同时运行 `claude --version` 确认 Claude Code 可用。

### 4.3 `cc_check` — 查看任务状态/结果

**输入 Schema：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `job` | string | ❌ | 最新 job | Job ID |
| `all` | boolean | ❌ | `false` | 列出所有 job |
| `wait` | boolean | ❌ | `false` | 等待完成（仅对 running job 有效） |

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
    "text": "## Job: cc-abc123\n\n**Status:** completed\n**Task:** Implement user auth middleware\n**Model:** claude-fable-5\n**Effort:** high\n**Duration:** 12.3s\n**Cost:** $0.05\n**Started:** 2026-07-06T10:00:00Z\n**Completed:** 2026-07-06T10:00:12Z\n\n### Result\n<full output>\n\n### Files Changed\n- src/auth.ts\n- tests/auth.test.ts"
  }]
}
```

**输出（all=true 摘要表格）：**

```
| Job ID | Status | Task | Model | Duration |
|--------|--------|------|-------|----------|
| cc-abc123 | completed | Implement auth | fable | 12.3s |
| cc-def456 | running | Fix CSS bug | sonnet | — |
```

### 4.4 `cc_cancel` — 取消任务

**输入 Schema：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `job` | string | ❌ | 最新活跃 job | Job ID |

**行为：**

- 无 `job`：找到最新的 `running`/`queued` job 并取消
- 有 `job`：取消指定 job
- 发送 SIGTERM 终止 claude 子进程
- 更新 job 状态为 `cancelled`

### 4.5 `cc_review` — 审查 Claude Code 产出

**输入 Schema：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `job` | string | ❌ | 最新已完成 job | Job ID |
| `adversarial` | boolean | ❌ | `false` | 对抗审查模式 |
| `focus` | string | ❌ | — | 审查关注点 |
| `base` | string | ❌ | `HEAD~1` | Git diff 基准 |

**行为：**

1. 找到目标 job（默认最新的 completed job）
2. 获取该 job 修改的文件列表（从 job 记录或 `git diff --name-only`）
3. 构建审查 prompt：
   - 普通模式：审查代码正确性、风格、潜在问题
   - 对抗模式（`adversarial=true`）：质疑实现选择、设计假设、边界条件、失败模式
4. 返回审查结果，Codex 自行决定是否需要修复

**注意：** 这个工具返回审查 prompt 和 diff 内容，由 Codex 自身执行审查（Codex 是审查者，不是调 Claude Code 审查）。

### 4.6 `cc_setup` — 环境检测

**输入 Schema：** 无参数

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
    "text": "## Claude Code Companion Setup\n\n✅ Claude Code: v2.1.201\n✅ Node.js: v22.x\n✅ Plugin ready\n\nNo issues found. Use `/claude-code:delegate` to start delegating tasks."
  }]
}
```

## 5. Skills 定义

### 5.1 `delegate` — 分派编码任务

**触发：** 用户要求把编码任务交给 Claude Code

**工作流：**

1. 先调用 `cc_list_models` 获取可用模型
2. 根据任务复杂度评估，选择合适的 model + effort：
   - 简单（修 typo、小 bug）：haiku + low
   - 中等（功能实现、单文件改动）：sonnet + medium
   - 复杂（多文件重构、架构改动）：opus + high
   - 极复杂（跨模块重设计、关键路径）：fable + xhigh
3. 调用 `cc_delegate`，传入 task + 选定的 model + effort
4. 等待结果返回
5. 向用户展示结果摘要
6. **自动提示**：任务已完成，建议运行 `/claude-code:review` 审查

### 5.2 `status` — 查看执行状态

**触发：** 用户想看 Claude Code 任务的状态

**工作流：**

1. 调用 `cc_check`
   - 用户指定 job ID → 传 `job` 参数
   - 用户说"所有"/"全部" → 传 `all=true`
   - 默认 → 不传参数（返回最新 job）

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
   - 默认 → 不传参数（取消最新活跃 job）

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
5. 处理 `tools/call` → 路由到对应 handler
6. 结果写入 stdout（JSON-RPC response）
7. 日志写入 stderr

### 6.2 Claude CLI 调用（claude-runner.mjs）

```javascript
// 核心调用方式
function buildClaudeCommand(task, options) {
  const args = ["-p", task, "--output-format", "json"];
  
  if (options.dangerouslySkipPermissions !== false) {
    args.push("--dangerously-skip-permissions");
  }
  
  if (options.model) args.push("--model", options.model);
  if (options.effort) args.push("--effort", options.effort);
  
  if (!options.write) {
    args.push("--allowedTools", "Read,Glob,Grep,Bash(git*)");
  }
  
  return { command: "claude", args };
}
```

### 6.3 Job 状态管理（state.mjs）

Job 记录结构：

```json
{
  "id": "cc-abc123",
  "status": "running",
  "phase": "executing",
  "task": "Implement user auth",
  "model": "fable",
  "effort": "high",
  "write": true,
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

状态：`queued` → `running` → `completed` | `failed` | `cancelled`

### 6.4 进程管理（process.mjs）

- `spawnDetached(command, args)` — 启动后台 claude 进程
- `terminateProcessTree(pid)` — 通过 `-pid` 杀进程组
- `binaryAvailable(command)` — 检测 CLI 可用性

## 7. 自动返回机制

**前台 delegate 完成后自动返回：**

MCP 工具 `cc_delegate` 在前台模式下同步等待 claude 进程完成，解析输出后直接返回结果。Codex 作为 MCP client 收到工具返回值后自然继续执行。

**后台 delegate 完成后通知：**

后台模式下，子进程完成后更新 state。用户通过 `cc_check` 或 skill `/claude-code:status` 查看结果。可以在 SKILL.md 中指导 Codex 定期轮询。

**delegate skill 的完整工作流：**

```
用户: "让 Claude Code 实现 auth middleware"
  → Codex 调用 cc_list_models
  → Codex 评估任务复杂度，选择 model=sonnet, effort=medium
  → Codex 调用 cc_delegate(task="...", model="sonnet", effort="medium")
  → MCP server 启动 claude -p "..." --model sonnet --effort medium
  → Claude Code 执行任务
  → MCP server 解析输出，返回结果
  → Codex 展示摘要 + 提示 "Run /claude-code:review to review"
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
