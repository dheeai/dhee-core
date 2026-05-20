/**
 * TDD tests for the ComfyUI active-jobs registry. Failure modes:
 *
 *   FM1. Register → cancel: interrupt() is called for every active job.
 *   FM2. Register → cancel: every job's AbortController is signalled
 *        BEFORE interrupt() — that's the contract that lets the
 *        wait loops wake within milliseconds instead of waiting out
 *        a 10-second poll cycle (the 2026-05-19 Soft Seinen
 *        stuck-Stopping incident).
 *   FM3. cancelAllActiveJobs clears the registry — a follow-on call
 *        finds nothing to cancel.
 *   FM4. Cancel with no active jobs → no-op, returns 0, no throw.
 *   FM5. Multiple jobs in flight → all aborted in parallel,
 *        all interrupts dispatched.
 *   FM6. An interrupt() that throws does NOT prevent others from being
 *        called (Promise.allSettled semantics).
 *   FM7. Unregister removes the job — a later cancel sees it gone.
 *   FM8. Registering the same controller twice is a no-op (Set
 *        semantics — same handle reference).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  _resetActiveJobsForTest,
  cancelAllActiveJobs,
  getActiveJobCount,
  registerActiveJob,
  unregisterActiveJob,
  type CancellableComfyJob,
} from '../../src/services/comfyui/activeJobs.js';

function makeJob(promptId: string, interruptImpl?: () => Promise<void>): CancellableComfyJob {
  return {
    promptId,
    interrupt: interruptImpl ?? (async () => undefined),
    abortController: new AbortController(),
  };
}

afterEach(() => {
  _resetActiveJobsForTest();
});

describe('activeJobs registry', () => {
  it('FM1: cancelAllActiveJobs calls interrupt() on every registered job', async () => {
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    registerActiveJob(makeJob('p1', a));
    registerActiveJob(makeJob('p2', b));

    const n = await cancelAllActiveJobs();

    expect(n).toBe(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('FM2: abort signal is fired BEFORE interrupt() — wait loops wake fast', async () => {
    // The contract: abort fires synchronously inside cancelAllActiveJobs
    // PRIOR to awaiting interrupt(). A wait loop watching the signal
    // can therefore exit immediately, even if interrupt()'s HTTP call
    // stalls (zrok hiccup, slow cloud).
    const order: string[] = [];
    const job: CancellableComfyJob = {
      promptId: 'p1',
      abortController: new AbortController(),
      interrupt: async () => {
        order.push('interrupt');
      },
    };
    job.abortController.signal.addEventListener('abort', () => {
      order.push('abort');
    });
    registerActiveJob(job);

    await cancelAllActiveJobs();

    expect(order[0]).toBe('abort');
    expect(order).toContain('interrupt');
  });

  it('FM2b: each job\'s abortController.signal.aborted is true after cancelAllActiveJobs', async () => {
    const job1 = makeJob('p1');
    const job2 = makeJob('p2');
    registerActiveJob(job1);
    registerActiveJob(job2);

    await cancelAllActiveJobs();

    expect(job1.abortController.signal.aborted).toBe(true);
    expect(job2.abortController.signal.aborted).toBe(true);
  });

  it('FM3: cancelAllActiveJobs clears the registry — second call finds nothing', async () => {
    registerActiveJob(makeJob('p1'));
    registerActiveJob(makeJob('p2'));
    expect(getActiveJobCount()).toBe(2);

    const n1 = await cancelAllActiveJobs();
    expect(n1).toBe(2);
    expect(getActiveJobCount()).toBe(0);

    const n2 = await cancelAllActiveJobs();
    expect(n2).toBe(0);
  });

  it('FM4: cancelAllActiveJobs with no registered jobs → 0, no throw', async () => {
    expect(getActiveJobCount()).toBe(0);
    await expect(cancelAllActiveJobs()).resolves.toBe(0);
  });

  it('FM5: parallel interrupts for many concurrent jobs', async () => {
    const interrupts: number[] = [];
    for (let i = 0; i < 5; i++) {
      const idx = i;
      registerActiveJob(
        makeJob(`p${i}`, async () => {
          interrupts.push(idx);
        }),
      );
    }

    const n = await cancelAllActiveJobs();
    expect(n).toBe(5);
    expect(interrupts).toHaveLength(5);
    // Order isn't guaranteed (Promise.allSettled), but every job
    // should have had its interrupt run.
    expect([...interrupts].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it('FM6: an interrupt that throws does not prevent others from being called', async () => {
    const good = vi.fn(async () => undefined);
    const bad = vi.fn(async () => {
      throw new Error('connection refused');
    });
    registerActiveJob(makeJob('p1', bad));
    registerActiveJob(makeJob('p2', good));

    // Most important assertion: this does NOT throw.
    await expect(cancelAllActiveJobs()).resolves.toBe(2);
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(1);
  });

  it('FM7: unregisterActiveJob removes the job — later cancel sees it gone', async () => {
    const a = vi.fn(async () => undefined);
    const b = vi.fn(async () => undefined);
    const jobA = makeJob('p1', a);
    const jobB = makeJob('p2', b);
    registerActiveJob(jobA);
    registerActiveJob(jobB);

    unregisterActiveJob(jobA);

    const n = await cancelAllActiveJobs();
    expect(n).toBe(1);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('FM8: registering the same handle twice is idempotent (Set semantics)', () => {
    const job = makeJob('p1');
    registerActiveJob(job);
    registerActiveJob(job);
    expect(getActiveJobCount()).toBe(1);
  });
});
