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
claude CLI (claude --print --input-format text --output-format json)
```

- **MCP server** (`scripts/cc-companion.mjs`): Single entry point. Handles JSON-RPC on stdin/stdout, routes `tools/call` to 7 handlers (cc_delegate, cc_check, cc_cancel, cc_review, cc_setup, cc_list_models, cc_resolve_route), and maps `notifications/cancelled` back to pending Claude processes via control pipe. All state mutation goes through `updateJob()` (validates phase transitions) → `upsertJob()`.
- **Claude runner** (`scripts/lib/claude-runner.mjs`): Spawns watchdog with stdin (config) + fd3 (control pipe). Keeps one MCP call pending while preserving server responsiveness. Passes `childEnv`, `routeSnapshot`, and `cliVersion` to the watchdog for dynamic routing and diagnostics.
- **Watchdog** (`scripts/lib/watchdog.mjs`): Supervised Claude runner. Reads config from stdin and writes the task to Claude stdin (never argv). Uses `claude --print --input-format text --output-format json` (P0 fix: Claude Code 2.1.208+ requires `--print` for `--output-format json`). The IPC channel carries cancellation and companion-death signals. On POSIX Claude runs as a process-group leader; on Windows tree termination uses `taskkill /T`, so cancellation includes tool/subagent descendants. Structured stdout returns every bounded `usageModelKeys` entry, never a guessed model. Non-zero exits inspect BOTH stdout and stderr (P0 fix — previously only stderr was read). Failure envelopes are private, redacted, and size-bounded.
- **Dynamic model routing** (`scripts/lib/routing.mjs`): Per-job active profile resolution with selector classification (inherited/alias/native), route snapshot construction (no secrets), child env construction (strips stale `ANTHROPIC_*` vars, injects active profile env), and bounded display resolution. Alias selectors are case-insensitive and normalized to Claude CLI aliases. Native IDs are passed through unchanged. Ambiguous selectors fail closed. The active profile is re-read per job — no cross-job caching. Profile data is allowlisted: only alias/native mappings, profile identity, and a non-secret fingerprint are read; tokens, full settings, auth headers, and full Provider URLs are never persisted or displayed.
- **Route status** (`scripts/lib/route-status.mjs`): Computes `resolved` / `accepted_but_unverified` / `model_drift_possible` / `rejected` from the route snapshot, job outcome, transcript execution evidence, and usage keys. A usage key is never treated as an execution model. Drift can only be detected when transcript evidence exists.
- **Failure diagnostics** (`scripts/lib/diagnostics.mjs`): Structured failure envelopes with a fixed stage enum (`spawn` / `cli_contract` / `configuration` / `provider_handshake` / `provider_response` / `json_protocol` / `timeout` / `cancelled`). Redaction scrubs API keys, Bearer tokens, Authorization headers, x-api-key, passwords, URLs with credentials, and `ANTHROPIC_*` env values. Detailed diagnostics (redacted stdout/stderr tails, error detail, session ID, usage key) live only in the private job artifact. MCP output shows only the safe summary with stage prefix and job ID.
- **Model evidence** (`scripts/lib/model-evidence.mjs`): Split into shared constants/sanitizers, a streaming transcript collector, unified formatters, and v3→v4→v5 migration. The collector validates the real config/projects root before treating it as a containment boundary, classifies symlink and read failures, destroys stalled streams at the absolute deadline, and bounds main/subagent bytes, global lines, per-line bytes, subagent count, and unique models. Storage and display sanitize independently; failures produce partial/unavailable evidence without changing task success.
- **Job state** (`scripts/lib/state.mjs`): Schema-v5 per-job atomic persistence in `<stateDir>/jobs/`. Cross-process writer leases use atomic creation, a serialized mutation guard, and a 60-second companion heartbeat. Job metadata is capped at 64 KiB. Terminal retention is enforced independently by age (30 days), count (50), and aggregate storage (100 MiB), while active/orphaned diagnostics are preserved. v3 `observedModel` is reclassified as a usage key. v4→v5 migration adds `selectorKind`, `routeSnapshot`, and `routeStatus`.
- **Job logs** (`scripts/lib/job-log.mjs`): Per-job `[timestamp] message` log files in `<stateDir>/jobs/`. Phase tracking with validated transitions. `readLogTail` reads only last 8KB.
- **Git integration** (`scripts/lib/git.mjs`): `resolveReviewTarget` (auto/working-tree/branch scope), `collectReviewContext` (staged/unstaged/untracked separation, diff size measurement, auto inline-diff vs self-collect). Binary detection via null-byte check. Symlink detection via `lstatSync`.
- **Process/workspace** (`scripts/lib/process.mjs`, `scripts/lib/workspace.mjs`): Binary availability check, process tree termination, git root walk-up.

## Key Design Decisions

- `dangerouslySkipPermissions` defaults to **false** (opt-in via `=== true`). Read-only mode (`write=false`) exposes only Read, Glob, Grep — no Bash at all.
- `updateJob()` does **soft** phase validation — logs invalid transitions but proceeds (prevents jobs getting stuck in unrecoverable states).
- `background=true` is **deprecated and rejected unconditionally**. Foreground delegation is the only mode.
- Task prompts are delivered via stdin (watchdog → Claude), never appearing in any process argv.
- **P0 CLI protocol**: Claude Code 2.1.208+ requires `--print` for `--output-format json`. The watchdog uses `claude --print --input-format text --output-format json`. The task is delivered via stdin (`--input-format text`), never in argv.
- Watchdog monitors its IPC control channel from the companion. Disconnect = companion died; explicit `cancel` = user cancellation. Both terminate the complete Claude process tree before the writer lease is released.
- Foreground jobs have no default internal wall-clock timeout; an optional `timeoutSeconds` input provides an opt-in hard limit. Bounded 8 MiB output capture, control-pipe cancellation, and exactly one JSON-RPC response when the child settles. The MCP transport uses a seven-day ceiling (604800s) as an orphan-safety boundary, not a task-duration estimate.
- **Dynamic model routing**: Model resolution uses three selector kinds — `inherited` (no `--model`), `alias` (Opus/Fable/Sonnet/Haiku, case-insensitive, normalized to lowercase CLI alias), and `native` (e.g., `deepseek-v4-pro`, `glm-5.2`, passed through unchanged). Ambiguous selectors fail closed. The active profile is re-read per job; stale `ANTHROPIC_*` env vars from a long-lived Codex process are stripped and replaced with the current profile's values. The plugin does not maintain a Provider model catalogue. `requestedModel`, `routeSnapshot`, `modelEvidence.executedModels` (transcript), and `modelEvidence.usageModelKeys` (final JSON) are distinct evidence layers. Route status (`resolved` / `accepted_but_unverified` / `model_drift_possible` / `rejected`) is computed from these layers. A usage key is never displayed as an execution model.
- **Failure diagnostics**: MCP output shows only a safe summary with stage prefix and job ID. Detailed evidence (redacted stdout/stderr tails, error detail, session ID, usage key, structured error flag) lives only in the private job artifact. The stage enum is fixed: `spawn` / `cli_contract` / `configuration` / `provider_handshake` / `provider_response` / `json_protocol` / `timeout` / `cancelled`.
- **cc_setup static checks** (zero model calls): CLI protocol verification (print-mode JSON support), companion/source/cache compatibility, active profile routing resolvability, state schema health. An optional `livenessProbe=true` with a positive `timeoutSeconds` runs a real Provider liveness probe — it is cost-bearing and must not be treated as a free check.
- Stateful tools require the user's absolute `cwd`; `cc_resolve_route` is stateless and does not require `cwd`. Shutdown only cancels jobs owned by the current MCP server session.
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
