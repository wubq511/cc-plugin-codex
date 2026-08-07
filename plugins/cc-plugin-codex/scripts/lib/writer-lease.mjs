/**
 * Writer lease — cross-process write exclusivity for one workspace.
 *
 * Split out of state.mjs so the lease concern (O_EXCL ownership + stale
 * takeover, file mutex) can evolve and be tested independently. A write-enabled
 * delegation holds exactly one lease file per workspace; lease ownership is
 * decided by O_EXCL creation (the cross-process decision) plus a bounded stale
 * takeover. State mutations must be bounded to a single lease owner; read-only
 * access takes no lease.
 *
 * Privacy: the lease file holds only { owner (random token), ts, jobId } — no
 * task content — inside the private 0o700 state dir.
 *
 * The atomic-write helpers are inlined (not imported from state.mjs) so the
 * module stays self-contained; they are short and stable.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveStateDir } from "./state.mjs";

const LEASE_FILE_NAME = "lease.lock";
const LEASE_STALE_MS = 5 * 60 * 1000;
const LEASE_MUTEX_STALE_MS = 5 * 1000;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

function resolveLeaseFile(cwd) {
  return path.join(resolveStateDir(cwd), LEASE_FILE_NAME);
}

function ensureLeaseDir(cwd) {
  fs.mkdirSync(resolveStateDir(cwd), { recursive: true, mode: DIR_MODE });
  try { fs.chmodSync(resolveStateDir(cwd), DIR_MODE); } catch { /* best effort */ }
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

function withLeaseMutex(cwd, operation) {
  ensureLeaseDir(cwd);
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
