---
name: setup
description: Use when you want to check if Claude Code is installed and ready, or when troubleshooting the plugin
---

# Setup & Environment Check

## Overview

Verify that Claude Code is installed and the plugin is ready to use. Performs static checks (zero model calls): CLI protocol verification, companion compatibility, active authority routing resolvability, source-vs-cache comparison, and state schema health. An optional cost-bearing liveness probe can be enabled with explicit authorization and a budget guard.

## Workflow

1. Call `cc_setup` with `cwd` set to the absolute path of the user's current workspace.

2. If everything is ready, inform the user they can start delegating tasks.

3. If issues are found:
   - **Claude Code not installed**: Suggest `npm install -g @anthropic-ai/claude-code`
   - **Node.js not available**: Suggest installing from https://nodejs.org/
   - **Git not found**: Review features need git — suggest installing git
   - **CLI protocol mismatch**: The installed Claude Code may not support print-mode JSON (`--print --input-format text --output-format json`). Suggest updating Claude Code to 2.1.208+.
   - **Active authority corrupt or unreadable**: The active cc-profile-switch profile (or fallback authority) could not be safely resolved — corrupt config, missing profile, path traversal, or symlink escape. No fallback profile is used. Fix the config or remove it for bare inheritance.
   - **Source/cache mismatch**: The installed plugin cache differs from the running source. Reinstall the plugin to align the cache.
   - **Claude Code not authenticated**: Suggest running `claude auth` or setting `ANTHROPIC_API_KEY`

## What It Checks (Static — Zero Model Calls)

- **Claude Code CLI availability and version**
- **CLI protocol verification**: confirms `--print`, `--input-format`, and `--output-format` flags are supported (print-mode JSON capability)
- **Companion compatibility**: server version, state schema v6, watchdog protocol
- **Active authority routing resolvability**: reads the active cc-profile-switch profile (default) — `${CC_PROFILE_SWITCH_HOME:-~/.cc-profile-switch}/config.json` → `lastUsedProfile` → `profiles/<name>/claude-home/settings.json` + common `api-settings.json` — and verifies it can be safely resolved. Falls back to a Claude-settings adapter (`<CLAUDE_CONFIG_DIR>/settings.json`) and an explicit `active-profile.json` fixture for tests/legacy. Reports source kind, profile identity, fingerprint, alias mapping count, and native display name count. Does NOT display secrets, tokens, or env var values. The authority is re-read fresh on every call — a profile switch takes effect without restarting Codex.
- **Source/cache compatibility**: performs a real comparison between the running plugin source and the installed cache directory (reports `match`, `differ`, or `not-installed` when running from source). Never prints a green compatibility claim without an actual comparison.
- **Node.js availability and version**
- **Git availability and version**
- **Workspace root detection**
- **Default branch detection (main/master)**
- **Current session ID**
- **State schema version (v6 with task privacy boundary, dynamic model routing, route snapshots, failure diagnostics)**
- **State health** (orphaned job count, active job count)

## Optional Liveness Probe (Cost-Bearing)

When the user explicitly asks for a real Provider liveness check, call `cc_setup` with:
- `livenessProbe: true`
- `timeoutSeconds: <positive integer>` (required — wall-clock budget for the probe)
- `maxBudgetUsd: <positive number>` (required — cost ceiling for the probe)
- `model` (optional): same selector semantics as `cc_delegate` (inherited / alias / native)

This makes **one real model call** and incurs a cost. It is NOT a free check. The probe runs a trivial task ("Reply with exactly: OK") and reports the result, cost, and duration. It is blocked if any static check fails.

**Honest cost + private evidence:** When telemetry is missing the probe reports cost as `unknown` (never `$0.00`); an explicit Provider-reported zero remains `$0.00` with `provider_reported` provenance. A private, bounded, auditable artifact is created before the Provider call and finalized afterward with the route snapshot, route status, execution/model evidence, duration, exit/failure classification, and cost. Standalone probe artifacts share the private 30-day/100MiB retention policy. A usage key is never treated as execution proof — only transcript evidence is. The MCP output links only to the probe ID and a safe summary.

**Budget guard (fail-closed):** Before the probe spawns Claude Code, the setup verifies that the installed CLI supports the `--max-budget-usd` flag (inspected via `claude --help`). If the flag is unsupported, the probe fails closed — **no Provider call is made**. The probe also fails closed if `livenessProbe` is not literally `true`, if `timeoutSeconds` is missing or non-positive, or if `maxBudgetUsd` is missing or non-positive.

Do not enable the liveness probe without explicit user authorization. Do not enable it in CI or automated setup flows.

## Examples

- "Check Claude Code setup" → `cc_setup` with the current workspace's absolute `cwd`
- "Is Claude Code ready?" → `cc_setup` with the current workspace's absolute `cwd`
- "Test if the Provider actually works" → `cc_setup` with `cwd`, `livenessProbe: true`, `timeoutSeconds: 30`, `maxBudgetUsd: 0.25`
- "Test liveness with the Opus alias" → `cc_setup` with `cwd`, `livenessProbe: true`, `timeoutSeconds: 30`, `maxBudgetUsd: 0.25`, `model: "Opus"`
