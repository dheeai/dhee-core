/**
 * Gated-run terminal-event integration (issue #133) — drives the REAL
 * production runner singleton (which wires `executeRunTo` →
 * runProjectViaBundle → walker) against a project whose
 * stop-after-each-collection gate is ON, and asserts the terminal
 * `completed` event carries the gate reason.
 *
 * This is the structural signal BOTH run-completion consumers depend on:
 *   - dhee-desktop's non-blocking re-wake nudge (dheeCoreManager
 *     .onRunTerminal reads `task.gatedAfter`), and
 *   - any future headless consumer.
 *
 * The bug it pins (issue #133): without the gate reason on the event, a
 * gated pause is indistinguishable from an end-to-end finish, and the
 * agent confabulates why downstream produced nothing ("ComfyUI likely
 * not configured"). Here we prove the real singleton stamps
 * `gatedAfter` + `pendingAfterGate` onto the `completed` event when the
 * walk pauses on the gate.
 *
 * (There is intentionally no blocking "run and wait" agent tool — the
 * agent always dispatches via the non-blocking dhee_start_run and reacts
 * to this terminal event. The singleton path under test is the one both
 * dhee_start_run and the desktop re-wake share.)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getBackgroundTaskRunner,
  __resetBackgroundTaskRunnerForTesting,
} from '../../src/server/runners/backgroundTaskRunnerSingleton.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { Runner } from '../../src/dag/schema.js';

/** Item-aware stub: upstream emits the fan-out items; the rest write a stub file. */
function fanRunner(): Runner {
  return {
    describe: () => ({
      id: 'test.fan',
      displayName: 'fan',
      description: 'test',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      const out = ctx.node.outputs.pattern.replace(/\{\{item_id\}\}/g, ctx.itemId ?? '');
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(
        abs,
        ctx.node.id === 'upstream'
          ? JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }] })
          : 'x',
      );
      return { ok: true, outputPath: out };
    },
  };
}

describe('gated-run terminal event — real BackgroundTaskRunner singleton', () => {
  let projectDir: string;
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    __resetBackgroundTaskRunnerForTesting();
    __resetGlobalRegistryForTesting();
    getGlobalRegistry().register(
      { tool: 'test.fan', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      fanRunner(),
    );

    tmpHome = mkdtempSync(join(tmpdir(), 'gated-home-'));
    origHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;

    // A user-scheme bundle: upstream(stage) → fanout(collection) → final(goal).
    const bundleDir = join(tmpHome, '.dhee/bundles', 'test_gate_e2e');
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, 'bundle.json'),
      JSON.stringify({
        id: 'test_gate_e2e',
        version: '0.1.0',
        engineCompat: '>=0.1.0',
        goal: 'final',
        dependencies: { runners: { 'test.fan': '>=0.1.0' } },
        nodes: [
          {
            id: 'upstream',
            kind: 'stage',
            inputs: [],
            outputs: { format: 'json', pattern: 'upstream.json' },
            runner: { tool: 'test.fan', config: {} },
          },
          {
            id: 'fanout',
            kind: 'collection',
            itemSource: 'upstream',
            inputs: [{ from: 'upstream', usage: 'input' }],
            outputs: { format: 'json', pattern: 'fanout/{{item_id}}.json' },
            runner: { tool: 'test.fan', config: {} },
          },
          {
            id: 'final',
            kind: 'stage',
            inputs: [{ from: 'fanout', usage: 'context' }],
            outputs: { format: 'video', pattern: 'final.mp4' },
            runner: { tool: 'test.fan', config: {} },
          },
        ],
      }),
    );

    projectDir = mkdtempSync(join(tmpdir(), 'gated-proj-'));
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        bundleSource: 'user:test_gate_e2e',
        // The per-project flag the desktop's "Stop after each collection" toggle writes.
        features: { gateAfterCollections: true },
      }),
    );
  });

  afterEach(() => {
    __resetBackgroundTaskRunnerForTesting();
    __resetGlobalRegistryForTesting();
    if (origHome !== undefined) process.env['HOME'] = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('stamps gatedAfter + pendingAfterGate onto the completed event when the walk pauses on the gate', async () => {
    const runner = getBackgroundTaskRunner();

    const terminal = new Promise<{ gatedAfter?: string; pendingAfterGate?: string[] }>(
      (resolve, reject) => {
        runner.on('completed', (e: { task: { gatedAfter?: string; pendingAfterGate?: string[] } }) => {
          resolve({
            ...(e.task.gatedAfter !== undefined ? { gatedAfter: e.task.gatedAfter } : {}),
            ...(e.task.pendingAfterGate !== undefined
              ? { pendingAfterGate: e.task.pendingAfterGate }
              : {}),
          });
        });
        // A gated pause classifies as `completed`, never failed/cancelled —
        // fail loudly if it does, so a regression here can't pass silently.
        runner.on('failed', (e: { error?: string }) => reject(new Error(`run failed: ${e.error}`)));
        runner.on('cancelled', () => reject(new Error('run cancelled unexpectedly')));
      },
    );

    const dispatch = runner.dispatch({
      kind: 'run_to',
      projectName: 'gated-proj',
      params: { projectDir },
      sessionId: 'test-gated',
    });
    expect(dispatch.status).toBe('started');

    const task = await terminal;
    // The run paused on the gate, by design — and said so on the event.
    expect(task.gatedAfter).toBe('fanout');
    // …and named the unrun downstream tail, resolved through the full stack.
    expect(task.pendingAfterGate).toEqual(['final']);
  });
});
