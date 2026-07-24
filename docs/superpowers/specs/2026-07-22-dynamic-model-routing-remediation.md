# Dynamic Model Routing — Final Review and Remediation

> Status: superseded by [final review round 2](2026-07-24-dynamic-model-routing-final-review.md); additional rework is required before merge.
>
> Reviewed branch: `glm/dynamic-model-routing@ad8bcebbe39a97225a0fdbcbdef3d7473a421950`
>
> Baseline: `main@9871d75`
> Date: 2026-07-22

## Decision

Do **not** merge `ad8bceb`. The non-interactive Claude protocol fix is valid and
the offline suite passes, but the implementation misses the central product
requirement: a Provider/profile switch must change the route used by the next
delegation from a long-lived Codex process.

This is one bounded rework on the existing branch. It is not a new feature
slice, and it must not introduce a second evaluation or Provider-management
system.

## Verified evidence

- `npm test`: 289 passed, 0 failed.
- `npm run verify:source`: passed.
- The local `cc-profile-switch` authority exists at
  `~/.cc-profile-switch/config.json`; its `lastUsedProfile` identifies the
  active profile. Its documented launch topology is:

  ```text
  config.json.lastUsedProfile
    -> profiles/<name>/claude-home/settings.json
    +  api-settings.json
    -> child CLAUDE_CONFIG_DIR + merged Provider env
  ```

- `~/.claude/active-profile.json` does not exist.
- The reviewed implementation instead makes that nonexistent file the default
  authority and, when it is absent, passes the long-lived parent environment
  through unchanged. A real profile switch can therefore be ignored.

The tests prove the invented file adapter works; they do not prove that the
actual profile switcher controls a delegated Claude process.

## Required architecture correction

### 1. One real active authority, selected before every job

Replace the default `active-profile.json` authority with a read-only adapter for
the existing `cc-profile-switch` state. It must be re-read at the start of
every `cc_delegate`, `cc_resolve_route`, and authorized liveness probe.

The default macOS topology is:

```text
${CC_PROFILE_SWITCH_HOME:-~/.cc-profile-switch}/config.json
  lastUsedProfile
    -> profiles/<safe-name>/claude-home/settings.json
    +  api-settings.json
```

The adapter must validate every JSON document and profile name/path, resolve
all paths under the configured app home, and fail at the `configuration` stage
when `cc-profile-switch` exists but cannot be safely resolved. It must never
fall back to a prior in-memory route or stale inherited `ANTHROPIC_*` state.

For users who do not have `cc-profile-switch`, a separately documented
Claude-settings adapter may read the current `~/.claude/settings.json`. Its
selection must be explicit and it must obey the same child-environment rules.
The old `active-profile.json` shape may remain only as an explicit test fixture
or explicitly selected compatibility adapter; it must not silently become the
normal production authority without a producer.

### 2. Preserve existing profile-switch precedence without exposing secrets

For the selected cc-profile-switch profile, construct the child configuration
from the same source classes used by cc-profile-switch:

```text
common api-settings env < profile claude-home/settings.json env
```

The profile's `claude-home` becomes child-only `CLAUDE_CONFIG_DIR`.

Before injecting this selected configuration, always remove every inherited
`ANTHROPIC_*` variable and the fixed Provider-routing flags
`CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CODE_USE_VERTEX`. Then inject only:

- validated `ANTHROPIC_[A-Z0-9_]+` string variables from the selected source;
- an intentionally allowlisted set of Claude routing flags, if declared by the
  selected source; and
- the selected `CLAUDE_CONFIG_DIR` and existing safe Claude profile settings
  needed for normal cc-profile-switch behavior.

Do not accept arbitrary `envVars`, arbitrary `stripInherited` lists, `PATH`,
`NODE_OPTIONS`, or arbitrary process environment keys from a JSON profile.
Secrets may enter the spawned child only. They must not enter route snapshots,
job metadata, diagnostics, stdout, Markdown, hashes, or tests.

