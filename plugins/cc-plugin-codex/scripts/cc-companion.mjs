#!/usr/bin/env node

/**
 * Claude Code Companion — MCP Server for Codex
 *
 * Implements the MCP stdio protocol (2025-03-26) with 6 tools:
 * - cc_delegate:    Delegate a coding task to Claude Code
 * - cc_list_models: List available Claude models
 * - cc_check:       Check job status/results
 * - cc_cancel:      Cancel a running job
 * - cc_review:      Review Claude Code output
 * - cc_setup:       Check environment readiness
 *
 * v0.2 improvements (mirroring codex-plugin-cc):
 * - Per-job log files (human-readable [timestamp] message format)
 * - Phase tracking (starting→executing→reviewing→editing→verifying→finalizing→completed)
 * - Phase inference from log content
 * - Rich git integration (resolveReviewTarget, collectReviewContext, staged/unstaged/untracked)
 * - Structured adversarial review prompt (XML template with attack_surface, finding_bar, grounding_rules, calibration_rules, final_check)
 * - Review output schema (verdict/summary/findings/next_steps, matching codex-plugin-cc format)
 * - Session scoping for jobs
 * - Job ID prefix matching
 * - Resume capability (--resume-last, --resume <sessionId>)
 */

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { runClaudeSync, runClaudeDetached, getClaudeAvailability, getKnownModels } from "./lib/claude-runner.mjs";
import { generateJobId, upsertJob, listJobs } from "./lib/state.mjs";
import { binaryAvailable, terminateProcessTree } from "./lib/process.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import { appendLogLine, appendLogBlock, createJobLogFile, readLogTail, isValidTransition, phaseDescription, inferPhaseFromLog } from "./lib/job-log.mjs";
import {
  detectDefaultBranch, getChangedFiles,
  resolveReviewTarget, collectReviewContext
} from "./lib/git.mjs";

// ─── MCP Protocol ───────────────────────────────────────────────────────────

const PROTOCOL_VERSION = "2025-03-26";

function sendMessage(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

function sendResponse(id, result) {
  sendMessage({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  sendMessage({ jsonrpc: "2.0", id, error: { code, message } });
}

function logError(msg) {
  process.stderr.write(`${msg}\n`);
}

// ─── Session ID ──────────────────────────────────────────────────────────────

const SESSION_ID = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

// ─── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "cc_delegate",
    description: "Delegate a coding task to Claude Code. Claude Code executes in a separate process and returns results automatically. By default runs in foreground (waits for completion). Set background=true to return immediately with a job ID. Use resume=true to continue the last Claude Code session, or resumeSession=<id> to resume a specific session.",
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "The coding task to delegate to Claude Code" },
        write: { type: "boolean", description: "Allow Claude Code to write files (default: true)" },
        background: { type: "boolean", description: "Run in background, return job ID immediately (default: false)" },
        model: { type: "string", description: "Claude model alias: fable, opus, sonnet, haiku", enum: ["fable", "opus", "sonnet", "haiku"] },
        effort: { type: "string", description: "Reasoning effort level", enum: ["low", "medium", "high", "xhigh", "max"] },
        dangerouslySkipPermissions: { type: "boolean", description: "Skip permission prompts (default: false, set true to allow Claude Code to write without confirmation)" },
        resume: { type: "boolean", description: "Resume the last Claude Code session (adds --resume-last flag)" },
        resumeSession: { type: "string", description: "Resume a specific Claude Code session by session ID (adds --resume <id> flag)" }
      },
      required: ["task"]
    }
  },
  {
    name: "cc_list_models",
    description: "List available Claude models with recommended effort levels. Use this to pick the right model and effort for a task before calling cc_delegate.",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "cc_check",
    description: "Check job status or get results. Without arguments, returns the latest job. Pass a job ID (or prefix) for details. Set all=true to list all jobs. Set wait=true to wait for a running job to complete. Set session=true to filter by current session.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Job ID or prefix to check (default: latest job)" },
        all: { type: "boolean", description: "List all jobs (default: false)" },
        wait: { type: "boolean", description: "Wait for job completion if still running (default: false)" },
        session: { type: "boolean", description: "Filter to current session's jobs (default: false)" }
      }
    }
  },
  {
    name: "cc_cancel",
    description: "Cancel a running Claude Code job. Without arguments, cancels the latest active job. Accepts job ID prefix.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Job ID or prefix to cancel (default: latest active job)" }
      }
    }
  },
  {
    name: "cc_review",
    description: "Review code changes made by a Claude Code job. Returns the diff and a structured review prompt for Codex to execute. Set adversarial=true to challenge implementation choices with a structured XML template. Auto-detects review scope (working-tree vs branch). Returns findings in a structured schema with verdict, severity-ranked findings, and next steps.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string", description: "Job ID or prefix to review (default: latest completed job)" },
        adversarial: { type: "boolean", description: "Adversarial review mode: challenge implementation choices and assumptions (default: false)" },
        focus: { type: "string", description: "Aspect to focus the review on (e.g., security, performance, correctness)" },
        base: { type: "string", description: "Git base ref for diff comparison (default: auto-detect)" },
        scope: { type: "string", description: "Review scope: auto, working-tree, or branch (default: auto)", enum: ["auto", "working-tree", "branch"] }
      }
    }
  },
  {
    name: "cc_setup",
    description: "Check if Claude Code is installed and ready to use. Reports version, availability, and any issues.",
    inputSchema: { type: "object", properties: {} }
  }
];

