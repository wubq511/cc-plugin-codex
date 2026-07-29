---
name: compact
description: Use when you want to compact a stopped Claude Code session to reclaim context — runs a read-only /compact and reports whether a boundary was crossed
---

# Compact a Stopped Claude Code Session

## Overview

`cc_compact` runs a read-only foreground `/compact` on a stopped Claude Code session. It captures a transcript cursor before the call and reports success only when this invocation appends a new canonical compact boundary. It does not modify permanent Claude/Provider configuration.

## When to Use

- The user wants to reclaim context in a stopped session before resuming it.
- The user wants to compact a specific session by ID or job.
- After a delegation completes and the user wants to compress its context.
- `cc_plan_continuation` returns `structuredContent.action: "compact_resume"`.

## When NOT to Use

- The session is still running or cancelling — `cc_compact` rejects active sessions.
- You want to configure auto-compact for future delegations — use `cc_delegate` with `autoCompact` instead.

## Workflow

1. **Ensure the session is stopped.** If a delegation is still running, wait for it to complete or cancel it first.

2. **Call `cc_compact`**:
   - `cwd` (required): absolute path to the user's current workspace
   - `job` (optional): job ID or prefix whose `claudeSessionId` to compact
   - `resumeSession` (optional): explicit Claude session ID to compact (takes precedence over `job`)
   - `continuationPlan` (optional): planId from `cc_plan_continuation` with `action: "compact_resume"`. Enforces the compact lifecycle: `issued → compacted → consumed` (each step exactly once). A non-compact_resume plan, replay, or expiry fails closed. After compact, pass the same planId to `cc_delegate` to resume.
   - `maxBudgetUsd` (optional): positive maximum budget in USD (≤ 1000) passed through to the CLI budget guard (`--max-budget-usd`). When supplied but the CLI lacks `--max-budget-usd`, the call fails closed before any Provider call. Omit to run without an explicit budget cap.

   If neither `job` nor `resumeSession` is provided, the latest stopped job with a `claudeSessionId` is used.

3. **Finish a planned continuation.** When `continuationPlan` was supplied:
   - If `compacted:true`, call `cc_delegate` once with the same planId.
   - If no new boundary was observed, still call `cc_delegate` once with the same planId; the lifecycle has converted the plan to its bound Resume fallback.
   - If `cc_compact` returns an error, do not consume the old plan. Call `cc_plan_continuation` again.

4. **Read the result.** The response reports:
   - `Compacted: true/false` — true only if a canonical `compact_boundary` was appended after the pre-call cursor
   - `Pre-compaction tokens` — token count before compaction (if observed)
   - `Trigger` — `manual` or `auto` (if observed)
   - `Observed boundary` — the actual pre-compaction token count (if observed)
   - `Requested target` / `Effective window` — from the job's stored auto-compact policy (if any)
   - `Cost` / `Duration` — this compact invocation's own telemetry; unknown cost remains null in `structuredContent`
   - `Reason` — why compaction did not happen (if `compacted: false`)

## Honest Reporting

The plugin **never fabricates** evidence:
- `observedBoundary` is `null` if not observed in the transcript.
- Historical boundaries and `isCompactSummary` markers never prove that this invocation compacted.
- `compacted: false` is returned when no new compact boundary is found — the session may have too few messages to compact.
- A missing transcript yields `compacted: false` with a "transcript not found" reason.

## Session Location Priority

1. `resumeSession` (explicit session ID)
2. `job` (job ID/prefix → read its `claudeSessionId`)
3. Latest stopped (terminal) job with a `claudeSessionId` in the workspace

Active or cancelling jobs are **always rejected**, including when the same session is selected through explicit `resumeSession`. Stored session/task auto-compact settings replay for the compact invocation; delegation-only settings do not.

## Examples

- "Compact the last session" → `cc_compact` with only `cwd`
- "Compact job cc-abc123" → `cc_compact` with `job: "cc-abc123"`
- "Compact session abc-123-def" → `cc_compact` with `resumeSession: "abc-123-def"`

## Notes

- `cc_compact` is read-only: it runs with `write=false` (Read, Glob, Grep only). No writer lease is needed.
- The compact invocation uses `claude --print --resume <sessionId> --input-format text --output-format json` with `/compact` as stdin input.
- `--session-id` is never used by `cc_compact` — only `--resume` (mutually exclusive with `--session-id`).
- The compact result is persisted to the job record's `compactResult` field (advisory, non-sensitive).
- After compacting, you can resume the same session with `cc_delegate` + `resumeSession` or by passing the `continuationPlan` from `cc_plan_continuation`.
- When a `continuationPlan` with `action: "compact_resume"` is supplied, `cc_compact` marks the plan as `issued` before the compact and `compacted` after. If compact produces no new boundary, the plan falls back to `resume` bound to the original session. If compact fails, the plan is marked as failed and must be re-planned.
