# CC Plugin Reliability, Safety, and Review Hardening

> **Status: implemented and verified.** The durability, ownership, watchdog,
> review-safety, and release-verification requirements are current. References
> below to schema v3 and `observedModel` describe the original audit baseline;
> the implemented store is schema v4 and model provenance is governed by
> [Model Evidence Provenance](./2026-07-11-model-evidence-provenance-design.md).

## Problem Statement

The plugin's primary foreground delegation path now waits silently and supports custom Providers, but a comprehensive adversarial audit found that several deeper reliability and ownership assumptions are still unsafe.

Job state is stored as one shared read-modify-write JSON file without cross-process coordination or atomic replacement. Multiple Codex tasks can run separate companion processes against the same workspace, so normal concurrent activity can lose jobs or leave truncated JSON. If the state file is corrupt, the current behavior silently returns an empty state, allowing the next update to overwrite recoverable history.

Process ownership is represented only by a persisted PID and one overloaded `sessionId`. The field starts as the MCP server identity and is later replaced by the Claude conversation identity. This breaks session filtering and makes ownership ambiguous. A later companion process can call cancel on a stale job and send a signal to a PID that may now belong to an unrelated process. A hard crash can also leave a detached Claude process running indefinitely because the foreground path intentionally has no default wall-clock timeout.

The explicit detached/background path does not share the foreground path's timeout or bounded capture. It writes directly to a result file without a size ceiling and reads that file back in one operation. If the companion crashes, no watcher remains to reconcile the result. The mode cannot wake Codex on completion, so its limited benefit does not justify its current durability and resource risks.

Task prompts are passed on the process command line, which exposes them in local process listings and subjects large tasks to operating-system argument limits. Job tasks and complete results are then duplicated into the shared state file and job logs. With the current 50 MiB capture ceiling and 50 retained jobs, state and logs can grow into gigabytes and every small status update can rewrite the entire state payload. Temporary state, log, and result files are also created with ordinary umask-derived permissions rather than an explicit private-data policy.

The review pipeline automatically embeds diffs and untracked file contents into an agent prompt. It has per-file limits but no global untracked-content budget, no sensitive-filename exclusion, no robust filename framing, and no explicit untrusted-content encoding. A repository can therefore cause excessive context, leak an untracked secret file, or inject instructions into the review prompt. Review verdict contracts are also inconsistent across the schema, prompt, skill, and documentation.

Finally, the repository has strong local tests, but the tests are not yet part of a committed standard test entrypoint or cross-platform CI. Current tests focus on one companion process and do not cover multi-process state races, hard crashes, stale PID reuse, Claude's structured error result, read-only enforcement, hostile review content, Windows command resolution, or install-version skew.

## Solution

Harden the plugin in three ordered phases. P0 establishes trustworthy data and process ownership. P1 makes execution resource-bounded and privacy-preserving. P2 hardens review input, cross-platform behavior, and release verification. Each phase must be independently releasable and must preserve the existing single pending foreground MCP call, silent waiting, Provider-agnostic model behavior, explicit cancellation, and requested-versus-observed model reporting.

P0 replaces the shared job array with an atomic per-job store, separates MCP ownership from Claude conversation identity, introduces an `orphaned` terminal/recovery state, refuses to signal processes that are not controlled by the current live server, and enforces one write-enabled delegation per canonical workspace. Corrupt state is quarantined instead of silently reset.

P1 moves prompt delivery from argv to stdin, introduces a small runner/watchdog process that owns Claude and terminates it when the companion control pipe closes, bounds every output and persistence surface, stores results separately from metadata, applies explicit private file permissions, and makes read-only mode genuinely unable to execute shell or write tools. New detached/background jobs are disabled in this hardening release; they may return only after a separately designed durable supervisor can provide bounded output, crash recovery, cancellation, and terminal-result reconciliation.

P2 treats repository review material as untrusted data, applies global context and sensitive-file policies, normalizes all review schemas, validates MCP arguments at runtime, improves file attribution and resume semantics, adds Linux/macOS/Windows CI, and provides one verified install workflow that cannot claim success while Codex is still running an older cached plugin.

