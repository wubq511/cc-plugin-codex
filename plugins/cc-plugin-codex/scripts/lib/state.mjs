/**
 * Job state management — schema v8, atomic per-job persistence.
 *
 * Each job lives in its own JSON file under <stateDir>/jobs/.
 * All writes use tmp+rename for atomicity. The write-exclusivity lease lives in
 * writer-lease.mjs. V2 state is migrated once under a migration lock; corrupt
 * state is quarantined instead of silently reset.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";
import { migrateV3ModelFields } from "./model-evidence.mjs";

export const STATE_VERSION = 8;
const JOBS_DIR_NAME = "jobs";
const LEGACY_STATE_FILE = "state.json";
const MAX_JOBS = 50;
const MAX_JOB_AGE_DAYS = 30;
const MAX_TOTAL_ARTIFACTS_BYTES = 100 * 1024 * 1024;
const MAX_JOB_METADATA_BYTES = 64 * 1024;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function nowIso() {
  return new Date().toISOString();
}

// A route snapshot is an audit record of the exact selector forwarded to
// native Claude. Keep this whitelist at the persistence boundary so stale
// versions of the plugin cannot keep arbitrary routing metadata in current
// state files.
const ROUTE_SNAPSHOT_FIELDS = Object.freeze([
  "selectorKind",
  "requestedValue",
  "cliArg",
  "canonicalAlias",
  "cliVersion",
  "timestamp",
]);

function sanitizeRouteSnapshot(snapshot) {
  if (snapshot === null || snapshot === undefined) return snapshot;
  if (typeof snapshot !== "object" || Array.isArray(snapshot)) return null;

  const sanitized = {};
  for (const field of ROUTE_SNAPSHOT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, field)) {
      sanitized[field] = snapshot[field];
    }
  }

  const originalKeys = Object.keys(snapshot);
  if (originalKeys.length === Object.keys(sanitized).length
    && originalKeys.every((key) => Object.prototype.hasOwnProperty.call(sanitized, key))) {
    return snapshot;
  }
  return sanitized;
}

function sanitizeJobForStorage(jobData) {
  const hasTask = Object.prototype.hasOwnProperty.call(jobData, "task");
  const hasTaskPreview = Object.prototype.hasOwnProperty.call(jobData, "taskPreview");
  const hasRouteSnapshot = Object.prototype.hasOwnProperty.call(jobData, "routeSnapshot");
  const sanitizedSnapshot = hasRouteSnapshot
    ? sanitizeRouteSnapshot(jobData.routeSnapshot)
    : undefined;
  const snapshotChanged = hasRouteSnapshot && sanitizedSnapshot !== jobData.routeSnapshot;
  if (!hasTask && !hasTaskPreview && !snapshotChanged) return jobData;

  const sanitized = { ...jobData };
  delete sanitized.task;
  delete sanitized.taskPreview;
  if (hasRouteSnapshot) sanitized.routeSnapshot = sanitizedSnapshot;
  return sanitized;
}

// ─── Path Resolution ─────────────────────────────────────────────────────────

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }
  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), "cc-companion", `${slug}-${hash}`);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

function resolveJobFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}

function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), LEGACY_STATE_FILE);
}

function resolveResultFile(cwd, jobId) {
  return path.join(resolveJobsDir(cwd), `${jobId}.result.json`);
}

// ─── File Utilities ──────────────────────────────────────────────────────────

function ensureDirPrivate(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(dirPath, DIR_MODE); } catch { /* best effort */ }
}

function ensureStateDir(cwd) {
  ensureDirPrivate(resolveStateDir(cwd));
  ensureDirPrivate(resolveJobsDir(cwd));
}

/**
 * Atomic file write: write to tmp in same directory, flush, rename over target.
 * Sets mode 0600 on the final file.
 */
