# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Codex plugin that dispatches coding tasks from Codex to Claude Code, then returns results for Codex to review. Reverse direction of OpenAI's `codex-plugin-cc` (which goes Claude Code → Codex).

## Architecture

```
Codex (MCP client)
  ↕ JSON-RPC over stdio (MCP 2025-03-26)
cc-companion.mjs (MCP server)
  ↕ stdin (config) + fd3 (control pipe) + stdout (result)
watchdog.mjs (supervised runner)
  ↕ stdin (task prompt, never argv)
claude CLI (claude --output-format json)
```

- **MCP server** (`scripts/cc-companion.mjs`): Single entry point. Handles JSON-RPC on stdin/stdout, routes `tools/call` to 6 handlers, and maps `notifications/cancelled` back to pending Claude processes via control pipe. All state mutation goes through `updateJob()` (validates phase transitions) → `upsertJob()`.
- **Claude runner** (`scripts/lib/claude-runner.mjs`): Spawns watchdog with stdin (config) + fd3 (control pipe). Keeps one MCP call pending while preserving server responsiveness.
- **Watchdog** (`scripts/lib/watchdog.mjs`): Supervised Claude runner. Reads config from stdin and writes the task to Claude stdin (never argv). The IPC channel carries cancellation and companion-death signals. On POSIX Claude runs as a process-group leader; on Windows tree termination uses `taskkill /T`, so cancellation includes tool/subagent descendants. Structured stdout returns every bounded `usageModelKeys` entry, never a guessed model.
- **Model evidence** (`scripts/lib/model-evidence.mjs`): Split into shared constants/sanitizers, a streaming transcript collector, unified formatters, and v3→v4 migration. The collector validates the real config/projects root before treating it as a containment boundary, classifies symlink and read failures, destroys stalled streams at the absolute deadline, and bounds main/subagent bytes, global lines, per-line bytes, subagent count, and unique models. Storage and display sanitize independently; failures produce partial/unavailable evidence without changing task success.
- **Job state** (`scripts/lib/state.mjs`): Schema-v4 per-job atomic persistence in `<stateDir>/jobs/`. Cross-process writer leases use atomic creation, a serialized mutation guard, and a 60-second companion heartbeat. Job metadata is capped at 64 KiB. Terminal retention is enforced independently by age (30 days), count (50), and aggregate storage (100 MiB), while active/orphaned diagnostics are preserved. v3 `observedModel` is reclassified as a usage key.
- **Job logs** (`scripts/lib/job-log.mjs`): Per-job `[timestamp] message` log files in `<stateDir>/jobs/`. Phase tracking with validated transitions. `readLogTail` reads only last 8KB.
- **Git integration** (`scripts/lib/git.mjs`): `resolveReviewTarget` (auto/working-tree/branch scope), `collectReviewContext` (staged/unstaged/untracked separation, diff size measurement, auto inline-diff vs self-collect). Binary detection via null-byte check. Symlink detection via `lstatSync`.
- **Process/workspace** (`scripts/lib/process.mjs`, `scripts/lib/workspace.mjs`): Binary availability check, process tree termination, git root walk-up.

## Key Design Decisions

- `dangerouslySkipPermissions` defaults to **false** (opt-in via `=== true`). Read-only mode (`write=false`) exposes only Read, Glob, Grep — no Bash at all.
- `updateJob()` does **soft** phase validation — logs invalid transitions but proceeds (prevents jobs getting stuck in unrecoverable states).
- `background=true` is **deprecated and rejected unconditionally**. Foreground delegation is the only mode.
- Task prompts are delivered via stdin (watchdog → Claude), never appearing in any process argv.
- Watchdog monitors its IPC control channel from the companion. Disconnect = companion died; explicit `cancel` = user cancellation. Both terminate the complete Claude process tree before the writer lease is released.
- Foreground jobs have no default internal wall-clock timeout; an optional `timeoutSeconds` input provides an opt-in hard limit. Bounded 8 MiB output capture, control-pipe cancellation, and exactly one JSON-RPC response when the child settles. The MCP transport uses a seven-day ceiling (604800s) as an orphan-safety boundary, not a task-duration estimate.
- Model resolution is owned by Claude Code and its Provider. The plugin does not maintain a model catalogue. `model` is a free-form optional override; when omitted, no `--model` argument is sent. Job state tracks `requestedModel`, `requestMode`, and `modelEvidence` (with `executedModels` from transcript and `usageModelKeys` from final JSON). The old `observedModel` field is removed in v4; v3 jobs are migrated with `observedModel` reclassified as a usage key, never as an executed model.
- Stateful tools require the user's absolute `cwd`; shutdown only cancels jobs owned by the current MCP server session.
- `collectReviewContext` auto-downgrades from inline-diff to self-collect when diff exceeds 256KB or file count exceeds 2.
- `base` ref in cc_review is validated against flag injection (`startsWith("-")` check).

## Validation & Install

```bash
# Run all tests
npm test

# Validate plugin manifest
python3 .agents/skills/plugin-creator/scripts/validate_plugin.py plugins/cc-plugin-codex

# Update cachebuster after changes
python3 .agents/skills/plugin-creator/scripts/update_plugin_cachebuster.py plugins/cc-plugin-codex

# Reinstall in Codex (from this repo root as marketplace)
codex plugin add cc-plugin-codex@cc-plugin-codex

# Quick MCP protocol smoke test
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | node plugins/cc-plugin-codex/scripts/cc-companion.mjs
```

## Review Output Schema

Defined in `schemas/review-output.schema.json`. Key fields: `verdict` (approve/needs-attention/request_changes/reject), `findings[].line_start`/`line_end` (integer), `findings[].confidence` (number 0-1), `findings[].recommendation` (minLength:1), `next_steps` (string array). SKILL.md docs must match this schema exactly.