// ─── Job Lookup with Prefix Matching ─────────────────────────────────────────

/**
 * Update job with phase transition validation.
 * Wraps upsertJob to log invalid phase transitions.
 */
function updateJob(workspaceRoot, patch) {
  if (patch.phase && patch.id) {
    const jobs = listJobs(workspaceRoot);
    const existing = jobs.find((j) => j.id === patch.id);
    if (existing?.phase && !isValidTransition(existing.phase, patch.phase)) {
      logError(`Invalid phase transition: ${existing.phase} → ${patch.phase} for job ${patch.id}`);
    }
  }
  return upsertJob(workspaceRoot, patch);
}

function findJob(jobs, idOrPrefix) {
  if (!idOrPrefix) return null;
  const exact = jobs.find((j) => j.id === idOrPrefix);
  if (exact) return exact;
  const matches = jobs.filter((j) => j.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new Error(`Ambiguous prefix "${idOrPrefix}" matches ${matches.length} jobs: ${matches.map((j) => j.id).join(", ")}`);
  }
  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getCwd(params) {
  return params._cwd || process.cwd();
}

function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

function findLatestJob(jobs, predicate = () => true) {
  return sortJobsNewestFirst(jobs).find(predicate) || null;
}

function findLatestActiveJob(jobs) {
  return findLatestJob(jobs, (j) => j.status === "running" || j.status === "queued");
}

function findLatestCompletedJob(jobs) {
  return findLatestJob(jobs, (j) => j.status === "completed");
}

function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCost(usd) {
  if (usd == null || !Number.isFinite(usd)) return "—";
  return `$${usd.toFixed(4)}`;
}

function formatElapsedDuration(startIso, endIso = null) {
  const start = Date.parse(startIso ?? "");
  if (!Number.isFinite(start)) return null;
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(end) || end < start) return null;
  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// ─── Tool Handlers ──────────────────────────────────────────────────────────

// cc_delegate
function handleDelegate(params) {
  const task = params.task;
  if (!task || !task.trim()) {
    return { content: [{ type: "text", text: "Error: task is required." }], isError: true };
  }

  const cwd = getCwd(params);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const write = params.write !== false;
  const background = params.background === true;
  const model = params.model || null;
  const effort = params.effort || null;
  const skipPerms = params.dangerouslySkipPermissions === true;
  const resume = params.resume === true;
  const resumeSession = params.resumeSession || null;

  const jobId = generateJobId("cc");
  const now = new Date().toISOString();
  const taskTitle = resume ? "Claude Code Resume" : "Claude Code Task";

  // Create log file
  const logFile = createJobLogFile(workspaceRoot, jobId, taskTitle);

  // Create job record
  const job = {
    id: jobId,
    status: "running",
    phase: "starting",
    task: task.trim(),
    model,
    effort,
    write,
    dangerouslySkipPermissions: skipPerms,
    background,
    resume,
    resumeSession,
    sessionId: SESSION_ID,
    pid: null,
    logFile,
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    completedAt: null,
    result: null,
    cost: null,
    duration: null,
    touchedFiles: [],
    errorMessage: null
  };

  updateJob(workspaceRoot, job);

  if (background) {
    appendLogLine(workspaceRoot, jobId, "Spawned background process.");
    updateJob(workspaceRoot, { id: jobId, phase: "executing" });

    // Set up result file for background completion
    const resultFile = path.join(path.dirname(logFile), `${jobId}.result.json`);

    const child = runClaudeDetached(task, {
      cwd: workspaceRoot, write, model, effort,
      dangerouslySkipPermissions: skipPerms, resume, resumeSession,
      resultFile
    });
    updateJob(workspaceRoot, { id: jobId, pid: child.pid, resultFile });

    // Watch for background process completion
    child.on("error", (err) => {
      const completedAt = new Date().toISOString();
      updateJob(workspaceRoot, {
        id: jobId, status: "failed", phase: "failed", pid: null, completedAt,
        errorMessage: `Failed to start claude: ${err.message}`
      });
      appendLogLine(workspaceRoot, jobId, `Spawn error: ${err.message}`);
    });

    child.on("exit", (code) => {
      const completedAt = new Date().toISOString();
      if (code === 0 && fs.existsSync(resultFile)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(resultFile, "utf8"));
          updateJob(workspaceRoot, {
            id: jobId, status: "completed", phase: "completed", pid: null, completedAt,
            result: parsed.result || "",
            cost: parsed.total_cost_usd || 0,
            duration: parsed.duration_ms ? parsed.duration_ms / 1000 : null,
            model: (parsed.modelUsage && Object.keys(parsed.modelUsage).length > 0) ? Object.keys(parsed.modelUsage)[0] : model,
            sessionId: parsed.session_id || null,
            errorMessage: null
          });
          appendLogLine(workspaceRoot, jobId, "Background task completed.");
        } catch {
          updateJob(workspaceRoot, { id: jobId, status: "failed", phase: "failed", pid: null, completedAt, errorMessage: "Background task output was not parseable" });
          appendLogLine(workspaceRoot, jobId, "Background task completed (output not parseable).");
        }
      } else {
        updateJob(workspaceRoot, {
          id: jobId, status: "failed", phase: "failed", pid: null, completedAt,
          errorMessage: `Background process exited with code ${code}`
        });
        appendLogLine(workspaceRoot, jobId, `Background task failed with exit code ${code}.`);
      }
    });

    return {
      content: [{
        type: "text",
        text: `Task started in background.\n\n**Job ID:** ${jobId}\n**Status:** running\n**Phase:** executing\n**Model:** ${model || "default"}\n**Effort:** ${effort || "default"}\n\nCheck status with \`cc_check\` or use \`cc_check --wait\` to wait for completion.`
      }]
    };
  }

  // Foreground mode
  appendLogLine(workspaceRoot, jobId, "Running claude -p synchronously.");
  updateJob(workspaceRoot, { id: jobId, phase: "executing" });

  const result = runClaudeSync(task, {
    cwd: workspaceRoot, write, model, effort,
    dangerouslySkipPermissions: skipPerms, resume, resumeSession
  });

  const completedAt = new Date().toISOString();

  if (result.ok) {
    updateJob(workspaceRoot, { id: jobId, phase: "verifying" });
    appendLogLine(workspaceRoot, jobId, "Execution complete, verifying output.");

    let touchedFiles = [];
    try {
      touchedFiles = getChangedFiles(workspaceRoot);
    } catch { /* ignore */ }

    updateJob(workspaceRoot, { id: jobId, phase: "finalizing" });
    appendLogLine(workspaceRoot, jobId, `Touched ${touchedFiles.length} files.`);

    updateJob(workspaceRoot, {
      id: jobId,
      status: "completed",
      phase: "completed",
      pid: null,
      completedAt,
      result: result.result,
      cost: result.cost,
      duration: result.duration,
      model: result.model || model,
      sessionId: result.sessionId || null,
      touchedFiles,
      errorMessage: null
    });

    appendLogBlock(workspaceRoot, jobId, "Final output", result.result);
    appendLogLine(workspaceRoot, jobId, `Done. Cost: ${formatCost(result.cost)}, Duration: ${formatDuration(result.duration ? result.duration * 1000 : null)}.`);

    const filesSection = touchedFiles.length > 0
      ? `### Files Changed\n${touchedFiles.map((f) => `- ${f}`).join("\n")}`
      : "";

    return {
      content: [{
        type: "text",
        text: `## Task Completed\n\n**Job ID:** ${jobId}\n**Duration:** ${formatDuration(result.duration ? result.duration * 1000 : null)}\n**Cost:** ${formatCost(result.cost)}\n**Model:** ${result.model || model || "default"}\n\n### Result\n${result.result}\n\n${filesSection}\n\n---\n💡 Run \`/claude:review\` to review the changes, or \`/claude:review --adversarial\` for an adversarial review.`
      }]
    };
  } else {
    updateJob(workspaceRoot, {
      id: jobId,
      status: "failed",
      phase: "failed",
      pid: null,
      completedAt,
      errorMessage: result.error
    });
    appendLogLine(workspaceRoot, jobId, `Failed: ${result.error}`);

    return {
      content: [{
        type: "text",
        text: `## Task Failed\n\n**Job ID:** ${jobId}\n**Error:** ${result.error}\n\nCheck \`/claude:status\` for details.`
      }],
      isError: true
    };
  }
}

