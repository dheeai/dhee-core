import { afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProductionControl } from '../../src/control/productionControl.js';
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), 'production-control-'));
  dirs.push(projectDir);
  writeFileSync(join(projectDir, 'project.json'), '{}');
  return realpathSync(projectDir);
}
it('rejects unknown operations and relative project paths without side effects', async () => {
  const run = vi.fn();
  const control = createProductionControl({ run });
  expect(await control({ action: 'gpu.submit', projectDir: fixture() })).toMatchObject({
    ok: false,
  });
  expect(await control({ action: 'project.status', projectDir: '.' })).toMatchObject({ ok: false });
  expect(run).not.toHaveBeenCalled();
});
it('blocks automated runs until the three-review policy is enabled, then forwards branch and cancellation', async () => {
  const projectDir = fixture();
  const run = vi.fn(async () => ({ ok: true, gatedAfter: 'review:storyboard' }));
  const control = createProductionControl({ run });
  expect(await control({ action: 'project.run', projectDir })).toMatchObject({
    ok: false,
    error: expect.stringMatching(/approval/i),
  });
  expect(run).not.toHaveBeenCalled();
  expect(await control({ action: 'review.enable', projectDir })).toMatchObject({ ok: true });
  const signal = new AbortController().signal;
  expect(
    await control(
      { action: 'project.run', projectDir, branchId: 'creative-b', stopAt: 'scene_clip' },
      { signal }
    )
  ).toMatchObject({ ok: true, result: { gatedAfter: 'review:storyboard' } });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({ projectDir, branchId: 'creative-b', stopAt: 'scene_clip', signal })
  );
});
it('requires an explicit human acknowledgement for creative decisions', async () => {
  const review = vi.fn();
  const control = createProductionControl({ recordReview: review });
  const request = {
    action: 'review.decide',
    projectDir: fixture(),
    gate: 'storyboard',
    expectedFingerprint: 'a'.repeat(64),
    decision: 'approved',
  };
  expect(await control(request)).toMatchObject({ ok: false });
  expect(review).not.toHaveBeenCalled();
  review.mockResolvedValue({ status: 'approved' });
  expect(await control({ ...request, humanAcknowledged: true })).toMatchObject({ ok: true });
  expect(review).toHaveBeenCalledWith(
    expect.objectContaining({ targets: [], expectedFingerprint: request.expectedFingerprint })
  );
});
it('returns a truthful project snapshot and never modifies review policy while reading', async () => {
  const control = createProductionControl();
  const projectDir = fixture();
  expect(await control({ action: 'project.status', projectDir })).toMatchObject({
    ok: true,
    result: { reviewsRequired: false },
  });
});
it('routes catalog checks through the gateway client and passes cancellation', async () => {
  const listWorkflows = vi.fn(async () => [{ name: 'test', status: 'unchecked' }]);
  const control = createProductionControl({ catalog: () => ({ listWorkflows }) });
  const signal = new AbortController().signal;
  expect(
    await control({ action: 'gpu.catalog', endpoint: 'http://gpu/mcp' }, { signal })
  ).toMatchObject({ ok: true, result: { workflows: [{ status: 'unchecked' }] } });
  expect(listWorkflows).toHaveBeenCalledWith(signal);
});
it('uses saved-job operations and returns summaries without prompts or remote URLs', async () => {
  const refresh = vi.fn();
  const list = vi.fn(() => [
    {
      id: 'a'.repeat(64),
      workflow: 'video',
      phase: 'tracked',
      inputs: { prompt: 'private' },
      endpoint: 'http://private/mcp',
      job: { state: 'done', outputs: [{ url: 'http://private/file' }] },
    },
  ]);
  const control = createProductionControl({
    jobs: () => ({ refresh, list, cancel: vi.fn(), download: vi.fn() }),
  });
  const result = await control({
    action: 'gpu.jobs',
    projectDir: fixture(),
    operation: 'refresh',
    id: 'a'.repeat(64),
  });
  expect(refresh).toHaveBeenCalledWith('a'.repeat(64), undefined);
  expect(result).toMatchObject({ ok: true, result: { jobs: [{ state: 'done' }] } });
  expect(JSON.stringify(result)).not.toMatch(/private/);
});

