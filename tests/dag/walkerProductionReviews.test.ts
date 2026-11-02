import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireWalkLock, isWalkLockResult } from '../../src/dag/projectWalkLock.js';
import { walkBundle } from '../../src/dag/walker.js';
import { openProjectionEngine } from '../../src/dag/eventLog/ProjectionEngine.js';
import {
  getGlobalRegistry,
  __resetGlobalRegistryForTesting,
} from '../../src/dag/runners/registry.js';
import { readProductionReview, recordProductionReview } from '../../src/dag/productionReviews.js';
import {
  setProductionReviewsRequired,
  requiredReviewNodes,
  checkProductionReviewGate,
} from '../../src/dag/productionReviewGates.js';
import type { CreativeGate } from '../../src/dag/productionReviewGates.js';
import type { DagBundle, Runner } from '../../src/dag/schema.js';
let projectDir: string;
let ran: string[];
const specs = [
  ['story', 'md', []],
  ['scenes_plan', 'json', ['story']],
  ['character_image', 'image', ['story', 'scenes_plan']],
  ['voice_reference', 'audio', ['story', 'scenes_plan']],
  ['shot_image', 'image', ['character_image', 'voice_reference', 'scenes_plan']],
  ['scene_clip', 'video', ['shot_image']],
  ['final_video', 'video', ['scene_clip']],
] as const;
const bundle: DagBundle = {
  id: 'review-fixture',
  version: '1',
  engineCompat: '>=0.1.0',
  goal: 'final_video',
  nodes: specs.map(([id, format, from]) => ({
    id,
    kind: 'stage',
    inputs: from.map(source => ({ from: source, usage: 'input' })),
    outputs: {
      format,
      pattern: `${id}.${{ image: 'png', audio: 'wav', video: 'mp4', md: 'md', json: 'json' }[format]}`,
    },
    runner: {
      tool: format === 'md' || format === 'json' ? 'llm.fixture' : 'fixture.media',
      config: {},
    },
  })),
};
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'review-walker-'));
  writeFileSync(join(projectDir, 'project.json'), '{}');
  ran = [];
  __resetGlobalRegistryForTesting();
  const runner: Runner = {
    describe: () => ({
      id: 'fixture',
      displayName: 'fixture',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      ran.push(ctx.node.id);
      writeFileSync(
        join(ctx.projectDir, ctx.node.outputs.pattern),
        ctx.node.outputs.format === 'json' ? '{}' : 'fixture'
      );
      return { ok: true, outputPath: ctx.node.outputs.pattern };
    },
  };
  for (const tool of ['llm.fixture', 'fixture.media'])
    getGlobalRegistry().register(
      { tool, version: '1.0.0', engineCompat: '>=0.1.0', credentials: [] },
      runner
    );
});
afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});
const run = (extra: Record<string, unknown> = {}) =>
  walkBundle({
    projectDir,
    bundle,
    bundleSource: 'test:reviews',
    engine: openProjectionEngine(projectDir),
    log: () => {},
    ...extra,
  });
async function approve(gate: CreativeGate) {
  const targets = requiredReviewNodes(bundle, gate).map(nodeId => ({ nodeId }));
  const review = await readProductionReview({ projectDir, gate, targets });
  await recordProductionReview({
    projectDir,
    gate,
    targets,
    expectedFingerprint: review.fingerprint!,
    decision: 'approved',
  });
}
describe('required creative reviews in the real walker', () => {
  it('preserves existing runs when the policy is disabled', async () => {
    expect((await run()).goal).toBeTruthy();
  });
  it('pauses before paid reference work and plain resume cannot bypass it', async () => {
    setProductionReviewsRequired({ projectDir, enabled: true });
    expect((await run()).gatedAfter).toBe('review:storyboard');
    expect(ran).toEqual(['story', 'scenes_plan']);
    expect((await run({ runOnly: ['final_video'] })).gatedAfter).toBe('review:storyboard');
    expect(ran).toEqual(['story', 'scenes_plan']);
  });
  it('requires each approval including the assembled rough cut before reporting a goal', async () => {
    setProductionReviewsRequired({ projectDir, enabled: true });
    await run();
    await approve('storyboard');
    expect((await run()).gatedAfter).toBe('review:references');
    expect(ran).not.toContain('shot_image');
    await approve('references');
    const cut = await run();
    expect(cut.gatedAfter).toBe('review:rough-cut');
    expect(cut.goal).toBeUndefined();
    await approve('rough-cut');
    expect((await run()).goal).toBeTruthy();
  });
  it('recloses the gate for changed content and stopAt cannot bypass it', async () => {
    setProductionReviewsRequired({ projectDir, enabled: true });
    await run();
    await approve('storyboard');
    writeFileSync(join(projectDir, 'story.md'), 'changed');
    expect((await run({ stopAt: 'character_image' })).gatedAfter).toBe('review:storyboard');
    expect(ran).not.toContain('character_image');
  });
  it('does not accept approval of a partial collection', async () => {
    await run();
    await approve('storyboard');
    const result = await checkProductionReviewGate({
      projectDir,
      bundle,
      gate: 'storyboard',
      instances: new Map([
        ['story', [{ status: 'completed' }]],
        ['scenes_plan', [{ status: 'completed' }, { itemId: 'missing', status: 'pending' }]],
      ]),
    });
    expect(result.approved).toBe(false);
  });
});

