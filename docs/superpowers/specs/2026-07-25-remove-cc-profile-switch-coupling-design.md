# Remove cc-profile-switch Coupling

## Decision

`cc-plugin-codex` will have no integration, adapter, discovery path, fallback,
configuration variable, or user-facing contract for `cc-profile-switch`.

The plugin's only runtime responsibility is to supervise a native Claude Code
CLI child process. Claude Code itself owns its native configuration. The plugin
must not inspect or modify that configuration, and it must not inspect or
modify `cc-profile-switch` files or invoke its CLI.

## Required runtime contract

```text
Codex -> cc-plugin-codex -> claude --print --input-format text --output-format json
```

1. Omitting `model` starts the native Claude CLI without a `--model` argument.
2. `Opus`, `Fable`, `Sonnet`, and `Haiku` are case-insensitive CLI aliases. The
   plugin normalizes and forwards them; it does not resolve them to a native
   model or claim which provider model they represent.
3. A valid native model ID is forwarded unchanged after strict syntax
   validation. An ambiguous or unsafe selector fails before Claude is spawned.
4. Actual model identity is determined only from Claude's post-run execution
   evidence. A requested selector is never execution proof.
5. A provider rejecting a selector is a rejected delegation. The plugin must
   not select another model, profile, configuration directory, or fallback.

## Explicitly removed behavior

Remove all production and compatibility support for:

- `cc-profile-switch`, `CC_PROFILE_SWITCH_HOME`, and `lastUsedProfile`;
- `CC_COMPANION_AUTHORITY_ADAPTER`, `claude-settings`, and
  `active-profile-fixture` adapters;
- `active-profile.json`, profile environment injection, allowlisted profile
  environment values, and child `CLAUDE_CONFIG_DIR` rewriting;
- profile fingerprints, profile identities, alias claims derived from profiles,
  active-authority diagnostics, and profile setup checks.

The repository must not discover, read, write, spawn, document, or test those
interfaces. Historical private artifacts may retain their historical content,
but current state migration and all new output must omit profile-derived fields.

## Component changes

### Routing and MCP

- Replace the authority/adapter subsystem with a small selector classifier and
  route snapshot builder that has no filesystem dependency.
- Make child environment construction inherit the process environment without
  profile-specific stripping, injection, or configuration-directory changes.
- Keep `cc_resolve_route` as a no-call preview of selector forwarding. Its
  result exposes selector kind and CLI argument only, plus non-secret runtime
  policy metadata; it has no source/profile/mapping fields.
- Keep `cc_list_models` honest: list only the plugin's supported aliases and
  explain that native-model availability belongs to the active Provider. It
  cannot enumerate or validate a Provider catalogue.
- Remove active-authority checks from `cc_setup`.

### State, evidence, and privacy

- Advance the state schema only if needed to remove profile-derived fields from
  newly persisted and migrated job records. Do not weaken existing task
  redaction, retention, integrity, atomic-write, or diagnostic guarantees.
- Preserve the distinction between requested selector, executed transcript
  model, and usage key.
- Remove profile-only formatting from reports without dropping execution
  evidence or failure classification.

### Existing dirty worktree

The seven uncommitted files present before this change are not trusted as a
solution. They remove task-redaction and retention safeguards in places. Their
intent must be reviewed against the current source and tests. Retain only
changes required by the decoupled design; restore or replace any weakening of
privacy, migration, retention, or test-helper behavior. No user work may be
discarded silently.

## Acceptance tests

1. A fake, corrupt `~/.cc-profile-switch` layout and all former adapter
   environment variables do not alter `cc_delegate`, `cc_resolve_route`, or
   `cc_setup` behavior.
2. Repository source, manifest, skills, tests, and documentation contain no
   runtime support or user instructions for cc-profile-switch or its former
   adapters.
3. Alias, native, inherited, ambiguous, unsafe, and provider-rejected selector
   paths are tested without a paid model call.
4. A job started with aliases or native IDs contains no profile identity,
   fingerprint, mapped-native claim, secret, or task text in MCP output,
   state, or diagnostics.
5. Existing task-redaction, atomic state writes, state migration, probe
   retention, cancellation, and transcript evidence tests remain intact.
6. `npm test`, `npm run verify:source`, plugin manifest validation, cachebuster
   update, and installed-cache verification pass.
7. The final pushed commit passes every GitHub Actions job on all configured
   operating systems and Node versions.

## Out of scope

- Integrating with, changing, launching, or validating `cc-profile-switch`.
- Building a Provider model catalogue or trying to infer current Provider
  aliases before execution.
- A paid liveness probe; deterministic fake-Claude coverage is sufficient for
  this change.
