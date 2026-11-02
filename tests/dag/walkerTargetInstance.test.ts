import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProjectViaBundle } from '../../src/server/runners/runProjectViaBundle.js';
import { walkBundle } from '../../src/dag/walker.js';
import { openProjectionEngine } from '../../src/dag/eventLog/ProjectionEngine.js';
import {
  getGlobalRegistry,
  __resetGlobalRegistryForTesting,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner } from '../../src/dag/schema.js';
let projectDir: string;
let ran: string[];
let planItems: string[];
let previousInputs: unknown[];
const bundle: DagBundle = {
  id: 'target-test',
  version: '1',
  engineCompat: '>=0.1.0',
  goal: 'final',
  nodes: [
    {
      id: 'plan',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'json', pattern: 'plan.json' },
      runner: { tool: 'fixture.target', config: {} },
    },
    {
      id: 'clip',
      kind: 'collection',
      itemSource: 'plan',
      inputs: [{ from: 'plan' }],
      outputs: { format: 'video', pattern: '{{item_id}}.mp4' },
      runner: { tool: 'fixture.target', config: {} },
    },
    {
      id: 'final',
      kind: 'stage',
      inputs: [{ from: 'clip', scope: 'all' }],
      outputs: { format: 'video', pattern: 'final.mp4' },
      runner: { tool: 'fixture.target', config: {} },
    },
  ],
};
beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'target-instance-'));
  writeFileSync(join(projectDir, 'project.json'), '{}');
  ran = [];
  planItems = ['one', 'two'];
  previousInputs = [];
  __resetGlobalRegistryForTesting();
  const runner: Runner = {
    describe: () => ({
      id: 'fixture.target',
      displayName: 'test',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      ran.push(`${ctx.node.id}:${ctx.itemId ?? ''}`);
      if (ctx.node.id === 'clip') previousInputs.push(ctx.inputs.clip);
      const out = ctx.node.id === 'plan' ? 'plan.json' : `${ctx.itemId ?? 'final'}.mp4`;
      writeFileSync(
        join(projectDir, out),
        ctx.node.id === 'plan' ? JSON.stringify(planItems.map(id => ({ id }))) : 'fixture'
      );
      return { ok: true, outputPath: out };
    },
  };
  getGlobalRegistry().register(
    { tool: 'fixture.target', version: '1', engineCompat: '>=0.1.0', credentials: [] },
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
    bundleSource: 'test:target',
    engine: openProjectionEngine(projectDir),
    log: () => {},
    ...extra,
  });
it('runs exactly one item without siblings, downstream work or final-video claims', async () => {
  await run({ stopAt: 'plan' });
  ran = [];
  const result = await run({ targetInstance: { nodeId: 'clip', itemId: 'two' } });
  expect(result.ok).toBe(true);
  expect(ran).toEqual(['clip:two']);
  expect(result).toMatchObject({
    selectedOutput: { nodeId: 'clip', itemId: 'two', outputRel: 'two.mp4' },
  });
  expect(result.goal).toBeUndefined();
  ran = [];
  expect((await run({ targetInstance: { nodeId: 'clip', itemId: 'two' } })).ok).toBe(true);
  expect(ran).toEqual([]);
});
it('does not generate missing prerequisites', async () => {
  const result = await run({ targetInstance: { nodeId: 'clip', itemId: 'two' } });
  expect(result.ok).toBe(false);
  expect(ran).toEqual([]);
});
it('rejects unknown items, stage item ids and conflicting scopes before any dispatch', async () => {
  await run({ stopAt: 'plan' });
  ran = [];
  for (const extra of [
    { targetInstance: { nodeId: 'clip', itemId: 'missing' } },
    { targetInstance: { nodeId: 'plan', itemId: 'two' } },
    { targetInstance: { nodeId: 'clip', itemId: 'one' }, stopAt: 'final' },
  ]) {
    expect((await run(extra)).ok).toBe(false);
    expect(ran).toEqual([]);
  }
});
it('rejects a stale prepared selection without starting anything', async () => {
  await run({ stopAt: 'plan' });
  ran = [];
  expect(
    (await run({ targetInstance: { nodeId: 'clip', itemId: 'two', selectionId: 'stale' } })).ok
  ).toBe(false);
  expect(ran).toEqual([]);
});

