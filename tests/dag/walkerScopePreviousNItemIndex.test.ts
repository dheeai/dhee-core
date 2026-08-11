/**
 * scope: 'previousN' — GENERIC ordering fallback (itemIndex).
 *
 * When a collection's itemIds are NOT shot-shaped (`*_shot_N`), the walker
 * falls back to each item's position in its itemSource ordering (itemIndex)
 * as the "previous" key — so ANY ordered collection (e.g. beats flattened
 * across chapters) can read its predecessors, not just the Qwen shot chains.
 *
 * Crucially, ordering is by GLOBAL position, not a trailing number: beats
 * repeat their chapter-local number across chapters (chapter_01_beat_002 and
 * chapter_02_beat_002 both end in "002"), so a trailing-digit scheme would
 * collide. itemIndex is unique and monotonic across the flat list.
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
type SeenInput = { itemId: string | undefined; priors: Array<{ shotNumber: number; itemId: string }> };
const seen: SeenInput[] = [];

function makeRecorder(): Runner {
  return {
    describe: () => ({ id: 'stub.recorder', displayName: 'stub', description: '', capabilities: [], modalities: { input: [], output: [] }, configSchema: {} }),
    async run(ctx: RunnerContext) {
      const prev = (ctx.inputs?.['beat_design'] as Array<{ shotNumber: number; itemId: string; outputAbs: string }>) ?? [];
      seen.push({ itemId: ctx.itemId, priors: prev.map((p) => ({ shotNumber: p.shotNumber, itemId: p.itemId })) });
      const out = (ctx.node.runner.config as Record<string, unknown>)['outputPath'] as string;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, '');
      return { ok: true, outputPath: out };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'prevN-idx-'));
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

/** beats_flat (stage) → beat_design (collection, self-edge previousN). */
function makeBundle(n: number): DagBundle {
  return {
    id: 'prevN-idx-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'beat_design',
    nodes: [
      {
        id: 'beats_flat',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/beats_flat.json' },
        runner: { tool: 'stub.recorder', config: {} },
      },
      {
        id: 'beat_design',
        kind: 'collection',
        itemSource: 'beats_flat',
        itemKey: 'beats',
        inputs: [
          { from: 'beats_flat', usage: 'input' },
          { from: 'beat_design', usage: 'context', scope: 'previousN', n },
        ],
        outputs: { format: 'json', pattern: 'plans/beat_design/{{item_id}}.json' },
        runner: { tool: 'stub.recorder', config: {} },
      },
    ],
  };
}

/** Flat beat ids that do NOT match `*_shot_N`, and DO repeat their local
 * number across chapters — proving global itemIndex ordering, not a suffix. */
function preSeed(beatIds: string[]): void {
  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  writeFileSync(join(projectDir, 'plans/beats_flat.json'), JSON.stringify({ beats: beatIds.map((id) => ({ id })) }));
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({
      id: 'p',
      walkState: {
        bundleSource: 'built-in:prevN-idx-test',
        bundleVersion: '0.1.0',
        engineVersion: '0.1.0',
        nodes: { beats_flat: { status: 'completed', outputPath: 'plans/beats_flat.json' } },
        lastInvalidatedIds: [],
      },
    }),
  );
}

const IDS = [
  'chapter_01_beat_001',
  'chapter_01_beat_002',
  'chapter_01_beat_003',
  'chapter_02_beat_001',
  'chapter_02_beat_002',
];

describe("walker scope: 'previousN' — itemIndex fallback (non-shot ids)", () => {
  it('(1) n=1 chains each beat to its immediate predecessor by global position', async () => {
    preSeed(IDS);
    const result = await walkBundle({ projectDir, bundle: makeBundle(1), bundleSource: 'built-in:prevN-idx-test' });
    expect(result.ok).toBe(true);
    const byId: Record<string, SeenInput> = {};
    for (const s of seen) if (s.itemId) byId[s.itemId] = s;

    expect(byId['chapter_01_beat_001']!.priors).toEqual([]); // first item, no prior
    expect(byId['chapter_01_beat_002']!.priors.map((p) => p.itemId)).toEqual(['chapter_01_beat_001']);
    expect(byId['chapter_02_beat_001']!.priors.map((p) => p.itemId)).toEqual(['chapter_01_beat_003']);
    // The collision case: chapter_02_beat_002's predecessor is chapter_02_beat_001
    // (global index 3), NOT chapter_01_beat_001 (which shares the "..._001" suffix).
    expect(byId['chapter_02_beat_002']!.priors.map((p) => p.itemId)).toEqual(['chapter_02_beat_001']);
  });

  it('(2) n=2 exposes the two most-recent predecessors, DESC by global position', async () => {
    preSeed(IDS);
    const result = await walkBundle({ projectDir, bundle: makeBundle(2), bundleSource: 'built-in:prevN-idx-test' });
    expect(result.ok).toBe(true);
    const last = seen.find((s) => s.itemId === 'chapter_02_beat_002')!;
    // indices: beat_002@ch02 = 4; the two priors are index 3 then 2.
    expect(last.priors.map((p) => p.itemId)).toEqual(['chapter_02_beat_001', 'chapter_01_beat_003']);
    // strictly DESC by the exposed order key
    expect(last.priors[0]!.shotNumber).toBeGreaterThan(last.priors[1]!.shotNumber);
  });
});
