# Auto-Compact, Session Resume, and Cancellation Hardening Spec

> Status: Canonical spec for the compact feature upgrade. All "必须/只允许/禁止" clauses are hard constraints. "建议" clauses may be replaced by a better approach with a note in PROGRESS.md.

Date: 2026-07-29
Baseline: 0.3.0+codex.20260724175624, 7 tools, schema v7, 331 tests, 0 skipped.

## 1. Goals

1. Per-delegation/session/task temporary auto-compact configuration via inline `--settings`, with zero writes to permanent Claude/Provider config or parent `process.env`.
2. A new `cc_compact` tool that runs a read-only foreground `/compact` on a stopped session and honestly reports whether a compact boundary was crossed.
3. Pre-allocated Claude session UUID (`--session-id`) for new delegations; resume uses only `--resume`; the two are mutually exclusive.
4. Cancellation state machine `running → cancelling → cancelled` with async confirmation: `cc_cancel` returns only after the process tree is dead and the writer lease is released.
5. `taskScopeId` for cross-delegation task-level scope inheritance without cwd/prompt guessing.
6. State schema v8 with v7 migration; all existing atomic-write / privacy / lease / retention guarantees preserved.

## 2. Cancellation State Machine (Task 1)

### 2.1 Problem

- `cc_cancel` writes `cancelled` and returns immediately after signalling; it does not wait for the watchdog/Claude process tree to exit or the writer lease to release.
- A late success result can race with the cancel write (`completed` vs `cancelled`).
- `gracefulShutdown` releases the writer lease before draining the foreground process tree, opening a second writer window.

### 2.2 State Machine

```
running ──cc_cancel──▶ cancelling ──process tree dead──▶ cancelled
   │                       ▲
   │                       │ late result arrives while cancelling
   │                       │ → finalizer writes cancelled (never completed)
   ▼
completed / failed          ← only when status was still running when finalizer reads
```

Hard rules:
- `cancelling` is a first-class status, not just a phase.
- Once `cancelling` is persisted, the terminal status **必须** be `cancelled` regardless of the result's `ok` field.
- If the job is already terminal (`cancelled`/`completed`/`failed`/`rejected`) when `cc_cancel` reads it, return the current status honestly; do not lie that a cancel was performed.
- `cc_cancel` **必须** hold the live in-memory controller for the job (from `activeForegroundRuns`). If no handle exists, it **禁止** claiming success via persisted PID signalling.
- `cc_cancel` **必须** await watchdog/Claude process tree exit and writer lease release before returning.
- Duplicate `cc_cancel` calls on the same job are idempotent: a second call while `cancelling` waits for the same settlement; a call after `cancelled` returns the existing status.

### 2.3 Centralized Finalizer

A single `finalizeJob` function is the only writer of terminal status. Both `handleDelegate`'s result path and `handleCancel`'s settlement path call it.

```text
finalizeJob(workspaceRoot, jobId, requestedStatus, patch):
  1. Read current job synchronously. The function has no await points, so
     read/decide/write is one event-loop critical section.
  2. If already terminal → return current (first writer wins, no override).
  3. If status === "cancelling" → finalStatus = "cancelled" (regardless of requestedStatus).
  4. Else → finalStatus = requestedStatus.
  5. Write terminal status + patch (pid: null, completedAt, routeStatus, ...).
  6. Return final job.
```

An in-memory Map caches the first terminal decision until the delegate cleanup
finishes. Re-entrant or late finalizer calls return that same decision. Together
with the synchronous critical section and atomic job write, this prevents the
completed-vs-cancelled race within one server process.

### 2.4 Graceful Shutdown

`gracefulShutdown` **必须**:
1. Mark owned running/queued jobs as `cancelling` (not directly `cancelled`).
2. Cancel all foreground executions (signal watchdog).
3. Await process tree exit (bounded grace period).
4. **Only then** release writer leases.
5. Transition any still-`cancelling` jobs to `cancelled`.

### 2.5 MCP notifications/cancelled

