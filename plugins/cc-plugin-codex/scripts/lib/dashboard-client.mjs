/**
 * Dashboard client, browser logic for the live panel.
 *
 * Inlined into the page by dashboard-page.mjs as a module script (no network
 * imports allowed). The pure, DOM-free core is exported so node --test can
 * cover it directly; the bootstrap at the bottom only runs in a browser.
 *
 * Information architecture (see CONTEXT.md):
 *   - Status Zone: current action + only metrics with a real live source
 *     (phase, elapsed, turns, tool calls). Cost shows the final value only.
 *   - Timeline: assistant narration is the primary signal; tool_use paired
 *     with its tool_result into one Tool Card. Success output collapses,
 *     error output auto-expands. Thinking hides behind an indicator,
 *     informative system events become dividers; high-frequency noise
 *     subtypes (thinking_tokens) and unparseable events are dropped.
 *   - Follow Mode: auto-scroll anchored at the bottom, paused on user
 *     scroll-up, resumed via the back-to-latest affordance.
 *   - Favicon: the Claude starburst (Simple Icons, CC0) at every state;
 *     completion overlays a green/red status dot.
 */

// ── Pure helpers ────────────────────────────────────────────────────────────

export function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function truncate(s, n) {
  s = String(s == null ? "" : s);
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/**
 * One-line "当前动作" label from assistant narration: collapse whitespace and
 * strip markdown emphasis/backticks, which read as noise in a status line.
 */
export function actionLabel(text) {
  return String(text == null ? "" : text).replace(/\s+/g, " ").replace(/[*`]/g, "").trim();
}

export function formatElapsed(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + " 秒";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " 分 " + String(s % 60).padStart(2, "0") + " 秒";
  return Math.floor(m / 60) + " 小时 " + (m % 60) + " 分";
}

export function formatClock(d) {
  const date = d instanceof Date ? d : new Date(d);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((n) => String(n).padStart(2, "0")).join(":");
}

const TOOL_VERBS = {
  Read: "读取", Edit: "编辑", Write: "写入", NotebookEdit: "编辑",
  Bash: "运行", Grep: "搜索", Glob: "搜索", Task: "委托",
  WebFetch: "抓取", WebSearch: "搜索", TodoWrite: "记录",
};

function countLines(s) {
  if (!s) return 0;
  return String(s).split("\n").length;
}

/**
 * Semantic one-line summary of a tool_use block, replacing raw JSON dumps.
 * Returns { verb, summary } where verb drives the "当前动作" phrasing.
 */
export function summarizeToolUse(name, input) {
  const verb = TOOL_VERBS[name] || "使用";
  const i = input && typeof input === "object" ? input : {};
  let summary = "";
  switch (name) {
    case "Read":
    case "Write":
    case "NotebookEdit":
      summary = i.file_path || i.notebook_path || "";
      break;
    case "Edit": {
      summary = i.file_path || "";
      const add = countLines(i.new_string);
      const del = countLines(i.old_string);
      if (add || del) summary += " · +" + add + " −" + del;
      break;
    }
    case "Bash":
      summary = String(i.command || "").split("\n")[0];
      break;
    case "Grep":
      summary = (i.pattern || "") + (i.path ? " · " + i.path : "");
      break;
    case "Glob":
      summary = i.pattern || "";
      break;
    case "Task":
      summary = i.description || "";
      break;
    case "WebFetch":
      summary = i.url || "";
      break;
    case "WebSearch":
      summary = i.query || "";
      break;
    default: {
      const firstScalar = Object.values(i).find((v) => typeof v === "string" || typeof v === "number");
      summary = firstScalar != null ? String(firstScalar) : "";
    }
  }
  return { verb, summary: truncate(summary, 96) };
}

// ── Timeline reducer (DOM-free) ─────────────────────────────────────────────
//
// Ingests raw stream-json events and emits view operations. The browser layer
// applies ops to the DOM; tests assert on ops and derived state directly.
// Card model: { id, kind, ...kindFields }. Ops:
//   { op: "append", card } | { op: "update", id, patch }

function resultContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && b.type === "text" ? b.text : typeof b === "string" ? b : JSON.stringify(b)))
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content, null, 2);
}

export function createTimelineReducer() {
  const cards = [];
  const byToolUseId = new Map();     // tool_use_id -> card
  const pendingResults = new Map();  // tool_use_id -> result block (arrived early)
  const metrics = { turns: 0, toolCalls: 0 };
  let lastAction = null;             // { label } one-line current action
  let result = null;                 // final result info
  let seq = 0;

  function append(card) {
    cards.push(card);
    return { op: "append", card };
  }

  function ingest(event, now = Date.now()) {
    if (!event || typeof event !== "object") return [];
    const ops = [];

    if (event.type === "system") {
      // thinking_tokens arrives once per thinking delta and carries no
      // renderable information: drop it (also dropped server-side).
      if (event.subtype === "thinking_tokens") return ops;
      const label = event.subtype === "init" ? "会话开始" : "系统 · " + (event.subtype || "事件");
      ops.push(append({ id: "c" + ++seq, kind: "divider", text: label, at: now }));
      return ops;
    }

    if (event.type === "assistant") {
      metrics.turns++;
      const blocks = event.message && Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && String(block.text || "").trim()) {
          const text = String(block.text);
          ops.push(append({ id: "c" + ++seq, kind: "msg", role: "assistant", text, at: now }));
          lastAction = { label: truncate(actionLabel(text), 48) };
        } else if (block.type === "thinking") {
          const text = block.thinking || block.text || "";
          ops.push(append({ id: "c" + ++seq, kind: "think", text, at: now }));
          lastAction = { label: "正在思考" };
        } else if (block.type === "tool_use") {
          metrics.toolCalls++;
          const { verb, summary } = summarizeToolUse(block.name, block.input);
          const card = {
            id: "c" + ++seq, kind: "tool", state: "run",
            name: block.name || "tool", verb, summary,
            toolUseId: block.id || null,
            output: null, isError: false, at: now, durationMs: null,
          };
          ops.push(append(card));
          if (card.toolUseId) {
            byToolUseId.set(card.toolUseId, card);
            const early = pendingResults.get(card.toolUseId);
            if (early) {
              pendingResults.delete(card.toolUseId);
              applyToolResult(card, early, now, ops);
            }
          }
          lastAction = { label: "正在" + verb + " " + summary };
        }
      }
      return ops;
    }

    if (event.type === "user") {
      const blocks = event.message && Array.isArray(event.message.content) ? event.message.content : [];
      for (const block of blocks) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_result") {
          const card = block.tool_use_id ? byToolUseId.get(block.tool_use_id) : null;
          if (card) {
            applyToolResult(card, block, now, ops);
          } else if (block.tool_use_id) {
            // Result arrived before its tool_use: buffer, never render loose.
            pendingResults.set(block.tool_use_id, block);
          }
          // Results without a tool_use_id carry no pairable information: drop.
        } else if (block.type === "text" && String(block.text || "").trim()) {
          ops.push(append({ id: "c" + ++seq, kind: "msg", role: "user", text: String(block.text), at: now }));
        }
      }
      return ops;
    }

    if (event.type === "result") {
      result = {
        ok: !event.is_error && event.subtype !== "error",
        text: typeof event.result === "string" ? event.result : "",
        costUsd: typeof event.total_cost_usd === "number" ? event.total_cost_usd : null,
        durationMs: typeof event.duration_ms === "number" ? event.duration_ms : null,
        numTurns: typeof event.num_turns === "number" ? event.num_turns : null,
      };
      ops.push(append({ id: "c" + ++seq, kind: "result", state: result.ok ? "ok" : "err", ...result, at: now }));
      lastAction = { label: result.ok ? "已完成" : "失败" };
      return ops;
    }

    // Unknown event types carry no renderable information: drop.
    return ops;
  }

  function applyToolResult(card, block, now, ops) {
    const patch = {
      state: block.is_error ? "err" : "ok",
      output: truncate(resultContentToText(block.content), 4000),
      isError: !!block.is_error,
      durationMs: Math.max(0, now - card.at),
    };
    Object.assign(card, patch);
    ops.push({ op: "update", id: card.id, patch });
  }

  return {
    ingest,
    get cards() { return cards; },
    get metrics() { return { ...metrics }; },
    get lastAction() { return lastAction; },
    get result() { return result; },
  };
}

// ── Follow mode (DOM-free state machine) ────────────────────────────────────

export function followReducer(state, action) {
  switch (action.type) {
    // Programmatic scrolls never reach here: only genuine user scroll input.
    case "user-scroll":
      return { following: !!action.nearBottom, pending: action.nearBottom ? 0 : state.pending };
    case "event-appended":
      return state.following ? state : { ...state, pending: state.pending + 1 };
    case "back-to-latest":
      return { following: true, pending: 0 };
    default:
      return state;
  }
}

// ── Completion notice (DOM-free decision) ───────────────────────────────────

export function completionNotice(resultInfo) {
  const ok = resultInfo && resultInfo.ok;
  return {
    titlePrefix: ok ? "✅ 完成 · " : "❌ 失败 · ",
    faviconColor: ok ? "#388a34" : "#c72e2e",
    ok: !!ok,
  };
}

// ── Favicon ────────────────────────────────────────────────────────────────
// Claude starburst logo path (Simple Icons, CC0) — the panel's icon at every
// state, inlined as a data URI (no external requests). A badge color overlays
// a small status dot for completion/failure.
const FAVICON_PATH = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

export function faviconHref(badgeColor) {
  const badge = badgeColor ? "<circle cx='18.5' cy='18.5' r='4.5' fill='" + badgeColor + "'/>" : "";
  const scale = badgeColor ? " transform='translate(1.2 1.2) scale(0.86)'" : "";
  const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'>" +
    "<g fill='#D97757'" + scale + "><path d='" + FAVICON_PATH + "'/></g>" + badge + "</svg>";
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

// ── Browser bootstrap ───────────────────────────────────────────────────────

if (typeof document !== "undefined" && typeof window !== "undefined") {
  bootstrap();
}

function bootstrap() {
  const BASE_TITLE = document.title || "Claude 实时面板";
  const token = new URLSearchParams(location.search).get("token") || "";
  const q = (p) => p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(token);

  const jobs = new Map(); // jobId -> { meta, reducer, notified }
  let selected = null;
  let follow = { following: true, pending: 0 };
  let soundOn = false;
  let audioCtx = null;

  const $ = (id) => document.getElementById(id);
  const statusZone = $("statusZone");
  const timeline = $("timeline");
  const backLatest = $("backLatest");
  const jobsBtn = $("jobsBtn");
  const jobsPop = $("jobsPop");
  const connEl = $("conn");
  const soundBtn = $("soundBtn");
  const currentJobEl = $("currentJob");

  function jobFor(jobId) {
    let j = jobs.get(jobId);
    if (!j) {
      j = { meta: { id: jobId }, reducer: createTimelineReducer(), notified: false };
      jobs.set(jobId, j);
    }
    return j;
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  function renderCard(card) {
    const ts = '<span class="ts">' + formatClock(card.at) + "</span>";
    if (card.kind === "divider") {
      return '<div class="divider" data-cid="' + card.id + '">' + esc(card.text + " · " + formatClock(card.at)) + "</div>";
    }
    if (card.kind === "msg") {
      const cls = card.role === "user" ? "msg user" : "msg";
      return '<div class="' + cls + '" data-cid="' + card.id + '"><span class="msg-text">' + esc(card.text) + "</span>" + ts + "</div>";
    }
    if (card.kind === "think") {
      return '<details class="think" data-cid="' + card.id + '"><summary>思考过程，点击展开</summary><pre>' + esc(card.text) + "</pre></details>";
    }
    if (card.kind === "result") {
      const meta = [];
      if (card.costUsd != null) meta.push("费用 $" + card.costUsd.toFixed(2));
      if (card.durationMs != null) meta.push("耗时 " + formatElapsed(card.durationMs));
      if (card.numTurns != null) meta.push(card.numTurns + " 轮");
      return '<div class="result-card ' + card.state + '" data-cid="' + card.id + '">' +
        '<div class="rc-title">' + (card.state === "ok" ? "任务完成" : "任务失败") + "</div>" +
        (card.text ? '<div class="rc-text">' + esc(truncate(card.text, 2000)) + "</div>" : "") +
        '<div class="rc-meta">' + esc(meta.join(" · ")) + "</div></div>";
    }
    // tool card
    const open = card.state === "err" ? " open" : "";
    const detail = card.output != null
      ? "<details" + open + '><summary>' + (card.state === "err" ? "错误输出" : "输出") + "</summary><pre>" + esc(card.output) + "</pre></details>"
      : "";
    const timeCell = card.state === "run"
      ? '<span class="t-time" data-run-start="' + card.at + '"></span>'
      : '<span class="t-time">' + (card.durationMs != null ? (card.durationMs / 1000).toFixed(1) + "s" : "") + "</span>";
    return '<div class="tool ' + card.state + '" data-cid="' + card.id + '"><div class="tool-head">' +
      '<span class="t-dot ' + card.state + '"></span>' +
      '<span class="t-name">' + esc(card.name) + "</span>" +
      '<span class="t-sum" title="' + esc(card.summary) + '">' + esc(card.summary) + "</span>" +
      '<span class="t-right">' + ts + timeCell + "</span></div>" + detail + "</div>";
  }

  function renderAll() {
    const j = selected ? jobs.get(selected) : null;
    if (!j) {
      timeline.innerHTML = '<div class="empty">暂无事件。发起一个委托后，这里会实时显示 Claude 的动作。</div>';
      return;
    }
    timeline.innerHTML = j.reducer.cards.length
      ? j.reducer.cards.map(renderCard).join("")
      : '<div class="empty">该任务暂无事件，等待 Claude 动作…</div>';
    scrollToBottom(false);
  }

  function applyOps(ops) {
    if (ops.length === 0) return;
    for (const op of ops) {
      if (op.op === "append") {
        timeline.querySelector(".empty")?.remove();
        const div = document.createElement("div");
        div.className = "ev-in";
        div.innerHTML = renderCard(op.card);
        // Unwrap: keep cards as direct timeline children so CSS filters work.
        while (div.firstChild) timeline.appendChild(div.firstChild);
      } else if (op.op === "update") {
        const el = timeline.querySelector('[data-cid="' + op.id + '"]');
        if (el) {
          const card = jobs.get(selected)?.reducer.cards.find((c) => c.id === op.id);
          if (card) {
            const div = document.createElement("div");
            div.innerHTML = renderCard(card);
            el.replaceWith(...[...div.childNodes]);
          }
        }
      }
    }
    if (follow.following) {
      scrollToBottom(true);
    } else {
      follow = followReducer(follow, { type: "event-appended" });
      updateBackLatest();
    }
  }

  function scrollToBottom(smooth) {
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }

  // ── Status zone ──────────────────────────────────────────────────────────

  function updateStatusZone() {
    const j = selected ? jobs.get(selected) : null;
    if (!j) {
      // No job selected: collapse the second header row entirely.
      statusZone.hidden = true;
      statusZone.innerHTML = "";
      return;
    }
    statusZone.hidden = false;
    const m = j.meta;
    const r = j.reducer.result;
    const terminal = ["completed", "failed", "cancelled"].includes(m.status) || !!r;
    const ok = r ? r.ok : m.status === "completed";
    const action = j.reducer.lastAction ? j.reducer.lastAction.label : "等待 Claude 动作…";
    const metrics = j.reducer.metrics;
    const end = m.completedAt ? new Date(m.completedAt).getTime() : Date.now();
    const elapsed = m.startedAt ? formatElapsed(end - new Date(m.startedAt).getTime()) : "—";
    const cost = r && r.costUsd != null ? "$" + r.costUsd.toFixed(2) : "—";

    statusZone.className = "status-zone" + (terminal ? (ok ? " done" : " err") : "");
    const dot = terminal
      ? '<span class="pulse static ' + (ok ? "ok" : "err") + '"></span>'
      : '<span class="pulse"></span>';
    const label = terminal ? (ok ? "已完成" : "已结束") : "当前动作";
    const metaParts = [
      "<span>阶段 · " + esc(m.phase || (terminal ? "结束" : "执行中")) + "</span>",
      "<span>已耗时 " + esc(elapsed) + "</span>",
      "<span>" + metrics.turns + " 轮</span>",
      "<span>" + metrics.toolCalls + " 次工具调用</span>",
      "<span>费用 " + esc(cost) + "</span>",
    ];
    const sid = m.claudeSessionId;
    const resumeBtn = sid
      ? '<button class="copy-btn" id="resumeBtn" data-cmd="claude --resume ' + esc(sid) + '" aria-label="在终端继续此会话" title="在终端继续此会话">⧉ resume</button>'
      : "";
    statusZone.innerHTML =
      '<div class="now-label">' + dot + esc(label) + "</div>" +
      '<div class="now-action">' + esc(action) + "</div>" +
      '<div class="now-meta">' + metaParts.join("") + resumeBtn + "</div>";
    const btn = $("resumeBtn");
    if (btn) btn.addEventListener("click", () => copyText(btn, btn.dataset.cmd || ""));
  }

  function updateCurrentJobLabel() {
    const m = selected ? jobs.get(selected)?.meta : null;
    currentJobEl.textContent = m ? (m.taskTitle || m.id || "") : "";
    currentJobEl.title = m && m.taskTitle ? m.taskTitle : "";
  }

  // ── Job list ─────────────────────────────────────────────────────────────

  function renderJobList() {
    const list = [...jobs.values()]
      .map((j) => j.meta)
      .sort((a, b) => String(b.startedAt || b.createdAt || "").localeCompare(String(a.startedAt || a.createdAt || "")));
    if (list.length === 0) {
      jobsPop.innerHTML = '<div class="empty-pop">暂无任务</div>';
      return;
    }
    jobsPop.innerHTML = list.map((j) => {
      const dur = j.startedAt
        ? formatElapsed((j.completedAt ? new Date(j.completedAt).getTime() : Date.now()) - new Date(j.startedAt).getTime())
        : "";
      const ws = j.workspace ? String(j.workspace).split("/").filter(Boolean).pop() : "";
      return '<div class="job-row' + (selected === j.id ? " active" : "") + '" data-id="' + esc(j.id) + '">' +
        '<span class="jtitle" title="' + esc(j.taskTitle || "") + '">' + esc(j.taskTitle || j.id) + "</span>" +
        '<span class="jstat ' + esc(j.status || "queued") + '">' + esc(j.status || "queued") + "</span>" +
        '<span class="jmeta">' + esc([dur, ws].filter(Boolean).join(" · ")) + "</span></div>";
    }).join("");
    jobsPop.querySelectorAll(".job-row").forEach((el) => {
      el.addEventListener("click", () => {
        selectJob(el.dataset.id);
        jobsPop.hidden = true;
      });
    });
  }

  function selectJob(jobId) {
    selected = jobId;
    follow = { following: true, pending: 0 };
    updateBackLatest();
    renderAll();
    updateStatusZone();
    updateCurrentJobLabel();
    renderJobList();
  }

  // ── Completion notification ──────────────────────────────────────────────

  function notifyCompletion(job) {
    if (job.notified) return;
    job.notified = true;
    const notice = completionNotice(job.reducer.result || { ok: job.meta.status === "completed" });
    document.title = notice.titlePrefix + BASE_TITLE;
    setFavicon(notice.faviconColor);
    if (soundOn) beep(notice.ok);
  }

  function setFavicon(badgeColor) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    link.href = faviconHref(badgeColor || null);
  }

  function beep(ok) {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      const notes = ok ? [880, 1174.7] : [392, 311.1];
      notes.forEach((freq, i) => {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = "sine";
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime + i * 0.18);
        gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + i * 0.18 + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * 0.18 + 0.16);
        osc.connect(gain).connect(audioCtx.destination);
        osc.start(audioCtx.currentTime + i * 0.18);
        osc.stop(audioCtx.currentTime + i * 0.18 + 0.17);
      });
    } catch { /* audio unavailable: silent by design */ }
  }

  soundBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    soundBtn.textContent = soundOn ? "提示音 开" : "提示音 关";
    soundBtn.setAttribute("aria-pressed", String(soundOn));
  });

  // ── Follow mode wiring ───────────────────────────────────────────────────

  function nearBottom() {
    return document.documentElement.scrollHeight - window.scrollY - window.innerHeight < 48;
  }
  function updateBackLatest() {
    if (follow.following || follow.pending === 0) {
      backLatest.classList.remove("show");
    } else {
      const text = "↓ " + follow.pending + " 条新动态，回到最新";
      backLatest.textContent = text;
      backLatest.setAttribute("aria-label", text);
      backLatest.classList.add("show");
    }
  }
  function onUserScroll() {
    follow = followReducer(follow, { type: "user-scroll", nearBottom: nearBottom() });
    updateBackLatest();
  }
  window.addEventListener("wheel", onUserScroll, { passive: true });
  window.addEventListener("touchmove", onUserScroll, { passive: true });
  backLatest.addEventListener("click", () => {
    follow = followReducer(follow, { type: "back-to-latest" });
    updateBackLatest();
    scrollToBottom(true);
  });

  // ── Filters ──────────────────────────────────────────────────────────────

  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.body.dataset.filter = chip.dataset.filter;
      document.querySelectorAll(".chip").forEach((c) => {
        const active = c === chip;
        c.classList.toggle("active", active);
        c.setAttribute("aria-pressed", String(active));
      });
    });
  });

  // ── Copy ─────────────────────────────────────────────────────────────────

  function copyText(btn, text) {
    const done = () => { btn.textContent = "已复制"; setTimeout(() => { btn.textContent = "⧉ resume"; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, () => { btn.textContent = "复制失败"; });
    } else {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); done(); } catch { btn.textContent = "复制失败"; }
      document.body.removeChild(ta);
    }
  }

  // ── Data wiring ──────────────────────────────────────────────────────────

  function ingest(jobId, event, now = Date.now()) {
    const j = jobFor(jobId);
    const ops = j.reducer.ingest(event, now);
    if (event && event.type === "result") {
      j.meta.status = j.reducer.result?.ok ? "completed" : "failed";
      j.meta.completedAt = new Date(now).toISOString();
      notifyCompletion(j);
      renderJobList();
    }
    if (jobId === selected) {
      applyOps(ops);
      updateStatusZone();
    }
  }

  async function pollJobs() {
    try {
      const r = await fetch(q("/api/jobs"));
      if (!r.ok) return;
      const data = await r.json();
      const list = Array.isArray(data.jobs) ? data.jobs : [];
      let selectedWentTerminal = false;
      for (const meta of list) {
        const j = jobFor(meta.id);
        const wasTerminal = ["completed", "failed", "cancelled"].includes(j.meta.status);
        Object.assign(j.meta, meta);
        const isTerminal = ["completed", "failed", "cancelled"].includes(j.meta.status);
        if (!wasTerminal && isTerminal) {
          notifyCompletion(j);
          if (meta.id === selected) selectedWentTerminal = true;
        }
      }
      renderJobList();
      if (!selected && list.length > 0) {
        const latest = [...list].sort((a, b) => String(b.startedAt || b.createdAt || "").localeCompare(String(a.startedAt || a.createdAt || "")))[0];
        selectJob(latest.id);
      } else if (selected) {
        updateStatusZone();
        updateCurrentJobLabel();
        if (selectedWentTerminal) renderAll();
      }
    } catch { /* offline tolerance */ }
  }

  function connectSSE() {
    let opened = false;
    const es = new EventSource(q("/events"));
    es.onopen = () => {
      connEl.textContent = "已连接";
      connEl.className = "conn ok";
      if (opened) {
        // Reconnect: the server replays its ring buffers, so wipe local
        // timelines to re-ingest the replay without duplicates.
        for (const j of jobs.values()) j.reducer = createTimelineReducer();
        if (selected) renderAll();
      }
      opened = true;
    };
    es.onerror = () => {
      connEl.textContent = "断开，重连中…";
      connEl.className = "conn off";
    };
    es.onmessage = (msg) => {
      try {
        const { jobId, event } = JSON.parse(msg.data);
        ingest(jobId, event);
      } catch { /* malformed frame */ }
    };
  }

  // ── Ticks ────────────────────────────────────────────────────────────────

  setInterval(() => {
    const j = selected ? jobs.get(selected) : null;
    if (j && !j.reducer.result && !["completed", "failed", "cancelled"].includes(j.meta.status)) {
      updateStatusZone();
    }
  }, 1000);

  setInterval(() => {
    document.querySelectorAll("[data-run-start]").forEach((el) => {
      const ms = Date.now() - Number(el.dataset.runStart);
      el.textContent = (ms / 1000).toFixed(1) + "s";
    });
  }, 200);

  jobsBtn.addEventListener("click", () => {
    jobsPop.hidden = !jobsPop.hidden;
    jobsBtn.setAttribute("aria-expanded", String(!jobsPop.hidden));
    if (!jobsPop.hidden) renderJobList();
  });
  document.addEventListener("click", (e) => {
    if (!jobsPop.hidden && !jobsPop.contains(e.target) && e.target !== jobsBtn) {
      jobsPop.hidden = true;
      jobsBtn.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !jobsPop.hidden) {
      jobsPop.hidden = true;
      jobsBtn.setAttribute("aria-expanded", "false");
      jobsBtn.focus();
    }
  });

  setFavicon(null);
  connectSSE();
  pollJobs();
  setInterval(pollJobs, 2000);
  renderAll();
  updateStatusZone();
}
