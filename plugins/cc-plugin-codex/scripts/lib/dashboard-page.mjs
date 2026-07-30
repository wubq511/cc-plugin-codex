/**
 * Dashboard HTML page — single file, zero dependencies, zero build.
 *
 * Served by dashboard.mjs at GET /?token=<token>. The page reads the token
 * from the URL and uses EventSource + fetch to render a real-time timeline of
 * Claude's actions. Chinese UI.
 */

export function renderDashboardPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude 实时面板</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1f2430; --border: #2a3140;
    --text: #e6e9ef; --muted: #8b95a7; --accent: #6bb6ff; --green: #7ee787;
    --amber: #f0c674; --red: #ff7b72; --tool: #d2a8ff;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--text); }
  header { display: flex; align-items: center; gap: 16px; padding: 12px 20px; background: var(--panel); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 10; }
  header h1 { font-size: 15px; margin: 0; font-weight: 600; }
  header .status { font-size: 13px; color: var(--muted); }
  header .phase { color: var(--accent); }
  header .elapsed { color: var(--amber); }
  .layout { display: flex; min-height: calc(100vh - 49px); }
  aside { width: 280px; border-right: 1px solid var(--border); background: var(--panel); overflow-y: auto; }
  main { flex: 1; overflow-y: auto; padding: 16px 20px; }
  .job-item { padding: 10px 16px; border-bottom: 1px solid var(--border); cursor: pointer; }
  .job-item:hover { background: var(--panel-2); }
  .job-item.active { background: var(--panel-2); border-left: 3px solid var(--accent); }
  .job-item .jid { font-family: ui-monospace, monospace; font-size: 12px; color: var(--accent); }
  .job-item .jstat { font-size: 12px; color: var(--muted); margin-top: 2px; }
  .pill { display: inline-block; padding: 1px 7px; border-radius: 10px; font-size: 11px; }
  .pill.running { background: #1f3a5f; color: var(--accent); }
  .pill.completed { background: #1a3a26; color: var(--green); }
  .pill.failed { background: #3a1f1f; color: var(--red); }
  .pill.cancelled { background: #3a3018; color: var(--amber); }
  .pill.queued { background: #2a2a3a; color: var(--muted); }
  .tl { display: flex; flex-direction: column; gap: 10px; }
  .ev { padding: 10px 14px; border-radius: 8px; background: var(--panel); border: 1px solid var(--border); }
  .ev .ev-head { font-size: 12px; color: var(--muted); margin-bottom: 6px; display: flex; justify-content: space-between; }
  .ev.system { border-left: 3px solid var(--muted); }
  .ev.assistant { border-left: 3px solid var(--accent); }
  .ev.user { border-left: 3px solid var(--tool); }
  .ev.result { border-left: 3px solid var(--green); }
  .ev .text { white-space: pre-wrap; word-break: break-word; font-size: 13px; line-height: 1.5; }
  .tool-card { background: var(--panel-2); border-radius: 6px; padding: 8px 10px; margin-top: 6px; }
  .tool-card .tname { color: var(--tool); font-family: ui-monospace, monospace; font-size: 13px; font-weight: 600; }
  details summary { cursor: pointer; font-size: 12px; color: var(--muted); margin-top: 4px; }
  details pre { margin: 6px 0 0; font-size: 12px; white-space: pre-wrap; word-break: break-word; color: var(--text); }
  .result-box { background: #142318; border-radius: 6px; padding: 10px 12px; }
  .result-box .meta { font-size: 12px; color: var(--muted); margin-top: 6px; }
  .resume-box { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 14px; }
  .resume-box .rhead { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
  .resume-box .rcmd { display: flex; align-items: center; gap: 10px; }
  .resume-box code { flex: 1; font-family: ui-monospace, monospace; font-size: 13px; color: var(--green); word-break: break-all; }
  .copy-btn { background: var(--panel); color: var(--text); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer; white-space: nowrap; }
  .copy-btn:hover { border-color: var(--accent); color: var(--accent); }
  .empty { color: var(--muted); text-align: center; padding: 60px 20px; font-size: 14px; }
  .conn { font-size: 11px; }
  .conn.ok { color: var(--green); } .conn.off { color: var(--red); }
</style>
</head>
<body>
<header>
  <h1>Claude 实时面板</h1>
  <span class="status">连接：<span id="conn" class="conn off">等待</span></span>
  <span class="status phase" id="phase"></span>
  <span class="status elapsed" id="elapsed"></span>
</header>
<div class="layout">
  <aside>
    <div style="padding:10px 16px;font-size:12px;color:var(--muted);border-bottom:1px solid var(--border)">任务列表</div>
    <div id="job-list"><div class="empty" style="padding:30px 16px">加载中…</div></div>
  </aside>
  <main>
    <div id="timeline" class="tl"><div class="empty">在左侧选择一个任务，或启动新的委托以查看实时动作。</div></div>
  </main>
</div>
<script>
const token = new URLSearchParams(location.search).get("token") || "";
const q = (p) => p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);
const state = { jobs: new Map(), selected: null, es: null, startedAt: null };

function fmtElapsed(ms) {
  if (ms == null) return "—";
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + " 秒";
  return Math.floor(s / 60) + " 分 " + (s % 60) + " 秒";
}
function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c])); }
function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }

function renderJobList() {
  const list = document.getElementById("job-list");
  const jobs = [...state.jobs.values()].sort((a, b) => String(b.startedAt || b.createdAt || "").localeCompare(String(a.startedAt || a.createdAt || "")));
  if (jobs.length === 0) { list.innerHTML = '<div class="empty" style="padding:30px 16px">暂无任务</div>'; return; }
  list.innerHTML = jobs.map((j) => {
    const st = j.status || "queued";
    return '<div class="job-item' + (state.selected === j.id ? " active" : "") + '" data-id="' + esc(j.id) + '">'
      + '<div class="jid">' + esc(trunc(j.id, 20)) + '</div>'
      + '<div class="jstat"><span class="pill ' + st + '">' + st + '</span> ' + esc(j.phase || "") + '</div>'
      + '</div>';
  }).join("");
  list.querySelectorAll(".job-item").forEach((el) => {
    el.addEventListener("click", () => { state.selected = el.dataset.id; renderJobList(); renderTimeline(); });
  });
}

function renderContentBlock(block) {
  if (!block || typeof block !== "object") return "";
  if (block.type === "text") {
    return '<div class="text">' + esc(block.text) + '</div>';
  }
  if (block.type === "thinking") {
    return '<details><summary>思考过程</summary><pre>' + esc(block.thinking || block.text || "") + '</pre></details>';
  }
  if (block.type === "tool_use") {
    const input = JSON.stringify(block.input, null, 2);
    const summary = trunc(JSON.stringify(block.input), 80);
    return '<div class="tool-card"><span class="tname">→ ' + esc(block.name) + '</span>'
      + '<div class="text" style="color:var(--muted);font-size:12px;margin-top:2px">' + esc(summary) + '</div>'
      + '<details><summary>参数</summary><pre>' + esc(input) + '</pre></details></div>';
  }
  if (block.type === "tool_result") {
    const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content, null, 2);
    const isError = block.is_error ? '<span style="color:var(--red)">（错误）</span>' : '';
    return '<div class="tool-card"><span class="tname">← 结果' + isError + '</span>'
      + '<details><summary>查看输出</summary><pre>' + esc(content) + '</pre></details></div>';
  }
  return '<div class="text">' + esc(JSON.stringify(block)) + '</div>';
}

