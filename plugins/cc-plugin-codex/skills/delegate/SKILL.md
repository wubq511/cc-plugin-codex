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
   - `resume`: set to `true` only when the user explicitly asks to preserve the same/latest Claude Code conversation. It resumes the last completed plugin job in this workspace that has a claudeSessionId. Cannot be combined with resumeSession.
   - `resumeSession`: pass a session ID only when the user explicitly identifies the Claude Code conversation to preserve (adds `--resume <id>`). Cannot be combined with resume.

   Call the registered `cc_delegate` MCP tool directly. You may announce the delegation once before the tool call, then remain silent while it is pending. Do not manually start `cc-companion.mjs`, wrap it in a shell/PTY, or emit periodic "still running" commentary. If the registered `cc_*` tools are unavailable, use the setup workflow and ask the user to restart or open a new task; never emulate delegation with a polling fallback.

2. **Present results** to the user when the task completes.

3. **Suggest review**: After a completed task, tell the user:
   > "Task completed. Run `/claude:review` to review the changes, or `/claude:review --adversarial` for a deeper review."

## Model Selection

Model resolution uses three selector kinds, resolved per job against the active Provider profile:

- **inherited** (default): omit `model` — no `--model` argument is sent. Claude Code uses its current configured default.
- **alias**: `Opus`, `Fable`, `Sonnet`, `Haiku` (case-insensitive). Normalized to the canonical lowercase Claude CLI alias (e.g., `Opus` → `--model opus`).
- **native**: a model ID with at least one digit and no spaces (e.g., `deepseek-v4-pro`, `glm-5.2`). Passed through unchanged as `--model <id>`.

Ambiguous selectors (no digit, not a known alias) are **rejected** — the plugin does not guess or silently fall back. Ask the user to clarify.

Use `cc_resolve_route` to preview how a selector will be routed before delegating. It is read-only, makes no model call, and does not require `cwd`.

The active profile is re-read per job. Stale `ANTHROPIC_*` environment variables from a long-lived Codex process are stripped and replaced with the current profile's values. If the profile cannot be safely determined, the job fails closed — it does not fall back to a stale profile.

After completion, the job reports four distinct evidence layers:
- **Requested model / selector kind**: the user's input and its classification (inherited/alias/native)
- **Route snapshot**: the resolved CLI argument, active profile fingerprint, and non-secret alias claim (no secrets persisted)
- **Claude-recorded execution model**: the model(s) recorded in the Claude Code session transcript (`message.model`)
- **Provider usage key**: the key(s) from the final JSON `modelUsage` object (billing/aggregation dimension)

Route status is computed from these layers:
- `resolved` — execution evidence matches the route claim
- `accepted_but_unverified` — no transcript evidence available (cannot verify)
- `model_drift_possible` — execution evidence conflicts with the route claim
- `rejected` — job failed

Execution model and usage key have different semantics and may differ (e.g., execution model `mimo-v2.5-pro` vs usage key `mimo-v2.5`). The plugin never treats a usage key as an execution model.

Do not call `cc_list_models` before ordinary delegation — it does not enumerate available models.

## Follow-up Context Policy

Task continuity does not require conversation continuity. The workspace, git diff, tests, and project instructions are the authoritative state for review-and-fix work.

For ordinary follow-ups such as "keep going", "continue", "fix the review findings", or another review/fix round:

- start a fresh Claude Code session by omitting both resume flags;
- give Claude Code a bounded handoff with only the current objective, actionable findings, still-valid constraints, and acceptance checks;
- tell Claude Code to inspect the current workspace and git diff as primary evidence;
- do not paste the full prior transcript, full diff, or verbose logs into the handoff.

Use this concise shape and omit empty sections:

```text
Objective
<current outcome and scope>

Current findings
<actionable review findings or verification failures>

Constraints
<still-valid decisions and non-negotiable requirements>

Acceptance checks
<commands or observable results that must pass>

Inspect the current workspace and git diff as primary evidence before editing.
```

Resume is an explicit conversation-preservation operation, not the default continuation strategy:

- "continue the same/latest Claude Code conversation" → `cc_delegate` with `resume=true`
- "resume Claude Code session abc123" → `cc_delegate` with `resumeSession="abc123"`
- ambiguous "continue" or "keep going" → fresh session with a bounded handoff
- "fresh start" → fresh session without resume flags

## Examples

- "Have Claude Code implement the auth middleware"
- "Delegate the CSS fix to Claude Code"
- "Ask Claude Code to refactor the database layer"
- "Continue the same latest Claude Code conversation" → `resume=true`
- "Resume Claude Code session cc-abc123" → `resumeSession="..."`
- "Fix these review findings and rerun the tests" → fresh session with a bounded handoff

## Notes

- `cc_delegate` defaults to foreground mode — it waits for Claude Code to finish and returns results immediately.
- Long-running tasks also stay in foreground: keep the single tool call pending until completion. Do not run outer `sleep` commands or repeatedly call `cc_check` while a normal delegate is pending.
- A pending foreground call is silent: do not send recurring progress/commentary messages merely to say that Claude Code has not finished. The next model action should occur after `cc_delegate` returns.
- `background=true` is deprecated and rejected unconditionally. Default foreground delegation waits silently without polling.
- The task prompt is sent via stdin (never argv) for privacy — it does not appear in any process command line. Be specific about what you want done.
- Claude Code is invoked with `claude --print --input-format text --output-format json` (print-mode JSON protocol). The task is delivered via stdin.
- Job ID supports prefix matching: "cc-abc" matches "cc-abc123def".
- When `model` is omitted, no `--model` argument is sent — Claude Code inherits its configured default.
- When `model` is an alias (Opus/Fable/Sonnet/Haiku), it is normalized to lowercase and passed as `--model <alias>`.
- When `model` is a native ID (contains a digit, no spaces), it is passed after `--model` unchanged.
- When `model` is ambiguous (no digit, not a known alias), the delegation is rejected — ask the user to clarify.
- `write=false` strictly prohibits Bash and write-capable tools; only Read, Glob, and Grep are exposed.
- Only one write-enabled delegation can run per workspace at a time (writer lease). Read-only delegations can run concurrently.
- Resume=true resolves to the latest completed plugin job with a claudeSessionId in the same workspace, not a global resume-last.
- Do not use `--fork-session` as a context-cost optimization: it creates a new session ID while retaining the resumed conversation history.
- On failure, the MCP output shows only a safe summary with a stage prefix (e.g., `[provider_response]`). Detailed diagnostics (redacted stdout/stderr, exit code, duration) are stored in the private job artifact, accessible via `cc_check` with the job ID.