// cc_list_models
function handleListModels() {
  const models = getKnownModels();
  const table = [
    "| Alias | Full Model ID | Best For | Recommended Effort |",
    "|-------|---------------|----------|--------------------|",
    ...models.map((m) => `| ${m.alias} | ${m.fullId} | ${m.bestFor} | ${m.recommendedEfforts.join(", ")} |`)
  ].join("\n");
  const guide = [
    "### Selection Guide",
    "- **Simple bug fix / typo**: haiku + low",
    "- **Feature implementation**: sonnet + medium",
    "- **Complex refactor / architecture**: opus + high",
    "- **Multi-file redesign / critical path**: fable + xhigh"
  ].join("\n");
  return {
    content: [{ type: "text", text: `## Available Claude Models\n\n${table}\n\n${guide}` }]
  };
}

// cc_check
function handleCheck(params) {
  const cwd = getCwd(params);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let jobs = listJobs(workspaceRoot);

  if (params.session === true) {
    jobs = jobs.filter((j) => j.sessionId === SESSION_ID);
  }

  if (params.all === true) {
    if (jobs.length === 0) {
      return { content: [{ type: "text", text: "No jobs found." }] };
    }
    const sorted = sortJobsNewestFirst(jobs);
    const table = [
      "| Job ID | Status | Phase | Task | Model | Duration |",
      "|--------|--------|-------|------|-------|----------|",
      ...sorted.map((j) => {
        const taskShort = (j.task || "").length > 30 ? j.task.slice(0, 27) + "..." : (j.task || "");
        return `| ${j.id} | ${j.status} | ${j.phase || "—"} | ${taskShort} | ${j.model || "—"} | ${formatDuration(j.duration ? j.duration * 1000 : null)} |`;
      })
    ].join("\n");
    return { content: [{ type: "text", text: `## All Jobs${params.session ? " (current session)" : ""}\n\n${table}` }] };
  }

  const jobIdOrPrefix = params.job;
  let job;
  if (jobIdOrPrefix) {
    try {
      job = findJob(jobs, jobIdOrPrefix);
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    if (!job) {
      return { content: [{ type: "text", text: `Job "${jobIdOrPrefix}" not found.` }], isError: true };
    }
  } else {
    job = findLatestJob(jobs);
    if (!job) {
      return { content: [{ type: "text", text: "No jobs found." }] };
    }
  }

  // If wait=true and job is still running, poll until complete
  if (params.wait === true && (job.status === "running" || job.status === "queued")) {
    const deadline = Date.now() + 4 * 60 * 1000;
    while (Date.now() < deadline) {
      const freshJobs = listJobs(workspaceRoot);
      const fresh = freshJobs.find((j) => j.id === job.id);
      if (!fresh || (fresh.status !== "running" && fresh.status !== "queued")) {
        job = fresh;
        break;
      }
      // Cross-platform sleep (no `sleep` command on Windows)
      try {
        const buf = new Int32Array(new SharedArrayBuffer(4));
        Atomics.wait(buf, 0, 0, 2000);
      } catch {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) { /* busy-wait */ }
      }
    }
    if (job && (job.status === "running" || job.status === "queued")) {
      return { content: [{ type: "text", text: `Job ${job.id} is still running after 4 minutes. Use \`cc_check\` to check again later.` }] };
    }
  }

  const resultSection = job.result ? `### Result\n${job.result}` : "";
  const filesSection = (job.touchedFiles && job.touchedFiles.length > 0)
    ? `### Files Changed\n${job.touchedFiles.map((f) => `- ${f}`).join("\n")}`
    : "";

  // Progress preview from log (matches codex-plugin-cc's readJobProgressPreview)
  const progressPreview = readLogTail(workspaceRoot, job.id, 4);
  const progressSection = progressPreview.length > 0
    ? `### Progress\n${progressPreview.map((l) => `- ${l}`).join("\n")}`
    : "";

  // Elapsed time for running jobs
  const elapsed = (job.status === "running" || job.status === "queued")
    ? formatElapsedDuration(job.startedAt ?? job.createdAt)
    : null;
  const elapsedSection = elapsed ? `**Elapsed:** ${elapsed}\n` : "";

  // Phase: use explicit phase or infer from log
  const phase = job.phase || inferPhaseFromLog(readLogTail(workspaceRoot, job.id, 20));

  return {
    content: [{
      type: "text",
      text: `## Job: ${job.id}\n\n**Status:** ${job.status}\n**Phase:** ${phase} (${phaseDescription(phase)})\n**Task:** ${job.task || "—"}\n**Model:** ${job.model || "—"}\n**Effort:** ${job.effort || "—"}\n**Duration:** ${formatDuration(job.duration ? job.duration * 1000 : null)}\n**Cost:** ${formatCost(job.cost)}\n**Session:** ${job.sessionId || "—"}\n${elapsedSection}**Started:** ${job.startedAt || job.createdAt || "—"}\n**Completed:** ${job.completedAt || "—"}\n\n${resultSection}\n\n${filesSection}\n\n${progressSection}`
    }]
  };
}

