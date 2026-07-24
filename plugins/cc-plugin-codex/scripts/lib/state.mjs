/**
 * Job state management — schema v6, atomic per-job persistence.
 *
 * Each job lives in its own JSON file under <stateDir>/jobs/.
 * All writes use tmp+rename for atomicity. Configuration metadata is separate
 * from job records. V2 state is migrated once under a migration lock; corrupt
 * state is quarantined instead of silently reset.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveWorkspaceRoot } from "./workspace.mjs";
import { migrateV3ModelFields } from "./model-evidence.mjs";

const STATE_VERSION = 6;
const CONFIG_FILE_NAME = "config.json";
const LEASE_FILE_NAME = "lease.lock";
const JOBS_DIR_NAME = "jobs";
const LEGACY_STATE_FILE = "state.json";
const MAX_JOBS = 50;
const MAX_JOB_AGE_DAYS = 30;
const MAX_TOTAL_ARTIFACTS_BYTES = 100 * 1024 * 1024;
const MAX_JOB_METADATA_BYTES = 64 * 1024;
const LEASE_STALE_MS = 5 * 60 * 1000;
const LEASE_MUTEX_STALE_MS = 5 * 1000;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function nowIso() {
  return new Date().toISOString();
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

function resolveConfigFile(cwd) {
  return path.join(resolveStateDir(cwd), CONFIG_FILE_NAME);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), LEGACY_STATE_FILE);
}

function resolveLeaseFile(cwd) {
  return path.join(resolveStateDir(cwd), LEASE_FILE_NAME);
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

export function resetMigrationFlag() {
  migratedWorkspaces.clear();
}

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
  const sanitized = { ...jobData };
  delete sanitized.task;
  delete sanitized.taskPreview;
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

export function reconcileOrphans(cwd) {
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
      if (job.status === "running" || job.status === "queued") {
        // Non-terminal job from another (or unknown) server becomes orphaned
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
 * Migrate a job to the current schema version (v6).
 *
 * v3 → v4: model evidence restructure (observedModel → usageModelKeys).
 * v4 → v5: add selectorKind, routeSnapshot, routeStatus (additive null fields).
 * v5 → v6: privacy boundary — drop `taskPreview` and legacy `task` content
 *          fields; replace with a non-reversible `taskRef` (short SHA-256
 *          prefix) derived from the existing `taskHash` when available. Old
 *          records must never cause task content to be rendered.
 *
 * Idempotent — v6 jobs pass through unchanged.
 */
function migrateJob(job) {
  if (!job || job.version >= STATE_VERSION) return job;

  let migrated = job;

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
  const safePatch = { ...jobPatch };
  delete safePatch.task;
  delete safePatch.taskPreview;

  const timestamp = nowIso();
  const existing = readJobFileSafe(cwd, jobPatch.id);
  if (existing) {
    // Migrate v3 → v4 if needed
    const migrated = migrateV3Job(existing);
    const merged = { ...migrated, ...safePatch, updatedAt: timestamp };
    writeJobFile(cwd, jobPatch.id, merged);
    return merged;
  }
  const newJob = { createdAt: timestamp, updatedAt: timestamp, version: STATE_VERSION, ...safePatch };
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
        if (migrated.version !== job.version) {
          try { writeJobFile(cwd, job.id, migrated); } catch { /* best effort */ }
        }
        jobs.push(migrated);
      }
    }
  } catch { /* best effort */ }

  return jobs.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
}

export function listJobsBySession(cwd, sessionId) {
  return listJobs(cwd).filter((j) => j.ownerServerId === sessionId);
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
  return findLatestJob(jobs, (j) => j.status === "running" || j.status === "queued");
}

export function findLatestCompletedJob(jobs) {
  return findLatestJob(jobs, (j) => j.status === "completed");
}

// ─── Writer Lease ────────────────────────────────────────────────────────────

function withLeaseMutex(cwd, operation) {
  ensureStateDir(cwd);
  const mutexDir = `${resolveLeaseFile(cwd)}.mutex`;
  const waitArray = new Int32Array(new SharedArrayBuffer(4));

  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      fs.mkdirSync(mutexDir, { mode: DIR_MODE });
      try {
        return operation();
      } finally {
        try { fs.rmdirSync(mutexDir); } catch { /* stale recovery handles crash residue */ }
      }
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        const stat = fs.statSync(mutexDir);
        if (Date.now() - stat.mtimeMs >= LEASE_MUTEX_STALE_MS) {
          fs.rmSync(mutexDir, { recursive: true, force: true });
          continue;
        }
      } catch { continue; }
      Atomics.wait(waitArray, 0, 0, 2);
    }
  }
  throw new Error("Writer lease mutex is busy");
}

