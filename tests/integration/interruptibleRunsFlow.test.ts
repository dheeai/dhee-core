/**
 * Interruptible-runs integration — the start_run / stop_run tools driven
 * against a REAL BackgroundTaskRunner with a stub executor (no LLM, no
 * GPU, no walker). Validates the integration the unit tests stubbed:
 *
 *   - dhee_start_run dispatches and returns IMMEDIATELY while the
 *     executor is still running in the background (non-blocking).
 *   - dhee_start_run on an already-active runner is rejected
 *     (single-flight), exactly as the agent would see mid-run.
 *   - dhee_stop_run aborts AND awaits the runner's cancelled event, so
 *     the slot is genuinely free afterward.
 *   - stop → start sequencing works against the real runner: a start
 *     issued right after stop_run returns is accepted (not rejected).
 *
 * This is the e2e seam between the agent tools and the real runner
 * semantics (cancel / single-flight / terminal events), without the
 * flaky LLM + Comfy/zrok layer.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BackgroundTaskRunner } from '../../src/server/runners/BackgroundTaskRunner.js';
import { makeStartRunTool } from '../../src/agent/pi/tools/dheeStartRun.js';
import { makeStopRunTool } from '../../src/agent/pi/tools/dheeStopRun.js';

interface ToolLike {
  execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'irun-'));
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'x', bundleSource: 'built-in:b' }));
  return dir;
}

/**
 * A stub executor that "runs" until aborted. Resolves naturally only
 * if `holdMs` elapses; honors the abort signal by returning promptly.
 * Lets us model an in-flight run we can interrupt deterministically.
 */
function makeHoldingExecutor() {
  let started = 0;
  const executor = (ctx: { signal: AbortSignal }) =>
    new Promise<void>((resolve) => {
      started++;
      if (ctx.signal.aborted) return resolve();
      const onAbort = () => {
        ctx.signal.removeEventListener('abort', onAbort);
        resolve(); // executor returns → runner emits 'cancelled' (signal.aborted)
      };
      ctx.signal.addEventListener('abort', onAbort);
    });
  return { executor, startedCount: () => started };
}

describe('interruptible runs — tools × real BackgroundTaskRunner', () => {
  const made: string[] = [];
  const cleanup = () => made.forEach((d) => rmSync(d, { recursive: true, force: true }));

  it('start_run is non-blocking: returns while the executor is still running', async () => {
    const dir = tmpProject(); made.push(dir);
    const { executor, startedCount } = makeHoldingExecutor();
    const runner = new BackgroundTaskRunner(executor);
    const start = makeStartRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;

    const out = await start.execute('t', { projectDir: dir, sessionId: 'chat-1' });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/background/i);
    // The executor is still holding (not resolved) — proves the tool
    // returned without waiting for the run to finish.
    expect(startedCount()).toBe(1);

    runner.cancel(); // clean up the holding executor
    cleanup();
  });

  it('start_run while a run is active → rejected (single-flight)', async () => {
    const dir = tmpProject(); made.push(dir);
    const { executor } = makeHoldingExecutor();
    const runner = new BackgroundTaskRunner(executor);
    const start = makeStartRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;

    await start.execute('t', { projectDir: dir });
    const second = await start.execute('t', { projectDir: dir });
    expect(second.isError).toBe(true);
    expect(second.content[0].text).toMatch(/already in flight|dhee_stop_run/i);

    runner.cancel();
    cleanup();
  });

  it('stop_run aborts + awaits, then a follow-up start_run is accepted (slot freed)', async () => {
    const dir = tmpProject(); made.push(dir);
    const { executor, startedCount } = makeHoldingExecutor();
    const runner = new BackgroundTaskRunner(executor);
    const start = makeStartRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    const stop = makeStopRunTool({ getBackgroundTaskRunner: () => runner as never, cancelTimeoutMs: 2000 }) as unknown as ToolLike;

    // 1. start a run (holds open)
    const s1 = await start.execute('t', { projectDir: dir });
    expect(s1.isError).toBeFalsy();

    // 2. stop it — must await the real 'cancelled' event
    const stopped = await stop.execute('t', {});
    expect(stopped.content[0].text).toMatch(/stopped/i);

    // 3. a follow-up start is NOT rejected — the single-flight slot
    //    actually freed because stop_run waited for cancellation.
    const s2 = await start.execute('t', { projectDir: dir });
    expect(s2.isError).toBeFalsy();
    expect(startedCount()).toBe(2); // two real dispatches went through

    runner.cancel();
    cleanup();
  });

  it('stop_run with no active run → reports nothing to stop (no hang)', async () => {
    const { executor } = makeHoldingExecutor();
    const runner = new BackgroundTaskRunner(executor);
    const stop = makeStopRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    const out = await stop.execute('t', {});
    expect(out.content[0].text).toMatch(/nothing to stop|no bundle run/i);
    cleanup();
  });
});