// cc_cancel
function handleCancel(params) {
  const cwd = getCwd(params);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);

  const jobIdOrPrefix = params.job;
  let job;
  if (jobIdOrPrefix) {
    try {
      job = findJob(jobs, jobIdOrPrefix);
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    if (!job) {
      return { content: [{ type: "text", text: `Job "${jobIdOrPrefix}" not found.` }], isError: true };
    }
  } else {
    job = findLatestActiveJob(jobs);
    if (!job) {
      return { content: [{ type: "text", text: "No active job found to cancel." }] };
    }
  }

  if (job.status !== "running" && job.status !== "queued") {
    return { content: [{ type: "text", text: `Job ${job.id} is not running (status: ${job.status}). Cannot cancel.` }] };
  }

  if (job.pid) {
    terminateProcessTree(job.pid);
  }

  const now = new Date().toISOString();
  appendLogLine(workspaceRoot, job.id, "Cancelled by user.");
  updateJob(workspaceRoot, {
    id: job.id,
    status: "cancelled",
    phase: "cancelled",
    pid: null,
    completedAt: now,
    errorMessage: "Cancelled by user."
  });

  return {
    content: [{
      type: "text",
      text: `Job ${job.id} cancelled.`
    }]
  };
}

// ─── Review Prompts ─────────────────────────────────────────────────────────

