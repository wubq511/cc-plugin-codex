# Dynamic Model Routing and Delegation Liveness

> Status: approved design; implementation requires the [final review round 2 repairs](2026-07-24-dynamic-model-routing-final-review.md) before merge.
>
> Date: 2026-07-22
>
> Scope: `cc-plugin-codex` Claude Code delegation path. This is one bounded change set; it must not be split into independently implemented slices.

> Relationship to prior design: this document supersedes the narrow prohibition on configuration-derived route claims in `2026-07-10-provider-agnostic-model-and-runtime-liveness.md`. The new requirement is to support dynamic alias routing across Provider changes. It permits only a small allowlisted active-profile resolver; it does not permit a Provider catalogue, arbitrary configuration export, or secret-bearing configuration persistence.

## Problem

The Companion currently starts Claude Code with `--output-format json`, but not `-p` / `--print`. Claude Code 2.1.208 documents JSON output as a print-mode-only feature. The plugin therefore starts an interactive CLI while expecting a single non-interactive JSON result on stdout. This invalid control-plane contract blocks every model before Provider routing is meaningful.

The current watchdog also discards stdout whenever Claude exits non-zero. A CLI or Provider error emitted on stdout is consequently reduced to `claude exited with code 1`, leaving no safe diagnostic evidence for Codex.

Model selection has a second, independent requirement. Robert may switch Provider configurations. He needs natural-language delegation to select either:

- a Claude Code semantic alias such as `Opus` or `Fable`, which must resolve using the currently active Provider configuration; or
- a Provider-native identifier such as `deepseek-v4-pro` or `glm-5.2`, which must be passed through unchanged.

The plugin must neither hard-code an alias-to-native mapping nor claim that a requested identifier proves the Provider actually executed that model.

## Goals

1. Restore a valid non-interactive Claude CLI protocol while retaining stdin-only task delivery.
2. Give every failed delegation a safe, actionable failure classification instead of an opaque exit code.
3. Make alias, native-ID, and inherited-default selection explicit and dynamically correct across Provider changes.
4. Confirm model routing from runtime evidence after execution, rather than guessing from configuration, aliases, or billing keys.
5. Keep credentials, raw Provider configuration, task prompts, transcripts, and hidden reasoning out of argv, normal job state, normal logs, and MCP presentation.
6. Preserve all existing safety boundaries: foreground pending call, cancellation, writer lease, bounded output, resume semantics, permission behavior, and provider-agnostic default delegation.

## Non-goals

- Querying a Provider model catalogue or billing API.
- Treating a configuration claim as proof of Provider execution.
- Automatically changing global Claude settings or Provider profiles.
- Automatically falling back from `Opus` to `Fable` for configuration, protocol, authentication, or model-ID errors.
- Replacing the existing fresh-session plus bounded-handoff policy.
- Adding a new external service, Dashboard, background queue, or persistent secret store.

## First-principles decisions

### 1. The non-interactive CLI contract is a hard prerequisite

Every delegated invocation must use print mode with text stdin and single-result JSON:

```text
claude --print --input-format text --output-format json [existing options]
```

The task remains on stdin; no prompt is appended to argv. Existing `--model`, `--effort`, `--resume`, permission, and read-only arguments retain their current semantics.

The exact order of flags is an implementation detail. The externally observable requirements are print mode, text stdin, JSON result, and no task content in argv.

### 2. Model request intent has three distinct kinds

The companion must record and validate this versioned intent shape:

```text
inherited: no --model; Claude Code uses the active profile default
alias:     --model <canonical Claude alias>, for example opus or fable
native:    --model <provider-native identifier>, passed exactly as supplied
```

The original user spelling is retained for presentation; aliases are normalized case-insensitively to the canonical Claude CLI alias for execution. Native identifiers are not rewritten. An ambiguous family request such as `DeepSeek` or `GLM` must not silently select a model.