function writeFileAtomic(targetPath, content) {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp-${Date.now()}-${randomBytes(4).toString("hex")}`);
  let fd;
  try {
    fd = fs.openSync(tmpPath, "w", FILE_MODE);
    fs.writeSync(fd, content, 0, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, targetPath);
    try { fs.chmodSync(targetPath, FILE_MODE); } catch { /* best effort */ }
  } catch (err) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    removeFileIfExists(tmpPath);
    throw err;
  }
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  }
}

function tryParseJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

// ─── V2 → V3 Migration ──────────────────────────────────────────────────────

const migratedWorkspaces = new Set();

function migrateV2State(cwd) {
  const stateDir = resolveStateDir(cwd);
  if (migratedWorkspaces.has(stateDir)) return;

  const stateFile = resolveStateFile(cwd);
  const jobsDir = resolveJobsDir(cwd);

  if (!fs.existsSync(stateFile)) {
    migratedWorkspaces.add(stateDir);
    return;
  }

  ensureStateDir(cwd);

  // Read and parse legacy state
  let raw;
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch {
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt legacy state — quarantine
    const quarantinePath = `${stateFile}.quarantine-${Date.now()}`;
    try {
      fs.renameSync(stateFile, quarantinePath);
      process.stderr.write(`[state] Legacy state file corrupt, quarantined to ${quarantinePath}\n`);
      migratedWorkspaces.add(stateDir);
    } catch (renameErr) {
      process.stderr.write(`[state] Failed to quarantine corrupt legacy state: ${renameErr.message}\n`);
    }
    return;
  }

  // Backup legacy state
  const backupPath = `${stateFile}.v2-backup`;
  try {
    fs.copyFileSync(stateFile, backupPath);
    try { fs.chmodSync(backupPath, FILE_MODE); } catch { /* best effort */ }
  } catch (err) {
    process.stderr.write(`[state] Failed to back up legacy state; migration deferred: ${err.message}\n`);
    return;
  }

  // Migrate jobs to per-job files
  const legacyJobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
  let migratedCount = 0;
  let migrationFailed = false;
  for (const job of legacyJobs) {
    if (!job || !job.id) continue;
    try {
      // Preserve legacy sessionId as ownerServerId for backward compat
      const migrated = { ...job };
      if (migrated.sessionId && !migrated.ownerServerId) {
        migrated.ownerServerId = migrated.sessionId;
        migrated.claudeSessionId = null;
      }
      migrated.version = 3;
      const jobFile = resolveJobFile(cwd, job.id);
      writeFileAtomic(jobFile, JSON.stringify(migrated, null, 2));
      migratedCount++;
    } catch (err) {
      migrationFailed = true;
      process.stderr.write(`[state] Failed to migrate job ${job.id}: ${err.message}\n`);
    }
  }

  if (migrationFailed) {
    process.stderr.write("[state] Legacy migration incomplete; source and backup retained for retry.\n");
    return;
  }

  // Remove legacy state file
  try {
    fs.unlinkSync(stateFile);
  } catch (err) {
    process.stderr.write(`[state] Failed to finalize legacy migration; source retained: ${err.message}\n`);
    return;
  }

  // Correct overly broad permissions on migrated files
  try {
    const files = fs.readdirSync(jobsDir);
    for (const file of files) {
      const filePath = path.join(jobsDir, file);
      try {
        const stat = fs.lstatSync(filePath);
        if (!stat.isSymbolicLink() && stat.isFile()) {
          const mode = stat.mode & 0o777;
          if (mode !== FILE_MODE) {
            fs.chmodSync(filePath, FILE_MODE);
          }
        }
      } catch { /* ignore individual file errors */ }
    }
    const stateDir = resolveStateDir(cwd);
    const dirStat = fs.statSync(stateDir);
    const dirMode = dirStat.mode & 0o777;
    if (dirMode !== DIR_MODE) {
      fs.chmodSync(stateDir, DIR_MODE);
    }
  } catch { /* best effort */ }

  process.stderr.write(`[state] Migrated ${migratedCount} jobs from v2 to v3 per-job store.\n`);
  migratedWorkspaces.add(stateDir);
}

// ─── Job File I/O ────────────────────────────────────────────────────────────

function readJobFileSafe(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  return tryParseJsonFile(jobFile);
}

function writeJobFile(cwd, jobId, jobData) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  // Privacy boundary (Req 1): task content must never reach disk. This is the
  // structural chokepoint for every write path (upsertJob, reconcileOrphans).
  // Even if a caller accidentally passes `task` or `taskPreview`, they are
  // dropped here. Only the non-reversible `taskRef` (short SHA-256 prefix) and
  // the full `taskHash` (irreversible, retained for migration derivation) may
  // be persisted. The full task enters only the Claude child stdin stream.
  const sanitized = sanitizeJobForStorage(jobData);
  const serialized = JSON.stringify(sanitized, null, 2);
  const size = Buffer.byteLength(serialized, "utf8");
  if (size > MAX_JOB_METADATA_BYTES) {
    throw new Error(`Job metadata exceeds ${MAX_JOB_METADATA_BYTES}-byte limit (${size} bytes)`);
  }
  writeFileAtomic(jobFile, serialized);
}

// ─── Result Artifact Storage ─────────────────────────────────────────────────

export function writeResultArtifact(cwd, jobId, result) {
  ensureStateDir(cwd);
  const resultFile = resolveResultFile(cwd, jobId);
  writeFileAtomic(resultFile, JSON.stringify(result, null, 2));
  return resultFile;
}

export function readResultArtifact(cwd, jobId) {
  return tryParseJsonFile(resolveResultFile(cwd, jobId));
}

// ─── Orphan Reconciliation ───────────────────────────────────────────────────

// Runs lazily via listJobs on first access to a workspace.
function reconcileOrphans(cwd) {
  migrateV2State(cwd);
  ensureStateDir(cwd);

  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) return 0;

  let orphanCount = 0;
  try {
    const files = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    for (const file of files) {
      const job = tryParseJsonFile(path.join(jobsDir, file));
      if (!job || !job.id) continue;
      if (job.status === "running" || job.status === "queued" || job.status === "cancelling") {
        // Non-terminal job from another (or unknown) server becomes orphaned.
        // Includes "cancelling" — the server that was cancelling it is gone.
        job.status = "orphaned";
        job.phase = "orphaned";
        job.pid = null;
        job.updatedAt = nowIso();
        job.errorMessage = job.errorMessage || "Companion server restarted; job could not be recovered.";
        writeJobFile(cwd, job.id, job);
        orphanCount++;
      }
    }
  } catch { /* best effort */ }
  return orphanCount;
}

// ─── V3 → V4 → V5 Migration ─────────────────────────────────────────────────

/**
 * Migrate a job to the current schema version (v8).
 *
 * v3 → v4: model evidence restructure (observedModel → usageModelKeys).
 * v4 → v5: add selectorKind, routeSnapshot, routeStatus (additive null fields).
 * v5 → v6: privacy boundary — drop `taskPreview` and legacy `task` content
 *          fields; replace with a non-reversible `taskRef` (short SHA-256
 *          prefix) derived from the existing `taskHash` when available. Old
 *          records must never cause task content to be rendered.
 *
 * v6 → v7: clear route fields written by the retired routing implementation.
 *          New v7 records use a fixed source-independent snapshot shape.
 *
 * v7 → v8: additive — new fields (claudeSessionUuid, autoCompact, compactResult)
 *          default to null/undefined. The `cancelling` status is a new
 *          non-terminal status between running and cancelled; no old jobs will
 *          have it. reconcileOrphans now also marks `cancelling` jobs as
 *          orphaned. All existing privacy chokepoints are preserved.
 *
 * Idempotent — v8 jobs pass through unchanged.
 */
function migrateJob(job) {
  if (!job) return job;

  // Jobs written before explicit per-job schema tagging are v3-era records.
  // Treat absent, malformed, and older values as the oldest supported schema
  // so the v5→v6 task-content scrub always runs. Never trust a future or
  // current version label to exempt a record that still carries task fields.
  const declaredVersion = Number.isInteger(job.version) && job.version >= 3
    ? job.version
    : 3;
  let migrated = declaredVersion === job.version ? job : { ...job, version: declaredVersion };

  // Defense-in-depth: even if declaredVersion >= STATE_VERSION, strip task
  // content and unsupported route metadata from malformed current records.
  if (declaredVersion >= STATE_VERSION) {
    const sanitized = sanitizeJobForStorage(migrated);
    if (sanitized !== migrated) {
      migrated = sanitized;
      if (migrated.taskRef === undefined) {
        migrated.taskRef = migrated.taskHash ? `sha256:${String(migrated.taskHash).slice(0, 12)}` : null;
      }
    }
    return migrated;
  }

  // v3 → v4: model evidence restructure
  if (migrated.version < 4) {
    try {
      migrated = migrateV3ModelFields(migrated);
    } catch (err) {
      process.stderr.write(`[state] Failed to migrate v3 job ${migrated.id}: ${err.message}\n`);
      // Continue — v4→v5 migration is additive and safe even on unmigrated v3
    }
  }

  // v4 → v5: add route routing fields (additive, null for legacy jobs)
  if (migrated.version < 5) {
    migrated = { ...migrated };
    migrated.selectorKind = migrated.selectorKind || null;
    migrated.routeSnapshot = migrated.routeSnapshot || null;
    migrated.routeStatus = migrated.routeStatus || null;
    migrated.version = 5;
  }

  // v5 → v6: privacy boundary — never persist or render task content.
  // Drop `taskPreview` (first 4 KiB of the task) and legacy `task` fields.
  // Derive a non-reversible short hash reference from `taskHash` when present.
  if (migrated.version < 6) {
    migrated = { ...migrated };
    delete migrated.taskPreview;
    delete migrated.task;
    if (migrated.taskRef === undefined) {
      migrated.taskRef = migrated.taskHash
        ? `sha256:${String(migrated.taskHash).slice(0, 12)}`
        : null;
    }
    migrated.version = 6;
  }

  // v6 → v7: every v6 route snapshot could contain a native selector inferred
  // from retired external configuration. Its provenance cannot be reconstructed
  // safely, so clear all derived route fields instead of preserving a claim.
  if (migrated.version < 7) {
    migrated = {
      ...sanitizeJobForStorage(migrated),
      selectorKind: null,
      routeSnapshot: null,
      routeStatus: null,
    };
    migrated.version = 7;
  }

  // v7 → v8: additive — new fields (claudeSessionUuid, autoCompact,
  // compactResult) default to null/undefined when absent. The `cancelling`
  // status is new; no migration action needed for old jobs. Privacy
  // chokepoints (sanitizeJobForStorage) are preserved by the write path.
  if (migrated.version < 8) {
    migrated = { ...migrated };
    if (migrated.claudeSessionUuid === undefined) migrated.claudeSessionUuid = null;
    if (migrated.autoCompact === undefined) migrated.autoCompact = null;
    if (migrated.compactResult === undefined) migrated.compactResult = null;
    migrated.version = 8;
  }

  return migrated;
}

// Backward compat alias
const migrateV3Job = migrateJob;

// ─── Core CRUD ───────────────────────────────────────────────────────────────

export function generateJobId(prefix = "cc") {
  const random = createHash("sha256").update(`${Date.now()}-${process.pid}-${Math.random()}`).digest("hex").slice(0, 6);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  migrateV2State(cwd);
  ensureStateDir(cwd);

  // Privacy boundary: strip task content from the patch before merge so it
  // never enters the persisted record or the in-memory return value. The
  // structural chokepoint (writeJobFile) strips again as defense in depth.
  const safePatch = sanitizeJobForStorage(jobPatch);

  const timestamp = nowIso();
  const existing = readJobFileSafe(cwd, jobPatch.id);
  if (existing) {
    // Migrate v3 → v4 if needed
    const migrated = migrateV3Job(existing);
    const merged = sanitizeJobForStorage({ ...migrated, ...safePatch, updatedAt: timestamp });
    writeJobFile(cwd, jobPatch.id, merged);
    return merged;
  }
  const newJob = sanitizeJobForStorage({ createdAt: timestamp, updatedAt: timestamp, version: STATE_VERSION, ...safePatch });
  writeJobFile(cwd, jobPatch.id, newJob);
  return newJob;
}

const reconciledWorkspaces = new Set();

export function listJobs(cwd) {
  migrateV2State(cwd);
  ensureStateDir(cwd);

  // Reconcile orphans on first access to each workspace
  const stateDir = resolveStateDir(cwd);
  if (!reconciledWorkspaces.has(stateDir)) {
    reconciledWorkspaces.add(stateDir);
    try { reconcileOrphans(cwd); } catch { /* best effort */ }
  }

  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) return [];

  const jobs = [];
  try {
    const files = fs.readdirSync(jobsDir).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    for (const file of files) {
      const job = tryParseJsonFile(path.join(jobsDir, file));
      if (job && job.id) {
        // Migrate v3 → v4 on read
        const migrated = migrateV3Job(job);
        // Atomic write-back: persist v4 migration to disk so observedModel is removed
        if (migrated !== job) {
          try { writeJobFile(cwd, job.id, migrated); } catch { /* best effort */ }
        }
        jobs.push(migrated);
      }
    }
  } catch { /* best effort */ }

  return jobs.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

// ─── Job Lookup ──────────────────────────────────────────────────────────────

export function findJob(jobs, idOrPrefix) {
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

export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function findLatestJob(jobs, predicate = () => true) {
  return sortJobsNewestFirst(jobs).find(predicate) || null;
}

export function findLatestActiveJob(jobs) {
  return findLatestJob(jobs, (j) => j.status === "running" || j.status === "queued" || j.status === "cancelling");
}

export function findLatestCompletedJob(jobs) {
  return findLatestJob(jobs, (j) => j.status === "completed");
}

// ─── Retention & Cleanup ─────────────────────────────────────────────────────

export function cleanupOldJobs(cwd) {
  const jobs = listJobs(cwd);
  const now = Date.now();
  const maxAgeMs = MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;
  const jobsDir = resolveJobsDir(cwd);

  // Prune by age (only terminal jobs, never active/orphaned)
  for (const job of jobs) {
    if (job.status === "running" || job.status === "queued" || job.status === "orphaned" || job.status === "cancelling") continue;
    const updatedAt = Date.parse(job.updatedAt || "");
    if (Number.isFinite(updatedAt) && (now - updatedAt) > maxAgeMs) {
      removeFileIfExists(resolveJobFile(cwd, job.id));
      removeFileIfExists(path.join(jobsDir, `${job.id}.log`));
      removeFileIfExists(resolveResultFile(cwd, job.id));
    }
  }

  // Liveness probes are intentionally auditable even if the watchdog never
  // creates a normal job. They therefore need their own retention pass: they
  // must not outlive the same 30-day private-evidence window as terminal jobs.
  pruneStandaloneProbeArtifacts(jobsDir, now, maxAgeMs);

  // Prune by count (oldest terminal jobs first, after 30-day age pruning)
  const remaining = listJobs(cwd);
  if (remaining.length > MAX_JOBS) {
    const terminalJobs = remaining
      .filter((j) => j.status !== "running" && j.status !== "queued" && j.status !== "orphaned" && j.status !== "cancelling")
      .sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));

    const toRemove = remaining.length - MAX_JOBS;
    for (let i = 0; i < Math.min(toRemove, terminalJobs.length); i++) {
      const job = terminalJobs[i];
      removeFileIfExists(resolveJobFile(cwd, job.id));
      removeFileIfExists(path.join(jobsDir, `${job.id}.log`));
      removeFileIfExists(resolveResultFile(cwd, job.id));
    }
  }

  // The byte cap is independent of job count and must always run.
  enforceTotalArtifactCap(cwd);
}

function enforceTotalArtifactCap(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  if (!fs.existsSync(jobsDir)) return;

  let totalBytes = 0;
  try {
    for (const name of fs.readdirSync(jobsDir)) {
      const filePath = path.join(jobsDir, name);
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          totalBytes += stat.size;
        }
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  if (totalBytes <= MAX_TOTAL_ARTIFACTS_BYTES) return;

  // Prune complete terminal job bundles oldest-first. Never delete an artifact
  // or log independently from an active/orphaned job's metadata.
  const terminalJobs = listJobs(cwd)
    .filter((job) => !["running", "queued", "orphaned", "cancelling"].includes(job.status))
    .sort((a, b) => String(a.updatedAt ?? "").localeCompare(String(b.updatedAt ?? "")));

  for (const job of terminalJobs) {
    if (totalBytes <= MAX_TOTAL_ARTIFACTS_BYTES) break;
    const bundle = [
      resolveJobFile(cwd, job.id),
      path.join(jobsDir, `${job.id}.log`),
      resolveResultFile(cwd, job.id),
    ];
    for (const filePath of bundle) {
      try {
        const size = fs.statSync(filePath).size;
        removeFileIfExists(filePath);
        totalBytes -= size;
      } catch { /* already absent */ }
    }
  }

  // A probe artifact has no mutable job record by design, so it is safe to
  // prune only after every eligible terminal job bundle has been considered.
  // This keeps active/orphaned job evidence protected while still making the
  // global 100 MiB cap truthful for all files in the private jobs directory.
  if (totalBytes > MAX_TOTAL_ARTIFACTS_BYTES) {
    const probes = listStandaloneProbeArtifacts(jobsDir);
    for (const probe of probes) {
      if (totalBytes <= MAX_TOTAL_ARTIFACTS_BYTES) break;
      removeFileIfExists(probe.path);
      totalBytes -= probe.size;
    }
  }
}

function listStandaloneProbeArtifacts(jobsDir) {
  if (!fs.existsSync(jobsDir)) return [];
  try {
    return fs.readdirSync(jobsDir)
      .filter((name) => /^probe-[a-z0-9-]+\.result\.json$/i.test(name))
      .map((name) => {
        const probePath = path.join(jobsDir, name);
        const stat = fs.statSync(probePath);
        return { path: probePath, mtimeMs: stat.mtimeMs, size: stat.size };
      })
      .filter((entry) => Number.isFinite(entry.mtimeMs) && Number.isFinite(entry.size))
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
  } catch {
    return [];
  }
}

function pruneStandaloneProbeArtifacts(jobsDir, now, maxAgeMs) {
  for (const probe of listStandaloneProbeArtifacts(jobsDir)) {
    if ((now - probe.mtimeMs) > maxAgeMs) removeFileIfExists(probe.path);
  }
}
