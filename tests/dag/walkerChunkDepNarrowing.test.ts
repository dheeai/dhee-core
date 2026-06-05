/**
 * Regression: chunked scene_clip must record only its OWN shots as
 * dependencies, not every shot (the scope='all' over-recording bug).
 *
 * The bug, observed driving a render: editing shot 3 re-rolled chunk 2
 * (shots 5-6). Cause — scene_clip declares shot_image / shot_motion_directive
 * as scope='all', so the walker stamped ALL six shots onto BOTH chunks'
 * node.completed.dependencies. cascadeInvalidationKeys then invalidated
 * every chunk on any single-shot edit.
 *
 * Fix (src/dag/chunkDeps.ts + walker scope='all' dep recording): narrow
 * each chunk's recorded shot deps to its shotRange.
 *
 * This test walks a real chunked scene with a stub runner, reads the
 * event log the walker wrote, and asserts:
 *   1. the scene split into ≥2 chunks,
 *   2. each chunk's shot deps are disjoint from its siblings' (the fix —
 *      pre-fix every chunk carried all shots),
 *   3. the union of all chunks' shot deps covers every shot,
 *   4. cascade-invalidation from a shot only reaches the chunk that
 *      actually contains it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import { cascadeInvalidationKeys } from '../../src/dag/cascadeInvalidationKeys.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner, RunnerContext } from '../../src/dag/schema.js';
import type { DheeEvent } from '../../src/dag/eventLog/events.js';

let projectDir: string;

/** Stub runner: writes an empty output file so the walker marks completed. */
function makeStub(): Runner {
  return {
    describe: () => ({
      id: 'stub.recorder',
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
      writeFileSync(abs, '');
      return { ok: true, outputPath: out };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'chunkdep-'));
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.recorder', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeStub(),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

/**
 * Bundle modeled on narrative_prompt_relay's video tail:
 *   shot_image / shot_motion_directive fan out per shot;
 *   scene_clip fans out per scene, chunked, consuming the shot
 *   collections at scope='all' (the over-recording trigger).
 */
function makeBundle(): DagBundle {
  return {
    id: 'chunkdep-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'scene_clip',
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
        inputs: [{ from: 'scenes_plan', usage: 'input' }],
        outputs: { format: 'image', pattern: 'imgs/{{item_id}}.png' },
        runner: { tool: 'stub.recorder', config: {} },
      },
      {
        id: 'shot_motion_directive',
        kind: 'collection',
        itemSource: 'scenes_plan',
        itemKey: 'shots',
        inputs: [{ from: 'scenes_plan', usage: 'input' }],
        outputs: { format: 'json', pattern: 'motion/{{item_id}}.json' },
        runner: { tool: 'stub.recorder', config: {} },
      },
      {
        id: 'scene_clip',
        kind: 'collection',
        itemSource: 'scenes_plan',
        itemKey: 'scenes',
        chunkBy: { constraint: 'max_frames', limit: 1000, fps: 24, firstSegmentPlusOne: true },
        inputs: [
          { from: 'shot_image', usage: 'input', scope: 'all' },
          { from: 'shot_motion_directive', usage: 'input', scope: 'all' },
          { from: 'scenes_plan', usage: 'context' },
        ],
        outputs: { format: 'video', pattern: 'clips/{{scene_id}}_{{chunk_id}}.mp4' },
        runner: { tool: 'stub.recorder', config: {} },
      },
    ],
  };
}

/** 6 shots × 10s = 240 frames each → splits into 2 chunks under the 1000 cap. */
function preSeed(): void {
  const shots = Array.from({ length: 6 }, (_, i) => ({
    id: `scene_1_shot_${i + 1}`,
    scene: 1,
    shotNumber: i + 1,
    duration: 10,
  }));
  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  writeFileSync(
    join(projectDir, 'plans/scenes_plan.json'),
    JSON.stringify({ scenes: [{ id: 'scene_1', title: 's1' }], shots }),
  );
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({
      id: 'p',
      walkState: {
        bundleSource: 'built-in:chunkdep-test',
        bundleVersion: '0.1.0',
        engineVersion: '0.1.0',
        nodes: { scenes_plan: { status: 'completed', outputPath: 'plans/scenes_plan.json' } },
        lastInvalidatedIds: [],
      },
    }),
  );
}

function readEvents(): DheeEvent[] {
  const p = join(projectDir, '.dhee', 'events.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DheeEvent);
}

/** chunkItemId → set of shot_image shot itemIds it recorded as deps. */
function shotDepsByChunk(events: DheeEvent[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.kind !== 'node.completed') continue;
    const p = (e as DheeEvent<'node.completed'>).payload;
    if (p.nodeId !== 'scene_clip' || !p.itemId) continue;
    const shots = new Set<string>();
    for (const d of p.dependencies ?? []) {
      if (d.nodeId === 'shot_image' && d.itemId) shots.add(d.itemId);
    }
    out.set(p.itemId, shots);
  }
  return out;
}

describe('chunked scene_clip records only its own shots as dependencies', () => {
  it('narrows scope=all shot deps per chunk so the cascade stays surgical', async () => {
    preSeed();
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:chunkdep-test',
      probeGpuVramBytes: async () => 12 * 1024 ** 3,
    });
    expect(result.ok).toBe(true);

    const events = readEvents();
    const byChunk = shotDepsByChunk(events);

    // (1) The scene split into ≥2 chunks.
    expect(byChunk.size).toBeGreaterThanOrEqual(2);
    const chunkIds = [...byChunk.keys()];

    // Every chunk recorded at least one shot dep (it consumes real shots).
    for (const [chunk, shots] of byChunk) {
      expect(shots.size, `chunk ${chunk} has shot deps`).toBeGreaterThan(0);
    }

    // (2) Each chunk's shot set is DISJOINT from every other chunk's.
    //     Pre-fix this failed: every chunk carried all 6 shots.
    const allShotDeps: string[] = [];
    for (const shots of byChunk.values()) allShotDeps.push(...shots);
    expect(allShotDeps.length, 'no shot is shared across chunks').toBe(new Set(allShotDeps).size);

    // (3) The union covers every shot (nothing dropped).
    expect(new Set(allShotDeps)).toEqual(
      new Set(['scene_1_shot_1', 'scene_1_shot_2', 'scene_1_shot_3', 'scene_1_shot_4', 'scene_1_shot_5', 'scene_1_shot_6']),
    );

    // (4) Cascade-invalidation from a shot reaches ONLY the chunk that
    //     contains it. Pick a representative shot from each chunk and
    //     assert the sibling chunk is untouched — the exact behavior the
    //     bug violated (editing shot 3 re-rolled the shots-5-6 chunk).
    const sceneClipKeyset = new Set(chunkIds.map((c) => `scene_clip:${c}`));
    for (const [chunk, shots] of byChunk) {
      const aShot = [...shots][0]!; // e.g. 'scene_1_shot_5'
      const hit = cascadeInvalidationKeys(events, { nodeId: 'shot_image', itemId: aShot })
        .map((k) => (k.itemId ? `${k.nodeId}:${k.itemId}` : k.nodeId))
        .filter((k) => sceneClipKeyset.has(k));
      // The chunk that owns the shot is invalidated...
      expect(hit, `${aShot} invalidates its own chunk`).toContain(`scene_clip:${chunk}`);
      // ...and NO sibling chunk is.
      for (const other of chunkIds) {
        if (other === chunk) continue;
        expect(hit, `${aShot} must NOT invalidate sibling ${other}`).not.toContain(`scene_clip:${other}`);
      }
    }
  });
});
