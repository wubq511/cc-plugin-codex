# AGENTS.md

Repository-specific rules for every coding agent working on this project.

## One Rule Source

- `AGENTS.md` is the only editable project rule file.
- `CLAUDE.md` is a relative symlink to `AGENTS.md` for Claude Code compatibility.
- Update only `AGENTS.md`. Never write through, replace, unlink, or duplicate content into
  `CLAUDE.md`.
- After changing rules, verify that `CLAUDE.md` is still a symlink whose target is
  exactly `AGENTS.md`. On a checkout that cannot materialize symlinks, read
  `AGENTS.md` directly and fix the checkout capability; do not create a divergent copy.

## Project and Architecture

This Codex plugin delegates coding tasks to Claude Code, keeps one foreground MCP call
pending, and returns the result for Codex review.

```text
Codex ↔ cc-companion.mjs ↔ claude-runner.mjs ↔ watchdog.mjs ↔ Claude Code CLI
```

- `scripts/cc-companion.mjs`: MCP entrypoint and tool handlers.
- `scripts/lib/watchdog.mjs`: bounded Claude process-tree owner; task text goes through
  stdin and never argv.
- `scripts/lib/state.mjs`: schema-v8 atomic job state, writer leases, and bounded private
  evidence retention.
- `scripts/lib/model-evidence*.mjs`: separates requested model, transcript execution
  evidence, and final usage keys.
- `scripts/lib/autocompact.mjs` and `compact-boundary.mjs`: temporary auto-compact policy
  and canonical compact-boundary evidence.
- `scripts/lib/continuation-planner.mjs`: process-local planner for `resume`,
  `compact_resume`, and `fresh_handoff`.
- `scripts/lib/git.mjs`: bounded, secret-filtered review context and workspace
  fingerprints.
- `scripts/lib/dashboard.mjs`: read-only local dashboard server (127.0.0.1 only,
  random-token auth, SSE). Events live in per-job in-memory ring buffers and must
  never be persisted to disk. High-frequency noise subtypes (thinking_tokens)
  are dropped at ingest so they cannot evict real events from the bounded ring.
- `scripts/lib/dashboard-page.mjs`: page assembly — inlines `dashboard-page.html`,
  `dashboard-page.css`, and `dashboard-client.mjs` into one response at load.
  Authored multi-file for review and tests, served single-response: no extra
  routes, no build, no runtime dependencies.
- `scripts/lib/dashboard-client.mjs`: dashboard browser logic. The DOM-free core
  (timeline reducer, tool summarizers, follow-mode state machine) is exported
  for `node --test`; the bootstrap only runs in a browser.
- `scripts/lib/task-title.mjs`: bounded, credential-redacted dashboard task
  titles derived from live task text. Titles are companion-memory only and
  must never reach disk — the persisted record keeps only `taskRef`.

## Non-Negotiable Contracts

- Delegation is foreground only; there is no background mode (`background` is rejected as
  an unknown parameter). Never emulate the plugin with shell, PTY, polling, or sleep loops.
- `dangerouslySkipPermissions` is opt-in. `write=false` exposes only Read, Glob, and
  Grep.
- Stateful tools require an absolute user-supplied `cwd`.
- Omitted `model` inherits Claude Code configuration without `--model`. Known aliases
  are forwarded to Claude; the plugin must not claim their provider model without
  transcript evidence.
- Keep `requestedModel`, executed transcript models, and `modelUsage` keys distinct. A
  usage key is not execution evidence.
- Cancellation may signal only a live controller owned by the current MCP server, never
  a persisted PID. Preserve `running → cancelling → cancelled` and wait for tree death
  plus lease release.
- New sessions use a pre-allocated `--session-id`; resumed sessions use `--resume`.
  These flags are mutually exclusive.
- Auto-compact settings are inline and process-local. Never write permanent Claude
  configuration or mutate the parent environment.
- `compacted: true` requires a new canonical `compact_boundary` after the invocation's
  transcript cursor. Never infer or fabricate it.
- Continuations must go through `cc_plan_continuation`. Plans are single-use,
  15-minute, process-local, and bound to action, parent session, workspace, model, and
  write profile. Incomplete evidence must never guess compaction; cumulative multi-turn
  billing usage must never be treated as current context.
- Repository content used in review prompts is untrusted evidence and must remain
  bounded and secret-filtered.
- Tool results are text-first (`content[]` only): never emit `structuredContent`
  duplicates. Tool schemas carry hard invocation rules; deep semantics live in the
  skills. Codex-side token budgets are pinned by `tests/token-budget.test.mjs`
  (see `docs/adr/0001-codex-side-token-cost.md`).
- `cc_check` must not re-deliver an unchanged terminal result: keep the
  process-local result fingerprint dedup and the `includeResult` escape hatch.

## Cross-Platform Contract

The supported platforms are macOS, Linux, and Windows. Windows compatibility is part of
the definition of done, not a later CI repair.

- Before changing process, filesystem, path, signal, cleanup, CLI discovery, or test
  code, identify the Windows behavior explicitly.
- Prefer Node APIs and `path`/`os` helpers. Do not assume POSIX separators, `/tmp`,
  executable bits, Unix signals, `sleep`, or shell utilities exist.
- Keep subprocess arguments as arrays with `shell: false`. Claude is commonly installed
  as an npm `.cmd` shim on Windows; route CLI discovery through
  `resolveCommandForSpawn` instead of spawning a bare command or concatenating a shell
  string.
- Process-tree termination must preserve the POSIX process-group path and the Windows
  `taskkill /T /F` path.
- Tests that execute fake Claude must provide the Windows `.cmd` shim and its Node
  entrypoint. Wait for child handles to close and use bounded Windows retries for
  temporary-directory cleanup where locks can linger.
- Platform branches need deterministic tests. A macOS/Linux pass alone is not evidence
  that a process or filesystem change is cross-platform.
- Keep `.github/workflows/ci.yml` covering Ubuntu, macOS, and Windows on every supported
  Node major. All matrix jobs must pass before declaring cross-platform completion.

## Validation and Install

Use the smallest relevant check while iterating, then finish with:

```bash
npm run verify:ci
npm run verify
```

`verify:ci` is the GitHub Actions entrypoint. `verify` also refreshes the cachebuster,
reinstalls the local plugin, compares source with the active cache, and tests the
installed copy. Open a new Codex task after reinstalling.

Do not run paid calibration during ordinary implementation or before code review and
zero-cost verification are clean. Calibration requires explicit budget authorization.

The canonical review schema is `schemas/review-output.schema.json`. Verdicts are
`approve`, `needs-attention`, `request_changes`, and `reject`; every finding requires
file, integer line bounds, confidence, and a non-empty recommendation.
