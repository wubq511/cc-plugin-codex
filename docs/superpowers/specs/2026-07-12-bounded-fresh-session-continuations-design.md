# Bounded Fresh-Session Continuations

**Date:** 2026-07-12
**Status:** Approved for implementation by the user's instruction to proceed autonomously after adversarial review

## Problem

The delegate skill currently maps ordinary continuation language such as "keep going" and "continue" to `resume=true`. In a review-and-fix loop, that makes multiple completed Claude Code jobs append to the same transcript. Every later turn can therefore inherit prior file reads, tool output, failed approaches, and corrections. Input cost grows with context size, while irrelevant history can also reduce execution quality.

The MCP tool itself already starts a fresh Claude Code session when neither `resume` nor `resumeSession` is supplied. The defect is the agent-facing policy that selects resume too broadly.

## First-Principles Constraints

1. A repair agent needs the current objective, current defects, non-negotiable constraints, and acceptance checks.
2. The workspace, git diff, tests, and project instructions are the authoritative implementation state. Chat history is not authoritative state.
3. Prior reasoning is useful only when it records a still-valid decision that cannot be recovered from the workspace.
4. Old tool output and failed approaches have recurring token cost and can anchor later work on stale assumptions.
5. The plugin cannot reliably observe Claude Code's live context occupancy before a run, so runtime token thresholds would be guesses.
6. Explicit same-session resume remains a legitimate expert operation and must not be removed.

## Considered Approaches

### 1. Keep resuming and rely on auto-compaction

Rejected as the default. Compaction summarizes history only after the context has grown, requires its own model operation, and can lose early instructions. It is a recovery mechanism, not a good review-loop boundary.

### 2. Resume with `--fork-session`

Rejected as a cost solution. Forking creates a new session ID but starts from the resumed conversation, so it isolates future branches without removing inherited history.

### 3. Fresh session with a bounded handoff package

Selected. Each review-to-fix delegation starts a new Claude Code session and passes only:

- objective and current scope;
- actionable review findings or verification failures;
- still-valid architectural constraints and decisions;
- acceptance checks;
- an instruction to inspect the current workspace and git diff as primary evidence.

The handoff must not include the full prior transcript, a full diff, or verbose logs. Claude Code can inspect those artifacts directly and selectively.

## Final Design

### Intent policy

The delegate skill distinguishes task continuity from conversation continuity:

- "continue", "keep going", "fix the review findings", and similar workflow language mean a fresh delegation with a bounded handoff.
- `resume=true` is used only when the user explicitly requests the same/latest Claude Code conversation or says that prior conversational reasoning must be preserved.
- `resumeSession` is used only when the user explicitly identifies a Claude session.
- An ambiguous continuation defaults to fresh because the workspace preserves task continuity at lower cost.

### MCP contract guidance

The `cc_delegate` tool description and server instructions will state that fresh sessions are the default for follow-up work and that resume is an explicit conversation-preservation operation. The existing parameters and runtime behavior remain backward-compatible.

No automatic resume-depth cap, hidden compaction, transcript parsing, or new context field will be added. These would either guess at context size, duplicate data already present in `task`, or introduce privacy and compatibility risks.

### Bounded handoff format

The skill will instruct Codex to compose a concise task with these headings when delegating a follow-up:

1. `Objective`
2. `Current findings`
3. `Constraints`
4. `Acceptance checks`

The prompt also tells Claude Code to inspect the current workspace and git diff before editing. Empty sections are omitted. Only actionable evidence is included.

### Documentation

README and PRD will explain the fresh-by-default review loop and the narrower meaning of resume. Existing direct resume examples remain available but will use explicit same-session wording.

## Error Handling and Compatibility

- Existing callers that pass `resume` or `resumeSession` keep their current behavior.
- Callers that omit both flags keep receiving a new Claude Code session.
- The server continues to reject `resume=true` combined with `resumeSession`.
- No state schema migration is needed.
- No Claude Code version dependency is added.

## Verification

Contract tests will assert that:

- ordinary continuation and review-fix language is documented as fresh-session behavior;
- same-session resume requires explicit intent;
- bounded handoffs exclude full transcripts, full diffs, and verbose logs;
- MCP descriptions do not present resume as the ordinary continuation default;
- existing runtime resume tests continue to pass.

The full test suite, source verification, plugin validation, cachebuster update, reinstall, and install verification will run after implementation.

## Adversarial Review

### Challenge: Fresh sessions may lose important architectural decisions

Valid. The initial design said "always fresh" without defining what survives. The corrected design requires a bounded handoff containing still-valid constraints and decisions, while treating repository docs and code as primary evidence.

### Challenge: A hard resume limit would guarantee bounded growth

It would guarantee a crude job count, not a token bound. One job can already be huge, while several tiny turns can be cheap. A limit would also reject explicit expert workflows without reliable evidence. The corrected design changes the default agent policy and preserves explicit override instead.

### Challenge: Codex may ignore prose guidance and keep setting `resume=true`

The policy is repeated at three agent-visible layers: delegate skill workflow, MCP tool description, and MCP server instructions. Contract tests lock those surfaces. Runtime cannot verify the user's semantic intent, so a server-side prohibition would be false precision.

### Challenge: Passing review findings duplicates context and can itself become large

The corrected design makes the handoff structurally bounded by content selection: actionable findings and concise verification failures only, never the full review transcript, full diff, or verbose logs. The workspace remains the retrieval surface.

### Challenge: `--fork-session` could preserve quality more safely

Forking protects transcript identity, not context cost. It remains outside scope because it does not solve the reported failure mode.

## Sources

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)
- [Manage costs effectively](https://code.claude.com/docs/en/costs)
- [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices)
- [How Claude Code uses prompt caching](https://code.claude.com/docs/en/prompt-caching)