### 3. Dynamic route snapshots, not a static model catalogue

At the start of every job, the companion resolves a non-secret route snapshot from the active Claude configuration/profile. It may read only an allowlisted routing projection: the active profile identity, alias-to-native declarations, native display-name declarations, and a profile revision/fingerprint. It must never persist or present a complete settings file, Provider URL, or credential-bearing environment.

The snapshot includes:

- selector kind and requested value;
- exact CLI argument, or inherited mode;
- active configuration/profile fingerprint;
- non-secret declared alias claim when available;
- Claude CLI version and timestamp.

It must not store API keys, tokens, full Provider URLs, authorization headers, or raw settings files. The snapshot is evidence of the configuration used to launch the job, not proof that the Provider honoured it.

No job may reuse a route snapshot from an earlier job. A Provider switch affects the next job only; an in-flight job remains bound to its start snapshot.

### 4. One active configuration authority per child process

The child process must be launched from the active profile snapshot, not from an uncontrolled mix of stale inherited `ANTHROPIC_*` environment variables and a later-mutated settings file.

The implementation must define one canonical active-profile source and create a child-only environment from it. A profile switch must update that source atomically; a shell-only environment change is not a supported way to switch a long-lived Codex desktop process. It must remove stale model-routing/auth variables inherited from the long-lived Codex process before injecting the current profile values. Secrets may exist only in the child environment; they must never be logged, persisted, displayed, or used as fingerprint input.

If the active-profile source cannot be safely resolved, the job fails before calling Claude with a configuration-stage error. It must not guess or silently use a prior profile.

### 5. Configuration claim and execution evidence stay separate

The result keeps the established three evidence layers and adds route status:

| Layer | Meaning |
| --- | --- |
| requested model | What the user asked for: alias, native ID, or inherited default. |
| route snapshot | What the current active configuration claimed at launch. |
| executed models | Claude transcript `message.model` evidence, when safely available. |
| usage model keys | Final JSON `modelUsage` aggregation keys; never execution-model proof. |

The final route status is one of `resolved`, `accepted_but_unverified`, `model_drift_possible`, or `rejected`.

- `resolved` requires compatible runtime execution evidence.
- Missing transcript evidence yields `accepted_but_unverified`, never a guessed success.
- A mismatch between the route claim and execution evidence yields `model_drift_possible`.
- A CLI/Provider rejection yields `rejected` with a safe failure category.

For aliases, a changed Provider mapping is valid only when the fresh route snapshot and runtime evidence agree. For native IDs, an unsupported ID fails closed; it does not become an alias fallback.

### 6. Natural-language routing is controlled, not inferential

The delegate Skill and MCP surface must expose a read-only route-resolution action that Codex can call before delegation when the user explicitly selects a model.

It returns bounded JSON with selector kind, canonical CLI argument, redacted route snapshot fingerprint, declared configuration claim if available, and the statement that live execution evidence is still required. It must not enumerate arbitrary Provider availability or promise Provider acceptance.

Natural-language rules:

- `Opus`, `Fable`, `Sonnet`, and `Haiku` are aliases.
- A current-profile display-name mapping may turn `DeepSeek V4 Pro` or `GLM 5.2` into the corresponding native ID.
- An exact native ID is passed unchanged.
- Unknown or ambiguous phrasing is rejected with a bounded clarification message.
- Omitted selection remains inherited and requires no resolver call.

### 7. Structured, private failure diagnostics

Every unsuccessful run produces a bounded diagnostic envelope with:

- failure stage: `spawn`, `cli_contract`, `configuration`, `provider_handshake`, `provider_response`, `json_protocol`, `timeout`, or `cancelled`;
- CLI version, requested selector, effort, exit code, signal, and duration;
- redacted and byte-bounded stdout/stderr tails;
- whether a structured CLI error, session ID, usage key, or transcript was observed.

