/**
 * Layer 2 — opt-in collection concurrency.
 *
 * The walker's collection instance loop runs serially today (one
 * `await runner.run(ctx)` at a time). This adds an OPT-IN bounded
 * promise-pool: `node.runner.config.concurrency` (else
 * `DHEE_COLLECTION_CONCURRENCY`, else `1`) instances may run at once.
 *
 * Hard guards — concurrency clamps to 1 regardless of config when:
 *   - the node's tool does not start with `llm.` (GPU/ffmpeg/comfy/cv/vlm
 *     stay serial — they may be resource-constrained in ways an LLM call
 *     isn't), OR
 *   - the node has any `scope==='previousN'` input (those instances have
 *     an inter-instance data dependency: each one reads the PRIOR
 *     instance's completed output).
 *
 * Default (no concurrency configured) MUST remain strictly serial — many
 * existing bundles depend on that today.
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
import type { DagBundle, Runner, RunnerContext } from '../../src/dag/schema.js';

let projectDir: string;

// Shared instrumentation the tracking runner writes into. Reset each test.
let inFlight = 0;
let maxInFlight = 0;
let startOrder: string[] = [];
let finishOrder: string[] = [];
const DELAY_MS = 25;

function makeTrackingRunner(tool: string): Runner {
  return {
    describe: () => ({
      id: tool,
      displayName: 'stub',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx: RunnerContext) {
      const itemId = ctx.itemId ?? 'none';
      startOrder.push(itemId);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, DELAY_MS));
      inFlight--;
      finishOrder.push(itemId);
      const out = (ctx.node.runner.config as Record<string, unknown>)['outputPath'] as string;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, JSON.stringify({ itemId }));
      return { ok: true, outputPath: out };
    },
  };
}

function makeItemsSourceRunner(n: number): Runner {
  return {
    describe: () => ({
      id: 'stub.items',
      displayName: 'stub',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx: RunnerContext) {
      const out = (ctx.node.runner.config as Record<string, unknown>)['outputPath'] as string;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      const items = Array.from({ length: n }, (_, i) => ({ id: `item_${i + 1}` }));
      writeFileSync(abs, JSON.stringify({ items }));
      return { ok: true, outputPath: out };
    },
  };
}

function makeBundle(opts: {
  tool: string;
  itemCount: number;
  concurrency?: number;
  withPreviousN?: boolean;
}): DagBundle {
  const inputs: DagBundle['nodes'][number]['inputs'] = [
    { from: 'items_source', usage: 'input' },
  ];
  if (opts.withPreviousN) {
    inputs.push({ from: 'items_source', usage: 'context', scope: 'previousN', n: 2 });
  }
  return {
    id: 'concurrency-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'parallel_stage',
    nodes: [
      {
        id: 'items_source',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/items.json' },
        runner: { tool: 'stub.items', config: {} },
      },
      {
        id: 'parallel_stage',
        kind: 'collection',
        itemSource: 'items_source',
        itemKey: 'items',
        inputs,
        outputs: { format: 'json', pattern: 'out/{{item_id}}.json' },
        runner: {
          tool: opts.tool,
          config: opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {},
        },
      },
    ],
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'walker-concurrency-'));
  inFlight = 0;
  maxInFlight = 0;
  startOrder = [];
  finishOrder = [];
  delete process.env['DHEE_COLLECTION_CONCURRENCY'];
  __resetGlobalRegistryForTesting();
  const reg = getGlobalRegistry();
  reg.register(
    { tool: 'stub.items', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeItemsSourceRunner(5),
  );
  reg.register(
    { tool: 'llm.test', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeTrackingRunner('llm.test'),
  );
  reg.register(
    { tool: 'comfy.test', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeTrackingRunner('comfy.test'),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
  delete process.env['DHEE_COLLECTION_CONCURRENCY'];
});

describe('walker collection concurrency', () => {
  it('runs up to `concurrency` instances of an llm.* collection simultaneously', async () => {
    const bundle = makeBundle({ tool: 'llm.test', itemCount: 5, concurrency: 3 });
    const result = await walkBundle({ projectDir, bundle });

    expect(result.ok).toBe(true);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBe(3); // 5 items, limit 3 — pool should saturate
    expect(startOrder.sort()).toEqual(['item_1', 'item_2', 'item_3', 'item_4', 'item_5']);
  });

  it('defaults to strictly serial when concurrency is not configured', async () => {
    const bundle = makeBundle({ tool: 'llm.test', itemCount: 5 });
    const result = await walkBundle({ projectDir, bundle });

    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(1);
    // Strictly serial → started (and finished) in original instance order.
    expect(startOrder).toEqual(['item_1', 'item_2', 'item_3', 'item_4', 'item_5']);
    expect(finishOrder).toEqual(['item_1', 'item_2', 'item_3', 'item_4', 'item_5']);
  });

  it('honors DHEE_COLLECTION_CONCURRENCY when node config does not set concurrency', async () => {
    process.env['DHEE_COLLECTION_CONCURRENCY'] = '4';
    const bundle = makeBundle({ tool: 'llm.test', itemCount: 5 });
    const result = await walkBundle({ projectDir, bundle });

    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(4);
  });

  it('stays serial for a node with a scope:previousN input, even with concurrency configured', async () => {
    const bundle = makeBundle({ tool: 'llm.test', itemCount: 5, concurrency: 5, withPreviousN: true });
    const result = await walkBundle({ projectDir, bundle });

    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(1);
  });

  it('honors explicit concurrency for a non-llm.* tool too (opt-in is tool-agnostic)', async () => {
    // 75ec0b0c dropped the llm.*-only restriction: concurrency is opt-in and
    // available to ANY runner that is safe to parallelise. The engine does not
    // gate it by tool type — the default stays serial so nothing parallelises
    // by accident, and `previousN` remains the one hard clamp (above).
    const bundle = makeBundle({ tool: 'comfy.test', itemCount: 5, concurrency: 5 });
    const result = await walkBundle({ projectDir, bundle });

    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(5);
  });

  it('still defaults a non-llm.* tool to serial when concurrency is NOT set', async () => {
    // The important half of "opt-in": absent config, a comfy-style runner must
    // not suddenly fan out just because the llm.* gate was removed.
    delete process.env['DHEE_COLLECTION_CONCURRENCY'];
    const bundle = makeBundle({ tool: 'comfy.test', itemCount: 5 });
    const result = await walkBundle({ projectDir, bundle });

    expect(result.ok).toBe(true);
    expect(maxInFlight).toBe(1);
  });
});