### 3. Alias/native resolution from live mappings

Build the non-secret projection from the selected active configuration on every
resolution. Derive alias claims from the current `ANTHROPIC_DEFAULT_*_MODEL`
keys and, where declared, display names from corresponding `_NAME` keys.

- `Opus` / `Fable` are case-insensitive aliases passed to Claude as `opus` /
  `fable`.
- Exact native IDs such as `deepseek-v4-pro` and `glm-5.2` pass unchanged.
- A bare family name such as `DeepSeek` or `GLM` remains ambiguous unless it is
  an exact active-profile display name; reject it with a bounded correction.
- Canonicalize alias/display lookup keys before storage, reject case-fold
  collisions, and fingerprint the canonical mapping plus the effective
  non-secret routing policy and injected key names (never values).

### 4. MCP and liveness contract

`cc_resolve_route` must return bounded machine-readable `structuredContent` as
well as concise text. It must include selector kind, requested value, CLI arg,
active-source kind, profile identity/fingerprint, non-secret alias claim, CLI
version, and the statement that this is not execution proof.

`cc_setup` liveness must accept the same optional model selector as delegation.
It requires explicit `livenessProbe: true`, a positive timeout, and a positive
`maxBudgetUsd` passed through to a CLI capability that is verified first. It
must record requested route, cost provenance (`provider_reported`,
`versioned_price_estimate`, or `unknown`), and runtime evidence. If a required
budget guard is unsupported or cost cannot be represented honestly, fail
closed rather than making the paid call.

Static setup must actually compare the loaded Companion/cache manifest against
the active installed cache using the existing `install-cache` helpers. It may
report `not-installed` when running source, but never print a green
compatibility claim without a comparison.

Keep the documented terminal `routeStatus` enum. Cancellation must either have
a documented non-terminal exception or persist a valid status; do not store
`null` as a final route status.

### 5. Documentation truthfulness

Either expose a bounded, redacted diagnostic summary via `cc_check` or remove
the claim that `cc_check` exposes private diagnostics. Update all setup and
delegate documentation to describe the real cc-profile-switch authority and
the source/cache/liveness limitations accurately.

## Required tests and acceptance evidence

Add deterministic tests that prove all of the following:

1. Switching `config.json.lastUsedProfile` between two fixture profiles changes
   the next job's snapshot and child env without restarting the companion.
2. `api-settings.json` plus the selected profile settings produce the documented
   precedence, while stale parent `ANTHROPIC_*`, Bedrock, and Vertex settings
   never survive.
3. Malformed config, invalid profile name, traversal/symlink escape, missing
   selected profile, or unsupported profile schema fails before spawning Claude.
4. Arbitrary profile environment keys and replacement strip lists are rejected;
   secrets do not appear in snapshots, diagnostics, state, or MCP output.
5. `Opus` / `Fable`, exact native IDs, exact display names, ambiguous names,
   mixed-case mapping keys, and case-fold collisions behave as specified.
6. Fingerprints change when any effective non-secret mapping, source identity,
   policy, or injected key set changes.
7. `cc_resolve_route` has a bounded JSON result and no secret-bearing fields.
8. `cc_setup` checks real source/cache state; liveness accepts the selected
   route and refuses missing/invalid budget guards without a Provider call.
9. Cancellation, non-zero stdout-only/stderr-only errors, resume, read-only
   policy, installed-cache checks, and all existing protocol tests stay green.

Do not run a paid liveness call in automated tests or while reworking this
branch. A human may authorize one minimal `Opus` probe only after merge,
cachebuster/install, and a fresh Codex task.

## Rework exit gate

The branch is ready for review only when the new tests pass, `npm test` and
`npm run verify:source` pass, `git diff --check main...HEAD` is clean, and a
safe local fixture demonstrates an actual `lastUsedProfile` switch changing
the route snapshot. Do not push, merge, reinstall, modify global Provider
configuration, or perform a paid liveness probe during rework.
