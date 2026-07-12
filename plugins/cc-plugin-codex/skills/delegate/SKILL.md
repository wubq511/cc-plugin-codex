---
name: delegate
description: Use when you want to delegate a coding task to Claude Code — it executes the task and returns results for review
---

# Delegate to Claude Code

## Overview

Send a coding task to Claude Code for execution. Claude Code runs in a separate process, completes the task, and returns results automatically. After completion, you should review the changes.

## Workflow

1. **Delegate the task** by calling `cc_delegate`:
   - `cwd` (required): absolute path to the user's current workspace
   - `task` (required): the coding task description
   - `model` (optional): explicit model override for this delegation. When omitted, Claude Code uses its current configured default (inherited from the user's Provider). Accepts any non-empty identifier — the plugin does not validate model names.
   - `effort` (optional): reasoning effort level (low, medium, high, xhigh, max)
   - `write`: set to `true` (default) to allow file writes, `false` for read-only analysis (strictly limits tools to Read, Glob, Grep)
   - `background`: DEPRECATED AND REJECTED. Do not pass `background=true` — it will always produce an error. Default foreground delegation waits silently without polling.
   - `timeoutSeconds` (optional): hard timeout in seconds (1..604800). When omitted, the task runs until it completes, fails, is cancelled, or the server shuts down. Supply only when the user explicitly requests a deadline.
   - `dangerouslySkipPermissions`: set to `true` to let Claude Code write without confirmation (default: false)
   - `resume`: set to `true` to resume the last completed plugin job in this workspace that has a claudeSessionId. Cannot be combined with resumeSession.
   - `resumeSession`: pass a session ID to resume a specific Claude Code session (adds `--resume <id>`). Cannot be combined with resume.

   Call the registered `cc_delegate` MCP tool directly. You may announce the delegation once before the tool call, then remain silent while it is pending. Do not manually start `cc-companion.mjs`, wrap it in a shell/PTY, or emit periodic "still running" commentary. If the registered `cc_*` tools are unavailable, use the setup workflow and ask the user to restart or open a new task; never emulate delegation with a polling fallback.

2. **Present results** to the user when the task completes.

3. **Suggest review**: After a completed task, tell the user:
   > "Task completed. Run `/claude:review` to review the changes, or `/claude:review --adversarial` for a deeper review."

## Model Selection

Model resolution is owned by Claude Code and its configured Provider. This plugin does not maintain or recommend a model catalogue.

- **Default**: omit `model` — Claude Code uses its current configured default (inherited).
- **Override**: supply any non-empty `model` identifier — the value is passed through exactly.
- **Effort** is independent from model selection and is not coupled to any specific model.

After completion, the job reports three distinct model evidence fields:
- **Requested model**: the explicit override (if any) or "inherited from Claude Code configuration"
- **Claude-recorded execution model**: the model(s) recorded in the Claude Code session transcript (`message.model`)
- **Provider usage key**: the key(s) from the final JSON `modelUsage` object (billing/aggregation dimension)

Execution model and usage key have different semantics and may differ (e.g., execution model `mimo-v2.5-pro` vs usage key `mimo-v2.5`). The plugin never treats a usage key as an execution model.

Do not call `cc_list_models` before ordinary delegation — it does not enumerate available models.

## Resume

When the user wants to continue a previous Claude Code session:
- "keep going", "resume", "continue" → `cc_delegate` with `resume=true`
- "resume session abc123" → `cc_delegate` with `resumeSession="abc123"`
- "fresh start" → `cc_delegate` without resume flags (new session)

## Examples

- "Have Claude Code implement the auth middleware"
- "Delegate the CSS fix to Claude Code"
- "Ask Claude Code to refactor the database layer"
- "Resume the last Claude Code session and keep going" → `resume=true`
- "Continue Claude Code session cc-abc123" → `resumeSession="..."`

## Notes

- `cc_delegate` defaults to foreground mode — it waits for Claude Code to finish and returns results immediately.
- Long-running tasks also stay in foreground: keep the single tool call pending until completion. Do not run outer `sleep` commands or repeatedly call `cc_check` while a normal delegate is pending.
- A pending foreground call is silent: do not send recurring progress/commentary messages merely to say that Claude Code has not finished. The next model action should occur after `cc_delegate` returns.
- `background=true` is deprecated and rejected unconditionally. Default foreground delegation waits silently without polling.
- The task prompt is sent via stdin (never argv) for privacy — it does not appear in any process command line. Be specific about what you want done.
- Job ID supports prefix matching: "cc-abc" matches "cc-abc123def".
- When `model` is omitted, no `--model` argument is sent — Claude Code inherits its configured default.
- When `model` is supplied, it is passed after `--model` unchanged.
- `write=false` strictly prohibits Bash and write-capable tools; only Read, Glob, and Grep are exposed.
- Only one write-enabled delegation can run per workspace at a time (writer lease). Read-only delegations can run concurrently.
- Resume=true resolves to the latest completed plugin job with a claudeSessionId in the same workspace, not a global resume-last.
