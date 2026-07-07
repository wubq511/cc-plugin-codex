# Claude Code Companion — Codex Plugin

> 在 Codex 中分派编码任务给 Claude Code，完成后自动返回结果供 Codex 审查。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 这是什么

一个 [Codex](https://codex.openai.com/) 插件，实现 **Codex → Claude Code** 方向的集成。让你在 Codex 里把编码任务交给 Claude Code 执行，完成后自动返回结果，并可以对产出做标准审查或对抗审查。

与 OpenAI 官方的 `codex-plugin-cc`（Claude Code → Codex）方向相反，互为补充。

## 功能

- **分派任务** — 把编码任务交给 Claude Code，选择模型和推理强度
- **前台/后台执行** — 前台模式等待完成立即返回，后台模式立即返回 job ID
- **状态追踪** — 实时查看任务进度、阶段、耗时、成本
- **代码审查** — 标准审查（找 bug）或对抗审查（质疑实现选择、攻击面分析）
- **会话恢复** — 支持恢复上一次 Claude Code 会话继续工作
- **Job 管理** — 前缀匹配、会话过滤、取消运行中的任务

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

Codex 会根据任务复杂度自动选择模型：

| 任务类型 | 模型 | 推理强度 |
|----------|------|----------|
| 修 typo、简单 bug | haiku | low |
| 功能实现 | sonnet | medium |
| 复杂重构 | opus | high |
| 跨模块重设计 | fable | xhigh |

也可以手动指定模型和推理强度。

### 查看状态

```
/claude:status        # 最新任务
/claude:status --all  # 所有任务
```

### 审查产出

```
/claude:review              # 标准审查
/claude:review --adversarial  # 对抗审查
```

**标准审查**：检查正确性、bug、安全、性能、可维护性。

**对抗审查**：质疑实现选择，分析攻击面（认证/数据丢失/竞态条件/可观测性缺口），要求每个发现都有具体代码位置和修复建议。

### 取消任务

```
/claude:cancel
```

### 环境检查

```
/claude:setup
```

## MCP 工具

插件通过 MCP server 暴露 6 个工具，供 Codex 直接调用：

| 工具 | 说明 |
|------|------|
| `cc_delegate` | 分派编码任务给 Claude Code |
| `cc_list_models` | 列出可用模型和推荐配置 |
| `cc_check` | 查看任务状态/结果 |
| `cc_cancel` | 取消运行中的任务 |
| `cc_review` | 审查代码变更 |
| `cc_setup` | 检查环境可用性 |

## 项目结构

```
├── marketplace.json               # Marketplace 清单（支持 Git URL 安装）
└── plugins/cc-plugin-codex/
    ├── .codex-plugin/plugin.json  # Codex 插件清单
    ├── .mcp.json                  # MCP server 声明（stdio）
    ├── scripts/
    │   ├── cc-companion.mjs         # MCP server 主进程
    │   └── lib/
    │       ├── claude-runner.mjs  # claude CLI 调用封装
    │       ├── git.mjs            # Git 集成（diff、review context）
    │       ├── job-log.mjs        # Job 日志和阶段追踪
    │       ├── process.mjs        # 进程管理
    │       ├── state.mjs          # Job 状态持久化
    │       └── workspace.mjs      # 工作区解析
    ├── skills/                    # Codex skill 定义
    │   ├── delegate/SKILL.md
    │   ├── status/SKILL.md
    │   ├── review/SKILL.md
    │   ├── cancel/SKILL.md
    │   └── setup/SKILL.md
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

## 与 codex-plugin-cc 的对比

| 维度 | codex-plugin-cc | 本插件 |
|------|-----------------|--------|
| 方向 | Claude Code → Codex | Codex → Claude Code |
| 通信 | codex app-server JSON-RPC | claude -p CLI |
| 插件系统 | Claude Code 插件 | Codex 插件 |
| 任务执行 | Codex app-server turn | claude -p 子进程 |
| 审查 | Codex 内置 reviewer | Codex 自身审查 diff |

## License

MIT