it('preserves exact scope and selected output through the project entry point', async () => {
  const previous = process.env.DHEE_USER_BUNDLES_DIR;
  process.env.DHEE_USER_BUNDLES_DIR = join(projectDir, 'bundles');
  mkdirSync(join(projectDir, 'bundles', 'target-test'), { recursive: true });
  writeFileSync(join(projectDir, 'bundles', 'target-test', 'bundle.json'), JSON.stringify(bundle));
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({ bundleSource: 'user:target-test' })
  );
  try {
    await runProjectViaBundle({ projectDir, stopAt: 'plan', log: () => {} });
    ran = [];
    const result = await runProjectViaBundle({
      projectDir,
      targetInstance: { nodeId: 'clip', itemId: 'one' },
      log: () => {},
    });
    expect(result).toMatchObject({
      ok: true,
      selectedOutput: { nodeId: 'clip', itemId: 'one', outputRel: 'one.mp4' },
    });
    expect(result.finalVideoAbs).toBeUndefined();
    expect(ran).toEqual(['clip:one']);
  } finally {
    if (previous === undefined) delete process.env.DHEE_USER_BUNDLES_DIR;
    else process.env.DHEE_USER_BUNDLES_DIR = previous;
  }
});

it('rechecks mandatory review policy inside the execution boundary', async () => {
  const result = await run({ targetInstance: { nodeId: 'plan' }, requireProductionReviews: true });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/approval/i);
  expect(ran).toEqual([]);
});

it('retains completed previous-shot inputs while dispatching only the selected item', async () => {
  planItems = ['shot_1', 'shot_2'];
  const chain = structuredClone(bundle);
  chain.nodes[1]!.inputs.push({ from: 'clip', scope: 'previousN', n: 1 });
  await run({ bundle: chain, stopAt: 'plan' });
  expect(
    (await run({ bundle: chain, targetInstance: { nodeId: 'clip', itemId: 'shot_1' } })).ok
  ).toBe(true);
  ran = [];
  expect(
    (await run({ bundle: chain, targetInstance: { nodeId: 'clip', itemId: 'shot_2' } })).ok
  ).toBe(true);
  expect(ran).toEqual(['clip:shot_2']);
  expect(previousInputs.at(-1)).toMatchObject([
    { itemId: 'shot_1', outputAbs: join(projectDir, 'shot_1.mp4') },
  ]);
});
it('blocks a previous-shot chain when its earlier shot has not completed', async () => {
  planItems = ['shot_1', 'shot_2'];
  const chain = structuredClone(bundle);
  chain.nodes[1]!.inputs.push({ from: 'clip', scope: 'previousN', n: 1 });
  await run({ bundle: chain, stopAt: 'plan' });
  ran = [];
  expect(
    (await run({ bundle: chain, targetInstance: { nodeId: 'clip', itemId: 'shot_2' } })).ok
  ).toBe(false);
  expect(ran).toEqual([]);
});
it('pins the expected runner tool before dispatch', async () => {
  await run({ stopAt: 'plan' });
  ran = [];
  const result = await run({
    targetInstance: { nodeId: 'clip', itemId: 'one', expectedTool: 'ffmpeg.concat' },
  });
  expect(result.ok).toBe(false);
  expect(result.error).toMatch(/runner|tool/i);
  expect(ran).toEqual([]);
});
it('pins a null default selection and rejects a subsequent runner swap', async () => {
  await run({ stopAt: 'plan' });
  const { openEventLog } = await import('../../src/dag/eventLog/EventLog.js');
  openEventLog(projectDir).append({
    kind: 'runner.swapped',
    actor: 'test',
    branchId: 'main',
    payload: {
      nodeId: 'clip',
      itemId: 'one',
      fromTool: 'fixture.target',
      toTool: 'fixture.target',
      configOverride: {},
    },
  });
  ran = [];
  expect(
    (
      await run({
        targetInstance: {
          nodeId: 'clip',
          itemId: 'one',
          selectionId: null,
          expectedTool: 'fixture.target',
        },
      })
    ).ok
  ).toBe(false);
  expect(ran).toEqual([]);
});

it('accepts a pinned bundle-default runner without a swap', async () => {
  await run({ stopAt: 'plan' });
  expect(
    (
      await run({
        targetInstance: {
          nodeId: 'clip',
          itemId: 'one',
          selectionId: null,
          expectedTool: 'fixture.target',
        },
      })
    ).ok
  ).toBe(true);
});
