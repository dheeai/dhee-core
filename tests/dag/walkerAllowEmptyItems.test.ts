import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, NodeDef, Runner } from '../../src/dag/schema.js';

let projectDir: string;
const ran: string[] = [];
let finalInputs: Record<string, unknown> | undefined;

function writeJson(projectDir: string, rel: string, value: unknown): void {
  const abs = join(projectDir, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, JSON.stringify(value));
}

function runner(): Runner {
  return {
    describe: () => ({
      id: 'stub.empty-items',
      displayName: 'stub',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      ran.push(ctx.itemId ? `${ctx.node.id}:${ctx.itemId}` : ctx.node.id);
      const pattern = ctx.node.outputs.pattern;
      const rel = ctx.itemId ? pattern.replace(/\{\{item_id\}\}/g, ctx.itemId) : pattern;
      if (ctx.node.id === 'plan') {
        writeJson(ctx.projectDir, rel, {
          split_beat_ids: [],
          required_items: [{ id: 'beat_1' }],
        });
      } else if (ctx.node.id === 'final') {
        finalInputs = ctx.inputs;
        writeJson(ctx.projectDir, rel, { ok: true });
      } else {
        writeJson(ctx.projectDir, rel, { id: ctx.itemId });
      }
      return { ok: true, outputPath: rel };
    },
  };
}

function collection(node: NodeDef & { allowEmptyItems?: boolean }): NodeDef {
  return node as NodeDef;
}

function bundle(): DagBundle {
  return {
    id: 'allow-empty-items-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'final',
    nodes: [
      {
        id: 'plan',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plan.json' },
        runner: { tool: 'stub.empty-items', config: {} },
      },
      collection({
        id: 'optional_prompt',
        kind: 'collection',
        itemSource: 'plan',
        itemKey: 'split_beat_ids',
        allowEmptyItems: true,
        inputs: [{ from: 'plan', usage: 'input' }],
        outputs: { format: 'json', pattern: 'optional_prompt/{{item_id}}.json' },
        runner: { tool: 'stub.empty-items', config: {} },
      }),
      collection({
        id: 'optional_image',
        kind: 'collection',
        itemSource: 'optional_prompt',
        allowEmptyItems: true,
        inputs: [{ from: 'optional_prompt', usage: 'input', scope: 'matching' }],
        outputs: { format: 'image', pattern: 'optional_image/{{item_id}}.png' },
        runner: { tool: 'stub.empty-items', config: {} },
      }),
      {
        id: 'required',
        kind: 'collection',
        itemSource: 'plan',
        itemKey: 'required_items',
        inputs: [{ from: 'plan', usage: 'input' }],
        outputs: { format: 'json', pattern: 'required/{{item_id}}.json' },
        runner: { tool: 'stub.empty-items', config: {} },
      },
      {
        id: 'final',
        kind: 'stage',
        inputs: [
          { from: 'optional_image', usage: 'input', scope: 'all' },
          { from: 'required', usage: 'input', scope: 'all' },
        ],
        outputs: { format: 'json', pattern: 'final.json' },
        runner: { tool: 'stub.empty-items', config: {} },
      },
    ],
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'allow-empty-items-'));
  ran.length = 0;
  finalInputs = undefined;
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.empty-items', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    runner(),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

describe('walker allowEmptyItems collections', () => {
  it('materializes optional empty source arrays as zero instances and lets downstream stages run', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: bundle(),
      bundleSource: 'built-in:allow-empty-items-test',
    });

    expect(result.ok).toBe(true);
    expect(ran).toEqual(['plan', 'required:beat_1', 'final']);
    expect(finalInputs?.['optional_image']).toEqual({});
    expect(finalInputs?.['required']).toEqual({
      beat_1: join(projectDir, 'required/beat_1.json'),
    });
  });
});
