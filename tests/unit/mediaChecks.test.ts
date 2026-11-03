import { afterEach, it, expect, vi } from 'vitest';
import {
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { ffmpegBin } from '../../src/dag/runners/ffmpegBin.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
import { checkProjectMedia } from '../../src/control/mediaChecks.js';
vi.mock('node:fs', { spy: true });
const dirs: string[] = [];
const original = process.env.DHEE_USER_BUNDLES_DIR;
afterEach(() => {
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
  if (original === undefined) delete process.env.DHEE_USER_BUNDLES_DIR;
  else process.env.DHEE_USER_BUNDLES_DIR = original;
});
function fixture(format: 'video' | 'audio' = 'video') {
  const projectDir = mkdtempSync(join(tmpdir(), 'media-checks-'));
  dirs.push(projectDir);
  const root = join(projectDir, 'bundles');
  mkdirSync(join(root, 'test'), { recursive: true });
  process.env.DHEE_USER_BUNDLES_DIR = root;
  writeFileSync(
    join(root, 'test', 'bundle.json'),
    JSON.stringify({
      id: 'test',
      version: '1',
      goal: 'clip',
      nodes: [
        {
          id: 'clip',
          kind: 'stage',
          inputs: [],
          outputs: { format, pattern: format === 'video' ? 'clip.mp4' : 'voice.wav' },
          runner: { tool: 'fixture', config: {} },
        },
      ],
    })
  );
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ bundleSource: 'user:test' }));
  const outputPath = format === 'video' ? 'clip.mp4' : 'voice.wav';
  openEventLog(projectDir).append({
    kind: 'node.completed',
    actor: 'test',
    branchId: 'main',
    payload: {
      nodeId: 'clip',
      versionId: 'v1',
      outputPath,
      artifact: { format },
      generation: { tool: 'fixture', toolVersion: '1', cached: false },
    },
  });
  return {
    projectDir,
    path: join(projectDir, outputPath),
    request: { projectDir, nodeId: 'clip', branchId: 'main' },
  };
}
function video(path: string, audio = true) {
  execFileSync(
    ffmpegBin(),
    [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=64x64:r=12:d=1',
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=1'] : []),
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      ...(audio ? ['-c:a', 'aac'] : []),
      path,
    ],
    { stdio: 'pipe' }
  );
}
it('checks the selected video bytes and reports actual streams without granting creative approval', async () => {
  const f = fixture();
  video(f.path);
  const report = await checkProjectMedia({
    ...f.request,
    expectedAudio: true,
    expectedDurationSec: 1,
  });
  expect(report.technicalStatus).toBe('passed');
  expect(report.source).toMatchObject({
    nodeId: 'clip',
    versionId: 'v1',
    sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(report.media).toMatchObject({ video: { width: 64, height: 64 }, audio: { channels: 1 } });
  expect(report.manualChecks.length).toBeGreaterThan(0);
  expect(report.creativeApproval).toBe('required');
});
it('flags missing required audio and duration mismatch', async () => {
  const f = fixture();
  video(f.path, false);
  const report = await checkProjectMedia({
    ...f.request,
    expectedAudio: true,
    expectedDurationSec: 4,
  });
  expect(report.technicalStatus).toBe('issues');
  expect(report.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'audio-required', status: 'fail' }),
      expect.objectContaining({ code: 'duration', status: 'fail' }),
    ])
  );
});
it('treats sustained silence as a review warning rather than a failed creative performance', async () => {
  const f = fixture('audio');
  execFileSync(ffmpegBin(), [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=mono',
    '-t',
    '1',
    f.path,
  ]);
  const report = await checkProjectMedia(f.request);
  expect(report.checks).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'silence', status: 'warning' })])
  );
  expect(report.technicalStatus).toBe('review');
});
it('reports corrupt or missing selected files as failed checks', async () => {
  const f = fixture();
  writeFileSync(f.path, 'not a video');
  expect((await checkProjectMedia(f.request)).technicalStatus).toBe('issues');
  rmSync(f.path);
  await expect(checkProjectMedia(f.request)).rejects.toThrow(/missing|unavailable|ENOENT/i);
});
it('rejects paths outside the project and unknown targets', async () => {
  const f = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'outside-media-'));
  dirs.push(outside);
  writeFileSync(join(outside, 'clip.mp4'), 'outside');
  symlinkSync(join(outside, 'clip.mp4'), f.path);
  await expect(checkProjectMedia(f.request)).rejects.toThrow(/inside|outside/i);
  await expect(checkProjectMedia({ ...f.request, nodeId: 'missing' })).rejects.toThrow(/target/i);
});

