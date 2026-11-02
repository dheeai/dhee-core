import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProductionControl } from '../../src/control/productionControl.js';
import { listGpuTargets, prepareGpuAttempt } from '../../src/control/gpuPreparation.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
import { resolveRunnerForInstance } from '../../src/dag/resolveRunnerForInstance.js';
const dirs: string[] = [];
const original = process.env.DHEE_USER_BUNDLES_DIR;
afterEach(() => {
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
  if (original === undefined) delete process.env.DHEE_USER_BUNDLES_DIR;
  else process.env.DHEE_USER_BUNDLES_DIR = original;
});
function setup() {
  const projectDir = mkdtempSync(join(tmpdir(), 'gpu-prepare-'));
  dirs.push(projectDir);
  const root = join(projectDir, 'bundles');
  mkdirSync(join(root, 'test'), { recursive: true });
  process.env.DHEE_USER_BUNDLES_DIR = root;
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ bundleSource: 'user:test' }));
  writeFileSync(
    join(root, 'test/bundle.json'),
    JSON.stringify({
      id: 'test',
      version: '1',
      engineCompat: '>=0.1.0',
      goal: 'clip',
      nodes: [
        {
          id: 'clip',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'video', pattern: 'clip.mp4' },
          runner: { tool: 'comfy.tti', config: {} },
        },
      ],
    })
  );
  const catalog = vi.fn(async () => [
    {
      name: 'video',
      description: 'video',
      version: 'v1',
      available: true,
      status: 'unchecked',
      inputs: {
        prompt: { type: 'string', required: true },
        seed: { type: 'int', random_default: true, min: 0, max: 4294967295 },
      },
    },
  ]);
  const req = {
    projectDir,
    branchId: 'main',
    nodeId: 'clip',
    requestId: 'request-001',
    expectedSelectionId: null,
    endpoint: 'http://gpu/mcp',
    workflow: 'video',
    workflowVersion: 'v1',
    inputs: { prompt: 'scene' },
    primaryOutput: 0,
  };
  return { projectDir, catalog, req };
}
it('saves an explicit attempt without uploading or submitting; identical retries retain it', async () => {
  const { projectDir, catalog, req } = setup();
  const saved = await prepareGpuAttempt(req, catalog);
  const repeat = await prepareGpuAttempt(req, catalog);
  expect(repeat).toEqual(saved);
  const resolved = resolveRunnerForInstance({
    projectDir,
    nodeId: 'clip',
    branchId: 'main',
    fallbackTool: 'comfy.tti',
  });
  expect(resolved).toMatchObject({
    tool: 'gpu.queue',
    configOverride: {
      workflow: 'video',
      workflowVersion: 'v1',
      inputs: { prompt: 'scene', seed: expect.any(Number) },
    },
  });
  expect(
    [...openEventLog(projectDir).read()].filter(e => e.kind === 'runner.swapped')
  ).toHaveLength(1);
  expect(listGpuTargets({ projectDir, branchId: 'main' }).targets[0]).toMatchObject({
    selectionId: saved.selectionId,
    selection: { attemptKey: saved.attemptKey },
  });
});
it('rejects stale catalog versions, missing inputs, unknown targets and branches', async () => {
  const { req, catalog } = setup();
  for (const patch of [
    { workflowVersion: 'old' },
    { inputs: {} },
    { nodeId: 'other' },
    { branchId: 'missing' },
  ])
    await expect(prepareGpuAttempt({ ...req, ...patch }, catalog)).rejects.toThrow();
  expect([...openEventLog(req.projectDir).read()]).toHaveLength(0);
});
it('rejects changed retries and stale concurrent selections', async () => {
  const { req, catalog } = setup();
  await prepareGpuAttempt(req, catalog);
  await expect(
    prepareGpuAttempt({ ...req, inputs: { prompt: 'changed' } }, catalog)
  ).rejects.toThrow(/different/);
  await expect(prepareGpuAttempt({ ...req, requestId: 'other-request' }, catalog)).rejects.toThrow(
    /changed/
  );
});
it('does not configure completed output silently', async () => {
  const { req, catalog } = setup();
  writeFileSync(join(req.projectDir, 'clip.mp4'), 'old');
  openEventLog(req.projectDir).append({
    kind: 'node.completed',
    actor: 'test',
    branchId: 'main',
    payload: { nodeId: 'clip', versionId: 'v1', outputPath: 'clip.mp4' },
  });
  await expect(prepareGpuAttempt(req, catalog)).rejects.toThrow(/completed/);
});

