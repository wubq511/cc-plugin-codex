# Provider-Agnostic Model Selection and Runtime Liveness

> **Status: partially superseded by [Dynamic Model Routing and Delegation Liveness](./2026-07-22-dynamic-model-routing-and-delegation-liveness-design.md).** Provider inheritance, free-form model
> overrides, silent foreground waiting, and opt-in deadlines remain current.
> References below to an “observed model” describe the original design and are
> superseded by [Model Evidence Provenance](./2026-07-11-model-evidence-provenance-design.md),
> which separates transcript-confirmed execution models from Provider usage keys.

## Problem Statement

The plugin currently presents a hard-coded catalogue of Claude model aliases and asks Codex to choose among `fable`, `opus`, `sonnet`, and `haiku`. That catalogue describes Anthropic's built-in aliases, not the models actually available through the user's current Claude Code configuration. The user runs Claude Code through a custom Provider and LLM API, can remap aliases, and may switch models at any time. As a result, the plugin can advertise models that are not real, reject valid custom model identifiers, or silently request an alias that resolves to a different underlying model.

The plugin also treats a fixed wall-clock duration as evidence of failure. A long-running coding task may still be healthy: the Provider may be queued, the selected model may reason slowly, the task may require many tool calls, or the API may retry internally. A fixed two-hour runner timeout and a nearby MCP tool timeout can therefore terminate useful work merely because it needs more time. Actual failure should be determined from observable failure signals, not guessed from task type, model name, or elapsed time.

## Solution

Make Claude Code the source of truth for Provider and model selection. A normal delegation inherits the user's current Claude Code configuration and does not pass `--model`. The existing optional `model` input becomes a free-form, explicit one-run override: when the user supplies a non-empty value, the plugin passes it through unchanged; when omitted, the plugin does not invent or select a model. The delegation skill stops calling a hard-coded model catalogue and stops automatically selecting an official model alias.

Retain `cc_list_models` as a compatibility tool for this iteration, but change its meaning and presentation. It must no longer claim to enumerate available models. It explains that model resolution is owned by Claude Code, reports that delegation defaults to inherited configuration, and reports requested-versus-observed model information from the latest completed local job when one exists. It must not query a Provider catalogue, expose credentials, print API keys, or promise that a previously observed model remains available. A future breaking release may rename this compatibility surface to runtime/model information, but this spec does not add another MCP tool.

Replace the default internal wall-clock kill with signal-based lifecycle handling. By default, a foreground Claude process runs until it completes, fails, is cancelled by the MCP client or user, exceeds the bounded output limit, or the companion server shuts down. Non-zero exit, spawn failure, invalid final JSON, structured CLI failure output, cancellation, and process termination remain terminal signals. Elapsed time remains status information, not a failure condition.

An explicit positive `timeoutSeconds` input remains available as an opt-in safety override for controlled environments and tests, but the plugin and skill must not calculate it from task type or model. The MCP transport uses an effectively non-expiring timeout: prefer the supported Codex representation for no timeout; if Codex requires a positive value, use a seven-day transport ceiling (`604800` seconds) and document it strictly as an orphan-safety boundary rather than a task-duration estimate.

## User Stories