function renderEvent(ev) {
  const type = ev.type || "unknown";
  const time = new Date().toLocaleTimeString("zh-CN");
  let body = "";
  if (type === "system") {
    body = '<div class="text" style="color:var(--muted)">系统事件：' + esc(ev.subtype || "") + '</div>';
  } else if (type === "assistant") {
    const blocks = (ev.message && Array.isArray(ev.message.content)) ? ev.message.content : [];
    body = blocks.map(renderContentBlock).join("");
  } else if (type === "user") {
    const blocks = (ev.message && Array.isArray(ev.message.content)) ? ev.message.content : [];
    body = blocks.map(renderContentBlock).join("");
  } else if (type === "result") {
    const meta = [];
    if (ev.total_cost_usd != null) meta.push("费用 $" + ev.total_cost_usd);
    if (ev.duration_ms != null) meta.push("耗时 " + (ev.duration_ms / 1000).toFixed(1) + "s");
    if (ev.num_turns != null) meta.push(ev.num_turns + " 轮");
    body = '<div class="result-box"><div class="text">' + esc(ev.result || "") + '</div>'
      + '<div class="meta">' + esc(meta.join(" · ")) + '</div></div>';
  } else {
    body = '<div class="text">' + esc(JSON.stringify(ev)) + '</div>';
  }
  return '<div class="ev ' + type + '"><div class="ev-head"><span>' + esc(type) + '</span><span>' + time + '</span></div>' + body + '</div>';
}

