# Dynamic Model Routing — Final Review Round 3

> Status: **required rework before merge**.
>
> Reviewed branch: `glm/dynamic-model-routing@b392b52`
>
> Baseline: `main@9871d75`
>
> Date: 2026-07-24

## Decision

Do **not** merge `b392b52` yet. The second rework fixed important behaviour:
the real active `cc-profile-switch` authority now resolves `Opus`, `Fable`,
`deepseek-v4-pro`, and `glm-5.2` without a Provider call; same-target display
names coalesce; and the branch's offline suite and source verification pass.

It nevertheless leaves two P0 secret/prompt-boundary violations and several
evidence-contract defects. This is a focused third rework on the same branch,
not a new architecture or a new ticket. Do not merge, push, reinstall the
plugin, change global Provider configuration, or run a paid liveness probe.

## Verified evidence

- `npm test`: 348 passed, 0 failed.
- `npm run verify:source`: passed.
- `git diff --check main...HEAD`: passed.
- A zero-cost local authority read resolves the current profile as follows:
  `Opus` and `Fable` are aliases; `deepseek-v4-pro` and `glm-5.2` are native
  selectors. Stale inherited routing variables did not survive child-env
  construction.

This evidence proves the desired alias/native routing direction, but it does
not prove the plugin keeps prompts and configuration values out of normal state
and MCP presentation.

## P0 — required before merge

### 1. Remove task text from normal job state and MCP presentation

The canonical design forbids task prompts in normal job state, normal logs, and
MCP presentation. `cc-companion.mjs` still stores the first 4 KiB in
`taskPreview` and renders it from `cc_check`, job listings, and `cc_review`.
This is a direct leak on every successful delegation; replacing only echoed
failure text is insufficient.

Replace `taskPreview` with a non-reversible, bounded task reference derived
from the existing SHA-256 task hash. Normal state, log lines, MCP responses,
review prompts, and preflight-rejected jobs may say that task content is
withheld and show a short hash reference, but may not persist or display any
task substring. Preserve the full task only in the child stdin stream.

Update state migration/backward compatibility deliberately: old records that
contain `taskPreview` must never cause the old content to be rendered. Add
tests for successful, rejected, cancelled, `cc_check all`, individual
`cc_check`, and `cc_review` paths.

### 2. Make failure diagnostics safe for common task echo encodings

`redactText()` currently replaces only an exact task literal, then
`buildFailureEnvelope()` persists stdout, stderr, and error detail. A provider
or CLI commonly emits a JSON-escaped task, a multiline task with escaped
newlines, or whitespace-normalized text; all of those bypass exact matching.
Short delegated tasks also bypass the current eight-character minimum.

Redaction must receive the actual delegated task and remove it even when it is
raw, JSON-escaped, newline-escaped, or whitespace-normalized. Do not lower the
privacy boundary for short real tasks. If a task-bearing diagnostic cannot be
reliably rendered safely, fail safe by storing a bounded generic marker (for
example `[TASK_BEARING_OUTPUT_REDACTED]`) instead of raw output. Keep ordinary,
non-task diagnostics useful and byte-bounded.

Add black-box fake-Claude tests for raw, quoted JSON, escaped newline,
whitespace-normalized, chunked, and short-task echoes. Assert that no task text
appears in the MCP result, state, job log, diagnostic artifact, or `cc_check`.

### 3. Validate and redact profile-derived route claims before projection

`deriveAliasMappings()` accepts `ANTHROPIC_DEFAULT_*_MODEL` values as arbitrary
strings and later places them in route snapshots and `cc_resolve_route` output.
A malformed profile can therefore turn a credential-like string into a
persisted/displayed "native model ID"; collision errors also interpolate both
raw values.

Apply the same strict bounded native-selector grammar to every profile-derived
model target **before** alias/display mappings, fingerprints, snapshots,
errors, or MCP output. Use generic bounded configuration errors rather than
echoing rejected values. Also validate/bound display names before use in output.
Tests must prove that a secret-like, control-character, whitespace, or overlong
profile value fails before spawn and never appears in state, diagnostics,
fingerprints, or `cc_resolve_route` output.

## P1 — complete in this focused rework

### 4. Make the legacy fixture evidence truthful

The `active-profile.json` adapter can declare `aliasMappings` and
`nativeDisplayNames` unrelated to the `envVars` injected into the child. It may
therefore report an alias route that Claude never received. Derive both mappings
from validated `envVars`, as the cc-profile-switch adapter does, or reject any
declared mapping mismatch. Add a mismatch regression.

### 5. Bound every public resolver and preflight diagnostic field

`cc_resolve_route` and rejected-job metadata must not reflect arbitrary
selector/error strings. Apply the same bounded safe-presentation contract to
requested selectors and configuration errors; preserve a category and task hash
reference, not raw untrusted input.

### 6. Record honest, private liveness evidence

On an explicitly authorized probe, `cc_setup` currently returns prose and
usage keys but does not persist a safe route snapshot, execution evidence, or
cost evidence. It also coerces absent cost to `$0.00` before marking provenance
unknown. The design requires a safe snapshot and honest execution evidence.

Add a bounded, private liveness artifact/result that records route snapshot,
route status, execution/model evidence, duration, exit/failure classification,
and cost with explicit provenance. Unknown cost must remain `unknown`/`null`,
never `$0.00`. The normal setup output may link only to a safe probe ID and
summary. This is exercised only with a fake CLI in automated tests; do not make
a paid call.

### 7. Correct stale documentation

The status skill still claims `cc_check` exposes an error excerpt, while the
implementation intentionally removed it. Align `plugins/cc-plugin-codex/skills`
and `CLAUDE.md` with the final task-redaction and liveness contracts.

## Acceptance gate

Before requesting merge, run:

```bash
npm test
npm run verify:source
git diff --check main...HEAD
```

The offline suite must include the adversarial cases above. Re-run the
zero-cost real active-authority read for the four current selectors without
printing profile values or secrets. Do not run a paid liveness probe. Leave the
worktree clean, create one coherent local commit, and do not push, merge,
reinstall, or change user Provider configuration.

## Explicit non-goals

- No Provider model catalogue or hardcoded DeepSeek/GLM mapping.
- No fallback orchestration inside the plugin.
- No global profile edit or `cc-profile-switch` repository change.
- No paid Provider probe in tests.
- No broad refactor of watchdog/process supervision.