it('blocks replacing an unresolved gateway attempt', async () => {
  const { req, catalog } = setup();
  const saved = await prepareGpuAttempt(req, catalog);
  const { QueueJobs } = await import('../../src/dag/gpuQueueJobs.js');
  const store = new QueueJobs(
    req.projectDir,
    () =>
      ({
        submit: async () => {
          throw new Error('lost reply');
        },
      }) as any
  );
  await store.submit({
    key: JSON.stringify(['gpu.queue', 'clip', '', saved.attemptKey]),
    endpoint: req.endpoint,
    workflow: 'video',
    version: 'v1',
    inputs: {},
  });
  await expect(
    prepareGpuAttempt(
      { ...req, requestId: 'new-attempt', expectedSelectionId: saved.selectionId },
      catalog
    )
  ).rejects.toThrow(/unresolved/);
});
it('uses separate attempt keys and selections on different branches', async () => {
  const { req, catalog } = setup();
  const main = await prepareGpuAttempt(req, catalog);
  const log = openEventLog(req.projectDir);
  log.append({
    kind: 'branch.created',
    actor: 'test',
    branchId: 'alternate',
    payload: { branchId: 'alternate', parentBranchId: 'main', forkedFromEventId: main.selectionId },
  });
  const alternate = await prepareGpuAttempt({ ...req, branchId: 'alternate' }, catalog);
  expect(main.attemptKey).not.toBe(alternate.attemptKey);
  expect(
    listGpuTargets({ projectDir: req.projectDir, branchId: 'main' }).targets[0]?.selectionId
  ).toBe(main.selectionId);
});
it('rejects preparation while a project run holds the lock', async () => {
  const { req, catalog } = setup();
  const { acquireWalkLock, isWalkLockResult } = await import('../../src/dag/projectWalkLock.js');
  const lock = acquireWalkLock(req.projectDir);
  if (isWalkLockResult(lock)) throw new Error('fixture lock failed');
  try {
    await expect(prepareGpuAttempt(req, catalog)).rejects.toThrow(/active run/);
  } finally {
    lock.release();
  }
});

it('does not steal a lock while another process is writing its owner payload', async () => {
  const { req, catalog } = setup();
  mkdirSync(join(req.projectDir, '.dhee'), { recursive: true });
  writeFileSync(join(req.projectDir, '.dhee/.walk.lock'), '');
  await expect(prepareGpuAttempt(req, catalog)).rejects.toThrow(/active run/);
});

it('reports a superseded retry without reverting the newer selection', async () => {
  const { req, catalog } = setup();
  const first = await prepareGpuAttempt(req, catalog);
  const second = await prepareGpuAttempt(
    { ...req, requestId: 'second-attempt', expectedSelectionId: first.selectionId },
    catalog
  );
  expect(await prepareGpuAttempt(req, catalog)).toMatchObject({
    selectionId: first.selectionId,
    active: false,
  });
  expect(listGpuTargets({ projectDir: req.projectDir }).targets[0]?.selectionId).toBe(
    second.selectionId
  );
});

it('protects unresolved attempts declared in the bundle before the first selection swap', async () => {
  const { req, catalog } = setup();
  const file = join(req.projectDir, 'bundles/test/bundle.json');
  const { readFileSync } = await import('node:fs');
  const bundle = JSON.parse(readFileSync(file, 'utf8'));
  bundle.nodes[0].runner = {
    tool: 'gpu.queue',
    config: { attemptKey: 'declared-attempt', workflow: 'video', workflowVersion: 'v1' },
  };
  writeFileSync(file, JSON.stringify(bundle));
  const { QueueJobs } = await import('../../src/dag/gpuQueueJobs.js');
  const store = new QueueJobs(
    req.projectDir,
    () =>
      ({
        submit: async () => {
          throw new Error('lost reply');
        },
      }) as any
  );
  await store.submit({
    key: JSON.stringify(['gpu.queue', 'clip', '', 'declared-attempt']),
    endpoint: req.endpoint,
    workflow: 'video',
    version: 'v1',
    inputs: {},
  });
  await expect(prepareGpuAttempt(req, catalog)).rejects.toThrow(/unresolved/);
});

