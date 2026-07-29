# PROGRESS — Compact Auto-Compact & Session Resume Upgrade

## Kickoff Receipt (2026-07-29)
- Baseline: 331 tests/0 skipped, verify:source green, worktree clean.
- Spec: docs/superpowers/specs/compact-auto-compact-and-session-resume.md (adversarial-reviewed).
- Key decisions: inline --settings JSON (file-or-json, zero writes), centralized synchronous finalizeJob critical section + terminal cache, cancelling status, crypto.randomUUID pre-alloc, taskScopeId as sole inheritance key.
- Task order: 1(cancel fix) → 2(autoCompact+taskScopeId) → 3(UUID+cc_compact+boundary) → 4(schema v8+docs+skills) → 5(verify).

## Task 0 — DONE
- [x] npm test 331 pass / 0 skipped
- [x] npm run verify:source green
- [x] Read companion/watchdog/state/routing/route-status/model-evidence/skills/tests
- [x] Verified CLI flags: --session-id <uuid>, --resume, --settings <file-or-json>, /compact
- [x] Wrote spec + adversarial review

## Task 1 — DONE: Cancellation fix
- [x] Red tests: cancelling status, async cc_cancel, race, lease, shutdown
- [x] Centralized synchronous finalizeJob critical section + finalizingJobs terminal cache
- [x] cc_cancel async confirm: cancelling → signal → await completionPromise → return
- [x] handleDelegate result path: try/finally with completionResolve
- [x] gracefulShutdown: mark cancelling → signal → await drain → release lease → finalize
- [x] Fixed test design: removed FAKE_CLAUDE_MODE env override (was making ALL delegations hang); now uses stdin mode via task text
- [x] hang-slow mode added to fake-claude.mjs for observable cancelling status
- [x] All 337 tests pass, 0 skipped, verify:source green

## Task 2 — DONE: autoCompact + taskScopeId
- [x] Red tests: validation (illegal fields, >90%, 256K/250K reject, 300K→333334, 230K→255556)
- [x] Red tests: inline --settings (two env keys only, parent env unchanged, HOME settings untouched)
- [x] Red tests: three scope inheritance/override/clear, taskScopeId isolation
- [x] Implement autocompact.mjs: validateAutoCompact, computeEffectiveWindow, buildInlineSettings, resolveScope, generateTaskScopeId, buildAutoCompactAudit
- [x] Implement inline --settings JSON injection in handleDelegate
- [x] Implement scope resolution + taskScopeId generation/inheritance (this-call > session > task > none)
- [x] watchdog.mjs accepts inlineSettings + sessionId params
- [x] 379 tests pass, 0 skipped

## Task 3 — DONE: UUID + cc_compact + boundary
- [x] Red tests: UUID pre-alloc before spawn, resume has no --session-id, cancel preserves IDs
- [x] Red tests: cc_compact rejects active/cancelling, boundary true/false, observedBoundary null if not observed
- [x] claude-runner.mjs passes sessionId to watchdog config
- [x] handleDelegate generates claudeSessionUuid, persists before spawn, passes to runClaude
- [x] Implement cc_compact tool (8th tool) — handleCompact with session locate/reject/compact/boundary
- [x] Implement compact-boundary.mjs (path-contained transcript reader, symlink escape rejection)
- [x] Auto-compact deviation recording (observedBoundary, compactTrigger) in handleDelegate success path
- [x] 396 tests pass, 0 skipped (17 new tests in compact-session.test.mjs)

## Task 4 — DONE: schema v8 + README + skills + cache
- [x] State schema v8: STATE_VERSION=8, v7→v8 migration (additive: claudeSessionUuid, autoCompact, compactResult, cancelling)
- [x] README: document cc_compact, autoCompact, --session-id, --resume, cancelling status
- [x] AGENTS.md: architecture + key decisions updated (8 tools, cancelling state machine, autoCompact, cc_compact)
- [x] Skills: delegate skill (autoCompact/taskScopeId) updated; compact skill created
- [x] cc_compact registered in HANDLERS and TOOLS (8 tools total)
- [x] Install cache: cachebuster updated to 0.3.0+codex.20260729051324

