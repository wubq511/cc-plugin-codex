---
name: review
description: Use when you want to review code changes made by Claude Code — standard review for bugs, or adversarial review to challenge implementation choices
---

# Review Claude Code Output

## Overview

Review code changes produced by a Claude Code task. Two modes:

- **Standard review**: Check for bugs, style issues, security problems, and performance concerns
- **Adversarial review**: Challenge implementation choices, question assumptions, identify failure modes and alternatives

Both modes produce **structured JSON output** with verdict, findings (severity-ranked), and next steps.

## Workflow

1. Determine review mode:
   - User says "adversarial", "challenge", "质疑" → `adversarial=true`
   - Default → standard review

2. Call `cc_review` with:
   - `job` (optional): job ID or prefix to review (default: latest completed job)
   - `adversarial` (optional): set to `true` for adversarial mode
   - `focus` (optional): specific aspect to focus on (e.g., "security", "performance")
   - `base` (optional): git base ref for diff (default: auto-detect)
   - `scope` (optional): review scope — `auto` (default: working-tree if dirty, else branch), `working-tree` (staged+unstaged+untracked), `branch` (diff against default branch from merge-base)

3. The tool returns the diff, git context, and review instructions. **You (Codex) execute the review** — apply the review criteria to the diff and produce a structured JSON result.

4. Parse the review result JSON and present findings to the user:
   - Overall verdict (approve / request_changes / reject)
   - Findings ordered by severity (critical → low)
   - Specific file and line references
   - Concrete recommendations for each finding
   - For adversarial: assumptions identified and their validity

5. If issues are found, suggest next steps:
   - Delegate fixes back to Claude Code: `/claude:delegate`
   - Fix directly in Codex

## Review Output Schema

All reviews produce JSON matching this schema:

```json
{
  "verdict": "approve|needs-attention",
  "summary": "terse ship/no-ship assessment",
  "findings": [{ "severity": "critical|high|medium|low", "title": "...", "body": "...", "file": "...", "line_start": 1, "line_end": 1, "confidence": 0.8, "recommendation": "..." }],
  "next_steps": ["step 1", "step 2"]
}
```

## Adversarial Review Dimensions

When `adversarial=true`, the review examines:

1. **Assumptions & Preconditions** — what does the code assume? What breaks if violated?
2. **Failure Modes & Degradation** — when does this fail silently? At scale? Under concurrency?
3. **Alternative Approaches** — were simpler alternatives considered? Known patterns/libraries?
4. **Technical Debt & Maintenance** — coupling, rewrite risk, known incompleteness markers
5. **Boundary Conditions** — empty inputs, null, race conditions, platform-specific behavior

## Git Context

The review tool automatically provides:
- Changed files list
- Working tree state (modified/added/deleted/untracked)
- Diff with size measurement (truncated if >512KB)
- Untracked file contents (for new files)
- Diff stat summary
- Auto-detected base ref (merge-base on feature branches, HEAD~1 on default)

## Examples

- "Review the Claude Code changes" → standard review
- "Adversarial review of what Claude Code did" → adversarial review
- "Review focusing on security" → `cc_review` with `focus="security"`
- "Review job cc-abc" → `cc_review` with `job="cc-abc"` (prefix matching)
