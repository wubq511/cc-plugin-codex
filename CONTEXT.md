# cc-plugin-codex

A Codex plugin that delegates coding tasks to Claude Code in the foreground and
surfaces a read-only live dashboard of the delegation while it blocks.

## Language

### Delegation core

**Delegation** (委托):
One foreground-blocking coding task handed from Codex to Claude Code via the
plugin. The unit of work everything else observes.
_Avoid_: request, invocation, run

**Job** (任务):
The plugin-side tracked record of one delegation: id, status, phase, timing,
and session identifiers. Jobs are what the dashboard lists.
_Avoid_: task record, session, process

**Event Stream** (事件流):
The bounded stream-json NDJSON events (system/assistant/user/result) forwarded
from the watchdog to the dashboard while a delegation runs. High-frequency
noise subtypes (thinking_tokens, one per thinking delta) are dropped at server
ingest — before the ring — and again in the client reducer. Events live only
in memory, never on disk.
_Avoid_: log, transcript, history

**Task Title** (任务标题):
A bounded (80-char), secret-filtered summary of a job's task text, exposed in
dashboard job metadata so humans can tell jobs apart. Job UUIDs alone are not
considered human-meaningful identification.
_Avoid_: task name, subject

### Dashboard surface

**Status Zone** (状态区):
The second row of the sticky dashboard header answering "what is Claude doing
right now": current action, phase, elapsed, turn and tool-call counts. Only
metrics with a real live data source appear here; cost appears only as the
final value from the result event. Hidden when no job is selected.
_Avoid_: header stats, summary bar, metrics panel

**Current Action** (当前动作):
A one-line human-readable summary of the latest tool activity, e.g. "正在编辑
scripts/lib/dashboard.mjs". The primary at-a-glance signal of the dashboard.
_Avoid_: latest event, activity label

**Timeline** (时间线):
The chronological, noise-reduced rendering of a job's event stream below the
status zone. Assistant narration is the primary signal; tool activity is
supporting evidence.
_Avoid_: feed, event list, log view

**Tool Card** (工具卡):
A tool_use paired with its tool_result into one timeline unit. Successful
output is collapsed inside; error output auto-expands and is highlighted.
_Avoid_: tool event, call/result pair

**Follow Mode** (跟随模式):
The timeline's auto-scroll behavior: anchored to the newest event while the
user is at the bottom, paused when the user scrolls up, resumed via the
"回到最新" affordance.
_Avoid_: auto-scroll, live tail