function buildStandardReviewPrompt(focus) {
  return `You are reviewing code changes made by Claude Code. Produce a structured review.

<review_schema>
{
  "verdict": "approve" | "request_changes",
  "summary": "terse ship/no-ship assessment",
  "findings": [{ "severity": "critical|high|medium|low", "title": "...", "body": "...", "file": "...", "line_start": N, "line_end": N, "confidence": 0.8, "recommendation": "..." }],
  "next_steps": ["step 1", "step 2"]
}
</review_schema>

<review_criteria>
1. **Correctness**: Does the code do what it's supposed to? Are there logic errors?
2. **Style**: Does it follow project conventions? Naming, formatting, structure?
3. **Bugs**: Edge cases, error handling, null/undefined checks, off-by-one errors
4. **Security**: Injection, auth bypass, unsafe deserialization, exposed secrets
5. **Performance**: N+1 queries, unnecessary allocations, missing caching
6. **Maintainability**: Magic numbers, unclear abstractions, missing tests
</review_criteria>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer: What can go wrong? Why is this code path vulnerable? What is the likely impact? What concrete change would fix it?
</finding_bar>

<focus>${focus || "general"}</focus>

<output_format>
Return only valid JSON matching the review_schema. Order findings by severity (critical first). Be specific with file paths and line numbers. Every finding must have a concrete recommendation.
</output_format>`;
}

