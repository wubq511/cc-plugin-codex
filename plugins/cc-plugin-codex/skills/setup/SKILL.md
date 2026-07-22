---
name: setup
description: Use when you want to check if Claude Code is installed and ready, or when troubleshooting the plugin
---

# Setup & Environment Check

## Overview

Verify that Claude Code is installed and the plugin is ready to use. Performs static checks (zero model calls): CLI protocol verification, companion compatibility, active profile routing resolvability, and state schema health. An optional cost-bearing liveness probe can be enabled with explicit authorization.

## Workflow

1. Call `cc_setup` with `cwd` set to the absolute path of the user's current workspace.

2. If everything is ready, inform the user they can start delegating tasks.

3. If issues are found:
   - **Claude Code not installed**: Suggest `npm install -g @anthropic-ai/claude-code`
   - **Node.js not available**: Suggest installing from https://nodejs.org/
   - **Git not found**: Review features need git — suggest installing git
   - **CLI protocol mismatch**: The installed Claude Code may not support print-mode JSON (`--print --input-format text --output-format json`). Suggest updating Claude Code to 2.1.208+.
   - **Active profile corrupt or unreadable**: The active-profile.json could not be safely resolved. No fallback profile is used. Fix the file or remove it for bare inheritance.
   - **Claude Code not authenticated**: Suggest running `claude auth` or setting `ANTHROPIC_API_KEY`

## What It Checks (Static — Zero Model Calls)

- **Claude Code CLI availability and version**
- **CLI protocol verification**: confirms `--print`, `--input-format`, and `--output-format` flags are supported (print-mode JSON capability)
- **Companion compatibility**: server version, state schema v5, watchdog protocol
- **Active profile routing resolvability**: reads the active profile and verifies it can be safely resolved. Reports profile identity, fingerprint, alias mapping count, and native display name count. Does NOT display secrets, tokens, or env var values.
- **Node.js availability and version**
- **Git availability and version**
- **Workspace root detection**
- **Default branch detection (main/master)**
- **Current session ID**
- **State schema version (v5 with dynamic model routing, route snapshots, failure diagnostics)**
- **State health** (orphaned job count, active job count)

## Optional Liveness Probe (Cost-Bearing)

When the user explicitly asks for a real Provider liveness check, call `cc_setup` with:
- `livenessProbe: true`
- `timeoutSeconds: <positive integer>` (required — this is the budget for the probe)

This makes **one real model call** and incurs a cost. It is NOT a free check. The probe runs a trivial task ("Reply with exactly: OK") and reports the result, cost, and duration. It is blocked if any static check fails.

Do not enable the liveness probe without explicit user authorization. Do not enable it in CI or automated setup flows.

## Examples

- "Check Claude Code setup" → `cc_setup` with the current workspace's absolute `cwd`
- "Is Claude Code ready?" → `cc_setup` with the current workspace's absolute `cwd`
- "Test if the Provider actually works" → `cc_setup` with `cwd`, `livenessProbe: true`, `timeoutSeconds: 30`