The watchdog must inspect both stdout and stderr on non-zero exits. It should first detect a structured JSON error where possible, then produce a safe error summary. Detailed diagnostics live only in the private job artifact; normal MCP output and job metadata expose only the category, safe message, and job ID.

### 8. Provider liveness is an explicit cost-bearing operation

`cc_setup` must distinguish:

1. local CLI protocol readiness, including print-mode JSON support;
2. installed Companion/cache compatibility;
3. active-profile resolution readiness; and
4. optional Provider liveness for a requested model route.

The first three must make no model call. The fourth requires explicit user authorization because it sends a minimal read-only prompt and may cost money. It must use a positive, bounded provider budget, record cost evidence honestly, and never be misrepresented as a zero-cost configuration check.

## Operational policy

Robert's default coding policy is:

```text
Primary:  Opus with effort=max
Fallback: Fable with effort=max, only after a classified transient Provider failure
```

The fallback is an orchestration policy, not hidden plugin behavior. It is forbidden after a CLI-contract, configuration, authentication, unsupported-native-ID, malformed-output, or missing-evidence failure. Each attempted route must be separately recorded.

## Required implementation boundaries

- Keep process spawning and JSON protocol handling in the watchdog/runner boundary.
- Keep active-profile discovery, environment construction, selector normalization, and route snapshots in a dedicated routing module.
- Keep redaction and diagnostic-envelope construction in a dedicated diagnostics module shared by setup and execution paths.
- Keep MCP request validation/presentation in the companion.
- Extend, rather than reinterpret, existing `requestedModel`, `requestMode`, and `modelEvidence` semantics.
- Preserve compatibility for callers that only supply the current free-form `model` string. The new selector-kind field may be additive; absent legacy input is classified conservatively.

## Testing decisions

All automated tests are offline and use strict fake Claude binaries. A good test observes the CLI contract or persisted evidence, not internal helper calls.

Required coverage:

1. A strict fake Claude rejects invocation without `--print`; delegation succeeds with print-mode JSON and stdin text.
2. The task marker never appears in watchdog or Claude argv.
3. Exact native IDs pass unchanged; aliases normalize only as documented.
4. Current profile switches are observed by a subsequent job; no job reuses an old snapshot.
5. A stale inherited routing/auth environment cannot override the active profile snapshot.
6. Native-ID rejection fails closed without alias fallback.
7. Alias route claim, transcript execution evidence, and usage keys remain semantically separate.
8. Missing evidence becomes `accepted_but_unverified`; mismatch becomes `model_drift_possible`.
9. Non-zero stdout-only, stderr-only, structured JSON, malformed JSON, spawn, timeout, and cancellation failures receive the correct safe classification.
10. Diagnostic redaction prevents secrets, task text, raw settings content, and provider credentials from reaching MCP output or persisted public metadata.
11. Route resolver produces bounded output; unknown/ambiguous natural-language selections fail closed.
12. `cc_setup` static checks make no Provider call; optional liveness is explicitly marked cost-bearing.
13. Existing resume, read-only tool policy, cancellation, output limit, model-evidence, state migration, and installed-cache tests remain green.

## Acceptance gate

The work is ready only when all of the following hold:

- The real installed cache and source both launch Claude with print-mode JSON.
- The plugin's offline suite, source verification, manifest validation, and installed-cache verification pass.
- A fresh Codex task loads the reinstalled plugin successfully.
- Static setup reports local readiness without a model call.
- After explicit authorization, one minimal read-only liveness probe records a safe route snapshot and honest execution evidence for `Opus`; `Fable` is probed only when its route needs verification.
- Failure output distinguishes protocol/configuration/provider faults without exposing credentials or prompts.

## Delivery and rollout

The implementation agent works on one feature branch and creates one coherent commit. It must not change global Provider configuration, call paid models during automated tests, push, merge, or reinstall the plugin.

After review, the integrator performs cachebuster and installation validation. A new Codex task is required after reinstall because the desktop app caches plugin code.