it('runs the same selected-media check through the structured controller', async () => {
  const { createProductionControl } = await import('../../src/control/productionControl.js');
  const f = fixture();
  video(f.path);
  expect(await createProductionControl()({ action: 'media.check', ...f.request })).toMatchObject({
    ok: true,
    result: { source: { versionId: 'v1' }, technicalStatus: 'passed' },
  });
});
it('honors cancellation and the shared project lock', async () => {
  const { acquireWalkLock, isWalkLockResult } = await import('../../src/dag/projectWalkLock.js');
  const f = fixture();
  video(f.path);
  const controller = new AbortController();
  controller.abort();
  await expect(checkProjectMedia(f.request, controller.signal)).rejects.toThrow();
  const lock = acquireWalkLock(f.projectDir);
  if (isWalkLockResult(lock)) throw new Error('fixture lock failed');
  try {
    await expect(checkProjectMedia(f.request)).rejects.toThrow(/in progress/);
  } finally {
    lock.release();
  }
});
it('rejects a selected version that changes while the snapshot is checked', async () => {
  const f = fixture();
  video(f.path);
  const pending = checkProjectMedia(f.request);
  openEventLog(f.projectDir).append({
    kind: 'node.completed',
    actor: 'test',
    branchId: 'main',
    payload: {
      nodeId: 'clip',
      versionId: 'v2',
      outputPath: 'clip.mp4',
      artifact: { format: 'video' },
      generation: { tool: 'fixture', toolVersion: '1', cached: false },
    },
  });
  await expect(pending).rejects.toThrow(/changed during/);
});
it('rejects a selection change during the final source hash', async () => {
  const f = fixture();
  video(f.path);
  const fs = await import('node:fs');
  const realRead = (await vi.importActual<typeof import('node:fs')>('node:fs')).createReadStream;
  let reads = 0;
  const spy = vi
    .spyOn(fs, 'createReadStream')
    .mockImplementation((...args: Parameters<typeof realRead>) => {
      const stream = realRead(...args);
      if (String(args[0]).endsWith('/clip.mp4') && ++reads === 2) {
        stream.once('data', () =>
          openEventLog(f.projectDir).append({
            kind: 'node.completed',
            actor: 'test',
            branchId: 'main',
            payload: {
              nodeId: 'clip',
              versionId: 'v2',
              outputPath: 'clip.mp4',
              artifact: { format: 'video' },
              generation: { tool: 'fixture', toolVersion: '1', cached: false },
            },
          })
        );
      }
      return stream;
    });
  try {
    await expect(checkProjectMedia(f.request)).rejects.toThrow(/changed during/);
  } finally {
    spy.mockRestore();
  }
});
it('persists results and marks them stale when expectations, bytes or selected version change', async () => {
  const f = fixture();
  video(f.path);
  const { readSavedMediaCheck } = await import('../../src/control/mediaChecks.js');
  expect((await readSavedMediaCheck(f.request)).status).toBe('missing');
  const req = { ...f.request, expectedAudio: true, expectedDurationSec: 1 };
  const report = await checkProjectMedia(req);
  expect(await readSavedMediaCheck(req)).toMatchObject({
    status: 'current',
    report: { source: JSON.parse(JSON.stringify(report.source)), technicalStatus: 'passed' },
  });
  expect((await readSavedMediaCheck({ ...req, expectedDurationSec: 4 })).status).toBe('stale');
  openEventLog(f.projectDir).append({
    kind: 'node.completed',
    actor: 'test',
    branchId: 'main',
    payload: { nodeId: 'clip', versionId: 'v2', outputPath: 'clip.mp4' },
  });
  expect((await readSavedMediaCheck(req)).status).toBe('stale');
  await checkProjectMedia(req);
  writeFileSync(f.path, 'changed bytes');
  expect((await readSavedMediaCheck(req)).status).toBe('stale');
  expect((await readSavedMediaCheck({ ...req, branchId: 'other' })).status).toBe('missing');
});
it('rejects a saved check whose selection changes during its hash verification', async () => {
  const f = fixture();
  video(f.path);
  await checkProjectMedia(f.request);
  const { readSavedMediaCheck } = await import('../../src/control/mediaChecks.js');
  const fs = await import('node:fs');
  const real = (await vi.importActual<typeof import('node:fs')>('node:fs')).createReadStream;
  const spy = vi
    .spyOn(fs, 'createReadStream')
    .mockImplementation((...args: Parameters<typeof real>) => {
      const stream = real(...args);
      stream.once('data', () =>
        openEventLog(f.projectDir).append({
          kind: 'node.invalidated',
          actor: 'test',
          branchId: 'main',
          payload: { nodeId: 'clip', reason: 'changed during read' },
        })
      );
      return stream;
    });
  try {
    expect((await readSavedMediaCheck(f.request)).status).toBe('stale');
  } finally {
    spy.mockRestore();
  }
});
it('refuses a report store symlink rather than writing outside the project', async () => {
  const f = fixture();
  video(f.path);
  const outside = mkdtempSync(join(tmpdir(), 'media-store-'));
  dirs.push(outside);
  symlinkSync(outside, join(f.projectDir, '.dhee/media-checks'));
  await expect(checkProjectMedia(f.request)).rejects.toThrow(/symlink/);
  const { readSavedMediaCheck } = await import('../../src/control/mediaChecks.js');
  await expect(readSavedMediaCheck(f.request)).rejects.toThrow(/symlink/);
});
it('rejects malformed persisted measurements before they reach the UI', async () => {
  const f = fixture();
  video(f.path);
  await checkProjectMedia(f.request);
  const { readSavedMediaCheck } = await import('../../src/control/mediaChecks.js');
  const dir = join(f.projectDir, '.dhee/media-checks');
  const path = join(dir, readdirSync(dir)[0]!);
  const saved = JSON.parse(readFileSync(path, 'utf8'));
  saved.report.media = { durationSec: 'bad' };
  writeFileSync(path, JSON.stringify(saved));
  await expect(readSavedMediaCheck(f.request)).rejects.toThrow();
});
it('detects an in-project media symlink retargeted while a saved report is verified', async () => {
  const f = fixture();
  video(f.path);
  const original = join(f.projectDir, 'original.mp4');
  renameSync(f.path, original);
  symlinkSync(original, f.path);
  await checkProjectMedia(f.request);
  const replacement = join(f.projectDir, 'replacement.mp4');
  writeFileSync(replacement, 'different bytes');
  const { readSavedMediaCheck } = await import('../../src/control/mediaChecks.js');
  const fs = await import('node:fs');
  const real = (await vi.importActual<typeof import('node:fs')>('node:fs')).createReadStream;
  const spy = vi
    .spyOn(fs, 'createReadStream')
    .mockImplementation((...args: Parameters<typeof real>) => {
      const stream = real(...args);
      stream.once('data', () => {
        unlinkSync(f.path);
        symlinkSync(replacement, f.path);
      });
      return stream;
    });
  try {
    expect((await readSavedMediaCheck(f.request)).status).toBe('stale');
  } finally {
    spy.mockRestore();
  }
});