## User Stories

1. As a user running multiple Codex tasks, I want each job record to survive concurrent updates, so that one task cannot erase another task's history.
2. As a user, I want a crash during state persistence to leave either the old complete record or the new complete record, so that state is never partially written.
3. As a user, I want corrupt state quarantined and reported, so that recoverable history is not silently overwritten.
4. As a user, I want MCP server ownership and Claude conversation identity stored separately, so that filtering, resume, and cancellation use the correct identity.
5. As a user, I want completed jobs to remain visible under the MCP session that created them, so that `session=true` behaves consistently before and after completion.
6. As a user, I want cancellation to affect only a process proven to belong to the current plugin server, so that a stale PID cannot kill unrelated software.
7. As a user, I want stale running records to become `orphaned`, so that the UI distinguishes an unknown process from an actively supervised job.
8. As a user, I want the plugin to explain when it cannot safely cancel an orphaned job, so that it fails closed instead of guessing.
9. As a user, I want a hard companion crash to terminate its foreground Claude process, so that no-timeout delegation cannot become a permanent orphan.
10. As a user, I want only one write-enabled Claude task in a workspace at a time, so that concurrent agents cannot overwrite each other's edits.
11. As a user, I want concurrent read-only tasks to remain possible, so that safe analysis is not unnecessarily serialized.
12. As a user, I want the plugin to report workspace changes observed during a job accurately, so that pre-existing changes are not falsely attributed to Claude.
13. As a user, I want task prompts sent through stdin, so that sensitive instructions are not visible in the process list.
14. As a user, I want large prompts to avoid operating-system argv limits, so that valid tasks do not fail with `E2BIG`.
15. As a user, I want job metadata to remain small, so that checking status is fast even after many tasks.
16. As a user, I want full results stored as bounded private artifacts rather than duplicated in every state update and log.
17. As a user, I want an explicit truncation marker when output exceeds a presentation limit, so that shortened results are never mistaken for complete output.
18. As a user, I want output, log, result, and total-retention limits, so that a malfunctioning model cannot fill memory or disk.
19. As a user, I want temporary job data readable only by my account, so that prompts and model results are not exposed to other local users.
20. As a user, I want Claude JSON results marked as errors to produce failed jobs even when the process exits with code zero.
21. As a user, I want malformed MCP inputs rejected, so that values such as the string `"false"` cannot accidentally enable writes.
22. As a user, I want `write=false` to prohibit Bash and write-capable tools, so that read-only smoke tests cannot modify my workspace.
23. As a user, I want ambiguous resume requests rejected, so that the plugin never resumes an unrelated Claude conversation.
24. As a user, I want `resume=true` to resolve the latest resumable plugin job in the current workspace, so that another terminal's “last session” cannot hijack continuation.
25. As a user, I want sensitive untracked files excluded from review context by default, so that `.env`, credentials, and private keys are not uploaded automatically.
26. As a user, I want review context globally bounded, so that thousands of small untracked files cannot exhaust the model context window.
27. As a user, I want repository text treated as untrusted evidence, so that instructions inside source files cannot redefine the review task.
28. As a user, I want unusual Git filenames handled without newline parsing errors, so that the review file list is accurate.
29. As a user, I want one canonical review verdict vocabulary, so that skill output, schemas, and consumers agree.
30. As a Windows user, I want Claude CLI discovery and process termination tested on Windows, so that `.cmd` resolution and process-tree behavior do not fail only after installation.
31. As a maintainer, I want a standard test command and CI matrix, so that regressions are caught before cache installation.
32. As a maintainer, I want the install workflow to verify active and source versions, so that a stale cache cannot be reported as successfully installed.
33. As a maintainer, I want fault-injection tests for disk failure, malformed JSON, process crash, and concurrent servers, so that lifecycle guarantees are evidence-backed.
34. As a user, I want setup diagnostics to show the active plugin version and resolved CLI paths without secrets, so that environment skew is obvious.

## Implementation Decisions

### P0 — Ownership and durable state

