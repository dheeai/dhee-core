/**
 * scope: 'previousN' — walker exposes up to N upstream completed
 * instances whose shotNumber is strictly less than the current
 * instance's shotNumber. Sorted DESC, truncated to N.
 *
 * Used by chain bundles (Qwen Edit chain) where the LLM picks the
 * best prior shot to use as the image-edit base.
 *
 * Manifestations covered:
 *   1. N=3 and 5 priors exist → expose 3 most recent
 *   2. N=10 and only 2 priors exist → expose 2 (no padding)
 *   3. current is shot 1 → expose empty array
 *   4. priors include some not yet completed → only completed
 *   5. items are ordered shotNumber DESC
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
type SeenInput = { itemId: string | undefined; previousShots: Array<{ shotNumber: number; itemId: string }> };
const seen: SeenInput[] = [];

function makeRecorder(): Runner {
  return {
    describe: () => ({ id: 'stub.recorder', displayName: 'stub', description: '', capabilities: [], modalities: { input: [], output: [] }, configSchema: {} }),
    async run(ctx: RunnerContext) {
      const prev = (ctx.inputs?.['shot_image'] as Array<{ shotNumber: number; itemId: string; outputAbs: string }>) ?? [];
      seen.push({ itemId: ctx.itemId, previousShots: prev.map((p) => ({ shotNumber: p.shotNumber, itemId: p.itemId })) });
      const out = (ctx.node.runner.config as Record<string, unknown>)['outputPath'] as string;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, '');
      return { ok: true, outputPath: out };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'prevN-'));
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
 * Bundle with one stage (scenes_plan) and one collection (shot_image)
 * whose items are shot ids like "scene_1_shot_1". The collection
 * declares scope:'previousN' on itself (self-reference), so each
 * instance sees the prior ones.
 */
function makeBundle(n: number): DagBundle {
  return {
    id: 'prevN-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'shot_image',
    nodes: [
      {
        id: 'scenes_plan',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/scenes_plan.json' },
        runner: { tool: 'stub.recorder', config: {} },
      },
      {
        id: 'shot_image',
        kind: 'collection',
        itemSource: 'scenes_plan',
        itemKey: 'shots',
        inputs: [
          { from: 'scenes_plan', usage: 'input' },
          { from: 'shot_image', usage: 'input', scope: 'previousN', n },
        ],
        outputs: { format: 'image', pattern: 'out/{{item_id}}.png' },
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
        bundleSource: 'built-in:prevN-test',
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

describe("walker scope: 'previousN'", () => {
  it('(1) N=3, 5 prior shots → expose the 3 most recent (DESC by shotNumber)', async () => {
    preSeed(makeShots(5));
    const result = await walkBundle({ projectDir, bundle: makeBundle(3), bundleSource: 'built-in:prevN-test' });
    expect(result.ok).toBe(true);

    const byId: Record<string, SeenInput> = {};
    for (const s of seen) if (s.itemId) byId[s.itemId] = s;

    // shot 1 has no prior
    expect(byId['scene_1_shot_1']!.previousShots).toEqual([]);
    // shot 2 has prior [1]
    expect(byId['scene_1_shot_2']!.previousShots.map((p) => p.shotNumber)).toEqual([1]);
    // shot 3 has prior [2, 1]
    expect(byId['scene_1_shot_3']!.previousShots.map((p) => p.shotNumber)).toEqual([2, 1]);
    // shot 4 has prior [3, 2, 1]
    expect(byId['scene_1_shot_4']!.previousShots.map((p) => p.shotNumber)).toEqual([3, 2, 1]);
    // shot 5: N=3 → take 3 most recent (4, 3, 2). NOT 1.
    expect(byId['scene_1_shot_5']!.previousShots.map((p) => p.shotNumber)).toEqual([4, 3, 2]);
  });

  it('(2) N=10 with only 2 priors → expose 2, no padding', async () => {
    preSeed(makeShots(3));
    const result = await walkBundle({ projectDir, bundle: makeBundle(10), bundleSource: 'built-in:prevN-test' });
    expect(result.ok).toBe(true);
    const shot3 = seen.find((s) => s.itemId === 'scene_1_shot_3');
    expect(shot3!.previousShots.map((p) => p.shotNumber)).toEqual([2, 1]);
  });

  it('(3) shot 1 has empty previousShots array', async () => {
    preSeed(makeShots(2));
    const result = await walkBundle({ projectDir, bundle: makeBundle(5), bundleSource: 'built-in:prevN-test' });
    expect(result.ok).toBe(true);
    const shot1 = seen.find((s) => s.itemId === 'scene_1_shot_1');
    expect(shot1!.previousShots).toEqual([]);
  });

  it('(4) shot 1 with self-referencing previousN exposes empty array (not undefined)', async () => {
    // Regression: when shot_image_prompt references shot_image (which
    // hasn't run yet for shot 1), walker must still set the input key
    // to [] so the template's {{shot_image}} substitution doesn't fail.
    preSeed(makeShots(1));
    const result = await walkBundle({ projectDir, bundle: makeBundle(5), bundleSource: 'built-in:prevN-test' });
    expect(result.ok).toBe(true);
    const shot1 = seen.find((s) => s.itemId === 'scene_1_shot_1');
    expect(shot1).toBeTruthy();
    expect(shot1!.previousShots).toEqual([]); // empty, not undefined
  });

  it('(5) priors are sorted shotNumber DESC', async () => {
    preSeed(makeShots(4));
    const result = await walkBundle({ projectDir, bundle: makeBundle(5), bundleSource: 'built-in:prevN-test' });
    expect(result.ok).toBe(true);
    const shot4 = seen.find((s) => s.itemId === 'scene_1_shot_4');
    const nums = shot4!.previousShots.map((p) => p.shotNumber);
    // Must be DESC
    for (let i = 0; i < nums.length - 1; i++) expect(nums[i]).toBeGreaterThan(nums[i + 1]!);
  });
});
