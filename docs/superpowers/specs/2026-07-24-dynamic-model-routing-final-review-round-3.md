# Dynamic Model Routing — Final Review Round 3

> Historical review — superseded by [Remove cc-profile-switch Coupling](2026-07-25-remove-cc-profile-switch-coupling-design.md). It does not describe the current runtime and must not be used as implementation or user-operation guidance.

> Status: **implemented, installed locally, and verified through the Provider boundary**. The final external result is an honest `rate_limited` response, not a synthetic pass.
>
> Reviewed branch: `glm/dynamic-model-routing`, including the privacy, authority, cache-install, and liveness-evidence closeout commits.
>
> Baseline: `main@9871d75`
>
> Date: 2026-07-24

## Decision

Do not treat `b392b52` alone as merge-ready. The completed rework fixes important behaviour:
the real active `cc-profile-switch` authority now resolves `Opus`, `Fable`,
`deepseek-v4-pro`, and `glm-5.2` without a Provider call; same-target display
names coalesce; and the branch's offline suite and source verification pass.

It initially left two P0 secret/prompt-boundary violations and several
evidence-contract defects. Those defects are now closed on the same branch;
this remains a focused rework, not a new routing architecture. No global
Provider configuration was modified.

## Local closure update

The required third rework was implemented at `93ad3c2`; the final closeout
additionally verifies the success-output prompt boundary, migrates
unversioned legacy state through the v6 privacy scrubber, preserves an explicit
Provider-reported zero cost as evidence, validates fixture profile identities,
applies the private retention policy to standalone liveness artifacts, treats
opaque credential-bearing profile values as runtime-only redaction markers, and
requires an explicit fallback-adapter selection when cc-profile-switch is
absent. It also preserves the plugin-owned failure-stage enum when a short
task forces private diagnostic redaction, and records a non-verbatim safe
Provider reason code for a failed liveness probe.

Offline tests and source verification remain the code merge gate. With explicit
authorization, the plugin was cachebuster-updated and installed from the local
marketplace; an installed-cache `cc_setup` confirmed schema v6 and a 35-file
source/cache match. Two bounded real `Opus` liveness attempts (45 seconds,
maximum `$0.10` each) reached the Provider and failed with `rate_limited`.
No cost telemetry was reported, so both records remain `unknown`; this is an
external availability limit, not a claimed successful execution or a reason to
change routing, credentials, or standards.

## Verified evidence

- `npm test`: 394 passed, 0 failed.
- `npm run verify:source`: passed.
- `git diff --check main...HEAD`: passed.
- A zero-cost local authority read resolves the current profile as follows:
  `Opus` and `Fable` are aliases; `deepseek-v4-pro` and `glm-5.2` are native
  selectors. Stale inherited routing variables did not survive child-env
  construction.

The installed liveness path also proved that `Opus` is accepted as an alias and
the CLI budget guard is active. It did not prove successful Provider execution:
the honest terminal classification is `provider_response` / `rate_limited`.

## Resolved P0 requirements

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

## Resolved P1 requirements

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

## Final acceptance gate

Before requesting merge, run:

```bash
npm test
npm run verify:source
git diff --check main...HEAD
```

The offline suite includes the adversarial cases above, and the zero-cost real
active-authority read resolves the four current selectors without printing
profile values or secrets. The installed-cache static check passed, and the
authorized liveness attempts were bounded and persisted as private evidence.
The outstanding operational action is to wait for the Provider rate limit to
clear before a future, explicitly authorized retry; it is not safe to retry
automatically or to record a false success.

## Explicit non-goals

- No Provider model catalogue or hardcoded DeepSeek/GLM mapping.
- No fallback orchestration inside the plugin.
- No global profile edit or `cc-profile-switch` repository change.
- No paid Provider probe in tests.
- No broad refactor of watchdog/process supervision.