- Introduce job-store schema version 3. Each job is canonical in its own metadata file rather than inside one shared jobs array. Configuration metadata remains separate from job records.
- Persist each job update with a temporary file in the same directory, flush it, and atomically rename it over the previous record. A reader must observe a complete old or complete new record, never partial JSON.
- Migrate version-2 state once under a migration lock. Preserve a private backup until migration and validation succeed. If parsing fails, rename the corrupt file to a timestamped quarantine path and return a visible recovery error; never silently replace it with empty state.
- Create state directories with mode `0700` and metadata, log, result, lock, and control files with mode `0600`. Correct overly broad legacy permissions during migration when ownership is the current user.
- Replace overloaded `sessionId` with distinct fields: `ownerServerId` for the MCP companion instance and `claudeSessionId` for Claude conversation resume. Preserve `requestedModel` and `observedModel` separately.
- Add `orphaned` as an explicit job status. On startup, any non-terminal record owned by another dead/unknown server becomes orphaned unless a trusted supervisor provides a terminal result.
- Never send a signal based only on a persisted PID. `cc_cancel` may terminate only a live controller/child handle registered by the current companion instance. Cancelling an orphaned or foreign-owned job returns a safe error and preserves diagnostics.
- Add an exclusive cross-process writer lease per canonical workspace. A write-enabled delegation fails fast with the active job ID when another writer owns the lease. Read-only delegations do not take the writer lease. Leases use an atomic create operation, an opaque owner token, and a heartbeat; stale lease recovery never signals a PID.
- Capture a bounded pre-run workspace fingerprint and compare it with the post-run fingerprint. Report the result as “workspace files changed during this job,” not as definitive agent authorship. Include untracked files and pre-modified files whose content changed. External concurrent edits remain explicitly un-attributed.
- Treat Claude result JSON with `is_error=true` or an error subtype as a failed job even if the process exit code is zero. Preserve a bounded diagnostic message and the terminal reason.
- Reject simultaneous `resume=true` and `resumeSession`. Resolve `resume=true` to the latest completed plugin job in the same workspace that has a `claudeSessionId`; do not use global `--resume-last`. An explicit `resumeSession` remains a direct user override.

### P1 — Supervised execution, privacy, and resource bounds

- Introduce a small runner/watchdog process for foreground execution. The companion communicates with it over a private control pipe. The watchdog owns the Claude process group, bounded capture, explicit timeout, cancellation, and terminal-result serialization. EOF on the control pipe means the companion died and causes the watchdog to terminate Claude before exiting.
- Deliver the task through Claude's stdin rather than as a process argument. The real-CLI contract test must prove print mode accepts stdin before the old argv path is removed. No fallback may expose the full task in argv; an unsupported CLI version must produce a clear setup error.
- Store only a 4 KiB task preview plus a SHA-256 digest in job metadata. The full prompt remains in memory for the active call and is not copied into lifecycle logs.
- Reduce the combined stdout/stderr capture ceiling to 8 MiB per job. Store the complete parsed result, when within that ceiling, in a separate private artifact. Limit MCP result/status presentation to 256 KiB with explicit original-size and truncation metadata.
- Limit job metadata to 64 KiB, lifecycle logs to 1 MiB per job, and total retained job artifacts to 100 MiB or 50 jobs, whichever threshold is reached first. Prune terminal jobs oldest-first after 30 days. Never prune active or orphaned diagnostics automatically.
- Lifecycle logs contain phases, timestamps, exit information, cost, model metadata, and artifact sizes, but not the complete model answer. Avoid duplicate full-result storage.
- Make `write=false` a strict capability boundary: expose only `Read`, `Glob`, and `Grep`; explicitly disallow Bash and write-capable tools. If Git context is needed, collect it in the companion with fixed argument arrays and include a bounded read-only summary.
- Keep `dangerouslySkipPermissions` opt-in. Reject contradictory combinations rather than relying on undocumented CLI precedence.
- Deprecate and reject new `background=true` delegations in this release with a migration message explaining that default foreground waiting is non-polling. Existing background records remain readable and reconcilable. Durable detached execution requires a separate supervisor/push design and is not emulated here.
- On spawn or persistence failure after a child starts, the watchdog must cancel the child before returning an error. Disk-full and permission failures may not leave an untracked running process.