1. As a user of a custom Claude Code Provider, I want delegation to inherit my current configuration, so that the plugin uses the model I actually configured.
2. As a user who changes Providers, I want the plugin to pick up the change without a code update, so that model selection never becomes stale.
3. As a user who changes models frequently, I want omission of the model input to mean “use Claude Code's current default,” so that routine delegation requires no duplicated configuration.
4. As a user, I want to provide an arbitrary model identifier for one task, so that I can override the configured default without changing global settings.
5. As a user of a non-Anthropic model, I want the plugin to accept its identifier without an official-model enum rejecting it.
6. As a user, I want an override to be passed through exactly, so that the plugin does not rewrite Provider-specific identifiers.
7. As a user, I want the completed job to show the model actually reported by Claude Code when available, so that I can distinguish requested configuration from runtime resolution.
8. As a user, I want requested and observed model values to remain distinct, so that alias remapping and Provider fallback are visible rather than concealed.
9. As a user, I do not want a model-list command to advertise fictional availability, so that I do not make decisions from a hard-coded catalogue.
10. As a user, I want Provider credentials and API configuration to remain private, so that runtime diagnostics cannot leak secrets.
11. As a user running a slow but healthy task, I want it to continue beyond the old fixed timeout, so that useful work is not discarded because of elapsed time.
12. As a user, I want Provider and CLI errors to fail promptly when the process reports them, so that removing the default timeout does not hide real failures.
13. As a user, I want cancellation from Codex to stop Claude immediately, so that an abandoned pending call cannot continue editing my workspace.
14. As a user, I want manual cancellation to remain available at any elapsed duration, so that I retain control over a task with no default hard deadline.
15. As a user, I want server shutdown to clean up processes owned by that server session, so that unlimited normal duration does not create orphan processes.
16. As a user, I want output capture to remain bounded, so that a malfunctioning CLI cannot consume unbounded memory even when time is not bounded.
17. As a user with an operational need for a deadline, I want an explicit timeout override, so that I can opt into a hard limit without changing the default for everyone.
18. As a user, I want timeout configuration to be independent of model branding and guessed task complexity, so that custom models are not assigned arbitrary deadlines.
19. As a Codex user, I want the delegate skill to wait silently in one MCP call, so that long tasks do not create polling turns or consume extra Codex tokens.
20. As a maintainer, I want compatibility for existing callers of `cc_list_models`, so that this correction does not require an unnecessary tool-name migration in the same release.

## Implementation Decisions

- Claude Code configuration is the only authority for the default Provider and model. The plugin will not maintain, download, infer, or validate a Provider model catalogue.
- The `model` field remains optional for API compatibility but changes from a closed enum to a free-form non-empty string. Its documented meaning is “explicit model override for this delegation.”
- When `model` is absent, the runner must omit `--model`. When present, the runner must append `--model` followed by the exact supplied value. Empty or whitespace-only overrides are rejected as invalid input rather than treated as a model.
- The plugin will not automatically choose a model based on task complexity. The delegate skill will not call `cc_list_models` before ordinary delegation and will not inject `fable`, `opus`, `sonnet`, or `haiku` unless the user explicitly names one.
- `effort` remains an optional Claude CLI control with the CLI-supported effort levels. It is independent from Provider/model discovery. When omitted, the runner inherits Claude Code behavior; when explicitly supplied, it is passed through. Model selection guidance must not couple a model brand to an effort level.
- Job state will distinguish the requested override from the runtime-observed model. The requested override may be absent. The observed model comes only from Claude Code result metadata and may also be absent. Runtime output must not overwrite history in a way that makes an override look like the actual model.
- `cc_list_models` remains callable for compatibility but no longer returns a hard-coded table or selection guide. It reports that the default is inherited, describes the optional free-form override, and summarizes requested/observed models from the latest completed local job when available. It must label observed values as historical evidence, not current availability.
- Runtime information must never expose API keys, authorization headers, tokens, or complete secret-bearing Provider configuration. The implementation must not parse Provider configuration because Claude Code does not expose a stable, credential-safe catalogue introspection interface.
- The runner has no default internal wall-clock timeout. Absence of a timeout means no timer is created.
- `cc_delegate` accepts an optional `timeoutSeconds` value. Omission disables the internal wall-clock timer. A supplied value must be a finite positive integer from `1` through `604800` seconds, matching the outer transport ceiling; zero, negative, fractional, infinite, non-numeric, and larger values return a validation error. The delegate skill supplies it only when the user explicitly requests a deadline.
- The plugin must not derive timeout values from task text, task classification, model aliases, observed model names, cost, token count, or Provider identity.
- Terminal failure signals remain: child spawn error, non-zero process exit, invalid required result JSON, explicit Claude CLI/API failure, output capture limit, MCP cancellation, user cancellation, and companion shutdown for jobs owned by the current server session.
- A running process with no final result is not considered failed solely because it is old. Status output may show elapsed duration and phase without generating periodic Codex commentary or automatic polling.
- The existing bounded output capture and process-tree termination behavior remain mandatory.
- MCP request cancellation remains bound to the corresponding child execution. A cancelled request must persist a cancelled job state, terminate the process tree, and suppress a late normal completion response.
- The MCP client transport timeout must not recreate the removed two-hour runner limit. Use the Codex-supported no-timeout representation if available. If Codex requires a finite positive `tool_timeout_sec`, set it to `604800` seconds and document that it is an outer orphan-safety ceiling, not an expected task duration.
- Explicit detached/background mode remains out of the default path and does not gain completion wake-up semantics in this work.
- Documentation, tool descriptions, skill guidance, job output labels, and tests must use Provider-agnostic terms. Official Claude aliases may appear only as user-supplied examples, never as the plugin's claimed catalogue.

