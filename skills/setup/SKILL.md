---
name: setup
description: Use when you want to check if Claude Code is installed and ready, or when troubleshooting the plugin
---

# Setup & Environment Check

## Overview

Verify that Claude Code is installed and the plugin is ready to use. Reports workspace info, default branch, and session ID.

## Workflow

1. Call `cc_setup` (no parameters needed).

2. If everything is ready, inform the user they can start delegating tasks.

3. If issues are found:
   - **Claude Code not installed**: Suggest `npm install -g @anthropic-ai/claude-code`
   - **Node.js not available**: Suggest installing from https://nodejs.org/
   - **Git not found**: Review features need git — suggest installing git
   - **Claude Code not authenticated**: Suggest running `claude auth` or setting `ANTHROPIC_API_KEY`

## What It Checks

- Claude Code CLI availability and version
- Node.js availability and version
- Git availability and version
- Workspace root detection
- Default branch detection (main/master)
- Current session ID

## Examples

- "Check Claude Code setup" → `cc_setup`
- "Is Claude Code ready?" → `cc_setup`