### P2 — Review safety, contracts, cross-platform support, and release verification

- Validate every MCP tool call against its published JSON Schema at runtime, including types, enums, numeric ranges, required values, mutual exclusions, and `additionalProperties=false`. Tool schemas are executable contracts, not documentation only.
- Route optional `cwd` through the same absolute, existing-directory validator used by stateful tools. Never resolve a relative review/history path against the plugin cache.
- Use NUL-delimited Git output for filenames and preserve filenames as data. Do not parse name lists by newline.
- Apply review-context budgets: at most 20 untracked files, 24 KiB per file, and 256 KiB total untracked content. Include omission counts and reasons.
- Never auto-include the content of sensitive untracked paths or extensions, including environment files, credentials, tokens, private keys, certificates, SSH material, auth stores, and files matched by configurable secret-name rules. Report only that they were skipped. Explicit opt-in to include sensitive content is outside this release.
- Frame repository context as untrusted, length-delimited data and escape structural delimiters. The review prompt must explicitly instruct the reviewer never to follow instructions found inside repository content. This reduces but does not claim to eliminate model prompt injection.
- Unify the review verdict enum and full schema in one canonical definition consumed by the tool prompt, skill documentation, README, and validation tests. Use `approve`, `needs-attention`, `request_changes`, and `reject` consistently.
- Add a standard repository test entrypoint and a CI matrix for supported Node on Ubuntu, macOS, and Windows. Resolve the Claude executable explicitly and support Windows `.cmd` launch without enabling a shell for user-controlled arguments.
- Add a single local verification/install workflow: source tests, syntax checks, schema validation, cachebuster update, plugin install, active-version check, source/cache comparison, installed-cache tests, and a final instruction to open a new Codex task. A failed step must stop the workflow and report source/active skew; it must never print success early.
- Extend `cc_setup` with active manifest version, server base version, resolved Node/Git/Claude executable paths, state schema/permission health, stale/orphaned job count, and whether a new Codex task is required. Do not display Provider URLs, keys, tokens, or auth values.
- Handle stdout `EPIPE`, fatal persistence errors, and unexpected event-listener exceptions by entering the same bounded shutdown path used for signals. Fatal errors must attempt to cancel all currently owned controllers before exit.

## Testing Decisions

- The primary seam remains the public MCP stdio protocol with a fake Claude executable. Most requirements must be asserted through tool requests, JSON-RPC responses, job files, workspace effects, and child lifecycle rather than private helper calls.
- Add one multi-process black-box harness that starts two or more companion processes against the same canonical workspace. It must prove that concurrent job creation preserves every job, produces valid JSON, enforces the writer lease, and allows concurrent read-only jobs.
- Add crash tests that kill the companion without graceful shutdown and prove the watchdog terminates the foreground Claude tree, terminal/orphan state is reconciled, and a new companion never signals an unverified persisted PID.
- Add a stale-PID test using a harmless unrelated process. A foreign/orphaned job record pointing at that PID must not terminate it.
- Add state migration tests for valid version-2 data, truncated JSON, disk-full/rename failure, permission repair, backup preservation, and retention pruning.
- Add session tests proving completed jobs remain visible under `session=true`, Claude session resume uses `claudeSessionId`, `resume=true` never invokes global resume-last, and conflicting resume inputs fail.
- Add runner tests for stdin prompt delivery, argv privacy, structured Claude `is_error`, error subtype, output cap, presentation truncation, control-pipe EOF, ignored SIGTERM followed by SIGKILL, and failure after spawn but before state registration.
- Add read-only adversarial tests in a temporary Git workspace. Prompts that request shell execution or file creation must leave the workspace byte-for-byte unchanged.
- Add resource tests proving metadata, logs, result artifacts, MCP responses, per-job storage, and total retention stay within declared limits under flood output and many jobs.
- Add review tests with thousands of small untracked files, newline-containing filenames, binary files, symlinks, nested Git worktrees, `.env`, private-key filenames, Markdown fences, XML-closing text, and explicit prompt-injection strings. Sensitive content must not appear in the returned review context.
- Add schema-contract tests that generate malformed raw MCP calls, including string booleans, extra fields, invalid enums, relative cwd, conflicting resume flags, and timeout overflow. All must fail before process spawn.
- Add schema-drift tests that compare the canonical review schema with tool prompts, skills, and documentation.
- Run CI on Ubuntu, macOS, and Windows with the supported Node version. Platform-specific process tests may use harmless fake executables but may not be silently skipped on Windows.
- Preserve the installed-cache smoke test using a temporary read-only workspace and inherited custom Provider configuration. It runs only in the local release workflow, never in public CI, and must not print credentials.
- The audit's existing fault injections become permanent regression tests: 20 concurrent job writers must produce 20 durable jobs, a foreign-session PID must survive cancellation, and a completed job must remain visible to its owner-session filter.

