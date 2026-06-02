/**
 * retryTransient — Comfy-tunnel-aware retry helper.
 *
 * Failure modes covered:
 *   1. Happy path: op succeeds first try → returns once.
 *   2. Transient 502 then success → retries, returns success on 2nd try.
 *   3. Transient on every attempt → throws after `attempts` with a
 *      message naming the attempt count + the final underlying error.
 *   4. Permanent error (e.g. 400/403/malformed) → bubbles immediately,
 *      NO retries burned.
 *   5. Honors AbortSignal between attempts.
 *   6. Backoff sequence is consulted (delays grow per attempt).
 *   7. isTransientError classifier picks up the canonical markers.
 */
import { describe, it, expect, vi } from 'vitest';
import { isTransientError, retryTransient } from '../../src/dag/runners/transientRetry.js';

describe('isTransientError', () => {
  it('matches 502 Bad Gateway', () => {
    expect(isTransientError(new Error('Failed: 502 Bad Gateway'))).toBe(true);
  });
  it('matches Gateway Time-out (zrok form)', () => {
    expect(isTransientError(new Error('Failed to upload image: Gateway Time-out'))).toBe(true);
  });
  it('matches ECONNRESET', () => {
    expect(isTransientError(new Error('ECONNRESET: socket disconnected'))).toBe(true);
  });
  it('matches "fetch failed"', () => {
    expect(isTransientError(new Error('fetch failed: cause ETIMEDOUT'))).toBe(true);
  });
  it('does NOT match 400 / 403 / 422', () => {
    expect(isTransientError(new Error('HTTP 400 — bad request'))).toBe(false);
    expect(isTransientError(new Error('HTTP 403 — forbidden'))).toBe(false);
    expect(isTransientError(new Error('HTTP 422 — unprocessable entity'))).toBe(false);
  });
  it('does NOT match arbitrary errors', () => {
    expect(isTransientError(new Error('node 999 not found in workflow'))).toBe(false);
  });
  it('treats nullish / undefined as not-transient', () => {
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError(null)).toBe(false);
  });
});

describe('retryTransient', () => {
  const fakeSleep = vi.fn(async () => {});

  it('1. returns on first success without retrying', async () => {
    const op = vi.fn(async () => 'ok');
    const r = await retryTransient(op, { sleep: fakeSleep });
    expect(r).toBe('ok');
    expect(op).toHaveBeenCalledTimes(1);
    expect(fakeSleep).not.toHaveBeenCalled();
  });

  it('2. transient → success on 2nd attempt', async () => {
    let n = 0;
    const op = async () => {
      n++;
      if (n < 2) throw new Error('502 Bad Gateway');
      return 'ok';
    };
    const r = await retryTransient(op, { sleep: fakeSleep });
    expect(r).toBe('ok');
    expect(n).toBe(2);
    expect(fakeSleep).toHaveBeenCalled();
  });

  it('3. transient every attempt → throws with attempt count + final cause', async () => {
    const op = vi.fn(async () => {
      throw new Error('Failed to upload image: Gateway Time-out');
    });
    await expect(
      retryTransient(op, { sleep: fakeSleep, attempts: 3, label: 'comfy.upload' }),
    ).rejects.toThrow(/comfy\.upload: transient upstream error after 3 attempts/);
    expect(op).toHaveBeenCalledTimes(3);
  });

  it('4. permanent error bubbles immediately — no retries', async () => {
    const op = vi.fn(async () => {
      throw new Error('node 999 not found in workflow');
    });
    await expect(retryTransient(op, { sleep: fakeSleep, attempts: 3 })).rejects.toThrow(
      'node 999 not found in workflow',
    );
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('5. honors AbortSignal between attempts', async () => {
    const ac = new AbortController();
    const op = vi.fn(async () => {
      ac.abort(); // abort after the first throw
      throw new Error('502');
    });
    await expect(
      retryTransient(op, { sleep: fakeSleep, attempts: 3, signal: ac.signal, label: 'q' }),
    ).rejects.toThrow(/q: aborted during retry backoff/);
    expect(op).toHaveBeenCalledTimes(1);
  });

  it('6. backoff delays grow per attempt index', async () => {
    const delays: number[] = [];
    const sleep = async (ms: number) => {
      delays.push(ms);
    };
    let n = 0;
    const op = async () => {
      n++;
      throw new Error('504');
    };
    await expect(
      retryTransient(op, { sleep, attempts: 3, backoffMs: [0, 100, 500] }),
    ).rejects.toBeDefined();
    // 3 attempts → 2 backoff calls (between att 1→2 and 2→3).
    expect(delays).toEqual([100, 500]);
    expect(n).toBe(3);
  });

  it('7. custom isTransient classifier wins over the default', async () => {
    const op = vi.fn(async () => {
      throw new Error('quack');
    });
    // Default says "quack" isn't transient; force it via the override.
    await expect(
      retryTransient(op, {
        sleep: fakeSleep,
        attempts: 2,
        isTransient: () => true,
      }),
    ).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(2);
  });
});
