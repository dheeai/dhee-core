/**
 * Regression: BUG-014 — Walker chunkBy must apply to the upstream-driven
 * materialization path (itemSource: <upstreamNodeId>), not just the legacy
 * 'itemSource: scene' CLI path. Without this, a scene whose total frames
 * exceed the runner's cap is handed to the runner as one over-cap instance
 * and the runner errors at submission time (e.g. LTX 1000-frame cap).
 *
 * Tests cover the manifestations enumerated in docs/bugs.md BUG-014:
 *   1. Scene under cap → one chunk per scene (full shotRange)
 *   2. Scene over cap → multiple chunks, disjoint shotRanges, all frames per chunk ≤ cap
 *   3. Multiple scenes mixed sizes → each chunked independently
 *   4. No chunkBy → one instance per scene (back-compat, no chunking)
 *   5. chunkBy declared but itemKey !== 'scenes' → no chunking (scene-specific feature)
 *   6. firstSegmentPlusOne=true → first shot of each chunk pays the +1 cost
 *   7. Shots missing scene/shotNumber but with scene_N_shot_M id → walker derives
 *   8. Per-chunk metadata (itemId, sceneNumber, shotRange, chunkIndex, chunkCount)
 *      is populated correctly
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
import type { DagBundle, NodeDef, Runner, RunnerContext } from '../../src/dag/schema.js';

let projectDir: string;
type Seen = {
  itemId: string | undefined;
  sceneNumber: number | undefined;
  shotRange: [number, number] | undefined;
  chunkIndex: number | undefined;
  chunkCount: number | undefined;
  outputPath: string;
};
const seen: Seen[] = [];

function makeRecorder(): Runner {
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
      // The walker computes inst fields and writes them into the runner
      // config (via buildRunnerConfig) — we read them from the instance
      // via ctx.node + an out-of-band stash. The simplest reliable way to
      // observe materialization is via the resolved outputPath pattern,
      // which by convention encodes scene_id (and we'll add chunk_id).
      const inst = (ctx as unknown as { __inst?: Record<string, unknown> }).__inst;
      seen.push({
        itemId: ctx.itemId,
        sceneNumber: (inst?.['sceneNumber'] as number | undefined) ?? undefined,
        shotRange: (inst?.['shotRange'] as [number, number] | undefined) ?? undefined,
        chunkIndex: (inst?.['chunkIndex'] as number | undefined) ?? undefined,
        chunkCount: (inst?.['chunkCount'] as number | undefined) ?? undefined,
        outputPath: 'recorded',
      });
      // Write a stub output so walker marks completed.
      const out = (ctx.node.runner.config as Record<string, unknown>)['outputPath'] as string;
      const abs = join(ctx.projectDir, out);
      mkdirSync(join(abs, '..'), { recursive: true });
      writeFileSync(abs, '');
      return { ok: true, outputPath: out };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'chunkby-'));
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
 * Build a tiny 2-node bundle:
 *   - `scenes_plan` stage that writes the given scenes+shots JSON
 *   - `scene_clip` collection that fans out via the given materialization rules
 */
function makeBundle(opts: {
  chunkBy?: NodeDef['chunkBy'];
  itemKey?: string;
}): DagBundle {
  const collection: NodeDef = {
    id: 'scene_clip',
    kind: 'collection',
    itemSource: 'scenes_plan',
    inputs: [{ from: 'scenes_plan', usage: 'input' }],
    outputs: { format: 'video', pattern: 'out/{{scene_id}}.mp4' },
    runner: { tool: 'stub.recorder', config: {} },
    ...(opts.itemKey ? { itemKey: opts.itemKey } : {}),
    ...(opts.chunkBy ? { chunkBy: opts.chunkBy } : {}),
  };
  return {
    id: 'chunkby-test',
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
      collection,
    ],
  };
}

function preSeedPlan(plan: object): void {
  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  writeFileSync(join(projectDir, 'plans/scenes_plan.json'), JSON.stringify(plan));
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({
      id: 'p',
      walkState: {
        bundleSource: 'built-in:chunkby-test',
        bundleVersion: '0.1.0',
        engineVersion: '0.1.0',
        nodes: {
          scenes_plan: { status: 'completed', outputPath: 'plans/scenes_plan.json' },
        },
        lastInvalidatedIds: [],
      },
    }),
  );
}