## Testing Decisions

- The primary test seam is the existing MCP stdio integration with a fake Claude executable. Tests should make requests through the public MCP tool contract and observe CLI arguments, job state, process lifecycle, and JSON-RPC responses. This is the highest useful seam and should carry most acceptance coverage.
- Verify that an ordinary delegate request without `model` launches Claude without a `--model` argument and completes normally.
- Verify that an arbitrary custom identifier such as `mimo-v2.5-pro` is accepted and passed after `--model` unchanged.
- Verify that whitespace-only model overrides are rejected with a clear tool error.
- Verify that requested override and observed model metadata are stored and displayed as distinct fields, including the case where they differ.
- Verify that `cc_list_models` contains no hard-coded official catalogue, no task-to-model recommendation table, and clearly describes inherited configuration plus optional override behavior.
- Verify that a delayed fake Claude process completes when no timeout is supplied, while an explicitly configured short timeout still terminates the process tree and returns a timeout error.
- Preserve runner-level tests for spawn failure, non-zero exit, invalid JSON, output-limit termination, and explicit timeout behavior. These are narrow process-boundary tests that complement the MCP seam.
- Preserve protocol-level tests proving `notifications/cancelled` terminates the matching pending delegate, persists `cancelled`, and does not emit a late completion response.
- Preserve shutdown tests covering foreground and detached jobs across multiple workspaces and proving that jobs owned by another MCP server session are untouched.
- Add a configuration contract test proving the MCP transport no longer has the former two-hour-class ceiling and follows the supported no-timeout or seven-day fallback decision.
- Tests must assert externally visible behavior rather than timer implementation, private maps, or internal helper names.
- A real smoke test should run one read-only delegation through the installed plugin using inherited configuration and confirm the actual model reported by Claude Code. A second smoke test should use `mimo-v2.5-pro` as an explicit override. Neither smoke test should expose Provider credentials or modify tracked files.

## Out of Scope

- Discovering or enumerating every model offered by a custom Provider.
- Validating whether an arbitrary model identifier exists before Claude Code attempts to use it.
- Editing the user's Claude Code Provider, API, authentication, alias, or fallback configuration.
- Implementing Provider-specific health checks, retry policies, rate-limit handling, or model fallback.
- Predicting task duration from task type, repository size, model name, Provider, token count, or historical averages.
- Automatically selecting a model for the user.
- Streaming hidden reasoning or raw chain-of-thought to Codex.
- Changing detached/background jobs into a push-notification or wake-up system.
- Renaming `cc_list_models` in this compatibility-focused iteration.
- Removing explicit user-requested timeout support.

## Further Notes

- The current environment demonstrates why the old abstraction is invalid: Claude Code configuration contains a custom base URL and model mappings, while completed result metadata can report a model different from the official alias requested by the plugin.
- “No default runner timeout” does not mean “no safety.” Cancellation, process ownership, bounded output, structured failures, shutdown cleanup, and the outer transport ceiling remain independent safety mechanisms.
- A lack of output is not a reliable failure signal for arbitrary Providers. If future Claude CLI versions expose a stable heartbeat or progress protocol, it may improve status reporting, but it must not become an automatic kill condition without a separate design.
- Existing uncommitted changes from the silent-wait repair are part of the implementation baseline and must be preserved. The implementing agent must not reset, overwrite, commit, push, or modify unrelated untracked files.
