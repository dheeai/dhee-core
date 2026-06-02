/**
 * dhee_start_run + dhee_stop_run — the interactive run-control tools.
 *
 * dhee_start_run: NON-BLOCKING dispatch. Returns immediately after the
 * runner accepts the task; never awaits a terminal event.
 *
 * dhee_stop_run: aborts the active run AND awaits the runner's
 * cancelled (or natural terminal) event before returning, so a
 * follow-up dhee_start_run isn't rejected by single-flight.
 *
 * Failure modes:
 *   start_run:
 *     1. fresh project → started, taskId in the message, no terminal-event await.
 *     2. runner rejects (run already active) → isError, names the active task.
 *     3. missing project.json → error.
 *     4. sessionId threaded into dispatch when provided.
 *   stop_run:
 *     5. active run → cancel() called, resolves after 'cancelled', stopped message.
 *     6. nothing active (cancel returns false) → "nothing to stop", no hang.
 *     7. cancel never confirms within timeout → returns a timeout note (no hang).
 *     8. run races to 'completed' before cancel lands → reports that, no error.
 *     9. stop→start sequencing: after stop resolves, the slot is free.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeStartRunTool } from '../../src/agent/pi/tools/dheeStartRun.js';
import { makeStopRunTool } from '../../src/agent/pi/tools/dheeStopRun.js';

interface ToolLike {
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function tmpProject(withJson = true): string {
  const dir = mkdtempSync(join(tmpdir(), 'startstop-'));
  if (withJson) writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'x', bundleSource: 'built-in:b' }));
  return dir;
}

// ── start_run stub runner ────────────────────────────────────────────

interface DispatchCall {
  sessionId: string;
  params: { projectDir: string; stage?: string; runOnly?: string[] };
}

function startRunner(result: { status: 'started'; taskId: string } | { status: 'rejected'; reason: string; activeTaskId: string; activeProjectName: string }) {
  const calls: DispatchCall[] = [];
  return {
    calls,
    dispatch(spec: { kind: string; projectName: string; params: DispatchCall['params']; sessionId: string }) {
      calls.push({ sessionId: spec.sessionId, params: spec.params });
      return result;
    },
  };
}

describe('dhee_start_run (non-blocking)', () => {
  const made: string[] = [];
  const cleanup = () => made.forEach((d) => rmSync(d, { recursive: true, force: true }));

  it('1. fresh project → started, taskId in message, returns without awaiting terminal event', async () => {
    const dir = tmpProject(); made.push(dir);
    const runner = startRunner({ status: 'started', taskId: 'task-1' });
    const tool = makeStartRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    // If start_run awaited a terminal event, this promise would never
    // resolve (the stub emits none). Resolving at all proves non-blocking.
    const out = await tool.execute('t', { projectDir: dir });
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toContain('task-1');
    expect(out.content[0].text).toMatch(/background/i);
    cleanup();
  });

  it('2. runner rejects (active run) → isError naming the active task', async () => {
    const dir = tmpProject(); made.push(dir);
    const runner = startRunner({ status: 'rejected', reason: 'task_already_running', activeTaskId: 'task-9', activeProjectName: 'other' });
    const tool = makeStartRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    const out = await tool.execute('t', { projectDir: dir });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toContain('task-9');
    expect(out.content[0].text).toMatch(/dhee_stop_run/);
    cleanup();
  });

  it('3. missing project.json → error', async () => {
    const dir = tmpProject(false); made.push(dir);
    const runner = startRunner({ status: 'started', taskId: 't' });
    const tool = makeStartRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    const out = await tool.execute('t', { projectDir: dir });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/project\.json not found/i);
    cleanup();
  });

  it('4. sessionId threaded into dispatch when provided', async () => {
    const dir = tmpProject(); made.push(dir);
    const runner = startRunner({ status: 'started', taskId: 't' });
    const tool = makeStartRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    await tool.execute('t', { projectDir: dir, sessionId: 'chat-abc', runOnly: ['shot_image'] });
    expect(runner.calls[0]!.sessionId).toBe('chat-abc');
    expect(runner.calls[0]!.params.runOnly).toEqual(['shot_image']);
    cleanup();
  });

  it('4b. no sessionId → falls back to a project-tagged id (headless)', async () => {
    const dir = tmpProject(); made.push(dir);
    const runner = startRunner({ status: 'started', taskId: 't' });
    const tool = makeStartRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    await tool.execute('t', { projectDir: dir });
    expect(runner.calls[0]!.sessionId).toMatch(/^dhee_start_run:/);
    cleanup();
  });
});

// ── stop_run stub runner ─────────────────────────────────────────────

type Handler = () => void;
function stopRunner(opts: { active: boolean; emitOnCancel?: 'cancelled' | 'completed' | 'failed' | null }) {
  const handlers: Record<string, Handler[]> = { cancelled: [], completed: [], failed: [] };
  let cancelCalls = 0;
  return {
    cancelCalls: () => cancelCalls,
    on(event: 'cancelled' | 'completed' | 'failed', h: Handler) {
      handlers[event]!.push(h);
      return () => {
        handlers[event] = handlers[event]!.filter((x) => x !== h);
      };
    },
    cancel() {
      cancelCalls++;
      if (!opts.active) return false;
      // Simulate the runner emitting its terminal event asynchronously
      // after the abort propagates.
      const ev = opts.emitOnCancel;
      if (ev) {
        setTimeout(() => handlers[ev]!.forEach((h) => h()), 5);
      }
      return true;
    },
  };
}

describe('dhee_stop_run (abort + await)', () => {
  it('5. active run → cancel called, resolves after cancelled, stopped message', async () => {
    const runner = stopRunner({ active: true, emitOnCancel: 'cancelled' });
    const tool = makeStopRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    const out = await tool.execute('t', {});
    expect(runner.cancelCalls()).toBe(1);
    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/stopped/i);
  });

  it('6. nothing active → "nothing to stop", no hang', async () => {
    const runner = stopRunner({ active: false });
    const tool = makeStopRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    const out = await tool.execute('t', {});
    expect(out.content[0].text).toMatch(/nothing to stop|no bundle run/i);
  });

  it('7. cancel never confirms within timeout → timeout note, no hang', async () => {
    const runner = stopRunner({ active: true, emitOnCancel: null }); // never emits
    const tool = makeStopRunTool({
      getBackgroundTaskRunner: () => runner as never,
      cancelTimeoutMs: 20,
    }) as unknown as ToolLike;
    const out = await tool.execute('t', {});
    expect(out.content[0].text).toMatch(/did not confirm|timeout|aborting/i);
  });

  it('8. run races to completed before cancel lands → reports it, no error', async () => {
    const runner = stopRunner({ active: true, emitOnCancel: 'completed' });
    const tool = makeStopRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    const out = await tool.execute('t', {});
    expect(out.content[0].text).toMatch(/completed/i);
  });

  it('9. stop→start sequencing: stop resolves before a follow-up start dispatches', async () => {
    // Model the single-flight slot: active until cancel resolves.
    let slotBusy = true;
    const handlers: Handler[] = [];
    const runner = {
      on(event: string, h: Handler) {
        if (event === 'cancelled') handlers.push(h);
        return () => undefined;
      },
      cancel() {
        if (!slotBusy) return false;
        setTimeout(() => {
          slotBusy = false; // slot frees
          handlers.forEach((h) => h());
        }, 5);
        return true;
      },
    };
    const stop = makeStopRunTool({ getBackgroundTaskRunner: () => runner as never }) as unknown as ToolLike;
    await stop.execute('t', {});
    // After stop resolves, the slot must be free so a start would not be rejected.
    expect(slotBusy).toBe(false);
  });
});
