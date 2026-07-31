# Codex-side token cost: thin schemas, text-first results, terminal-result dedup

A July 2026 audit measured this plugin's token cost on the Codex side (the
calling agent, not the Claude Code side): ~4,500 always-on tokens (9 tool
schemas + initialize instructions + skill front-matter) plus per-call result
payloads. We decided to cut the measured waste without architectural change:
tool schemas keep only the hard rules needed for a correct call while deep
semantics live in the skills (progressive disclosure); tool results are
text-first and emit no `structuredContent` duplicates; `cc_check` does not
re-deliver an unchanged terminal result — it returns a process-local result
fingerprint instead, with `includeResult: true` as the explicit escape hatch;
the deprecated `background` parameter was removed (unknown-parameter rejection
covers the foreground-only contract); and budget assertions in
`tests/token-budget.test.mjs` pin the gains.

Rejected alternatives: Tool Search / deferred loading, code-execution style
"code mode", and converting the plugin to a CLI. The measured surface (9 tools,
~13.5 KB of schema after slimming) sits below every published threshold for
those techniques (Anthropic suggests Tool Search only past ~10K tokens or 10+
tools of definitions; the large reported wins come from servers with dozens to
thousands of tools), so they would add a discovery round-trip and lose typed
input validation for no measurable gain.

Consequences: `structuredContent` removal also sidesteps a Codex client bug
(openai/codex#10334) where `content[]` is hidden from the model when
`structuredContent` is present. Consumers that parsed the structured fields
(tests, `scripts/calibrate-continuation.mjs`) now parse the labeled text lines,
which are the plugin's output contract. After an MCP server restart the first
`cc_check` of a terminal job re-delivers its result once, because the delivery
record is process-local; this is accepted as a bounded, rare re-payment.
