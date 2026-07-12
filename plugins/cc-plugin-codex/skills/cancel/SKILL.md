---
name: cancel
description: Use when you want to cancel a running Claude Code task
---

# Cancel Claude Code Task

## Overview

Cancel a Claude Code task that is currently running. By default cancels the latest active job. Accepts job ID prefix.

## Workflow

1. Call `cc_cancel`:
   - `cwd` (required): absolute path to the user's current workspace
   - `cwd` only → cancel the latest running/queued job
   - `job="<id>"` → cancel a specific job (accepts prefix, e.g. "cc-abc")

2. Confirm the cancellation to the user.

## Examples

- "Cancel the Claude Code task" → `cc_cancel` with the current workspace's absolute `cwd` (latest active)
- "Cancel job cc-abc" → `cc_cancel` with `job="cc-abc"` (prefix matching)
