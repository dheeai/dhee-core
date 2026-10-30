import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QueueJobs } from '../../src/dag/gpuQueueJobs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'queue-jobs-'));
  dirs.push(dir);
  const remote = {
    submit: vi.fn(async () => ({ job_id: 'job1' })),
    getJob: vi.fn(async () => ({ job_id: 'job1', state: 'queued' })),
    cancel: vi.fn(async () => ({})),
  };
  const fetcher = vi.fn(async () => new Response('media'));
  const jobs = new QueueJobs(dir, () => remote as any, fetcher as typeof fetch);
  const input = {
    key: 'scene1-v1',
    endpoint: 'http://gpu/mcp',
    workflow: 'video',
    version: 'v1',
    inputs: { prompt: 'scene', refs: ['up_b', 'up_a'] },
  };
  return { dir, remote, fetcher, jobs, input };
}
describe('durable queue jobs', () => {
  it('persists accepted id and resumes after restart without resubmitting', async () => {
    const { dir, remote, jobs, input } = fixture();
    const first = await jobs.submit(input);
    const reopened = new QueueJobs(dir, () => remote as any);
    expect((await reopened.submit(input)).jobId).toBe('job1');
    expect(remote.submit).toHaveBeenCalledTimes(1);
    expect((await reopened.refresh(first.id)).job?.state).toBe('queued');
  });
  it('persists ambiguous dispatch and refuses automatic resubmission', async () => {
    const { jobs, remote, input } = fixture();
    remote.submit.mockRejectedValueOnce(new Error('connection lost'));
    const record = await jobs.submit(input);
    expect(record.phase).toBe('unknown');
    expect((await jobs.submit(input)).phase).toBe('unknown');
    expect(remote.submit).toHaveBeenCalledTimes(1);
  });
  it('rejects a changed request reusing an existing operation key', async () => {
    const { jobs, input } = fixture();
    await jobs.submit(input);
    await expect(jobs.submit({ ...input, inputs: { prompt: 'changed' } })).rejects.toThrow(
      /different/
    );
  });
  it('marks cancellation requested without claiming the remote job stopped', async () => {
    const { jobs, remote, input } = fixture();
    const first = await jobs.submit(input);
    const cancelled = await jobs.cancel(first.id);
    expect(cancelled.cancelRequested).toBe(true);
    expect(cancelled.job?.state).not.toBe('cancelled');
    expect(remote.cancel).toHaveBeenCalledWith('job1', undefined);
  });
  it('downloads all outputs and keeps checksums and native audio together', async () => {
    const { dir, jobs, remote, input } = fixture();
    remote.getJob.mockResolvedValue({
      job_id: 'job1',
      state: 'done',
      outputs: [{ url: 'http://gpu/files/clip.mp4' }, { url: 'http://gpu/files/voice.wav' }],
    } as any);
    const first = await jobs.submit(input);
    await jobs.refresh(first.id);
    const saved = await jobs.download(first.id);
    expect(saved.phase).toBe('downloaded');
    expect(saved.files).toHaveLength(2);
    expect(saved.files?.[0].sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(join(dir, saved.files![1].path), 'utf8')).toBe('media');
  });
  it('retains remote id after a partial download failure and allows download retry', async () => {
    const { jobs, remote, fetcher, input } = fixture();
    remote.getJob.mockResolvedValue({
      job_id: 'job1',
      state: 'done',
      outputs: [{ url: 'http://gpu/files/a.mp4' }, { url: 'http://gpu/files/b.wav' }],
    } as any);
    fetcher
      .mockResolvedValueOnce(new Response('first'))
      .mockResolvedValueOnce(new Response('expired', { status: 410 }));
    const first = await jobs.submit(input);
    await jobs.refresh(first.id);
    await expect(jobs.download(first.id)).rejects.toThrow('410');
    expect(jobs.read(first.id).phase).toBe('tracked');
    expect((await jobs.download(first.id)).phase).toBe('downloaded');
    expect(remote.submit).toHaveBeenCalledTimes(1);
  });
  it('rejects foreign output URLs and empty output lists', async () => {
    const { jobs, remote, input, fetcher } = fixture();
    const first = await jobs.submit(input);
    remote.getJob.mockResolvedValue({
      job_id: 'job1',
      state: 'done',
      outputs: [{ url: 'http://elsewhere/file.mp4' }],
    } as any);
    await jobs.refresh(first.id);
    await expect(jobs.download(first.id)).rejects.toThrow(/origin/);
    expect(fetcher).not.toHaveBeenCalled();
    remote.getJob.mockResolvedValue({ job_id: 'job1', state: 'done', outputs: [] } as any);
    await jobs.refresh(first.id);
    await expect(jobs.download(first.id)).rejects.toThrow(/outputs/);
  });
  it('rejects concurrent writers instead of dispatching duplicate work', async () => {
    const { jobs, remote, input } = fixture();
    let finish!: (value: { job_id: string }) => void;
    remote.submit.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const first = jobs.submit(input);
    await expect(jobs.submit(input)).rejects.toThrow(/progress/);
    finish({ job_id: 'job1' });
    await first;
  });
  it('does not dispatch when already aborted', async () => {
    const { jobs, remote, input } = fixture();
    await expect(jobs.submit(input, AbortSignal.abort())).rejects.toThrow();
    expect(remote.submit).not.toHaveBeenCalled();
  });
});

