import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Git integration for review.
 *
 * Mirrors codex-plugin-cc's git.mjs with:
 * - Default branch detection (remote HEAD → local HEAD → candidates)
 * - Working tree state (staged/unstaged/untracked, isDirty)
 * - Diff collection with size measurement and auto-scope
 * - Untracked file content collection (with binary/text detection)
 * - Merge-base for feature branch reviews
 * - Commit log for branch reviews
 * - Review scope resolution (auto/working-tree/branch)
 */

const MAX_UNTRACKED_BYTES = 24 * 1024;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function git(cwd, args, options = {}) {
  return spawnSync("git", args, {
    cwd,
    env: process.env,
    encoding: "utf8",
    timeout: options.timeout || 10000,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    stdio: "pipe"
  });
}

function gitOk(cwd, args, options = {}) {
  const result = git(cwd, args, options);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed (exit ${result.status}): ${(result.stderr || "").trim()}`);
  }
  return result.stdout.trim();
}

/**
 * Check if a buffer is probably text (not binary).
 */
function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) return false;
  }
  return true;
}

// ─── Branch Detection ────────────────────────────────────────────────────────

/**
 * Detect the default branch name (main, master, trunk, or fallback).
 */
export function detectDefaultBranch(cwd) {
  // Try remote HEAD first (same as codex-plugin-cc)
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"], { timeout: 5000 });
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  // Try show-ref for candidates (same as codex-plugin-cc)
  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    // Check local ref
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`], { timeout: 3000 });
    if (local.status === 0) return candidate;
    // Check remote ref
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`], { timeout: 3000 });
    if (remote.status === 0) return `origin/${candidate}`;
  }

  // Fallback
  return "HEAD~1";
}

/**
 * Get current branch name.
 */
export function getCurrentBranch(cwd) {
  try {
    return gitOk(cwd, ["branch", "--show-current"], { timeout: 3000 }) || "HEAD";
  } catch {
    return "HEAD";
  }
}

// ─── Working Tree State ──────────────────────────────────────────────────────

/**
 * Get working tree state with staged/unstaged/untracked separation.
 * Matches codex-plugin-cc's getWorkingTreeState.
 */
export function getWorkingTreeState(cwd) {
  try {
    const staged = gitOk(cwd, ["diff", "--cached", "--name-only"], { timeout: 5000 }).split("\n").filter(Boolean);
    const unstaged = gitOk(cwd, ["diff", "--name-only"], { timeout: 5000 }).split("\n").filter(Boolean);
    const untracked = gitOk(cwd, ["ls-files", "--others", "--exclude-standard"], { timeout: 5000 }).split("\n").filter(Boolean);

    return {
      staged,
      unstaged,
      untracked,
      isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0,
      totalChanges: staged.length + unstaged.length + untracked.length
    };
  } catch (err) {
    return { staged: [], unstaged: [], untracked: [], isDirty: false, totalChanges: 0, error: err.message };
  }
}

// ─── Review Scope ────────────────────────────────────────────────────────────

/**
 * Resolve what to review: working-tree diff or branch diff.
 * Matches codex-plugin-cc's resolveReviewTarget.
 */
export function resolveReviewTarget(cwd, options = {}) {
  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  // Prevent git flag injection: base ref must not start with '-'
  if (baseRef && baseRef.startsWith("-")) {
    throw new Error(`Invalid base ref "${baseRef}": must not start with '-'`);
  }

  if (baseRef) {
    return { mode: "branch", label: `branch diff against ${baseRef}`, baseRef, explicit: true };
  }

  if (requestedScope === "working-tree") {
    return { mode: "working-tree", label: "working tree diff", explicit: true };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(`Unsupported review scope "${requestedScope}". Use: auto, working-tree, branch, or pass base.`);
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return { mode: "branch", label: `branch diff against ${detectedBase}`, baseRef: detectedBase, explicit: true };
  }

  // auto: if dirty, review working tree; otherwise review branch
  if (state.isDirty) {
    return { mode: "working-tree", label: "working tree diff", explicit: false };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return { mode: "branch", label: `branch diff against ${detectedBase}`, baseRef: detectedBase, explicit: false };
}

// ─── Diff Collection ─────────────────────────────────────────────────────────

/**
 * Measure the byte size of a git diff output.
 */
function measureDiffBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (result.error && (result.error.code === "ENOBUFS" || result.error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")) return maxBytes + 1;
  if (result.error || result.status !== 0) return 0;
  return Buffer.byteLength(result.stdout, "utf8");
}

/**
 * Get diff with size measurement. Returns diff content and metadata.
 */
export function getDiff(cwd, base = "HEAD~1", options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_INLINE_DIFF_MAX_BYTES;

  try {
    const statResult = git(cwd, ["diff", "--stat", base], { timeout: 10000 });
    const diffResult = git(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", base], { timeout: 30000 });

    if (diffResult.status !== 0) {
      return { ok: false, error: "git diff failed", diff: "", stat: "" };
    }

    const diff = diffResult.stdout;
    const stat = statResult.status === 0 ? statResult.stdout : "";
    const bytes = Buffer.byteLength(diff, "utf8");
    const truncated = bytes > maxBytes;

    return {
      ok: true,
      diff: truncated ? diff.slice(0, maxBytes) + `\n\n... (diff truncated, original size: ${bytes} bytes)` : diff,
      stat,
      bytes,
      truncated,
      lineCount: diff.split("\n").length
    };
  } catch (err) {
    return { ok: false, error: err.message, diff: "", stat: "" };
  }
}

/**
 * Get list of changed files between base and HEAD.
 */
export function getChangedFiles(cwd, base = "HEAD~1") {
  try {
    return gitOk(cwd, ["diff", "--name-only", base], { timeout: 5000 }).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

// ─── Working Tree Context ────────────────────────────────────────────────────

/**
 * Format an untracked file for review context.
 * Reads file content if text and under size limit.
 */
function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let lstat;
  try {
    lstat = fs.lstatSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: broken symlink or unreadable file)`;
  }
  if (lstat.isSymbolicLink()) {
    return `### ${relativePath}\n(skipped: symbolic link)`;
  }
  if (lstat.isDirectory()) {
    return `### ${relativePath}\n(skipped: directory)`;
  }
  if (lstat.size > MAX_UNTRACKED_BYTES) {
    return `### ${relativePath}\n(skipped: ${lstat.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(absolutePath);
  } catch {
    return `### ${relativePath}\n(skipped: unreadable file)`;
  }
  if (!isProbablyText(buffer)) {
    return `### ${relativePath}\n(skipped: binary file)`;
  }

  return `### ${relativePath}\n\`\`\`\n${buffer.toString("utf8").trimEnd()}\n\`\`\``;
}