it('drives a real narrative fixture through all three approvals without a GPU call', async () => {
  const { mkdirSync } = await import('node:fs');
  const { getGlobalRegistry } = await import('../../src/dag/runners/registry.js');
  const projectDir = fixture();
  const bundleRoot = join(projectDir, 'test-bundles');
  const bundleDir = join(bundleRoot, 'control-fixture');
  mkdirSync(bundleDir, { recursive: true });
  const previous = process.env.DHEE_USER_BUNDLES_DIR;
  process.env.DHEE_USER_BUNDLES_DIR = bundleRoot;
  const specs = [
    ['story', 'md', []],
    ['scenes_plan', 'json', ['story']],
    ['character_image', 'image', ['story', 'scenes_plan']],
    ['voice_reference', 'audio', ['story', 'scenes_plan']],
    ['scene_clip', 'video', ['character_image', 'voice_reference', 'scenes_plan']],
    ['final_video', 'video', ['scene_clip']],
  ] as const;
  const ran: string[] = [];
  getGlobalRegistry().register(
    { tool: 'test.control', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    {
      describe: () => ({
        id: 'test.control',
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
    }
  );
  writeFileSync(
    join(bundleDir, 'bundle.json'),
    JSON.stringify({
      id: 'control-fixture',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      dependencies: { runners: { 'test.control': '^0.1.0' } },
      goal: 'final_video',
      nodes: specs.map(([id, format, from]) => ({
        id,
        kind: 'stage',
        inputs: from.map(source => ({ from: source, usage: 'input' })),
        outputs: {
          format,
          pattern: `${id}.${{ md: 'md', json: 'json', image: 'png', audio: 'wav', video: 'mp4' }[format]}`,
        },
        runner: { tool: 'test.control', config: {} },
      })),
    })
  );
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({ bundleSource: 'user:control-fixture' })
  );
  const control = createProductionControl();
  try {
    expect(await control({ action: 'review.enable', projectDir })).toMatchObject({ ok: true });
    for (const gate of ['storyboard', 'references', 'rough-cut']) {
      const result = await control({ action: 'project.run', projectDir });
      expect(result).toMatchObject({ ok: true, result: { gatedAfter: `review:${gate}` } });
      if (gate === 'storyboard') expect(ran).toEqual(['story', 'scenes_plan']);
      const review = await control({ action: 'review.read', projectDir, gate });
      expect(review).toMatchObject({
        ok: true,
        result: { status: 'unreviewed', fingerprint: expect.any(String) },
      });
      const fingerprint = (review as any).result.fingerprint;
      expect(
        await control({
          action: 'review.decide',
          projectDir,
          gate,
          decision: 'approved',
          expectedFingerprint: fingerprint,
          humanAcknowledged: true,
        })
      ).toMatchObject({ ok: true, result: { status: 'approved' } });
    }
    expect(await control({ action: 'project.run', projectDir })).toMatchObject({
      ok: true,
      result: { finalVideoAbs: expect.any(String) },
    });
  } finally {
    if (previous === undefined) delete process.env.DHEE_USER_BUNDLES_DIR;
    else process.env.DHEE_USER_BUNDLES_DIR = previous;
  }
});

it('reports durable pause hints as project-wide rather than implying branch completion', async () => {
  const projectDir = fixture();
  writeFileSync(
    join(projectDir, 'project.json'),
    JSON.stringify({
      pausedAtGate: { gatedAfter: 'review:references', ts: 1 },
      pausedAtBudget: { capUsd: 2, spentUsd: 2, nextNodeId: 'clip', ts: 1 },
    })
  );
  expect(
    await createProductionControl()({ action: 'project.status', projectDir, branchId: 'alternate' })
  ).toMatchObject({
    ok: true,
    result: {
      pauseHints: {
        scope: 'project',
        gate: { gatedAfter: 'review:references' },
        budget: { nextNodeId: 'clip' },
      },
    },
  });
});