it('does not create queue storage through a symlink outside the project', async () => {
  const { symlinkSync, existsSync } = await import('node:fs');
  const project = mkdtempSync(join(tmpdir(), 'queue-project-'));
  dirs.push(project);
  const outside = mkdtempSync(join(tmpdir(), 'queue-outside-'));
  dirs.push(outside);
  symlinkSync(outside, join(project, '.dhee'));
  expect(() => new QueueJobs(project)).toThrow();
  expect(existsSync(join(outside, 'gpu-queue'))).toBe(false);
});

it('allows only one dispatch across competing Node processes', async () => {
  const { spawn } = await import('node:child_process');
  const dir = mkdtempSync(join(tmpdir(), 'queue-processes-'));
  dirs.push(dir);
  const source = new URL('../../src/dag/gpuQueueJobs.ts', import.meta.url).href;
  const script = `import {QueueJobs} from ${JSON.stringify(source)}; import {appendFileSync} from 'node:fs';
    const store = new QueueJobs(${JSON.stringify(dir)}, () => ({submit:async()=>{appendFileSync(${JSON.stringify(join(dir, 'dispatches'))},'dispatch\\n'); await new Promise(r=>setTimeout(r,150)); return {job_id:'job1'};}}));
    try {await store.submit({key:'same',endpoint:'http://gpu/mcp',workflow:'video',version:'v1',inputs:{}})} catch(e) {if (!/progress|EEXIST/.test(e.message)) {console.error(e); process.exitCode=1;}}`;
  await Promise.all(
    Array.from(
      { length: 4 },
      () =>
        new Promise<void>((done, reject) => {
          const child = spawn(
            process.execPath,
            ['--import', 'tsx', '--input-type=module', '-e', script],
            { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] }
          );
          let error = '';
          child.stderr.on('data', data => {
            error += String(data);
          });
          child.on('error', reject);
          child.on('exit', code => (code === 0 ? done() : reject(new Error(error))));
        })
    )
  );
  expect(readFileSync(join(dir, 'dispatches'), 'utf8').trim().split('\n')).toEqual(['dispatch']);
}, 10_000);

it('does not discard saved outputs when asked to download an already saved job', async () => {
  const { jobs, remote, fetcher, input } = fixture();
  remote.getJob.mockResolvedValue({
    job_id: 'job1',
    state: 'done',
    outputs: [{ url: 'http://gpu/files/a.mp4' }],
  } as any);
  const first = await jobs.submit(input);
  await jobs.refresh(first.id);
  const saved = await jobs.download(first.id);
  fetcher.mockRejectedValue(new Error('remote expired'));
  expect((await jobs.download(first.id)).files).toEqual(saved.files);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('keeps healthy jobs visible alongside an unreadable record', async () => {
  const { writeFileSync } = await import('node:fs');
  const { jobs, input } = fixture();
  await jobs.submit(input);
  writeFileSync(join(jobs.storeDir, `${'f'.repeat(64)}.json`), 'truncated');
  const listed = jobs.list();
  expect(listed.some(record => record.jobId === 'job1')).toBe(true);
  expect(listed.some(record => record.error?.includes('Unreadable'))).toBe(true);
});
