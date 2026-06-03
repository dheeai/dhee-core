/**
 * Walker cooperative cancellation (the 2026-06-03 stop_run gap).
 *
 * stop_run → BackgroundTaskRunner.cancel() aborts the walker's signal.
 * The walker must NOT dispatch the next node once the signal is aborted
 * — the field symptom was "scene_clip:chunk_1 completed, chunk_2 STARTED"
 * after a stop, because the node loop checked stopAt but never the abort
 * signal.
 *
 * These tests CALL walkBundle with a recording stub runner and a real
 * AbortController:
 *   1. Abort mid-walk (during node n1) → n2/n3/goal never run; result is
 *      not-ok with a "cancelled" error.
 *   2. Pre-aborted signal → no node runs at all.
 *   3. Sanity: no signal → the whole chain runs (guards against the
 *      check accidentally halting normal walks).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner } from '../../src/dag/schema.js';

const ran: string[] = [];
let controller: AbortController;
/** Node id whose runner should fire controller.abort() while "in flight". */
let abortDuring: string | null = null;

function recordingRunner(): Runner {
  return {
    describe: () => ({
      id: 'stub.rec',
      displayName: 'rec',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      ran.push(ctx.node.id);
      // Simulate stop_run landing while THIS node is rendering: the
      // node still completes, but the walker must not advance past it.
      if (abortDuring && ctx.node.id === abortDuring) controller.abort();
      const out = ctx.node.outputs.pattern;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, 'x');
      return { ok: true, outputPath: out };
    },
  };
}

let projectDir: string;
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'walker-abort-'));
  ran.length = 0;
  controller = new AbortController();
  abortDuring = null;
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.rec', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    recordingRunner(),
  );
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

const LINEAR_BUNDLE: DagBundle = {
  id: 'lin',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  goal: 'final',
  nodes: [
    { id: 'n1', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'n1.md' }, runner: { tool: 'stub.rec', config: {} } },
    { id: 'n2', kind: 'stage', inputs: [{ from: 'n1', usage: 'context' }], outputs: { format: 'md', pattern: 'n2.md' }, runner: { tool: 'stub.rec', config: {} } },
    { id: 'n3', kind: 'stage', inputs: [{ from: 'n2', usage: 'context' }], outputs: { format: 'md', pattern: 'n3.md' }, runner: { tool: 'stub.rec', config: {} } },
    { id: 'final', kind: 'stage', inputs: [{ from: 'n3', usage: 'context' }], outputs: { format: 'video', pattern: 'final.mp4' }, runner: { tool: 'stub.rec', config: {} } },
  ],
};

describe('walker honors the abort signal', () => {
  it('aborting during n1 stops the walk before n2 (no later nodes run)', async () => {
    abortDuring = 'n1';
    const r = await walkBundle({
      projectDir,
      bundle: LINEAR_BUNDLE,
      bundleSource: 'built-in:lin',
      signal: controller.signal,
    });
    expect(ran).toEqual(['n1']); // n2, n3, final never dispatched
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cancel/i);
  });

  it('a pre-aborted signal runs nothing', async () => {
    controller.abort();
    const r = await walkBundle({
      projectDir,
      bundle: LINEAR_BUNDLE,
      bundleSource: 'built-in:lin',
      signal: controller.signal,
    });
    expect(ran).toEqual([]);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cancel/i);
  });

  it('sanity: with no abort, the whole chain runs to the goal', async () => {
    const r = await walkBundle({
      projectDir,
      bundle: LINEAR_BUNDLE,
      bundleSource: 'built-in:lin',
      signal: controller.signal, // never aborted
    });
    expect(ran.sort()).toEqual(['final', 'n1', 'n2', 'n3']);
    expect(r.ok).toBe(true);
  });
});