The MCP `notifications/cancelled` handler calls the same `setCancel` path as `cc_cancel`: it transitions to `cancelling`, signals the watchdog, and the delegate's result path settles via the finalizer. No late MCP response is sent for a cancelled request (the `pendingToolCalls` guard already suppresses it).

## 3. Auto-Compact Policy (Task 2)

### 3.1 API

`cc_delegate` gains an optional `autoCompact` directive. It is one of:

```json
{
  "contextWindowTokens": 256000,
  "targetTokens": 230000,
  "scope": "delegation"
}
```

```json
{ "scope": "task", "taskScopeId": "550e8400-e29b-41d4-a716-446655440000" }
```

```json
{ "scope": "task", "taskScopeId": "550e8400-e29b-41d4-a716-446655440000", "clear": true }
```

`null` is also accepted. On an explicit session resume it clears that exact
session's inherited policy; otherwise it means no policy for this invocation.

| Field | Type | Rule |
|-------|------|------|
| `contextWindowTokens` | positive safe integer | User-declared, unverified. **禁止** inferring from Opus/Fable, Provider routing, or `[1M]` markers. Required together with `targetTokens` for a full policy. |
| `targetTokens` | positive safe integer | Nominal target. **必须** ≤ `floor(contextWindowTokens * 0.9)`, else reject before spawn. Required together with `contextWindowTokens` for a full policy. |
| `scope` | enum `delegation\|session\|task` | Default `delegation` for a full policy. Task inherit/clear directives require `task`. |
| `taskScopeId` | UUID string | Omit on the first full task policy to generate a UUID. Carry that UUID for task inheritance. |
| `clear` | boolean | Only `true` is valid, only with `scope:"task"` plus a UUID, and cannot be combined with context/target. |

Unknown task IDs fail before spawn. They **禁止** silently running without the
policy the caller requested. `taskScopeId:null` is rejected because it cannot
identify which task policy to clear; omitting the field on a full task policy
means "generate a new task ID."

### 3.2 Computation

- Fixed `pct = 90`.
- `effectiveWindow = ceil(targetTokens / 0.9)`.
- Validation examples (hard):
  - `256K / 250K` → reject (250000 > floor(256000 × 0.9) = 230400).
  - `256K / 230K` → accept (230000 ≤ 230400). effectiveWindow = ceil(230000 / 0.9) = 255556.
  - `1M / 300K` → accept. effectiveWindow = ceil(300000 / 0.9) = 333334.
  - `300K / 333334` (target > context) → reject.