export function acquireWriterLease(cwd, ownerToken) {
  return withLeaseMutex(cwd, () => {
    const leaseFile = resolveLeaseFile(cwd);

    for (let attempt = 0; attempt < 3; attempt++) {
      const now = Date.now();
      const leaseData = { owner: ownerToken, ts: now, jobId: null };
      let fd;
      try {
        // O_EXCL is the actual cross-process ownership decision. Atomic rename is
        // appropriate for updates, but it cannot safely acquire a missing lock.
        fd = fs.openSync(leaseFile, "wx", FILE_MODE);
        fs.writeFileSync(fd, JSON.stringify(leaseData), "utf8");
        fs.fsyncSync(fd);
        return { acquired: true, owner: ownerToken };
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }

      const existing = tryParseJsonFile(leaseFile);
      if (existing) {
        const age = now - (existing.ts || 0);
        if (age < LEASE_STALE_MS) {
          if (existing.owner !== ownerToken) {
            return { acquired: false, owner: existing.owner, jobId: existing.jobId };
          }
          existing.ts = now;
          writeFileAtomic(leaseFile, JSON.stringify(existing));
          return { acquired: true, owner: ownerToken };
        }
      }

      const stalePath = `${leaseFile}.stale-${process.pid}-${randomBytes(4).toString("hex")}`;
      try {
        fs.renameSync(leaseFile, stalePath);
        removeFileIfExists(stalePath);
      } catch (err) {
        if (err.code !== "ENOENT") continue;
      }
    }

    const owner = tryParseJsonFile(leaseFile);
    return { acquired: false, owner: owner?.owner, jobId: owner?.jobId };
  });
}

export function updateWriterLeaseJobId(cwd, ownerToken, jobId) {
  return withLeaseMutex(cwd, () => {
    const leaseFile = resolveLeaseFile(cwd);
    const existing = tryParseJsonFile(leaseFile);
    if (!existing || existing.owner !== ownerToken) return false;
    existing.jobId = jobId;
    existing.ts = Date.now();
    writeFileAtomic(leaseFile, JSON.stringify(existing));
    return true;
  });
}

export function refreshWriterLease(cwd, ownerToken) {
  return withLeaseMutex(cwd, () => {
    const leaseFile = resolveLeaseFile(cwd);
    const existing = tryParseJsonFile(leaseFile);
    if (!existing || existing.owner !== ownerToken) return false;
    existing.ts = Date.now();
    writeFileAtomic(leaseFile, JSON.stringify(existing));
    return true;
  });
}

export function isWriterLeaseOwner(cwd, ownerToken) {
  const leaseFile = resolveLeaseFile(cwd);
  const existing = tryParseJsonFile(leaseFile);
  return existing?.owner === ownerToken;
}

export function releaseWriterLease(cwd, ownerToken) {
  return withLeaseMutex(cwd, () => {
    const leaseFile = resolveLeaseFile(cwd);
    const existing = tryParseJsonFile(leaseFile);
    if (!existing || existing.owner !== ownerToken) return false;
    removeFileIfExists(leaseFile);
    return true;
  });
}

export function getWriterLeaseOwner(cwd) {
  const leaseFile = resolveLeaseFile(cwd);
  const existing = tryParseJsonFile(leaseFile);
  if (!existing) return null;
  const age = Date.now() - (existing.ts || 0);
  if (age >= LEASE_STALE_MS) return null;
  return existing;
}

// ─── Config ──────────────────────────────────────────────────────────────────

export function loadConfig(cwd) {
  return tryParseJsonFile(resolveConfigFile(cwd)) || {};
}

export function saveConfig(cwd, config) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveConfigFile(cwd), JSON.stringify(config, null, 2));
}

// ─── Retention & Cleanup ─────────────────────────────────────────────────────

export function cleanupOldJobs(cwd) {
  const jobs = listJobs(cwd);
  const now = Date.now();
  const maxAgeMs = MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;
  const jobsDir = resolveJobsDir(cwd);

  // Prune by age (only terminal jobs, never active/orphaned)
  for (const job of jobs) {
    if (job.status === "running" || job.status === "queued" || job.status === "orphaned") continue;
    const updatedAt = Date.parse(job.updatedAt || "");
    if (Number.isFinite(updatedAt) && (now - updatedAt) > maxAgeMs) {
      removeFileIfExists(resolveJobFile(cwd, job.id));
      removeFileIfExists(path.join(jobsDir, `${job.id}.log`));
      removeFileIfExists(resolveResultFile(cwd, job.id));
    }
  }

  // Prune by count (oldest terminal jobs first, after 30-day age pruning)
  const remaining = listJobs(cwd);
  if (remaining.length > MAX_JOBS) {
    const terminalJobs = remaining
      .filter((j) => j.status !== "running" && j.status !== "queued" && j.status !== "orphaned")
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
    .filter((job) => !["running", "queued", "orphaned"].includes(job.status))
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
}

// ─── Backward Compat (used by existing tests) ───────────────────────────────

export function resolveJobFile_export(cwd, jobId) {
  return resolveJobFile(cwd, jobId);
}

export function readJobFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJobFileDirect(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, JSON.stringify(payload, null, 2));
  return jobFile;
}
