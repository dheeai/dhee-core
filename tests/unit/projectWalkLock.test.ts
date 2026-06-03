/**
 * projectWalkLock + walkBundle single-flight guard.
 *
 * Exercises the fix for the 2026-06-03 concurrency incident: two walks
 * of the same project could run at once (dhee_regenerate_node bypassed
 * the BackgroundTaskRunner's single-flight guard), corrupting the event
 * log + walkState. The fix is a per-project lock at the walkBundle
 * chokepoint.
 *
 * These tests CALL the real functions (no source grepping):
 *   1. acquire → second acquire on same project is rejected (held).
 *   2. release → can re-acquire.
 *   3. different projects acquire independently.
 *   4. isWalkLocked reflects held state.
 *   5. a stale lock file (dead holder pid) is reclaimed.
 *   6. walkBundle returns ok:false "already in progress" when the lock
 *      is pre-held.
 *   7. walkBundle RELEASES the lock when it finishes (even on an early
 *      error return), so a subsequent walk can acquire.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import {
  acquireWalkLock,
  isWalkLocked,
  isWalkLockResult,
  type WalkLock,
} from '../../src/dag/projectWalkLock.js';
import { dheeDir } from '../../src/dag/eventLog/eventLogPath.js';
import { walkBundle } from '../../src/dag/walker.js';
import type { DagBundle } from '../../src/dag/schema.js';

describe('projectWalkLock', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'walklock-test-'));
    dirs.push(d);
    return d;
  }

  it('rejects a second concurrent acquire on the same project', () => {
    const dir = tmp();
    const a = acquireWalkLock(dir);
    expect(isWalkLockResult(a)).toBe(false);

    const b = acquireWalkLock(dir);
    expect(isWalkLockResult(b)).toBe(true);
    if (isWalkLockResult(b)) expect(b.holder).toMatch(/this process/);

    (a as WalkLock).release();
  });

  it('allows re-acquire after release', () => {
    const dir = tmp();
    const a = acquireWalkLock(dir);
    expect(isWalkLockResult(a)).toBe(false);
    (a as WalkLock).release();

    const b = acquireWalkLock(dir);
    expect(isWalkLockResult(b)).toBe(false);
    (b as WalkLock).release();
  });

  it('locks are independent per project', () => {
    const d1 = tmp();
    const d2 = tmp();
    const a = acquireWalkLock(d1);
    const b = acquireWalkLock(d2);
    expect(isWalkLockResult(a)).toBe(false);
    expect(isWalkLockResult(b)).toBe(false);
    (a as WalkLock).release();
    (b as WalkLock).release();
  });

  it('isWalkLocked reflects the held state', () => {
    const dir = tmp();
    expect(isWalkLocked(dir)).toBe(false);
    const a = acquireWalkLock(dir);
    expect(isWalkLocked(dir)).toBe(true);
    (a as WalkLock).release();
    expect(isWalkLocked(dir)).toBe(false);
  });

  it('reclaims a stale lock file whose holder pid is dead', () => {
    const dir = tmp();
    // A pid that is essentially guaranteed not to exist.
    mkdirSync(dheeDir(dir), { recursive: true });
    const deadLock = { pid: 2_000_000_000, startedAt: Date.now(), host: hostname() };
    writeFileSync(join(dheeDir(dir), '.walk.lock'), JSON.stringify(deadLock), 'utf8');
    expect(isWalkLocked(dir)).toBe(false); // dead holder → not locked

    const a = acquireWalkLock(dir); // should reclaim and succeed
    expect(isWalkLockResult(a)).toBe(false);
    (a as WalkLock).release();
  });

  it('walkBundle rejects when the project lock is already held', async () => {
    const dir = tmp();
    const held = acquireWalkLock(dir);
    expect(isWalkLockResult(held)).toBe(false);

    const minimalBundle = { id: 't', version: '0.0.0', nodes: [] } as unknown as DagBundle;
    const result = await walkBundle({ projectDir: dir, bundle: minimalBundle, log: () => {} });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already in progress/i);

    (held as WalkLock).release();
  });

  it('walkBundle releases the lock when it finishes (early error path)', async () => {
    const dir = tmp();
    const minimalBundle = { id: 't', version: '0.0.0', nodes: [] } as unknown as DagBundle;

    // stopAt references a node not in the (empty) bundle → walkBundleOnce
    // returns ok:false quickly, AFTER the lock was acquired. The finally
    // must still release it.
    const result = await walkBundle({
      projectDir: dir,
      bundle: minimalBundle,
      stopAt: 'does_not_exist',
      log: () => {},
    });
    expect(result.ok).toBe(false);

    // Lock released → a fresh acquire succeeds and no lock file lingers.
    expect(isWalkLocked(dir)).toBe(false);
    expect(existsSync(join(dheeDir(dir), '.walk.lock'))).toBe(false);
    const a = acquireWalkLock(dir);
    expect(isWalkLockResult(a)).toBe(false);
    (a as WalkLock).release();
  });
});