## Task 5 — DONE: final verification (R1)
- [x] npm test: 396 pass / 0 skipped / 0 fail
- [x] npm run verify:source: green
- [x] python3 validate_plugin.py: passed
- [x] npm run verify: FULLY INSTALLED green

## R2 — Fix round (user review rejected R1)

### P0-1 FIXED: compact-boundary parser used self-invented structure
- Real transcript: `{type:"system", subtype:"compact_boundary", compactMetadata:{preTokens, trigger}}`
- Old parser tested `{type:"compact_boundary", preTokens, compactTrigger}` (never matches real transcripts)
- Fix: parseTranscriptForBoundary now detects `type:"system" + subtype:"compact_boundary"` and extracts from `compactMetadata.preTokens`/`compactMetadata.trigger`. Legacy markers kept defensively.
- Tests updated to real structure; red→green confirmed.

### P0-2 FIXED: cc_compact ignored claudeSessionUuid for cancelled new sessions
- Cancelled new jobs have claudeSessionUuid (pre-allocated) but null claudeSessionId.
- handleCompact only read job.claudeSessionId → "No stopped session" for cancelled jobs.
- Fix: handleCompact falls back to claudeSessionId || claudeSessionUuid (both for job lookup and latest-stopped-job search).
- Red test: cancel new job → cc_compact(job) locates session via UUID. Green confirmed.

### P1-1 FIXED: task inheritance/clear contract unfulfilled
- Schema required contextWindowTokens+targetTokens (blocked taskScopeId-only inheritance) and type:"object" (blocked autoCompact:null).
- taskScopeId:null generated a new ID instead of clearing (validateAutoCompact normalized undefined→null).
- resolveScope never called in production code.
- Fix: schema type:["object","null"], removed required; validateAutoCompact preserves undefined/null/string distinction and supports inheritanceMode; cc-companion uses resolveScope for session-scope replay; taskScopeId:undefined generates, null clears, string inherits.
- Red tests: taskScopeId:null clears (not generate), taskScopeId:undefined generates. Green confirmed.

### P1-2 FIXED: cancellation race not sealed
- finalizingJobs.set() never called — Map always empty, lock never acquired.
- Success/failure paths called updateJob directly, bypassing finalizeJob.
- Fix: finalizeJob now writes Map (caches result); success/failure paths route through finalizeJob; finally block clears Map entry. First writer wins; cancelling always takes priority.
- BLOCKED.md: quick_validate.py exists in cc-profile-switch profiles — both skills pass. Removed false blocker.

## Task 5 (R2) — DONE: final verification
- [x] npm test: 399 pass / 0 skipped / 0 fail
- [x] npm run verify:source: green
- [x] python3 validate_plugin.py: passed
- [x] delegate/compact quick_validate: both pass (quick_validate.py from cc-profile-switch)
- [x] npm run verify: FULLY INSTALLED green (cache 0.3.0+codex.20260729054830 matches source)
- [x] MCP=8 tools, tests≥331 (399), skipped=0
- [x] Zero-drift: git diff .claude/ empty, parent env no compact keys
- [x] BLOCKED.md: 无

## R3 — Independent completion audit and repair

R2's 399 green tests did not prove the complete contract. The independent
audit found and repaired these additional gaps:

- [x] Manual compact now snapshots transcript device/inode/size before
  invocation and only accepts a canonical boundary appended after that cursor.
  Historical boundaries and `isCompactSummary` no longer produce false success.
- [x] Auto-compact observation on resumed sessions uses the same pre-run cursor,
  so an older boundary is not attributed to the current delegation.
- [x] Explicit `resumeSession` is matched against all active local job session
  identifiers and cannot bypass the active/cancelling guard.
