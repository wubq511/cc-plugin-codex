# Dynamic Model Routing — Final Review Round 2

> Status: superseded by [Final Review Round 3](./2026-07-24-dynamic-model-routing-final-review-round-3.md).
>
> Reviewed branch: `glm/dynamic-model-routing@3665cf2`
>
> Baseline: `main@9871d75`
>
> Date: 2026-07-24

## Decision

Do **not** merge `3665cf2` yet. The rework correctly moved the default authority to
`cc-profile-switch`, re-reads it per request, implements common/profile precedence,
and restores the non-interactive CLI protocol. However, two P0 defects and several
adjacent contract defects remain. One P0 is reproducible with Robert's current
profile configuration without a Provider call: resolving `Opus` or `Fable` fails
before delegation.

This is one focused repair on the same branch. Do not redesign routing, add a
Provider catalogue, change global Provider settings, run a paid probe, push, merge,
or reinstall the plugin.

## Evidence that passed but is insufficient

- `npm test`: 325 passed, 0 failed.
- `npm run verify:source`: passed.
- Print-mode JSON, fresh cc-profile-switch reads, stale `ANTHROPIC_*` stripping,
  profile precedence, and isolated alias/native fixture coverage are present.

Those tests miss the real shared-model configuration shape and several output paths.

## P0 repairs

### Valid duplicate display declarations must coalesce

`deriveAliasMappings()` rejects every repeated canonical display name. The current
`api-settings.json` intentionally declares `glm-5.1` for both Sonnet and Fable,
and both declarations point to the same native model. That is valid: several aliases
may target one model. The resolver currently throws `ProfileResolutionError` before
delegation.

- Coalesce a duplicate display name when its canonical native ID is identical.
- Fail closed only when one canonical display name maps to different native IDs.
- Add a shared-target fixture regression and a distinct-target collision rejection
  test.

### Captured failures must never reveal task text

`redactText()` intentionally retains ordinary text. Failure diagnostics persist
redacted stdout/stderr, and `cc_check` renders `errorDetail`. A CLI or Provider
error echoing a task marker can therefore put prompt text in an artifact and normal
MCP output.

Apply context-aware task-literal redaction before diagnostic persistence and every
MCP presentation. `cc_check` must render only stage, duration, structured-error
presence, and a generic safe summary, not raw error excerpts. Add a black-box
fake-Claude echo test proving a unique task marker is absent from job state,
diagnostics artifact, normal logs, `cc_delegate`, and `cc_check` output.

## P1 repairs

1. **Source/cache root mismatch.** `cc_setup` compares source `scripts/` with the
   installed plugin root, so a correct installed cache always differs. Compare root
   with root (or scripts with scripts), and test matching and mismatched fixtures.
2. **Fallback symlink containment.** Apply the cc-profile-switch adapter's
   realpath/containment rule to fallback `settings.json` and `active-profile.json`.
   Test both symlink escapes fail before spawn.
3. **Bound native selectors.** Reject controls, all whitespace, and overlong values
   before snapshot, structured output, or CLI argv. Continue to allow legitimate
   native forms with slash, colon, dot, underscore, and hyphen.
4. **Record preflight failures.** Authority or selector failure must create a bounded
   rejected job with ID, configuration diagnostic, and private artifact. MCP only
   exposes category, generic safe summary, and job ID; Claude is never spawned.
5. **Versioned authority schema.** Explicitly accept only the known
   cc-profile-switch config version; unknown future versions fail before spawn.
6. **Contract/documentation alignment.** Update `cc_delegate.model` and
   `cc_list_models` from arbitrary passthrough to inherited/alias/bounded-native/
   exact-display semantics. Remove owner and Claude session IDs from `cc_check` MCP
   output or stop claiming they are private. Correct the state header to schema v5.

## Acceptance evidence

Run `npm test`, `npm run verify:source`, and `git diff --check main...HEAD`.
Add focused tests for every item above. The safe integration fixture must mirror the
shared Fable/Sonnet native target and prove alias resolution succeeds without
printing local configuration values or secrets.

Do not run a paid liveness probe. That remains a post-install, explicitly authorized
human operation.