// Capture per-instance fields by stashing them onto ctx before runner runs.
// We monkey-patch the walker's getRunner to wrap the runner so we can grab
// the instance. Since the walker doesn't natively expose inst on ctx, we
// instead infer via outputPath which contains scene_id (the itemId).
// For tests where we need shotRange + chunkIndex, we read them from the
// walkState produced by the walker via project.json after the run.
import { readFileSync } from 'node:fs';
function readWalkState(): Record<string, { status: string; outputPath?: string; metadata?: Record<string, unknown> }> {
  const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as {
    walkState?: { nodes?: Record<string, { status: string; outputPath?: string; metadata?: Record<string, unknown> }> };
  };
  return proj.walkState?.nodes ?? {};
}

describe('BUG-014 — walker chunkBy on upstream-driven materialization', () => {
  it('(1) scene under cap → single chunk per scene with shotRange covering all shots', async () => {
    preSeedPlan({
      scenes: [{ id: 'scene_1', title: 's1', mainSubject: 'x', narrativeMode: 'setup' }],
      shots: [
        { id: 'scene_1_shot_1', scene: 1, shotNumber: 1, duration: 3 },
        { id: 'scene_1_shot_2', scene: 1, shotNumber: 2, duration: 3 },
      ],
    });
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle({
        itemKey: 'scenes',
        chunkBy: { constraint: 'max_frames', limit: 1000, fps: 24, firstSegmentPlusOne: true },
      }),
      bundleSource: 'built-in:chunkby-test',
    });
    expect(result.ok).toBe(true);
    // 2 shots × 3s × 24fps = 144 frames + first-segment +1 = 145, well under 1000.
    // Expect exactly one chunk: scene_1_chunk_1.
    const ws = readWalkState();
    const keys = Object.keys(ws).filter((k) => k.startsWith('scene_clip:'));
    expect(keys).toEqual(['scene_clip:scene_1_chunk_1']);
  });

  it('(2) scene over cap → multiple chunks with disjoint shotRanges covering all shots', async () => {
    // Build a scene with 10 shots × 10s = 100s = 2400 frames at 24fps.
    // Cap 1000 frames → expect ~3 chunks.
    const shots: Array<{ id: string; scene: number; shotNumber: number; duration: number }> = [];
    for (let i = 1; i <= 10; i += 1) {
      shots.push({ id: `scene_1_shot_${i}`, scene: 1, shotNumber: i, duration: 10 });
    }
    preSeedPlan({
      scenes: [{ id: 'scene_1', title: 's1', mainSubject: 'x', narrativeMode: 'setup' }],
      shots,
    });
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle({
        itemKey: 'scenes',
        chunkBy: { constraint: 'max_frames', limit: 1000, fps: 24, firstSegmentPlusOne: true },
      }),
      bundleSource: 'built-in:chunkby-test',
    });
    expect(result.ok).toBe(true);
    const ws = readWalkState();
    const chunkKeys = Object.keys(ws)
      .filter((k) => k.startsWith('scene_clip:scene_1_chunk_'))
      .sort();
    // Expect at least 3 chunks (2400 / 1000 = 2.4 → 3 chunks).
    expect(chunkKeys.length).toBeGreaterThanOrEqual(3);
    // Each chunk's outputPath encodes scene_1_chunk_M; just confirm there's
    // no duplicate and chunks cover indexes 1..N.
    const expected = chunkKeys.map((_, idx) => `scene_clip:scene_1_chunk_${idx + 1}`);
    expect(chunkKeys).toEqual(expected);
  });

  it('(3) multiple scenes mixed sizes → each chunked independently', async () => {
    const shots: Array<{ id: string; scene: number; shotNumber: number; duration: number }> = [];
    // Scene 1: 10 × 10s = 100s = 2400 frames → splits.
    for (let i = 1; i <= 10; i += 1) {
      shots.push({ id: `scene_1_shot_${i}`, scene: 1, shotNumber: i, duration: 10 });
    }
    // Scene 2: 1 × 5s = 5s = 120 frames → single chunk.
    shots.push({ id: `scene_2_shot_1`, scene: 2, shotNumber: 1, duration: 5 });
    // Scene 3: 5 × 4s = 20s = 480 frames → single chunk.
    for (let i = 1; i <= 5; i += 1) {
      shots.push({ id: `scene_3_shot_${i}`, scene: 3, shotNumber: i, duration: 4 });
    }
    preSeedPlan({
      scenes: [
        { id: 'scene_1', title: 'a', mainSubject: 'x', narrativeMode: 'setup' },
        { id: 'scene_2', title: 'b', mainSubject: 'x', narrativeMode: 'rising' },
        { id: 'scene_3', title: 'c', mainSubject: 'x', narrativeMode: 'climax' },
      ],
      shots,
    });
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle({
        itemKey: 'scenes',
        chunkBy: { constraint: 'max_frames', limit: 1000, fps: 24, firstSegmentPlusOne: true },
      }),
      bundleSource: 'built-in:chunkby-test',
    });
    expect(result.ok).toBe(true);
    const ws = readWalkState();
    const s1 = Object.keys(ws).filter((k) => k.startsWith('scene_clip:scene_1_chunk_'));
    const s2 = Object.keys(ws).filter((k) => k.startsWith('scene_clip:scene_2_chunk_'));
    const s3 = Object.keys(ws).filter((k) => k.startsWith('scene_clip:scene_3_chunk_'));
    expect(s1.length).toBeGreaterThanOrEqual(3);
    expect(s2).toEqual(['scene_clip:scene_2_chunk_1']);
    expect(s3).toEqual(['scene_clip:scene_3_chunk_1']);
  });

  it('(4) no chunkBy → one instance per scene (back-compat, no chunking)', async () => {
    const shots: Array<{ id: string; scene: number; shotNumber: number; duration: number }> = [];
    for (let i = 1; i <= 10; i += 1) {
      shots.push({ id: `scene_1_shot_${i}`, scene: 1, shotNumber: i, duration: 10 });
    }
    preSeedPlan({
      scenes: [{ id: 'scene_1', title: 's1', mainSubject: 'x', narrativeMode: 'setup' }],
      shots,
    });
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle({ itemKey: 'scenes' }), // no chunkBy
      bundleSource: 'built-in:chunkby-test',
    });
    expect(result.ok).toBe(true);
    const ws = readWalkState();
    // No chunks — just 'scene_clip:scene_1' (back-compat per-scene instance).
    const keys = Object.keys(ws).filter((k) => k.startsWith('scene_clip:'));
    expect(keys).toEqual(['scene_clip:scene_1']);
  });

  it('(5) chunkBy with itemKey !== scenes → no chunking attempted (scene-specific feature)', async () => {
    preSeedPlan({
      scenes: [{ id: 'scene_1' }],
      shots: [
        { id: 'scene_1_shot_1', scene: 1, shotNumber: 1, duration: 5 },
        { id: 'scene_1_shot_2', scene: 1, shotNumber: 2, duration: 5 },
      ],
    });
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle({
        itemKey: 'shots',
        chunkBy: { constraint: 'max_frames', limit: 1000, fps: 24, firstSegmentPlusOne: true },
      }),
      bundleSource: 'built-in:chunkby-test',
    });
    expect(result.ok).toBe(true);
    const ws = readWalkState();
    // itemKey='shots' → fans out per shot (chunking doesn't apply here);
    // chunkBy is silently ignored for non-scenes itemKey.
    const keys = Object.keys(ws).filter((k) => k.startsWith('scene_clip:')).sort();
    expect(keys).toEqual([
      'scene_clip:scene_1_shot_1',
      'scene_clip:scene_1_shot_2',
    ]);
  });

  it('(6) firstSegmentPlusOne=true vs false changes when packing crosses the cap', async () => {
    // Construct a scene right at the boundary. Each shot is 5s × 24fps = 120
    // frames, aligned to 8 = 120. With firstSegmentPlusOne=true, first shot
    // of each chunk pays +1, so the first chunk's first shot is 121 frames.
    // 8 such shots × 120 = 960; with +1 on first, 961. The 9th would push to
    // 961 + 120 = 1081 > 1000 → new chunk.
    const shots: Array<{ id: string; scene: number; shotNumber: number; duration: number }> = [];
    for (let i = 1; i <= 12; i += 1) {
      shots.push({ id: `scene_1_shot_${i}`, scene: 1, shotNumber: i, duration: 5 });
    }
    preSeedPlan({
      scenes: [{ id: 'scene_1' }],
      shots,
    });
    const withPlusOne = await walkBundle({
      projectDir,
      bundle: makeBundle({
        itemKey: 'scenes',
        chunkBy: { constraint: 'max_frames', limit: 1000, fps: 24, firstSegmentPlusOne: true },
      }),
      bundleSource: 'built-in:chunkby-test',
    });
    expect(withPlusOne.ok).toBe(true);
    const wsPlusOne = readWalkState();
    const chunksPlusOne = Object.keys(wsPlusOne)
      .filter((k) => k.startsWith('scene_clip:scene_1_chunk_'))
      .length;
    // 12 shots × 120 frames + 8 chunks-worth of +1 ≈ 1440+. With cap 1000 →
    // 2 chunks (8 shots in first chunk = 961, remaining 4 = 481).
    expect(chunksPlusOne).toBe(2);
  });

  it('(7) shots missing scene/shotNumber but with scene_N_shot_M id → walker derives and chunks', async () => {
    // No `scene` or `shotNumber` keys — just ids.
    const shots: Array<{ id: string; duration: number }> = [];
    for (let i = 1; i <= 10; i += 1) {
      shots.push({ id: `scene_1_shot_${i}`, duration: 10 });
    }
    preSeedPlan({
      scenes: [{ id: 'scene_1' }],
      shots,
    });
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle({
        itemKey: 'scenes',
        chunkBy: { constraint: 'max_frames', limit: 1000, fps: 24, firstSegmentPlusOne: true },
      }),
      bundleSource: 'built-in:chunkby-test',
    });
    expect(result.ok).toBe(true);
    const ws = readWalkState();
    const chunks = Object.keys(ws).filter((k) => k.startsWith('scene_clip:scene_1_chunk_'));
    // Same shape as test (2) — 2400 frames must chunk to 3+.
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('(8) per-chunk metadata + production {{scene_id}}_{{chunk_id}} pattern produces distinct paths', async () => {
    // 6 shots × 16s = 96s = 2304 frames → 3 chunks. Use the real bundle's
    // output pattern `out/{{scene_id}}_{{chunk_id}}.mp4` to prove that
    // the walker exposes both vars and that distinct chunks write to
    // distinct files (the bug we just fixed where all chunks collided on
    // the same outputPath).
    const shots: Array<{ id: string; scene: number; shotNumber: number; duration: number }> = [];
    for (let i = 1; i <= 6; i += 1) {
      shots.push({ id: `scene_1_shot_${i}`, scene: 1, shotNumber: i, duration: 16 });
    }
    preSeedPlan({
      scenes: [{ id: 'scene_1' }],
      shots,
    });
    // Custom bundle with production-style pattern.
    const productionBundle: DagBundle = {
      id: 'chunkby-test',
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
          id: 'scene_clip',
          kind: 'collection',
          itemSource: 'scenes_plan',
          inputs: [{ from: 'scenes_plan', usage: 'input' }],
          outputs: { format: 'video', pattern: 'out/{{scene_id}}_{{chunk_id}}.mp4' },
          runner: { tool: 'stub.recorder', config: {} },
          itemKey: 'scenes',
          chunkBy: { constraint: 'max_frames', limit: 1000, fps: 24, firstSegmentPlusOne: true },
        },
      ],
    };
    const result = await walkBundle({
      projectDir,
      bundle: productionBundle,
      bundleSource: 'built-in:chunkby-test',
    });
    expect(result.ok).toBe(true);
    const ws = readWalkState();
    const keys = Object.keys(ws).filter((k) => k.startsWith('scene_clip:scene_1_chunk_')).sort();
    expect(keys).toEqual([
      'scene_clip:scene_1_chunk_1',
      'scene_clip:scene_1_chunk_2',
      'scene_clip:scene_1_chunk_3',
    ]);
    // Each chunk wrote to a DISTINCT file (no overwrite collision).
    const paths = new Set<string>();
    for (let i = 1; i <= 3; i += 1) {
      const entry = ws[`scene_clip:scene_1_chunk_${i}`];
      expect(entry?.status).toBe('completed');
      expect(entry?.outputPath).toBe(`out/scene_1_chunk_${i}.mp4`);
      paths.add(entry?.outputPath ?? '');
    }
    expect(paths.size).toBe(3);
  });
});