it('refuses policy changes while a walk holds the project lock', () => {
  const lock = acquireWalkLock(projectDir);
  if (isWalkLockResult(lock)) throw new Error('test lock unavailable');
  try {
    expect(() => setProductionReviewsRequired({ projectDir, enabled: true })).toThrow(
      /in progress/
    );
  } finally {
    lock.release();
  }
});
it('requires an explicit audio audition before scene generation', async () => {
  await run();
  await approve('references');
  const instances = new Map(
    requiredReviewNodes(bundle, 'references').map(id => [id, [{ status: 'completed' }]])
  );
  const noVoice = { ...bundle, nodes: bundle.nodes.filter(n => n.id !== 'voice_reference') };
  expect(
    await checkProductionReviewGate({ projectDir, bundle: noVoice, gate: 'references', instances })
  ).toMatchObject({ approved: false, reason: expect.stringContaining('voice_reference') });
});

it('uses approved siblings when a targeted run excludes storyboard inputs', async () => {
  const scoped = {
    ...bundle,
    nodes: bundle.nodes.map(n =>
      n.id === 'character_image'
        ? { ...n, inputs: [{ from: 'story', usage: 'input' as const }] }
        : n
    ),
  };
  await run({ bundle: scoped });
  await approve('storyboard');
  setProductionReviewsRequired({ projectDir, enabled: true });
  const result = await run({ bundle: scoped, stopAt: 'character_image' });
  expect(result.gatedAfter).toBeUndefined();
});
it('rejects completed artifacts whose dependency lineage is missing', async () => {
  await run();
  await approve('storyboard');
  const { readFileSync } = await import('node:fs');
  const path = join(projectDir, '.dhee', 'events.jsonl');
  const lines = readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map(line => {
      const e = JSON.parse(line);
      if (e.kind === 'node.completed') delete e.payload.dependencies;
      return JSON.stringify(e);
    });
  writeFileSync(path, lines.join('\n') + '\n');
  await approve('references');
  await approve('rough-cut');
  setProductionReviewsRequired({ projectDir, enabled: true });
  expect((await run()).goal).toBeUndefined();
});

it('builds Desktop review targets from the current collection membership', async () => {
  const { mkdirSync, readFileSync } = await import('node:fs');
  const { readProjectProductionReview, recordProjectProductionReview } =
    await import('../../src/dag/projectProductionReviews.js');
  const { openEventLog } = await import('../../src/dag/eventLog/EventLog.js');
  await run();
  const collection = {
    id: 'shot_image_prompt',
    kind: 'collection' as const,
    itemSource: 'scenes_plan',
    inputs: [{ from: 'scenes_plan', usage: 'input' as const }],
    outputs: { format: 'json' as const, pattern: 'prompt_{{item_id}}.json' },
    runner: { tool: 'llm.fixture', config: {} },
  };
  const currentBundle = {
    ...bundle,
    nodes: [
      ...bundle.nodes.map(n =>
        n.id === 'final_video'
          ? { ...n, inputs: [...n.inputs, { from: collection.id, usage: 'context' as const }] }
          : n
      ),
      collection,
    ],
  };
  const root = join(projectDir, 'bundles');
  const dir = join(root, 'review-fixture');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(currentBundle));
  const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
  project.bundleSource = 'user:review-fixture';
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project));
  writeFileSync(join(projectDir, 'scenes_plan.json'), JSON.stringify({ items: [{ id: 'one' }] }));
  for (const itemId of ['one', 'removed_shot']) {
    const outputPath = `prompt_${itemId}.json`;
    writeFileSync(join(projectDir, outputPath), '{}');
    openEventLog(projectDir).append({
      kind: 'node.completed',
      actor: 'walker',
      branchId: 'main',
      payload: {
        nodeId: collection.id,
        itemId,
        versionId: `v-${itemId}`,
        outputPath,
        dependencies: [{ nodeId: 'scenes_plan', role: 'input' }],
      },
    } as any);
  }
  const oldRoot = process.env.DHEE_USER_BUNDLES_DIR;
  process.env.DHEE_USER_BUNDLES_DIR = root;
  try {
    const input = {
      projectDir,
      gate: 'storyboard',
      targets: [
        { nodeId: 'story' },
        { nodeId: 'scenes_plan' },
        ...['one', 'removed_shot'].map(itemId => ({ nodeId: collection.id, itemId })),
      ],
    };
    const review = await readProjectProductionReview(input);
    expect(review.status).toBe('unreviewed');
    expect(review.previews?.some(p => p.key.endsWith('removed_shot'))).toBe(false);
    await recordProjectProductionReview({
      ...input,
      expectedFingerprint: review.fingerprint!,
      decision: 'approved',
    });
    setProductionReviewsRequired({ projectDir, enabled: true });
    expect(
      (await run({ bundle: currentBundle, stopAt: 'character_image' })).gatedAfter
    ).toBeUndefined();
  } finally {
    if (oldRoot === undefined) delete process.env.DHEE_USER_BUNDLES_DIR;
    else process.env.DHEE_USER_BUNDLES_DIR = oldRoot;
  }
});

it('exact reference runs preserve the full storyboard gate and never run other references', async () => {
  setProductionReviewsRequired({ projectDir, enabled: true });
  await run();
  ran = [];
  expect((await run({ targetInstance: { nodeId: 'character_image' } })).gatedAfter).toBe(
    'review:storyboard'
  );
  expect(ran).toEqual([]);
  await approve('storyboard');
  expect(
    (await run({ targetInstance: { nodeId: 'character_image' } })).selectedOutput?.nodeId
  ).toBe('character_image');
  expect(ran).toEqual(['character_image']);
});
it('exact goal execution still requires rough-cut review', async () => {
  await run();
  setProductionReviewsRequired({ projectDir, enabled: true });
  await approve('storyboard');
  await approve('references');
  ran = [];
  const result = await run({ targetInstance: { nodeId: 'final_video' } });
  expect(result.gatedAfter).toBe('review:rough-cut');
  expect(result.selectedOutput).toBeUndefined();
  expect(ran).toEqual([]);
});