/**
 * Collect full working tree context for review.
 * Matches codex-plugin-cc's collectWorkingTreeContext.
 */
export function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitOk(cwd, ["status", "--short", "--untracked-files=all"]);
  const changedFiles = [...new Set([...state.staged, ...state.unstaged, ...state.untracked])].sort();

  const parts = [];

  parts.push(`## Git Status\n\n${status || "(none)"}\n`);

  if (includeDiff) {
    const stagedDiff = gitOk(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]);
    const unstagedDiff = gitOk(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]);
    const untrackedBody = state.untracked.map((f) => formatUntrackedFile(cwd, f)).join("\n\n");

    parts.push(`## Staged Diff\n\n${stagedDiff || "(none)"}\n`);
    parts.push(`## Unstaged Diff\n\n${unstagedDiff || "(none)"}\n`);
    if (untrackedBody) {
      parts.push(`## Untracked Files\n\n${untrackedBody}\n`);
    }
  } else {
    const stagedStat = git(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = git(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = state.untracked.map((f) => formatUntrackedFile(cwd, f)).join("\n\n");

    parts.push(`## Staged Diff Stat\n\n${stagedStat || "(none)"}\n`);
    parts.push(`## Unstaged Diff Stat\n\n${unstagedStat || "(none)"}\n`);
    parts.push(`## Changed Files\n\n${changedFiles.join("\n") || "(none)"}\n`);
    if (untrackedBody) {
      parts.push(`## Untracked Files\n\n${untrackedBody}\n`);
    }
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

/**
 * Collect branch context for review.
 * Matches codex-plugin-cc's collectBranchContext.
 */
export function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const mergeBase = gitOk(cwd, ["merge-base", "HEAD", baseRef]);
  const commitRange = `${mergeBase}..HEAD`;
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitOk(cwd, ["diff", "--name-only", commitRange]).split("\n").filter(Boolean);
  const logOutput = gitOk(cwd, ["log", "--oneline", "--decorate", commitRange]);
  const diffStat = gitOk(cwd, ["diff", "--stat", commitRange]);

  const parts = [];
  parts.push(`## Commit Log\n\n${logOutput || "(none)"}\n`);
  parts.push(`## Diff Stat\n\n${diffStat || "(none)"}\n`);

  if (includeDiff) {
    const branchDiff = gitOk(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange]);
    parts.push(`## Branch Diff\n\n${branchDiff || "(none)"}\n`);
  } else {
    parts.push(`## Changed Files\n\n${changedFiles.join("\n") || "(none)"}\n`);
  }

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${mergeBase}.`,
    content: parts.join("\n"),
    changedFiles,
    mergeBase,
    commitRange
  };
}

/**
 * Collect review context — auto-selects working-tree or branch mode.
 * Matches codex-plugin-cc's collectReviewContext.
 */
export function collectReviewContext(cwd, target, options = {}) {
  const maxInlineFiles = options.maxInlineFiles ?? DEFAULT_INLINE_DIFF_MAX_FILES;
  const maxInlineDiffBytes = options.maxInlineDiffBytes ?? DEFAULT_INLINE_DIFF_MAX_BYTES;
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(cwd);
    // Measure diff size
    const stagedBytes = measureDiffBytes(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"], maxInlineDiffBytes);
    const unstagedBytes = measureDiffBytes(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"], maxInlineDiffBytes);
    diffBytes = stagedBytes + unstagedBytes;

    const allFiles = [...new Set([...state.staged, ...state.unstaged, ...state.untracked])];
    includeDiff = options.includeDiff ?? (allFiles.length <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(cwd, state, { includeDiff });
  } else {
    const mergeBase = gitOk(cwd, ["merge-base", "HEAD", target.baseRef]);
    const commitRange = `${mergeBase}..HEAD`;
    const fileCount = gitOk(cwd, ["diff", "--name-only", commitRange]).split("\n").filter(Boolean).length;
    diffBytes = measureDiffBytes(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", commitRange], maxInlineDiffBytes);
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(cwd, target.baseRef, { includeDiff });
  }

  return {
    cwd,
    branch: getCurrentBranch(cwd),
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: includeDiff
      ? "Use the repository context below as primary evidence."
      : "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.",
    ...details
  };
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/**
 * Get the merge base between current branch and default branch.
 */
export function getMergeBase(cwd, defaultBranch) {
  try {
    return gitOk(cwd, ["merge-base", defaultBranch, "HEAD"], { timeout: 5000 });
  } catch {
    return null;
  }
}

/**
 * Get content of untracked files (for review context).
 * Legacy API kept for backward compat; prefer collectWorkingTreeContext.
 * Uses Node.js fs instead of `head` command for cross-platform support.
 */
export function getUntrackedContent(cwd, filePaths, maxLines = 100) {
  const contents = {};
  for (const filePath of filePaths.slice(0, 20)) {
    try {
      const absolutePath = path.resolve(cwd, filePath);
      const data = fs.readFileSync(absolutePath, "utf8");
      const lines = data.split("\n");
      contents[filePath] = lines.slice(0, maxLines).join("\n");
    } catch { /* skip */ }
  }
  return contents;
}