it('routes preparation and target inspection through the shared production controller', async () => {
  const { req, catalog } = setup();
  const control = createProductionControl({ catalog: () => ({ listWorkflows: catalog }) });
  const prepared = await control({ action: 'gpu.prepare', ...req });
  expect(prepared).toMatchObject({ ok: true, result: { active: true, workflow: 'video' } });
  const targets = await control({ action: 'gpu.targets', projectDir: req.projectDir });
  expect(targets).toMatchObject({
    ok: true,
    result: { targets: [{ nodeId: 'clip', tool: 'gpu.queue' }] },
  });
  expect(catalog).toHaveBeenCalledTimes(1);
});

it('exposes an approval-gated exact run of a saved selection through the controller', async () => {
  const { req, catalog } = setup();
  const saved = await prepareGpuAttempt(req, catalog);
  const run = vi.fn(async () => ({
    ok: true,
    selectedOutput: { nodeId: 'clip', outputAbs: '/fixture/clip.mp4', outputRel: 'clip.mp4' },
  }));
  const control = createProductionControl({ run });
  const request = {
    action: 'gpu.run',
    projectDir: req.projectDir,
    nodeId: 'clip',
    expectedSelectionId: saved.selectionId,
  };
  expect(await control(request)).toMatchObject({
    ok: false,
    error: expect.stringMatching(/approval/i),
  });
  expect(run).not.toHaveBeenCalled();
  await control({ action: 'review.enable', projectDir: req.projectDir });
  expect(await control({ ...request, expectedSelectionId: 'stale' })).toMatchObject({ ok: false });
  expect(run).not.toHaveBeenCalled();
  expect(await control(request)).toMatchObject({
    ok: true,
    result: { selectedOutput: { nodeId: 'clip' } },
  });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ targetInstance: { nodeId: 'clip', selectionId: saved.selectionId } })
  );
});
it('blocks contradictory scene evidence before saving an attempt', async () => {
  const { req, catalog } = setup();
  const { sceneInputDigest } = await import('../../src/control/sceneIntent.js');
  const sceneIntent = {
    requirements: [
      {
        id: 'doctor',
        description: 'Doctor remains seated',
        expected: 'seated',
        sources: ['motion'],
      },
    ],
    sources: [
      {
        id: 'motion',
        inputKey: 'prompt',
        sha256: sceneInputDigest('scene'),
        evidence: 'Read prompt',
        facts: { doctor: 'exiting' },
      },
    ],
  };
  await expect(prepareGpuAttempt({ ...req, sceneIntent } as any, catalog)).rejects.toThrow(
    /Scene intent blocked/
  );
});
it('pins checked scene evidence and rejects changed text', async () => {
  const { req, catalog } = setup();
  const { sceneInputDigest } = await import('../../src/control/sceneIntent.js');
  const sceneIntent = {
    requirements: [
      {
        id: 'doctor',
        description: 'Doctor remains seated',
        expected: 'seated',
        sources: ['motion'],
      },
    ],
    sources: [
      {
        id: 'motion',
        inputKey: 'prompt',
        sha256: sceneInputDigest('scene'),
        evidence: 'Read prompt',
        facts: { doctor: 'seated' },
      },
    ],
  };
  await expect(
    prepareGpuAttempt({ ...req, inputs: { prompt: 'changed' }, sceneIntent } as any, catalog)
  ).rejects.toThrow(/stale/);
  const result = await prepareGpuAttempt({ ...req, sceneIntent } as any, catalog);
  const saved = [...openEventLog(req.projectDir).read()].find(e => e.id === result.selectionId);
  expect(saved?.payload).toMatchObject({ configOverride: { sceneIntent } });
});