function buildAdversarialReviewPrompt(focus, collectionGuidance) {
  return `<role>
You are Codex performing an adversarial software review.
Your job is to break confidence in the change, not to validate it.
</role>

<task>
Review the provided repository context as if you are trying to find the strongest reasons this change should not ship yet.
User focus: ${focus || "No extra focus provided."}
</task>

<operating_stance>
Default to skepticism.
Assume the change can fail in subtle, high-cost, or user-visible ways until the evidence says otherwise.
Do not give credit for good intent, partial fixes, or likely follow-up work.
If something only works on the happy path, treat that as a real weakness.
</operating_stance>

<attack_surface>
Prioritize the kinds of failures that are expensive, dangerous, or hard to detect:
- auth, permissions, tenant isolation, and trust boundaries
- data loss, corruption, duplication, and irreversible state changes
- rollback safety, retries, partial failure, and idempotency gaps
- race conditions, ordering assumptions, stale state, and re-entrancy
- empty-state, null, timeout, and degraded dependency behavior
- version skew, schema drift, migration hazards, and compatibility regressions
- observability gaps that would hide failure or make recovery harder
</attack_surface>

<review_method>
Actively try to disprove the change.
Look for violated invariants, missing guards, unhandled failure paths, and assumptions that stop being true under stress.
Trace how bad inputs, retries, concurrent actions, or partially completed operations move through the code.
If the user supplied a focus area, weight it heavily, but still report any other material issue you can defend.
${collectionGuidance || "Use the repository context below as primary evidence."}
</review_method>

<finding_bar>
Report only material findings.
Do not include style feedback, naming feedback, low-value cleanup, or speculative concerns without evidence.
A finding should answer:
1. What can go wrong?
2. Why is this code path vulnerable?
3. What is the likely impact?
4. What concrete change would reduce the risk?
</finding_bar>

<structured_output_contract>
Return only valid JSON matching the provided schema.
Keep the output compact and specific.
Use \`needs-attention\` if there is any material risk worth blocking on.
Use \`approve\` only if you cannot support any substantive adversarial finding from the provided context.
Every finding must include:
- the affected file
- \`line_start\` and \`line_end\`
- a confidence score from 0 to 1
- a concrete recommendation
Write the summary like a terse ship/no-ship assessment, not a neutral recap.
</structured_output_contract>

<grounding_rules>
Be aggressive, but stay grounded.
Every finding must be defensible from the provided repository context or tool outputs.
Do not invent files, lines, code paths, incidents, attack chains, or runtime behavior you cannot support.
If a conclusion depends on an inference, state that explicitly in the finding body and keep the confidence honest.
</grounding_rules>

<calibration_rules>
Prefer one strong finding over several weak ones.
Do not dilute serious issues with filler.
If the change looks safe, say so directly and return no findings.
</calibration_rules>

<final_check>
Before finalizing, check that each finding is:
- adversarial rather than stylistic
- tied to a concrete code location
- plausible under a real failure scenario
- actionable for an engineer fixing the issue
</final_check>`;
}

