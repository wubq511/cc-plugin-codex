# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Codex plugin that dispatches coding tasks from Codex to Claude Code, then returns results for Codex to review. Reverse direction of OpenAI's `codex-plugin-cc` (which goes Claude Code → Codex).

## Architecture

```
Codex (MCP client)
  ↕ JSON-RPC over stdio (MCP 2025-03-26)
cc-companion.mjs (MCP server)
  ↕ spawn / spawnSync
claude CLI (claude -p --output-format json)
```

- **MCP server** (`scripts/cc-companion.mjs`): Single entry point. Handles JSON-RPC on stdin/stdout, routes `tools/call` to 6 handlers. All state mutation goes through `updateJob()` (validates phase transitions) → `upsertJob()`.
- **Claude runner** (`scripts/lib/claude-runner.mjs`): Builds CLI args, runs `claude -p` sync or detached. Detached mode writes stdout to a `resultFile` via fd; caller reads it on `child.on("exit")`.
- **Job state** (`scripts/lib/state.mjs`): Persisted to `${os.tmpdir()}/cc-companion/<slug-hash>/state.json`. Max 50 jobs, pruned on save. Job IDs use SHA-256 hash for collision resistance.
- **Job logs** (`scripts/lib/job-log.mjs`): Per-job `[timestamp] message` log files in `<stateDir>/jobs/`. Phase tracking with validated transitions. `readLogTail` reads only last 8KB.
- **Git integration** (`scripts/lib/git.mjs`): `resolveReviewTarget` (auto/working-tree/branch scope), `collectReviewContext` (staged/unstaged/untracked separation, diff size measurement, auto inline-diff vs self-collect). Binary detection via null-byte check. Symlink detection via `lstatSync`.
- **Process/workspace** (`scripts/lib/process.mjs`, `scripts/lib/workspace.mjs`): Binary availability check, process tree termination, git root walk-up.

## Key Design Decisions

- `dangerouslySkipPermissions` defaults to **false** (opt-in via `=== true`). Read-only mode uses narrow `Bash(git log*),Bash(git diff*),...` allowlist, not `Bash(git*)`.
- `updateJob()` does **soft** phase validation — logs invalid transitions but proceeds (prevents jobs getting stuck in unrecoverable states).
- Background jobs: `spawn()` with `child.on("error")` for ENOENT and `child.on("exit")` reading `resultFile`. Unparseable results → `status: "failed"`.
- `collectReviewContext` auto-downgrades from inline-diff to self-collect when diff exceeds 256KB or file count exceeds 2.
- `base` ref in cc_review is validated against flag injection (`startsWith("-")` check).

## Validation & Install

```bash
# Validate plugin manifest
python3 .claude/skills/plugin-creator/scripts/validate_plugin.py ~/plugins/claude-code

# Update cachebuster after changes
python3 .claude/skills/plugin-creator/scripts/update_plugin_cachebuster.py ~/plugins/claude-code

# Reinstall in Codex
codex plugin remove claude-code
codex plugin add claude-code@personal

# Quick MCP protocol smoke test
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}' | node scripts/cc-companion.mjs
```

## Review Output Schema

Defined in `schemas/review-output.schema.json`. Key fields: `verdict` (approve/needs-attention/request_changes/reject), `findings[].line_start`/`line_end` (integer), `findings[].confidence` (number 0-1), `findings[].recommendation` (minLength:1), `next_steps` (string array). SKILL.md docs must match this schema exactly.
