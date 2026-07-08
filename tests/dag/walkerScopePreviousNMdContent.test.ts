/**
 * Regression: `scope: 'previousN'` content-inlining was gated behind
 * `outputs.format === 'json'`, so a `previousN` self-chain over a
 * markdown-format collection only ever carried forward
 * { shotNumber, itemId, outputAbs } — a PATH, never the actual prior
 * item's text. narrative_speech_shot_by_shot's `shot_state` node
 * (`outputs.format: 'md'`) has exactly this self-chain
 * (`scope: previousN, n: 1`) as its one continuity mechanism, and it
 * silently never carried real content.
 *
 * Fix: content-inlining now happens for any text-representable format
 * (json/md/text) — parsed as JSON only when the format genuinely is
 * 'json', inlined as a raw string otherwise. Binary formats
 * (image/video/audio) are untouched (still path-only; see
 * walkerScopePreviousN.test.ts's shot_image/'image' case).
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
type SeenInput = { itemId: string | undefined; previousShots: Array<{ shotNumber: number; itemId: string; content?: unknown }> };
const seen: SeenInput[] = [];

function makeRecorder(): Runner {
  return {
    describe: () => ({ id: 'stub.recorder', displayName: 'stub', description: '', capabilities: [], modalities: { input: [], output: [] }, configSchema: {} }),
    async run(ctx: RunnerContext) {
      const prev = (ctx.inputs?.['shot_state'] as Array<{ shotNumber: number; itemId: string; outputAbs: string; content?: unknown }>) ?? [];
      seen.push({ itemId: ctx.itemId, previousShots: prev.map((p) => ({ shotNumber: p.shotNumber, itemId: p.itemId, content: p.content })) });
      const out = (ctx.node.runner.config as Record<string, unknown>)['outputPath'] as string;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, `state for ${ctx.itemId}`);
      return { ok: true, outputPath: out };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'prevN-md-'));
  seen.length = 0;
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.recorder', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeRecorder(),
  );
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

/**
 * Modeled on narrative_speech_shot_by_shot's `shot_state` node: a
 * markdown-format ('md') collection that self-chains via
 * scope:'previousN', n:1.
 */
function makeBundle(): DagBundle {
  return {
    id: 'prevN-md-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'shot_state',
    nodes: [
      {
        id: 'scenes_plan',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/scenes_plan.json' },
        runner: { tool: 'stub.recorder', config: {} },
      },
      {
        id: 'shot_state',
        kind: 'collection',
        itemSource: 'scenes_plan',
        itemKey: 'shots',
        inputs: [
          { from: 'scenes_plan', usage: 'input' },
          { from: 'shot_state', usage: 'context', scope: 'previousN', n: 1 },
        ],
        outputs: { format: 'md', pattern: 'state/{{item_id}}.md' },
        runner: { tool: 'stub.recorder', config: {} },
      },
    ],
  };
}

function preSeed(shots: Array<{ id: string; shotNumber: number }>): void {
  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  writeFileSync(join(projectDir, 'plans/scenes_plan.json'), JSON.stringify({ shots }));
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({
      id: 'p',
      walkState: {
        bundleSource: 'built-in:prevN-md-test',
        bundleVersion: '0.1.0',
        engineVersion: '0.1.0',
        nodes: { scenes_plan: { status: 'completed', outputPath: 'plans/scenes_plan.json' } },
        lastInvalidatedIds: [],
      },
    }),
  );
}

function makeShots(n: number): Array<{ id: string; shotNumber: number }> {
  return Array.from({ length: n }, (_, i) => ({ id: `scene_1_shot_${i + 1}`, shotNumber: i + 1 }));
}

describe("walker scope: 'previousN' inlines md content (not just a path)", () => {
  it('shot 2 sees shot 1\'s actual text content, not a path-only entry', async () => {
    preSeed(makeShots(3));
    const result = await walkBundle({ projectDir, bundle: makeBundle(), bundleSource: 'built-in:prevN-md-test' });
    expect(result.ok).toBe(true);

    const byId: Record<string, SeenInput> = {};
    for (const s of seen) if (s.itemId) byId[s.itemId] = s;

    expect(byId['scene_1_shot_2']!.previousShots).toHaveLength(1);
    expect(byId['scene_1_shot_2']!.previousShots[0]!.content).toBe('state for scene_1_shot_1');

    expect(byId['scene_1_shot_3']!.previousShots).toHaveLength(1);
    expect(byId['scene_1_shot_3']!.previousShots[0]!.content).toBe('state for scene_1_shot_2');
  });
});