// cc_review
function handleReview(params) {
  const cwd = getCwd(params);
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = listJobs(workspaceRoot);

  const jobIdOrPrefix = params.job;
  let job;
  if (jobIdOrPrefix) {
    try {
      job = findJob(jobs, jobIdOrPrefix);
    } catch (err) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    if (!job) {
      return { content: [{ type: "text", text: `Job "${jobIdOrPrefix}" not found.` }], isError: true };
    }
  } else {
    job = findLatestCompletedJob(jobs);
    if (!job) {
      return { content: [{ type: "text", text: "No completed job found to review." }] };
    }
  }

  const adversarial = params.adversarial === true;
  const focus = params.focus || null;

  // Resolve review target (auto/working-tree/branch)
  let target;
  try {
    target = resolveReviewTarget(workspaceRoot, {
      base: params.base,
      scope: params.scope
    });
  } catch (err) {
    return { content: [{ type: "text", text: `Review target error: ${err.message}` }], isError: true };
  }

  // Collect full review context (diff, git status, untracked files, commit log)
  let context;
  try {
    context = collectReviewContext(workspaceRoot, target);
  } catch (err) {
    return { content: [{ type: "text", text: `Failed to collect review context: ${err.message}` }], isError: true };
  }

  // Build review prompt
  const reviewPrompt = adversarial
    ? buildAdversarialReviewPrompt(focus, context.collectionGuidance)
    : buildStandardReviewPrompt(focus);

  // Schema reference matching codex-plugin-cc format
  const schemaRef = `### Review Output Schema\nProduce your review as JSON matching this schema:\n\`\`\`json\n${JSON.stringify({
    verdict: "approve|needs-attention",
    summary: "terse ship/no-ship assessment",
    findings: [{ severity: "critical|high|medium|low", title: "...", body: "...", file: "...", line_start: 1, line_end: 1, confidence: 0.8, recommendation: "..." }],
    next_steps: ["step 1", "step 2"]
  }, null, 2)}\n\`\`\``;

  return {
    content: [{
      type: "text",
      text: `## Review: Job ${job.id}\n\n**Task:** ${job.task || "—"}\n**Model:** ${job.model || "—"}\n**Review Mode:** ${adversarial ? "Adversarial" : "Standard"}\n**Target:** ${target.label}\n**Files:** ${context.fileCount}\n**Diff Size:** ${context.diffBytes} bytes\n**Input Mode:** ${context.inputMode}\n\n### Review Instructions\n${reviewPrompt}\n\n<repository_context>\n${context.content}\n</repository_context>\n\n${schemaRef}`
    }]
  };
}