- [x] `cc_compact` replays stored session/task inline settings and never replays
  delegation-only settings.
- [x] New/resumed canonical `claudeSessionId` is persisted before spawn; the
  cancelled-new-session workflow is now genuinely cancel → compact → same-ID
  resume.
- [x] Task IDs are UUIDs. Unknown/cleared task inheritance fails before spawn.
  Session/task clears persist tombstones; policy ordering uses immutable
  creation time so later compactResult updates cannot resurrect older policy.
- [x] Cancellation during post-result evidence collection returns cancelled
  consistently in state, `cc_cancel`, and the pending `cc_delegate` response.
  Cancel finalization preserves cancelled route/error semantics.
- [x] A controller is registered before pre-spawn transcript scanning. Cancel
  requests in that window settle as cancelled without spawning Claude; spawn
  failures no longer leave a persisted running job.
- [x] Unsafe-range token integers are rejected. Compact evidence collection
  fails closed when the pre-invocation cursor scan was uncertain, and
  `compactResult.reason` is persisted alongside the response.
- [x] Canonical spec, README, AGENTS.md, delegate skill, and compact skill
  updated before final verification.
- [x] Final full test/source/plugin/skill/install verification and zero-drift
  audit.

### R3 final verification

- `npm test`: 416 pass / 0 skipped / 0 fail.
- `npm run verify:source`: green; 416 tests, 32 `.mjs` files clean, 40 source
  files hashed, manifest and MCP config valid.
- Plugin validator: passed.
- Delegate and compact `quick_validate.py`: both passed.
- Real local transcript dark test: canonical boundary parsed as
  `preTokens=168390`, `trigger=auto`, `warning=null`.
- `npm run verify`: FULLY INSTALLED green; source/cache recursive diff empty,
  installed-cache tests passed, version
  `0.3.0+codex.20260729063834`.
- Installed MCP black-box `tools/list`: 8 tools including `cc_compact`.
- Zero drift: user `~/.claude/settings.json` digest and mtime unchanged;
  both permanent compact keys absent; parent compact env keys absent; project
  `.claude/` has no git diff; `scripts/verify-install.mjs` and
  `.agents/plugins/marketplace.json` untouched.
- Final standards/spec review: pass. No remaining actionable finding.

## R4 — Knowledge closeout and release handoff

- [x] Reconciled `AGENTS.md`, `CLAUDE.md`, `PRD.md`, `README.md`, the canonical
  compact spec, and the delegate/setup/compact skills against the schema-v8
  runtime and eight-tool MCP surface.
- [x] Removed stale current-state claims for seven tools, schema v7, five
  skills, immediate cancellation, and missing compact/session policy behavior.
  The compact spec retains its seven-tool/schema-v7 sentence only as the
  explicitly labelled pre-upgrade baseline.
- [x] Rechecked remote divergence before publication: local `main` and
  `origin/main` were even before the closeout commit.
- [x] Refreshed cachebuster and reinstalled the plugin. Final version:
  `0.3.0+codex.20260729070734`.
- [x] Final local gates: 416 pass / 0 skipped / 0 fail; source verification,
  plugin validator, delegate/setup/compact skill validation, full installed
  verification, and recursive source/cache comparison all green.
- [x] Published implementation commit `41659ff`. CI #12 passed Linux/macOS but
  exposed Windows-only failures: filesystem paths passed directly to ESM
  `import()`, a running-state/cancel-handle publication race, and a POSIX-only
  SIGTERM assumption in a graceful-shutdown test.
- [x] Replaced dynamic test imports with a static module import, registered the
  cancel handle before persisting `running`, used stdin EOF for the Windows
  graceful-shutdown path, and made `cc_setup` report the exported schema-v8
  constant instead of stale hard-coded v7 text.
- [ ] Push the CI repair commit and observe its six GitHub Actions jobs to
  terminal status.