function renderResumeBox(job) {
  const sid = job && job.claudeSessionId;
  if (!sid) return "";
  const cmd = "claude --resume " + sid;
  return '<div class="resume-box"><div class="rhead">在终端继续此会话（在 workspace 根目录运行）</div>'
    + '<div class="rcmd"><code>' + esc(cmd) + '</code>'
    + '<button class="copy-btn" data-cmd="' + esc(cmd) + '">复制</button></div></div>';
}

function copyText(btn, text) {
  const done = () => { btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "复制"; }, 1500); };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => { btn.textContent = "复制失败"; });
  } else {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); done(); } catch { btn.textContent = "复制失败"; }
    document.body.removeChild(ta);
  }
}

function renderTimeline() {
  const tl = document.getElementById("timeline");
  const job = state.jobs.get(state.selected);
  if (!job) { tl.innerHTML = '<div class="empty">未选择任务。</div>'; return; }
  const events = job.timeline || [];
  const resumeBox = renderResumeBox(job);
  const eventsHtml = events.length === 0
    ? '<div class="empty">该任务暂无事件。等待 Claude 动作…</div>'
    : events.map((e) => renderEvent(e.event)).join("");
  tl.innerHTML = resumeBox + eventsHtml;
  tl.querySelectorAll(".copy-btn").forEach((btn) => {
    btn.addEventListener("click", () => copyText(btn, btn.dataset.cmd || ""));
  });
  // update header phase/elapsed
  const phaseEl = document.getElementById("phase");
  const elapsedEl = document.getElementById("elapsed");
  phaseEl.textContent = job.phase ? "阶段：" + job.phase : "";
  if (job.startedAt) {
    const end = job.completedAt ? new Date(job.completedAt).getTime() : Date.now();
    elapsedEl.textContent = "已耗时：" + fmtElapsed(end - new Date(job.startedAt).getTime());
  } else { elapsedEl.textContent = ""; }
}

function ingestEvent(jobId, event) {
  if (!jobId || !event) return;
  let job = state.jobs.get(jobId);
  if (!job) { job = { id: jobId, timeline: [] }; state.jobs.set(jobId, job); }
  if (!job.timeline) job.timeline = [];
  job.timeline.push({ event });
  // A result event finalizes the job locally.
  if (event.type === "result") { job.completedAt = new Date().toISOString(); }
  if (state.selected === jobId) renderTimeline();
}

async function pollJobs() {
  try {
    const r = await fetch(q("/api/jobs"));
    if (!r.ok) return;
    const data = await r.json();
    const jobs = data.jobs || [];
    for (const j of jobs) {
      let existing = state.jobs.get(j.id);
      if (!existing) { existing = { id: j.id, timeline: [] }; state.jobs.set(j.id, existing); }
      Object.assign(existing, j);
      existing.timeline = existing.timeline || [];
    }
    renderJobList();
    if (!state.selected && jobs.length > 0) { state.selected = jobs[0].id; renderTimeline(); }
    if (state.selected) renderTimeline();
  } catch { /* ignore */ }
}

function connectSSE() {
  const conn = document.getElementById("conn");
  try { if (state.es) state.es.close(); } catch {}
  state.es = new EventSource(q("/events"));
  state.es.onopen = () => { conn.textContent = "已连接"; conn.className = "conn ok"; };
  state.es.onerror = () => { conn.textContent = "断开，重连中…"; conn.className = "conn off"; };
  state.es.onmessage = (msg) => {
    try {
      const { jobId, event } = JSON.parse(msg.data);
      ingestEvent(jobId, event);
    } catch { /* ignore malformed */ }
  };
}

connectSSE();
pollJobs();
setInterval(pollJobs, 2000);
setInterval(() => { if (state.selected) renderTimeline(); }, 1000); // refresh elapsed
</script>
</body>
</html>`;
}