// cc_setup
function handleSetup() {
  const cwd = process.cwd();
  const claudeStatus = getClaudeAvailability(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });

  const lines = ["## Claude Code Companion Setup\n"];

  if (claudeStatus.available) {
    lines.push(`✅ Claude Code: ${claudeStatus.detail}`);
  } else {
    lines.push(`❌ Claude Code: ${claudeStatus.detail}`);
  }

  if (nodeStatus.available) {
    lines.push(`✅ Node.js: ${nodeStatus.detail}`);
  } else {
    lines.push(`❌ Node.js: ${nodeStatus.detail}`);
  }

  const gitStatus = binaryAvailable("git", ["--version"], { cwd });
  if (gitStatus.available) {
    lines.push(`✅ Git: ${gitStatus.detail}`);
  } else {
    lines.push(`⚠️ Git: not found (review features need git)`);
  }

  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let defaultBranch = "HEAD~1";
  try {
    defaultBranch = detectDefaultBranch(workspaceRoot);
  } catch { /* not a git repo */ }

  lines.push(`\n**Workspace:** ${workspaceRoot}`);
  lines.push(`**Default branch:** ${defaultBranch}`);
  lines.push(`**Session ID:** ${SESSION_ID}`);

  if (claudeStatus.available && nodeStatus.available) {
    lines.push("\n✅ Plugin ready\n");
    lines.push("No issues found. Use `/claude:delegate` to start delegating tasks.");
  } else {
    lines.push("\n❌ Setup incomplete");
    if (!claudeStatus.available) {
      lines.push("Install Claude Code: `npm install -g @anthropic-ai/claude-code`");
    }
    if (!nodeStatus.available) {
      lines.push("Install Node.js: https://nodejs.org/");
    }
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }]
  };
}

// ─── Tool Router ────────────────────────────────────────────────────────────

const HANDLERS = {
  cc_delegate: handleDelegate,
  cc_list_models: handleListModels,
  cc_check: handleCheck,
  cc_cancel: handleCancel,
  cc_review: handleReview,
  cc_setup: handleSetup
};

// ─── JSON-RPC Message Handling ──────────────────────────────────────────────

function handleMessage(msg) {
  if (msg.id !== undefined && !msg.method) return;

  if (msg.method && msg.id === undefined) {
    if (msg.method === "notifications/initialized") { /* ready */ }
    return;
  }

  if (msg.method && msg.id !== undefined) {
    switch (msg.method) {
      case "initialize": {
        sendResponse(msg.id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "claude-code-companion", version: "0.2.0" },
          instructions: "Claude Code Companion: delegate coding tasks to Claude Code from Codex. Supports job logs, phase tracking, adversarial review, session scoping, prefix matching, and resume."
        });
        break;
      }
      case "tools/list": {
        sendResponse(msg.id, { tools: TOOLS });
        break;
      }
      case "tools/call": {
        if (!msg.params || typeof msg.params !== "object") {
          sendError(msg.id, -32602, "Invalid params: expected object");
          break;
        }
        const toolName = msg.params.name;
        const toolArgs = (msg.params.arguments && typeof msg.params.arguments === "object") ? msg.params.arguments : {};
        const handler = HANDLERS[toolName];
        if (!handler) {
          sendError(msg.id, -32601, `Unknown tool: ${toolName}`);
          break;
        }
        try {
          const result = handler(toolArgs);
          sendResponse(msg.id, result);
        } catch (err) {
          sendResponse(msg.id, {
            content: [{ type: "text", text: `Error: ${err.message || String(err)}` }],
            isError: true
          });
        }
        break;
      }
      case "ping": {
        sendResponse(msg.id, {});
        break;
      }
      default: {
        sendError(msg.id, -32601, `Method not found: ${msg.method}`);
        break;
      }
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const rl = readline.createInterface({ input: process.stdin });

  rl.on("line", (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      handleMessage(msg);
    } catch (err) {
      logError(`Failed to parse JSON-RPC message: ${err.message}`);
    }
  });

  rl.on("close", () => {
    process.exit(0);
  });
}

main();
