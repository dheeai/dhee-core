import { afterEach, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGpuQueueRunner } from '../../../src/dag/runners/gpuQueue.js';
const dirs: string[] = [];
afterEach(() => {
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
});
function fixture() {
  const projectDir = mkdtempSync(join(tmpdir(), 'queue-runner-'));
  dirs.push(projectDir);
  writeFileSync(join(projectDir, 'ref.png'), 'reference');
  const catalog = {
    name: 'video',
    description: '',
    version: 'v1',
    available: true,
    status: 'unchecked',
    inputs: {
      prompt: { type: 'string', required: true },
      refs: { type: 'file_list' },
      seed: { type: 'int', random_default: true, min: 0, max: 4294967295 },
    },
  };
  const client = {
    listWorkflows: vi.fn(async () => [catalog]),
    submit: vi.fn(async () => ({ job_id: 'j1' })),
    getJob: vi.fn(async () => ({
      job_id: 'j1',
      state: 'done',
      outputs: [{ url: 'http://gpu/files/clip.mp4' }, { url: 'http://gpu/files/voice.wav' }],
    })),
    cancel: vi.fn(async () => ({})),
  };
  const fetcher = vi.fn(async (url: any) =>
    new URL(url).pathname === '/upload'
      ? new Response(JSON.stringify({ ref: 'up_reference' }))
      : new Response('media')
  );
  const runner = createGpuQueueRunner({
    clientFactory: () => client as any,
    fetcher: fetcher as typeof fetch,
    pollMs: 0,
  });
  const ctx: any = {
    projectDir,
    inputs: { story: 'baseline placeholder', references: [join(projectDir, 'ref.png')] },
    node: {
      id: 'clip',
      runner: {
        tool: 'gpu.queue',
        config: {
          endpoint: 'http://gpu/mcp',
          workflow: 'video',
          workflowVersion: 'v1',
          attemptKey: 'attempt1',
          inputMap: { prompt: 'story', refs: 'references' },
          outputPath: 'clip.mp4',
        },
      },
    },
    log: vi.fn(),
  };
  return { projectDir, client, fetcher, runner, ctx };
}
it('runs through uploads, durable queue and local output retrieval, then resumes without resubmission', async () => {
  const { projectDir, client, fetcher, runner, ctx } = fixture();
  const result = await runner.run(ctx);
  expect(result.ok).toBe(true);
  expect(readFileSync(join(projectDir, 'clip.mp4'), 'utf8')).toBe('media');
  expect(result.ok && result.outputs).toHaveLength(1);
  expect(client.submit.mock.calls[0]?.[1]).toMatchObject({
    prompt: 'baseline placeholder',
    refs: ['up_reference'],
  });
  expect((await runner.run(ctx)).ok).toBe(true);
  expect(client.submit).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
it('rejects changed workflow versions before upload or submit', async () => {
  const { client, runner, ctx, fetcher } = fixture();
  ctx.node.runner.config.workflowVersion = 'old';
  expect(await runner.run(ctx)).toMatchObject({
    ok: false,
    error: expect.stringMatching(/version/i),
  });
  expect(client.submit).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
it('rejects references outside the project', async () => {
  const { runner, ctx, fetcher } = fixture();
  ctx.inputs.references = ['/etc/hosts'];
  expect(await runner.run(ctx)).toMatchObject({
    ok: false,
    error: expect.stringMatching(/project/i),
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it('does not silently reuse an attempt with changed reference bytes', async () => {
  const { projectDir, runner, ctx, client } = fixture();
  await runner.run(ctx);
  writeFileSync(join(projectDir, 'ref.png'), 'changed');
  expect(await runner.run(ctx)).toMatchObject({
    ok: false,
    error: expect.stringMatching(/different request/),
  });
  expect(client.submit).toHaveBeenCalledTimes(1);
});
it('returns failures instead of throwing and retains terminal failed jobs', async () => {
  const { runner, ctx, client } = fixture();
  client.getJob.mockResolvedValue({ job_id: 'j1', state: 'failed', error: 'model missing' } as any);
  expect(await runner.run(ctx)).toMatchObject({
    ok: false,
    error: expect.stringMatching(/model missing/),
  });
  expect((await runner.run(ctx)).ok).toBe(false);
  expect(client.submit).toHaveBeenCalledTimes(1);
});

it('can reuse saved outputs when the live catalog is temporarily unavailable', async () => {
  const { runner, ctx, client } = fixture();
  expect((await runner.run(ctx)).ok).toBe(true);
  client.listWorkflows.mockRejectedValue(new Error('offline'));
  expect((await runner.run(ctx)).ok).toBe(true);
  expect(client.submit).toHaveBeenCalledTimes(1);
});

it('requests cancellation when an accepted job is aborted', async () => {
  const { runner, ctx, client } = fixture();
  const controller = new AbortController();
  ctx.signal = controller.signal;
  client.getJob.mockImplementation(async () => {
    controller.abort(new Error('Stopped by user'));
    return { job_id: 'j1', state: 'running' } as any;
  });
  expect(await runner.run(ctx)).toMatchObject({ ok: false });
  expect(client.cancel).toHaveBeenCalledWith('j1', undefined);
});
it('rejects tampered saved outputs without resubmitting', async () => {
  const { runner, ctx, client, projectDir } = fixture();
  const result = await runner.run(ctx);
  if (!result.ok) throw new Error(result.error);
  writeFileSync(join(projectDir, result.outputs![0].path), 'tampered');
  expect(await runner.run(ctx)).toMatchObject({
    ok: false,
    error: expect.stringMatching(/output changed/),
  });
  expect(client.submit).toHaveBeenCalledTimes(1);
});
it('keeps an accepted job resumable after a wait timeout', async () => {
  const { runner, ctx, client } = fixture();
  ctx.node.runner.config.timeoutSeconds = 1;
  let now = 0;
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  client.getJob.mockImplementation(async () => {
    now += 2000;
    return { job_id: 'j1', state: 'running' } as any;
  });
  try {
    expect(await runner.run(ctx)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/timed out/),
    });
  } finally {
    clock.mockRestore();
  }
  expect(client.cancel).not.toHaveBeenCalled();
  client.getJob.mockResolvedValue({
    job_id: 'j1',
    state: 'done',
    outputs: [{ url: 'http://gpu/files/clip.mp4' }],
  } as any);
  expect((await runner.run(ctx)).ok).toBe(true);
  expect(client.submit).toHaveBeenCalledTimes(1);
});

it('executes a declared queue node through the real DAG walker', async () => {
  const { runner, client, projectDir } = fixture();
  const { walkBundle } = await import('../../../src/dag/walker.js');
  const { getGlobalRegistry } = await import('../../../src/dag/runners/registry.js');
  const { getRunner } = await import('../../../src/dag/runners/index.js');
  const original = getRunner('gpu.queue');
  expect(original?.describe().id).toBe('gpu.queue');
  const registry = getGlobalRegistry();
  registry.register(
    { tool: 'gpu.queue', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    runner
  );
  writeFileSync(join(projectDir, 'project.json'), '{}');
  try {
    const result = await walkBundle({
      projectDir,
      bundleSource: 'test:gpu-queue',
      log: () => {},
      bundle: {
        id: 'queue-fixture',
        version: '0.1.0',
        engineCompat: '>=0.1.0',
        dependencies: { runners: { 'gpu.queue': '^0.1.0' } },
        goal: 'clip',
        nodes: [
          {
            id: 'clip',
            kind: 'stage',
            inputs: [],
            outputs: { format: 'video', pattern: 'renders/clip.mp4' },
            runner: {
              tool: 'gpu.queue',
              config: {
                endpoint: 'http://gpu/mcp',
                workflow: 'video',
                workflowVersion: 'v1',
                attemptKey: 'fixture-attempt',
                inputs: { prompt: 'test fixture', refs: ['ref.png'] },
              },
            },
          },
        ],
      },
    });
    expect(result.goal).toBeTruthy();
    expect(readFileSync(join(projectDir, 'renders/clip.mp4'), 'utf8')).toBe('media');
    expect(client.submit).toHaveBeenCalledTimes(1);
  } finally {
    if (original)
      registry.register(
        { tool: 'gpu.queue', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
        original
      );
  }
});

it('resumes against the saved gateway after Desktop changes or clears its endpoint', async () => {
  const { runner, ctx, client } = fixture();
  expect((await runner.run(ctx)).ok).toBe(true);
  ctx.node.runner.config.endpoint = 'http://new-gateway/mcp';
  expect((await runner.run(ctx)).ok).toBe(true);
  ctx.node.runner.config.endpoint = '';
  expect((await runner.run(ctx)).ok).toBe(true);
  expect(client.submit).toHaveBeenCalledTimes(1);
});