## Out of Scope

- Enumerating or validating custom Provider model catalogues.
- Implementing Provider-specific retries, fallback models, rate-limit policy, billing limits, or health checks.
- Reintroducing durable detached/background execution, completion push notifications, or Codex wake-up behavior. These require a separate supervisor protocol and product decision.
- Automatically creating isolated Git worktrees for each job. The writer lease is the safety boundary for this release; isolated execution can be designed later.
- Perfect attribution when a human or external process edits the workspace during a job. The plugin reports observed changes and avoids claiming exclusive authorship.
- Building a general-purpose secret scanner. This release uses conservative sensitive-path exclusion and bounded context; repository owners remain responsible for tracked secrets.
- Encrypting local job artifacts at rest. Private filesystem permissions are required; encrypted storage is a separate feature.
- Automatically committing, pushing, publishing, or deploying changes.
- Remote or multi-host job coordination.

## Further Notes

### Confirmed audit findings

- **Critical — foreign PID termination:** a new companion process will currently signal a persisted running job's PID even when the job belongs to another server session. A harmless fault-injection process was terminated by `cc_cancel`.
- **High — multi-process state corruption:** five 20-writer fault-injection rounds retained only 4, 7, 8, 8, and 8 jobs; one round logged truncated JSON. The current single-file read-modify-write store is not safe for normal multi-task Codex use.
- **High — session identity corruption:** completion replaces the MCP session identity with the Claude conversation identity. A completed fake job immediately disappeared from `session=true` results.
- **High — background resource/durability gap:** detached execution bypasses timeout and bounded capture, can grow its result file without limit, loses stderr, and has no post-crash watcher.
- **High — unbounded duplicated persistence:** a captured result can be stored in both shared state and logs, making the nominal 50-job retention capable of gigabyte-scale state and repeated full-file rewrites.
- **High — prompt privacy:** a fault-injection marker in the task was visible in the process command line.
- **High — structured CLI errors treated as success:** JSON parsing currently checks process exit and parse validity but not Claude's structured error indicators.
- **Medium — local data permissions:** observed state directories and files were mode `0755` and `0644`. The current macOS per-user temp parent reduces exposure locally, but the plugin itself does not enforce privacy and Linux `/tmp` deployments may expose prompts/results to other users.
- **Medium — inaccurate file attribution:** changed-file reporting compares against a generic Git base and can include pre-existing work while missing untracked creations.
- **Medium — review data leakage and prompt injection:** untracked content has no global budget or sensitive-name filter and is interpolated directly into review prompt structure.
- **Medium — read-only mode is not proven read-only:** the Bash prefix allowlist has no end-to-end mutation test and should not be used as a security boundary.
- **Medium — runtime schema drift:** raw MCP arguments are not validated against tool schemas, and the review verdict vocabulary differs between the canonical schema, prompts, and skill.
- **Medium — cross-platform and release gaps:** no committed standard test entrypoint or OS CI matrix exists, and the project has already experienced a source/cache version mismatch that was initially reported as a successful reinstall.

### Ordering rationale

P0 blocks release because it protects unrelated processes and prevents job loss. P1 is next because removing the default time limit is safe only when parent death, output growth, prompt privacy, and persistence are bounded independently. P2 should follow on the new store/runner boundaries so review and release tests target stable interfaces rather than cementing the current monolith.