Claude Code applies `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` as a percentage of
`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, and caps that window at the model's actual
context window. The override can lower a model's built-in proactive threshold
but cannot raise it. Therefore the requested threshold is exact only when the
actual routed model window is at least `effectiveWindow` and no higher-priority
managed policy or model-specific earlier threshold wins. With a custom Provider,
the plugin **禁止** promising an exact hit from the user-declared window alone.

### 3.3 Inline Settings Injection

The compact env keys are injected via `--settings <json-string>` (Claude CLI accepts a JSON string per `--settings <file-or-json>`). **禁止** writing to `~/.claude/**`, project `.claude/`, or parent `process.env`.

The inline settings JSON contains **only** two env keys:

```json
{
  "env": {
    "CLAUDE_CODE_AUTO_COMPACT_WINDOW": "<effectiveWindow>",
    "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "90"
  }
}
```

No other settings keys are injected. The JSON string is built with `JSON.stringify` and passed as a single `--settings` argument.

### 3.4 Honest Reporting

The output **必须** distinguish three layers:
- `requestedTarget`: the user-supplied `targetTokens` (nominal).
- `effectiveWindow`: the computed `ceil(target / 0.9)` injected via settings.
- `observedBoundary`: what was actually observed from the transcript (may be `null` if not observed). **禁止** fabricating.

Claude may truncate the window, skip a turn, or a managed policy may override — these can cause early or offset compaction. The plugin never claims precise target hit.

### 3.5 Scope Semantics

| Scope | Lifetime | Persistence | Replay |
|-------|----------|-------------|--------|
| `delegation` | Current process + subagents only | Audit record only | Not replayed |
| `session` | Bound to Claude session | Persisted in job record | Replayed on `resume` / `cc_compact` of same session |
| `task` | All delegations of same Codex task | Persisted (taskScopeId) | New Claude sessions inherit if same taskScopeId |

Priority (high → low): **this-call explicit value > session > task > none**.

taskScopeId rules:
- First `task` scope call without `taskScopeId`: generate a UUID, persist before spawn, return in MCP response.
- Return that generated UUID on completed, failed, and cancelled delegation
  responses and expose it through `cc_check`; a failed first session must not
  strand the task policy.
- Subsequent task-policy inheritance calls: **必须** carry the same UUID with `scope:"task"`. Supplying a full policy with a new UUID starts a separate task scope; supplying an unknown UUID without a full policy fails closed.
- **禁止** guessing task membership by cwd, prompt text, or server session.
- `{scope:"task", taskScopeId, clear:true}` writes a task tombstone. Later inheritance with that ID fails until a new full policy is explicitly supplied.
- `autoCompact:null` on an explicit resume writes a session tombstone. Later resumes and `cc_compact` of that session do not replay an older session policy.

### 3.6 Audit Fields (non-sensitive)

The job record stores non-sensitive audit fields for the compact policy:
- `autoCompact.scope` — the resolved scope.
- `autoCompact.contextWindowTokens` — user-declared (integer).
- `autoCompact.targetTokens` — user-declared (integer).
- `autoCompact.effectiveWindow` — computed (integer).
- `autoCompact.taskScopeId` — the resolved task scope ID (or null).
- `autoCompact.settingsInjected` — boolean (true if --settings was passed).
- `autoCompact.cleared` — boolean tombstone marker for an explicit session/task clear.

No secrets, no full settings JSON, no parent env snapshot.

## 4. Pre-allocated UUID + cc_compact (Task 3)

### 4.1 Pre-allocated Session UUID

For new (non-resume) delegations:
1. Generate `claudeSessionUuid = crypto.randomUUID()` before spawn.
2. Persist it in both `claudeSessionUuid` and the provisional canonical
   `claudeSessionId` immediately (before the watchdog starts).
3. Pass `--session-id <uuid>` to the Claude CLI.
4. The result's `session_id` **应该** match the pre-allocated UUID. The
   caller-selected `--session-id` remains the canonical `claudeSessionId`; the
   result artifact separately records the Provider/CLI-returned value so a
   mismatch cannot redirect later compact/resume operations.

For resume delegations:
- Use `--resume <sessionId>` only. **禁止** combining `--session-id` and `--resume`.
- The pre-allocated UUID is not generated; `claudeSessionUuid` is null and
  `claudeSessionId` is the resumed session ID before spawn.

Cancellation **必须** preserve `claudeSessionId`, `claudeSessionUuid`, `taskScopeId`, and the auto-compact policy in the job record.

### 4.2 cc_compact Tool

```
cc_compact(cwd, job?, resumeSession?)
```

Behavior:
1. Locate the target session:
   - If `resumeSession` provided: validate it as a session ID.
   - Else if `job` provided: find job by ID/prefix, read its canonical session ID.
   - Else: find the latest stopped job in the workspace with a `claudeSessionId`.
2. Match the selected session against every local job's `claudeSessionId`,
   `claudeSessionUuid`, and `resumeSession`. **Reject** if any matching job is
   `running`, `queued`, or `cancelling`, including when the caller selected the
   session with explicit `resumeSession`.
3. **Reject** if the job is owned by another server session and is not terminal.
4. Resolve the stored policy for the selected job/session. Replay `session` and
   `task` policy through the same inline `--settings`; do not replay a
   `delegation` policy or a clear tombstone.
5. Capture a bounded transcript cursor before invocation.
6. Run `claude --print --resume <sessionId> --input-format text --output-format json` with `/compact` as stdin input. Read-only foreground (no write tools, no --dangerously-skip-permissions).
7. Parse the JSON result.
8. Collect only compact boundary evidence appended after the pre-invocation
   cursor (bounded, path-contained — same safety pattern as
   model-evidence-collector).
9. Return:

```json
{
  "compacted": true|false,
  "preTokens": <integer|null>,
  "trigger": "manual"|"auto"|null,
  "reason": "<string if not compacted>",
  "requestedTarget": <integer|null>,
  "effectiveWindow": <integer|null>,
  "observedBoundary": <integer|null>
}
```

Rules:
- Only a canonical `type:"system", subtype:"compact_boundary"` record appended
  after this invocation's cursor → `compacted: true`.
- A historical boundary or `isCompactSummary` marker alone **禁止** proving
  success for the current invocation.
- Insufficient messages (Claude returns without compacting) → `compacted: false` + reason.
- **禁止** fabricating `observedBoundary` or `preTokens` if not actually observed.
- `requestedTarget` and `effectiveWindow` come from the job's stored auto-compact policy (if any).

### 4.3 Boundary Collection

The boundary collector reads the Claude session transcript JSONL:
- Same path-safety pattern as `model-evidence-collector.mjs`: sessionId validated, realpath containment, bounded read, deadline.
- Captures the transcript device/inode/byte-size cursor immediately before the
  invocation and reads only bytes appended to the same regular file. A replaced
  or truncated transcript fails closed.
- Looks only for canonical system `compact_boundary` records. Legacy top-level
  `compact_boundary` may be parsed for backwards compatibility, but summary
  markers never count as boundary proof.
- Extracts `compactMetadata.preTokens` and `compactMetadata.trigger`
  (manual/auto) from the real transcript structure.
- Returns `null` if no boundary found or transcript unavailable.
- **禁止** reading or persisting transcript content beyond the boundary metadata.

### 4.4 Auto-Compact Deviation Recording

If auto-compact was configured for a delegation and the transcript shows a compact boundary:
- Capture a pre-run cursor and record only a boundary appended during this
  delegation. A boundary from an earlier resume is not evidence for this run.
- Record `observedBoundary` (the actual pre-compaction token count).
- Present `observedBoundary` beside `requestedTarget`. Do not invent an
  arbitrary "significant deviation" threshold; the two explicit values are
  the audit evidence.
- If no boundary was observed, `observedBoundary` is `null` — do not fabricate.

## 5. State Schema v8 (Task 4)

### 5.1 New Fields (additive)

| Field | Type | Description |
|-------|------|-------------|
| `claudeSessionUuid` | string\|null | Pre-allocated UUID for new sessions |
| `autoCompact` | object\|null | Resolved compact policy or clear tombstone (scope, contextWindowTokens, targetTokens, effectiveWindow, taskScopeId, settingsInjected, cleared) |
| `compactResult` | object\|null | Result of cc_compact (compacted, preTokens, trigger, reason, observedBoundary) |

### 5.2 New Status

`cancelling` — non-terminal status between `running` and `cancelled`.

### 5.3 Migration v7 → v8

- Additive: new fields default to `null`/`undefined`.
- `cancelling` status: no old jobs will have it; `reconcileOrphans` now also marks `cancelling` jobs as `orphaned`.
- Idempotent: v8 jobs pass through unchanged.
- All existing privacy chokepoints (`sanitizeJobForStorage`, 64 KiB cap, atomic write, lease, retention) are preserved.

### 5.4 Privacy

- `autoCompact` contains only non-sensitive integers, booleans, enums, and a
  UUID. `compactResult` additionally contains one bounded plugin-generated
  reason string when no new boundary was observed.
- No task content, no secrets, no full settings JSON, no parent env snapshot.
- `taskScopeId` is a UUID — non-sensitive.
- `claudeSessionUuid` is a UUID — non-sensitive.

## 6. Adversarial Review

### 6.1 Config Leak
- **Risk**: inline `--settings` JSON leaks into argv, logs, or state.
- **Mitigation**: the settings JSON contains only two env keys (no secrets). It is passed as a single argv element to the Claude child, not to the watchdog. The watchdog passes it through to Claude. The settings JSON is **not** persisted in job state (only the computed integers are). The watchdog's argv never contains the task. `--settings` is not logged.

### 6.2 Cross-Task Pollution
- **Risk**: task scope inherited by wrong task due to cwd/prompt guessing.
- **Mitigation**: taskScopeId is the **only** inheritance key. First generation creates a UUID; subsequent calls **必须** explicitly carry the same ID. No cwd, prompt, or server-session matching. Different ID = different task scope (isolation).

### 6.3 Cancel/Complete Race
- **Risk**: `completed` overwrites `cancelled` or vice versa.
- **Mitigation**: centralized `finalizeJob` with per-job in-memory lock. Once `cancelling` is persisted, terminal status is always `cancelled`. First terminal writer wins; second call is a no-op.

### 6.4 Lease Early Release
- **Risk**: writer lease released before process tree dies, opening a second writer window.
- **Mitigation**: lease release happens **after** `execution.result` resolves (watchdog exited). `gracefulShutdown` drains processes before releasing leases. `cc_cancel` awaits process tree death before returning.

### 6.5 Fake Compact
- **Risk**: `cc_compact` returns `compacted: true` without actual compaction.
- **Mitigation**: `compacted: true` requires a canonical `compact_boundary`
  appended after the pre-invocation cursor. Old boundaries and summary markers
  do not count. No new boundary → `false`. `observedBoundary` is `null` if not
  observed, never fabricated.

### 6.6 Session Hijacking
- **Risk**: `cc_compact` or `resume` operates on a session owned by another server.
- **Mitigation**: `cc_compact` rejects active/cancelling jobs. For stopped jobs, it verifies the session ID format and uses `--resume` (Claude's own session validation). The plugin never injects session IDs into other servers' jobs. `--session-id` is only used for new sessions with a freshly generated UUID.

## 7. Test Plan (Red → Green)

All tests use the fake Claude. No paid calls. tests ≥ 331, skipped = 0.

### 7.1 Cancellation
- `cancelling` status during cancel; `cc_cancel` returns after process tree dead + lease released.
- Fake Claude leaves descendants → all dead after cancel.
- Completed-vs-cancel race: result arrives as cancel is requested → final status is `cancelled` (if cancelling was set) or `completed` (if completed was written first).
- No handle → honest "not running" or "foreign-owned" response.
- Duplicate cancel is idempotent.
- Graceful shutdown: processes drained before lease released.
- Immediate compact/new write after cancel does not conflict (lease is free).

### 7.2 AutoCompact Validation
- Illegal fields (non-integer, negative, missing) → reject.
- `target > 90% of context` → reject before spawn (256K/250K).
- `300K → effectiveWindow 333334`; `230K → 255556`.
- Temp HOME settings: digest/mtime/file count unchanged; parent env unchanged.
- `--settings` arg contains only the two compact env keys.

### 7.3 Scope Inheritance
- Three scopes: delegation (not replayed), session (replayed on resume), task (new session inherits same taskScopeId).
- Unknown taskScopeId inheritance → fail before spawn; a new full policy with a different UUID is isolated.
- Explicit session null and explicit task clear directive persist tombstones.
- Priority: this-call > session > task > none.

### 7.4 UUID + Resume
- UUID generated and persisted before spawn.
- New session uses `--session-id`; resume uses `--resume` only (no `--session-id`).
- Provisional canonical `claudeSessionId` is persisted before spawn and cancellation preserves it, taskScopeId, and policy.

### 7.5 cc_compact
- Active/cancelling job → reject.
- Explicit `resumeSession` matching an active/cancelling job → reject.
- Stopped job → run `/compact`.
- Historical boundary before invocation → `compacted:false`.
- Boundary appended by the compact invocation → `compacted: true`, preTokens, trigger.
- Session/task stored policy is replayed; delegation policy is not.
- Insufficient messages (no boundary marker) → `compacted: false` + reason.
- `observedBoundary` is `null` if not observed.

### 7.6 Non-Regression
- All 331 existing tests pass unchanged.
- No deleted tests, no skip/todo, no relaxed assertions, no `|| true`.
