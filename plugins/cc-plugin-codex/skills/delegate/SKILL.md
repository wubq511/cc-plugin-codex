---
name: delegate
description: Use when you want to delegate a coding task to Claude Code — it executes the task and returns results for review
---

# Delegate to Claude Code

## Overview

Send a coding task to Claude Code for execution. Claude Code runs in a separate process, completes the task, and returns results automatically. After completion, you should review the changes.

## Workflow

1. **Assess task complexity** to pick model and effort:
   - Call `cc_list_models` to see available options
   - Simple (typo fix, small bug): `haiku` + `low`
   - Medium (feature implementation, single file): `sonnet` + `medium`
   - Complex (multi-file refactor, architecture): `opus` + `high`
   - Very complex (cross-module redesign, critical path): `fable` + `xhigh`

2. **Delegate the task** by calling `cc_delegate`:
   - `task` (required): the coding task description
   - `model`: chosen model alias
   - `effort`: chosen effort level
   - `write`: set to `true` (default) to allow file writes, `false` for read-only analysis
   - `background`: set to `true` to run in background and return immediately
   - `dangerouslySkipPermissions`: set to `true` to let Claude Code write without confirmation (default: false)
   - `resume`: set to `true` to continue the last Claude Code session (adds `--resume-last`)
   - `resumeSession`: pass a session ID to resume a specific Claude Code session (adds `--resume <id>`)

3. **Present results** to the user when the task completes.

4. **Suggest review**: After a completed task, tell the user:
   > "Task completed. Run `/claude:review` to review the changes, or `/claude:review --adversarial` for a deeper review."

## Resume

When the user wants to continue a previous Claude Code session:
- "keep going", "resume", "continue" → `cc_delegate` with `resume=true`
- "resume session abc123" → `cc_delegate` with `resumeSession="abc123"`
- "fresh start" → `cc_delegate` without resume flags (new session)

## Model Selection Guide

| Task Type | Model | Effort |
|-----------|-------|--------|
| Typo fix, simple bug | haiku | low |
| Feature implementation | sonnet | medium |
| Complex refactor | opus | high |
| Cross-module redesign | fable | xhigh |

## Examples

- "Have Claude Code implement the auth middleware"
- "Delegate the CSS fix to Claude Code"
- "Ask Claude Code to refactor the database layer"
- "Resume the last Claude Code session and keep going" → `resume=true`
- "Continue Claude Code session cc-abc123" → `resumeSession="..."`

## Notes

- `cc_delegate` defaults to foreground mode — it waits for Claude Code to finish and returns results immediately.
- For long-running tasks, use `background=true` and check progress with `/claude:status`.
- The task prompt is passed directly to `claude -p`. Be specific about what you want done.
- Job ID supports prefix matching: "cc-abc" matches "cc-abc123def".
