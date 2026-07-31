---
name: status
description: Use when you want to check the status of a Claude Code task — see progress, phase, results, or list all jobs
---

# Check Task Status

## Overview

Check the status and results of Claude Code tasks. Shows phase tracking, recent log entries, model evidence, route status, and a bounded diagnostic summary for failed/cancelled jobs.

## Workflow

1. Call `cc_check` with appropriate parameters:
   - `cwd` (required): absolute path to the user's current workspace
   - `cwd` only → latest job details (with phase and recent log)
   - `job="<id>"` → specific job details (accepts prefix matching, e.g. "cc-abc")
   - `all=true` → list all jobs in a summary table
   - `wait=true` → wait for a running job to complete (up to 4 minutes)
   - `session=true` → filter to current session's jobs only
   - `includeResult=true` → force re-delivery of the full terminal result

2. Terminal-result dedup: a repeated `cc_check` of an unchanged terminal job returns a **结果指纹** (result fingerprint) line and a short "unchanged" note instead of the full result — the payload was already delivered by `cc_delegate`'s terminal return or an earlier check. The fingerprint is recomputed from the on-disk artifact (nothing extra is persisted), so after an MCP server restart the next check simply re-delivers once. Pass `includeResult=true` whenever you actually need the full result text again.

3. Present the status information to the user, including:
   - Current phase and its description
   - Recent log entries showing progress
   - Session ID for the job
   - Route status (resolved / accepted_but_unverified / model_drift_possible / rejected / cancelled)
   - Task reference: a short, non-reversible SHA-256 hash prefix (never the task content itself — task text enters only the Claude child stdin stream)
   - For failed/cancelled/rejected jobs: a bounded, doubly-redacted diagnostic summary (failure stage, duration, structured-error flag). Raw error excerpts, stdout/stderr, session IDs, usage keys, and task content are never exposed in MCP output — they live only in the private job artifact.

## Phase Tracking

Jobs progress through phases:
- `starting` → Preparing to execute task
- `executing` → Claude Code is working on the task
- `verifying` → Verifying the implementation
- `finalizing` → Finalizing changes
- `completed` → Task completed successfully
- `failed` → Task failed
- `cancelled` → Task cancelled by user

## Examples

- "Check Claude Code status" → `cc_check` with the current workspace's absolute `cwd` (latest job)
- "Show all Claude Code jobs" → `cc_check` with `all=true`
- "Check job cc-abc" → `cc_check` with `job="cc-abc"` (prefix)
- "Wait for Claude Code to finish" → `cc_check` with `wait=true`
- "Show my session's jobs" → `cc_check` with `session=true`
