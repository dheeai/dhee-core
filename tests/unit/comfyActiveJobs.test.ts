/**
 * Cancel-all-in-flight-ComfyUI-jobs contract.
 *
 * Pin the behavior the cancel button depends on: every job registered
 * after a successful prompt submission must have `interrupt()` fired
 * when cancelAllActiveJobs() runs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerActiveJob,
  unregisterActiveJob,
  cancelAllActiveJobs,
  getActiveJobCount,
  _resetActiveJobsForTest,
  type CancellableComfyJob,
} from '../../src/services/comfyui/activeJobs.js';

beforeEach(() => {
  _resetActiveJobsForTest();
});

function makeJob(promptId: string): {
  job: CancellableComfyJob;
  interruptCallCount: () => number;
} {
  let count = 0;
  const job: CancellableComfyJob = {
    promptId,
    interrupt: async () => {
      count += 1;
    },
    // Bug B fix (2026-05-20): cancelAllActiveJobs now drains the
    // Comfy queue (POST /queue {clear:true}) in local mode in
    // addition to per-prompt /interrupt. New fields are required on
    // the handle; this helper supplies stub defaults so the older
    // tests below still construct valid handles. The richer
    // dedup/cloud-safety coverage lives in tests/unit/activeJobs.test.ts.
    clearQueue: async () => undefined,
    serverKey: 'http://test-comfy',
    abortController: new AbortController(),
  };
  return { job, interruptCallCount: () => count };
}

describe('cancelAllActiveJobs', () => {
  it('fires interrupt on every registered job', async () => {
    const a = makeJob('p1');
    const b = makeJob('p2');
    const c = makeJob('p3');
    registerActiveJob(a.job);
    registerActiveJob(b.job);
    registerActiveJob(c.job);

    const cancelled = await cancelAllActiveJobs();

    expect(cancelled).toBe(3);
    expect(a.interruptCallCount()).toBe(1);
    expect(b.interruptCallCount()).toBe(1);
    expect(c.interruptCallCount()).toBe(1);
  });

  it('clears the registry after cancel-all', async () => {
    registerActiveJob(makeJob('p1').job);
    registerActiveJob(makeJob('p2').job);
    expect(getActiveJobCount()).toBe(2);

    await cancelAllActiveJobs();

    expect(getActiveJobCount()).toBe(0);
  });

  it('returns 0 and does nothing when no jobs are registered', async () => {
    const cancelled = await cancelAllActiveJobs();
    expect(cancelled).toBe(0);
  });

  it('does not fire interrupt on jobs that were unregistered first (normal completion)', async () => {
    const a = makeJob('p1');
    registerActiveJob(a.job);
    unregisterActiveJob(a.job);

    await cancelAllActiveJobs();

    expect(a.interruptCallCount()).toBe(0);
  });

  it('swallows errors from individual interrupt calls and still attempts all others', async () => {
    const failJob: CancellableComfyJob = {
      promptId: 'p1',
      interrupt: async () => {
        throw new Error('comfy unreachable');
      },
      clearQueue: async () => undefined,
      serverKey: 'http://test-comfy',
      abortController: new AbortController(),
    };
    const ok = makeJob('p2');
    registerActiveJob(failJob);
    registerActiveJob(ok.job);

    // Must not throw — cancel paths cannot fail.
    await expect(cancelAllActiveJobs()).resolves.toBe(2);
    // The OK job still got interrupted despite the other failing.
    expect(ok.interruptCallCount()).toBe(1);
  });
});
