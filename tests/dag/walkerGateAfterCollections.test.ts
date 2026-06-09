/**
 * gateAfterCollections — the walker's stop-after-each-collection gate.
 *
 * Behavior pinned here:
 *   (a) Gate ON: a walk halts right after a collection node finishes
 *       (its instances ran), reporting `gatedAfter`. Downstream stays
 *       unrun.
 *   (b) Resume: a second walk on the same project cache-skips the now-
 *       complete collection (no new work → no re-gate) and runs through
 *       to the goal.
 *   (c) Gate OFF (default): the walk runs straight to the goal in one
 *       pass.
 *   (d) When the collection IS the goal, completing it finishes the run
 *       — it never gates.
 *
 * Bundle shape: upstream(stage) → fanout(collection, items a/b/c) →
 * final(stage, goal).
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

let ran: string[] = [];

/** Records each (node[:item]) it runs; upstream emits the fan-out items. */
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
      ran.push(ctx.itemId ? `${ctx.node.id}:${ctx.itemId}` : ctx.node.id);
      const out = ctx.node.outputs.pattern.replace(/\{\{item_id\}\}/g, ctx.itemId ?? '');
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      const content =
        ctx.node.id === 'upstream'
          ? JSON.stringify({ items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] })
          : 'x';
      writeFileSync(abs, content);
      return { ok: true, outputPath: out };
    },
  };
}

let projectDir: string;
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'gate-coll-'));
  ran = [];
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

const BUNDLE: DagBundle = {
  id: 'gate',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  goal: 'final',
  nodes: [
    {
      id: 'upstream',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'json', pattern: 'upstream.json' },
      runner: { tool: 'stub.rec', config: {} },
    },
    {
      id: 'fanout',
      kind: 'collection',
      itemSource: 'upstream',
      inputs: [{ from: 'upstream', usage: 'input' }],
      outputs: { format: 'json', pattern: 'fanout/{{item_id}}.json' },
      runner: { tool: 'stub.rec', config: {} },
    },
    {
      id: 'final',
      kind: 'stage',
      inputs: [{ from: 'fanout', usage: 'context' }],
      outputs: { format: 'video', pattern: 'final.mp4' },
      runner: { tool: 'stub.rec', config: {} },
    },
  ],
};

describe('gateAfterCollections', () => {
  it('(a) halts right after the collection node, leaving the goal unrun', async () => {
    const r = await walkBundle({
      projectDir,
      bundle: BUNDLE,
      bundleSource: 'built-in:gate',
      gateAfterCollections: true,
    });
    expect(r.ok).toBe(true);
    expect(r.gatedAfter).toBe('fanout');
    expect(r.goal).toBeUndefined();
    // The unrun downstream tail is reported so the caller can say
    // exactly what's pending behind the gate (issue #133).
    expect(r.pendingAfterGate).toEqual(['final']);
    // upstream + all three fan-out items ran; final did NOT.
    expect(ran.sort()).toEqual(['fanout:a', 'fanout:b', 'fanout:c', 'upstream']);
    expect(ran).not.toContain('final');
  });

  it('(b) resume cache-skips the collection (no re-gate) and reaches the goal', async () => {
    // First pass gates after fanout.
    const first = await walkBundle({
      projectDir,
      bundle: BUNDLE,
      bundleSource: 'built-in:gate',
      gateAfterCollections: true,
    });
    expect(first.gatedAfter).toBe('fanout');

    // Resume: same project, gate still on. The completed collection is
    // cache-skipped (does no work → must not re-gate), so the walk runs
    // through to the goal.
    ran = [];
    const second = await walkBundle({
      projectDir,
      bundle: BUNDLE,
      bundleSource: 'built-in:gate',
      gateAfterCollections: true,
    });
    expect(second.ok).toBe(true);
    expect(second.gatedAfter).toBeUndefined();
    expect(second.goal?.outputRel).toBe('final.mp4');
    // Only `final` ran on resume — upstream + fanout were cache-skipped.
    expect(ran).toEqual(['final']);
  });

  it('(c) gate off (default) runs straight to the goal in one pass', async () => {
    const r = await walkBundle({
      projectDir,
      bundle: BUNDLE,
      bundleSource: 'built-in:gate',
    });
    expect(r.ok).toBe(true);
    expect(r.gatedAfter).toBeUndefined();
    expect(r.goal?.outputRel).toBe('final.mp4');
    expect(ran).toContain('final');
  });

  it('(d) never gates when the collection is the bundle goal', async () => {
    const goalIsCollection: DagBundle = {
      ...BUNDLE,
      goal: 'fanout',
      nodes: BUNDLE.nodes.filter((n) => n.id !== 'final'),
    };
    const r = await walkBundle({
      projectDir,
      bundle: goalIsCollection,
      bundleSource: 'built-in:gate',
      gateAfterCollections: true,
    });
    expect(r.ok).toBe(true);
    expect(r.gatedAfter).toBeUndefined();
    // The goal collection completed — the run is done, not paused.
    expect(ran.sort()).toEqual(['fanout:a', 'fanout:b', 'fanout:c', 'upstream']);
  });
});
