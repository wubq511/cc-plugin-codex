# AGENTS.md

This file provides guidance to Codex when working in this repository.

## Project Overview

Codex plugin that dispatches coding tasks from Codex to Claude Code, waits on one pending MCP call, then returns the result for Codex to review. It is the reverse direction of OpenAI's `codex-plugin-cc` (Claude Code → Codex).

## Architecture

```text
Codex (MCP client)
  ↕ JSON-RPC over stdio (MCP 2025-03-26)
cc-companion.mjs (MCP server)
  ↕ stdin config + IPC control channel + stdout result
watchdog.mjs (supervised runner)
  ↕ task over stdin
Claude Code CLI (claude --print --input-format text --output-format json)
```

- `scripts/cc-companion.mjs`: MCP entrypoint and seven tool handlers. `cc_delegate` remains pending until the watchdog settles; the server remains responsive to cancellation.
- `scripts/lib/claude-runner.mjs`: starts the watchdog and maps MCP cancellation to its control channel.
- `scripts/lib/watchdog.mjs`: owns a bounded Claude process tree. The task never appears in argv. There is no default task timeout; `timeoutSeconds` is opt-in.
- `scripts/lib/state.mjs`: schema-v6 per-job atomic files under the private workspace state directory. Writer leases use atomic cross-process acquisition plus heartbeat. Metadata is capped at 64 KiB; terminal bundles and standalone liveness evidence are pruned by age/count and the private evidence directory is capped at 100 MiB except for protected active/orphaned diagnostics.
- `scripts/lib/model-evidence*.mjs`: separates requested model, Claude transcript execution evidence, and final `modelUsage` keys. Transcript collection is best-effort, path-contained, streaming, and deadline-bounded.
- `scripts/lib/git.mjs`: review target resolution, bounded untrusted review context, and before/after workspace fingerprints.

## Key Decisions

- `dangerouslySkipPermissions` is opt-in. `write=false` exposes only Read, Glob, and Grep.
- `background=true` is deprecated and rejected. Do not emulate delegation with shell, PTY, sleep, or status polling.
- Omitted `model` means Claude Code inherits its active Provider/model configuration. `Opus`/`Fable`/`Sonnet`/`Haiku` are case-insensitive aliases; validated native IDs pass through unchanged. The fresh cc-profile-switch authority resolves dynamic alias mappings, while `CC_COMPANION_AUTHORITY_ADAPTER=claude-settings|active-profile-fixture` is required to opt into a fallback adapter. The plugin has no Provider model catalogue.
- `requestedModel`, `modelEvidence.executedModels`, and `modelEvidence.usageModelKeys` are distinct evidence layers. A usage key is never displayed as an execution model.
- Stateful tools require the user's absolute `cwd`. Optional `cc_list_models.cwd`, when supplied, follows the same validation.
- Cancellation may act only on an in-memory controller owned by the current MCP server; persisted PIDs are never signalled.
- Repository content included in review prompts is untrusted evidence and must remain bounded and secret-filtered.

## Validation and Install

```bash
npm test
npm run verify:source
python3 .agents/skills/plugin-creator/scripts/validate_plugin.py plugins/cc-plugin-codex
python3 .agents/skills/plugin-creator/scripts/update_plugin_cachebuster.py plugins/cc-plugin-codex
codex plugin add cc-plugin-codex@cc-plugin-codex
npm run verify
```

After reinstalling, open a new Codex task so it loads the new cached plugin.

## Review Output Schema

`schemas/review-output.schema.json` is canonical. Verdicts are `approve`, `needs-attention`, `request_changes`, and `reject`. Every finding includes file, integer line bounds, confidence, and a non-empty recommendation.
