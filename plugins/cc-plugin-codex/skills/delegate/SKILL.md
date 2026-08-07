---
name: delegate
description: Use when you want to delegate a coding task to Claude Code — it executes the task and returns results for review
---

# Delegate to Claude Code

## Overview

Send a coding task to Claude Code for execution. Claude Code runs in a separate process, completes the task, and returns results automatically. After completion, you should review the changes.

## Workflow

1. **Delegate the task** by calling `cc_delegate` with the required `cwd` (absolute path to the user's current workspace) and `task`. Parameters, defaults, and validation rules are defined authoritatively in the `cc_delegate` tool schema — follow it directly. This skill adds only the semantics the schema does not repeat: model-routing evidence (below), follow-up context policy, and auto-compact scope semantics.

   Call the registered `cc_delegate` MCP tool directly. You may announce the delegation once before the tool call, then remain silent while it is pending. Do not manually start `cc-companion.mjs`, wrap it in a shell/PTY, or emit periodic "still running" commentary. If the registered `cc_*` tools are unavailable, use the setup workflow and ask the user to restart or open a new task; never emulate delegation with a polling fallback.

2. **Present results** to the user when the task completes.

3. **Suggest review**: After a completed task, tell the user:
   > "Task completed. Run `/claude:review` to review the changes, or `/claude:review --adversarial` for a deeper review."

## Model Selection

Model resolution uses three selector kinds, classified per job with no filesystem or authority dependency:

- **inherited** (default): omit `model` — no `--model` argument is sent. Claude Code uses its current configured default.
- **alias**: `Opus`, `Fable`, `Sonnet`, `Haiku` (case-insensitive). Normalized to the canonical lowercase Claude CLI alias (e.g., `Opus` → `--model opus`).
- **native**: a model ID with at least one digit and no spaces (e.g., `deepseek-v4-pro`, `glm-5.2`). Passed through unchanged as `--model <id>`.

Ambiguous selectors (no digit, not a known alias) are **rejected** — the plugin does not guess or silently fall back. Ask the user to clarify.

Use `cc_resolve_route` to preview how a selector will be routed before delegating. It is read-only, makes no model call, does not require `cwd`, and returns a human-readable text summary (selector kind, CLI arg, non-secret route snapshot).

The plugin does not read, write, or modify any external routing configuration. It does not inject or strip environment variables for routing purposes — the child Claude process inherits the parent environment unchanged.

After completion, the job reports four distinct evidence layers:
- **Requested model / selector kind**: the user's input and its classification (inherited/alias/native)
- **Route snapshot**: the resolved CLI argument (no secrets persisted)
- **Claude-recorded execution model**: the model(s) recorded in the Claude Code session transcript (`message.model`)
- **Provider usage key**: the key(s) from the final JSON `modelUsage` object (billing/aggregation dimension)

Route status is computed from these layers:
- `resolved` — execution evidence matches the route claim
- `accepted_but_unverified` — no transcript evidence available (cannot verify)
- `model_drift_possible` — execution evidence conflicts with the route claim
- `rejected` — job failed
- `cancelled` — job cancelled before the route could be verified (documented non-terminal exception; `null` is never persisted as a final route status)

Execution model and usage key have different semantics and may differ (e.g., execution model `mimo-v2.5-pro` vs usage key `mimo-v2.5`). The plugin never treats a usage key as an execution model.

Do not call `cc_list_models` before ordinary delegation — it does not enumerate available models.

## Follow-up Context Policy

Task continuity does not require conversation continuity. The workspace, git diff, tests, and project instructions are the authoritative state for review-and-fix work.

For follow-ups such as "keep going", "continue", "fix the review findings", or another review/fix round:

1. **Call `cc_plan_continuation` first**, after classifying the follow-up:
   - `parentJob`: use the exact prior plugin job whenever known. Use `parentSession` only when the user identifies a Claude session directly.
   - `relationship`: `same_attempt` for fixing/retrying the same acceptance target; `same_goal` for another slice of the same outcome; `next_step` for a dependent but distinct stage; `unrelated` when the old reasoning is irrelevant; `unknown` only when inspection cannot resolve it.
   - `contextValue`: `essential` when decisions/reasoning cannot be reconstructed cheaply from the workspace; `useful` when reuse saves meaningful reading; `reconstructable` when current files, diff, tests, and rules are sufficient.
   - `userIntent`: `same_session` only for an explicit request to preserve the conversation; `fresh` only for an explicit fresh-start request; otherwise `auto`.
   - `correctionCount`: number of completed correction/rework rounds for this same target, including the immediately preceding failed correction.
   - `allowCompact`: false if the user forbids compaction or the next action is time-critical; otherwise true.
   - `model` and `write`: the exact values you will pass to the next `cc_delegate` (`null`/omitted model means inherited). A mismatch at execution fails closed.
   - `sessionPollution`: true only when the session contains substantial obsolete, conflicting, or unrelated work. Do not guess drift flags; the plugin derives workspace/CLI/tool drift and merges any concrete caller evidence.
2. **Read the plan's action (动作) and execute exactly once:**
   - `resume`: call `cc_delegate` with `continuationPlan=planId`; do not add resume flags.
   - `compact_resume`: call `cc_compact` with the same `continuationPlan`, then call `cc_delegate` with that same plan. If no new compact boundary is observed, the plan safely falls back to Resume; if compact fails, re-plan.
   - `fresh_handoff`: fill the returned bounded `handoffTemplate`, then call `cc_delegate` with `continuationPlan=planId` and no resume flags.
3. **Re-plan instead of improvising** when the plan expires, is replayed, or a bound input changes. Without a plan, delegation starts a fresh session.

When the plan returns `fresh_handoff`, give Claude Code a bounded handoff with only the current objective, actionable findings, still-valid constraints, and acceptance checks. Use this concise shape (omit empty sections):

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

Do not paste the full prior transcript, full diff, or verbose logs into the handoff.

Resume is an explicit conversation-preservation operation, not the default continuation strategy:

- "continue the same/latest Claude Code conversation" → `cc_plan_continuation` with `userIntent: "same_session"`, then `cc_delegate` with the `planId`
- "resume Claude Code session abc123" → `cc_delegate` with `resumeSession="abc123"`
- ambiguous "continue" or "keep going" → `cc_plan_continuation` with `userIntent: "auto"`, then follow the plan
- "fresh start" → `cc_plan_continuation` with `userIntent: "fresh"`, then `cc_delegate` with the `planId`

## Examples

- "Have Claude Code implement the auth middleware"
- "Delegate the CSS fix to Claude Code"
- "Ask Claude Code to refactor the database layer"
- "Continue the same latest Claude Code conversation" → plan with `userIntent:"same_session"` and consume the returned action
- "Resume Claude Code session cc-abc123" → `resumeSession="..."`
- "Fix these review findings and rerun the tests" → classify as `same_attempt`, use `userIntent:auto`, and follow the returned plan

## Auto-Compact

`autoCompact` configures temporary auto-compaction for a delegation. It injects two env keys (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`) via Claude CLI's inline `--settings <json>` flag. **No writes** to `~/.claude/**`, project `.claude/`, or parent `process.env`.

```json
{
  "contextWindowTokens": 256000,
  "targetTokens": 230000,
  "scope": "delegation"
}
```

| Field | Rule |
|-------|------|
| `contextWindowTokens` | Positive safe integer. User-declared, unverified. Never inferred from model or routing. |
| `targetTokens` | Positive safe integer. Must be ≤ `floor(contextWindowTokens * 0.9)`, else rejected before spawn. |
| `scope` | `delegation` (default), `session`, or `task`. |
| `taskScopeId` | UUID for task-scope inheritance. Omit on the first full task policy to auto-generate. |
| `clear` | Only `true` is valid. With `scope:"task"` and a task UUID, writes a clear tombstone without injecting settings. |

**Scope semantics:**
- `delegation`: current process + subagents only. Its audit is recorded, but it is never replayed.
- `session`: bound to the Claude session. Persisted in the job record. Replayed on `resume` / `cc_compact` of the same session.
- `task`: covers all delegations of the same Codex task, including new Claude sessions. `taskScopeId` is the **only** inheritance key — no cwd/prompt guessing. First full task policy without `taskScopeId` generates a UUID and returns it; later calls inherit with `{scope:"task", taskScopeId}`. Unknown or cleared IDs fail before spawn.

The generated `taskScopeId` is returned on completed, failed, and cancelled
delegations and is also visible in `cc_check`, so a failed first session does
not break task-scope continuity.

**Priority:** this-call explicit value > session > task > none. On an explicit resume, `autoCompact:null` clears the session policy. Clear a task policy with `{scope:"task", taskScopeId, clear:true}`. Never send `taskScopeId:null`.

**Honest reporting:** the response distinguishes `target` (nominal, user-supplied), `effectiveWindow` (computed `ceil(target/0.9)`), and `observedBoundary` (from transcript, may be null). Claude caps the configured window at the routed model's actual window and the percentage override can only lower built-in thresholds. With a custom Provider, never promise an exact hit from the user-declared window alone.

**Examples:**
- "All new sessions for this task should compact at 300K tokens" → first call `autoCompact: { contextWindowTokens: 1000000, targetTokens: 300000, scope: "task" }`; later calls `autoCompact: { scope: "task", taskScopeId: "<returned UUID>" }`.
- "This session should compact at 230K" → `autoCompact: { contextWindowTokens: 256000, targetTokens: 230000, scope: "session" }` — replayed on resume.

## Notes

- `cc_delegate` defaults to foreground mode — it waits for Claude Code to finish and returns results immediately.
- Long-running tasks also stay in foreground: keep the single tool call pending until completion. Do not run outer `sleep` commands or repeatedly call `cc_check` while a normal delegate is pending.
- A pending foreground call is silent: do not send recurring progress/commentary messages merely to say that Claude Code has not finished. The next model action should occur after `cc_delegate` returns.
- Delegation is foreground only — there is no background mode. The single pending call waits silently without polling until Claude Code finishes.
- The task prompt is sent via stdin (never argv) for privacy — it does not appear in any process command line. Be specific about what you want done.
- Claude Code is invoked with `claude --print --input-format text --output-format stream-json --verbose` (print-mode streaming protocol). The task is delivered via stdin.
- Job ID supports prefix matching: "cc-abc" matches "cc-abc123def".
- When `model` is omitted, no `--model` argument is sent — Claude Code inherits its configured default.
- When `model` is an alias (Opus/Fable/Sonnet/Haiku), it is normalized to lowercase and passed as `--model <alias>`.
- When `model` is a native ID (contains a digit, no spaces), it is passed after `--model` unchanged.
- When `model` is ambiguous (no digit, not a known alias), the delegation is rejected — ask the user to clarify.
- `write=false` strictly prohibits Bash and write-capable tools; only Read, Glob, and Grep are exposed.
- Only one write-enabled delegation can run per workspace at a time (writer lease). Read-only delegations can run concurrently.
- Resume=true resolves to the latest completed plugin job with a claudeSessionId in the same workspace, not a global resume-last.
- Do not use `--fork-session` as a context-cost optimization: it creates a new session ID while retaining the resumed conversation history.
- Terminal responses carry a `**终端续接：**` line with a `claude --resume <sessionId>` command — relay it verbatim to the user. Claude Code `-p` sessions never appear in the interactive `/resume` picker, so resuming in a terminal requires the explicit ID; run the command in the workspace root.
- On failure, the MCP output shows only a safe summary with a stage prefix (e.g., `[provider_response]`). `cc_check` additionally exposes a safe diagnostic summary (failure stage, duration, structured-error flag) for failed/cancelled/rejected jobs. Full diagnostics (redacted stdout/stderr tails, error detail, exit code, session ID, usage key) live only in the private job artifact — MCP output never exposes raw stdout/stderr, error excerpts, session IDs, or usage keys.
