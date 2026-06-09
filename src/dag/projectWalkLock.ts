/**
 * projectWalkLock — a per-project mutex that prevents two concurrent
 * walks of the SAME project from racing on project.json + the event
 * log.
 *
 * Why this exists (the 2026-06-03 eye-of-the-storm incident): the agent
 * reaches the walker through two asymmetric paths. `dhee_start_run`
 * goes through the single-flight `BackgroundTaskRunner`;
 * `dhee_regenerate_node` goes straight to `runProjectViaBundle` →
 * `walkBundle`, bypassing that guard. So a regenerate could launch a
 * SECOND walk while a start_run walk was still live. Two concurrent
 * walks each open their own `EventLog` handle (independent cached seq
 * counters → duplicate `seq`s) and each persist their own walkState
 * snapshot (last-writer-wins → lost invalidations). The single-flight
 * guarantee lived in the dispatch wrapper instead of around the walk
 * itself.
 *
 * The fix puts the guard at the universal chokepoint — `walkBundle` —
 * keyed per project, with two layers:
 *   - In-process Set: catches same-process concurrency (the observed
 *     case — both walks ran inside one node process).
 *   - Cross-process advisory lock file (`<.dhee>/.walk.lock`, created
 *     atomically with O_EXCL): catches a second OS process (e.g. a
 *     `scripts/*.ts` walker) walking the same project. A lock whose
 *     holder PID is dead (same host) is reclaimed as stale.
 *
 * Semantics: acquire-or-REJECT (not queue) — mirrors the
 * BackgroundTaskRunner's existing single-flight rejection. The caller
 * gets a clear "already in progress" result and should stop the active
 * run first.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { dheeDir } from './eventLog/eventLogPath.js';

/** Held walk locks in THIS process, keyed by resolved projectDir. */
const heldInProcess = new Set<string>();

export interface WalkLock {
  /** Release the lock. Idempotent. */
  release(): void;
}

export interface WalkLockHeld {
  held: true;
  /** Human-readable description of the current holder, for error messages. */
  holder: string;
}

export function isWalkLockResult(v: WalkLock | WalkLockHeld): v is WalkLockHeld {
  return (v as WalkLockHeld).held === true;
}

function lockFilePath(projectDir: string): string {
  return join(dheeDir(projectDir), '.walk.lock');
}

interface LockPayload {
  pid: number;
  startedAt: number;
  host: string;
}

/** True if `pid` is a live process we can observe on this host. */
function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM → the process exists but is owned by another user (alive).
    // ESRCH → no such process (dead).
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Read the on-disk lock payload, or null if missing/unreadable.
 */
function readLock(path: string): LockPayload | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Partial<LockPayload>;
    if (typeof raw.pid !== 'number') return null;
    return {
      pid: raw.pid,
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
      host: typeof raw.host === 'string' ? raw.host : '',
    };
  } catch {
    return null;
  }
}

/**
 * Decide whether an existing lock file is STALE (safe to reclaim).
 *
 * Reclaim only when we're confident the holder is gone:
 *   - unreadable / corrupt lock → stale.
 *   - same host AND holder PID is dead → stale.
 *   - same host AND holder PID is OUR pid but not tracked in-process →
 *     a leftover from a crashed prior incarnation → stale.
 * Otherwise (live holder, or a holder on a DIFFERENT host we can't
 * verify) → NOT stale; treat as held.
 */
function isStaleLock(payload: LockPayload | null): boolean {
  if (payload === null) return true;
  const sameHost = payload.host === '' || payload.host === hostname();
  if (!sameHost) return false; // can't verify a remote pid — be conservative
  if (payload.pid === process.pid) return true; // our own crashed leftover
  return !isProcessAlive(payload.pid);
}

function describeHolder(payload: LockPayload | null): string {
  if (payload === null) return 'an unknown process';
  const when = payload.startedAt > 0 ? new Date(payload.startedAt).toISOString() : 'unknown time';
  const host = payload.host || 'this host';
  return `pid ${payload.pid} on ${host} (since ${when})`;
}

function writeLockFile(path: string): void {
  const payload: LockPayload = {
    pid: process.pid,
    startedAt: Date.now(),
    host: hostname(),
  };
  const fd = openSync(path, 'wx'); // O_EXCL — atomic create, throws EEXIST if present
  try {
    writeSync(fd, JSON.stringify(payload));
  } finally {
    closeSync(fd);
  }
}

/**
 * Non-mutating check: is a walk currently in progress for this project
 * (in this process, or a live holder cross-process)? Used by callers
 * that want to bail BEFORE mutating state (e.g. regenerateNode, which
 * invalidates nodes before walking).
 */
export function isWalkLocked(projectDir: string): boolean {
  const key = resolve(projectDir);
  if (heldInProcess.has(key)) return true;
  const path = lockFilePath(key);
  if (!existsSync(path)) return false;
  return !isStaleLock(readLock(path));
}

/**
 * Try to acquire the per-project walk lock. Returns a {@link WalkLock}
 * with `release()` on success, or {@link WalkLockHeld} when a walk is
 * already in progress for this project. Never blocks.
 */
export function acquireWalkLock(projectDir: string): WalkLock | WalkLockHeld {
  const key = resolve(projectDir);

  // Layer 1: same-process.
  if (heldInProcess.has(key)) {
    return { held: true, holder: `another walk in this process (pid ${process.pid})` };
  }

  // Layer 2: cross-process advisory file.
  const path = lockFilePath(key);
  const dir = dheeDir(key);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  try {
    writeLockFile(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // Lock file already exists — reclaim only if stale.
    const existing = readLock(path);
    if (!isStaleLock(existing)) {
      return { held: true, holder: describeHolder(existing) };
    }
    try {
      unlinkSync(path);
      writeLockFile(path);
    } catch {
      // Lost a reclaim race with another acquirer — treat as held.
      return { held: true, holder: describeHolder(readLock(path)) };
    }
  }

  heldInProcess.add(key);
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      heldInProcess.delete(key);
      try {
        unlinkSync(path);
      } catch {
        // Already gone (manual cleanup, reclaim by another process) — fine.
      }
    },
  };
}
