import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeProductionRequest } from '../../src/control/productionControl.js';
const roots: string[] = [];
const before = process.env.DHEE_USER_BUNDLES_DIR;
afterEach(() => {
  if (before === undefined) delete process.env.DHEE_USER_BUNDLES_DIR;
  else process.env.DHEE_USER_BUNDLES_DIR = before;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(path = 'inputs/story.md') {
  const root = mkdtempSync(join(tmpdir(), 'production-intake-'));
  roots.push(root);
  const bundles = join(root, 'bundles');
  mkdirSync(join(bundles, 'intake-test'), { recursive: true });
  writeFileSync(
    join(bundles, 'intake-test/bundle.json'),
    JSON.stringify({
      id: 'intake-test',
      version: '0.1.0',
      engineCompat: '*',
      inputs: [{ id: 'story', kind: 'file', path, required: true }],
      dependencies: { runners: {} },
      goal: 'story',
      nodes: [
        { id: 'story', kind: 'stage', outputs: { format: 'md', pattern: 'inputs/story.md' } },
      ],
    })
  );
  process.env.DHEE_USER_BUNDLES_DIR = bundles;
  return root;
}
it('discovers and describes the same user bundle through shared controls', async () => {
  setup();
  const list = await executeProductionRequest({ action: 'bundle.list' });
  expect(list.ok).toBe(true);
  expect(JSON.stringify(list)).toContain('intake-test');
  const detail = await executeProductionRequest({
    action: 'bundle.describe',
    bundleId: 'intake-test',
  });
  expect(detail.ok).toBe(true);
  expect(JSON.stringify(detail)).toContain('inputs/story.md');
});
it('initializes a fresh project with exact brief bytes and required reviews, without running', async () => {
  const root = setup();
  const projectDir = join(root, 'new-project');
  const request = {
    action: 'project.create',
    projectDir,
    name: 'Intake',
    bundleId: 'intake-test',
    inputs: { story: 'A doctor stays seated. The patient exits.' },
  };
  const result = await executeProductionRequest(request);
  expect(result.ok).toBe(true);
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe(request.inputs.story);
  const status = await executeProductionRequest({ action: 'project.status', projectDir });
  expect(status.ok).toBe(true);
  expect(JSON.stringify(status)).toContain('"reviewsRequired":true');
  const original = readFileSync(join(projectDir, 'project.json'), 'utf8');
  expect((await executeProductionRequest(request)).ok).toBe(false);
  expect(readFileSync(join(projectDir, 'project.json'), 'utf8')).toBe(original);
});
it('rejects missing required inputs and unknown IDs before creating files', async () => {
  const root = setup();
  for (const inputs of [{}, { story: 'brief', unknown: 'ignored?' }]) {
    const projectDir = join(root, 'no-write');
    expect(
      (
        await executeProductionRequest({
          action: 'project.create',
          projectDir,
          name: 'Bad',
          bundleId: 'intake-test',
          inputs,
        })
      ).ok
    ).toBe(false);
    expect(existsSync(projectDir)).toBe(false);
  }
});
it('rejects bundle input paths that escape or overwrite project metadata', async () => {
  for (const path of ['../outside.md', 'project.json', '.dhee/events.jsonl']) {
    const root = setup(path);
    const projectDir = join(root, 'no-write');
    expect(
      (
        await executeProductionRequest({
          action: 'project.create',
          projectDir,
          name: 'Bad',
          bundleId: 'intake-test',
          inputs: { story: 'brief' },
        })
      ).ok
    ).toBe(false);
    expect(existsSync(projectDir)).toBe(false);
  }
});

it('rejects invalid project settings before creating the project', async () => {
  const root = setup();
  const manifestPath = join(root, 'bundles/intake-test/bundle.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.inputs.push({ id: 'duration', kind: 'project', field: 'targetDuration', default: 4 });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  for (const duration of [false, -1, 'four']) {
    const projectDir = join(root, `invalid-${duration}`);
    const response = await executeProductionRequest({
      action: 'project.create',
      projectDir,
      name: 'Invalid settings',
      bundleId: 'intake-test',
      inputs: { story: 'Brief', duration },
    });
    expect(response.ok).toBe(false);
    expect(existsSync(projectDir)).toBe(false);
  }
});

it('imports a declared local reference byte-for-byte with its source hash', async () => {
  const root = setup();
  const manifestPath = join(root, 'bundles/intake-test/bundle.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.inputs.push({ id: 'voice', kind: 'file', path: 'inputs/voice.wav', required: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const bytes = Buffer.from([82, 73, 70, 70, 0, 255, 128, 1]);
  const sourcePath = join(root, 'voice source.wav');
  writeFileSync(sourcePath, bytes);
  const { createHash } = await import('node:crypto');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const projectDir = join(root, 'with-voice');
  const response = await executeProductionRequest({
    action: 'project.create',
    projectDir,
    name: 'Voice',
    bundleId: 'intake-test',
    inputs: { story: 'Brief', voice: { kind: 'localFile', sourcePath, expectedSha256: sha256 } },
  });
  expect(response.ok).toBe(true);
  expect(readFileSync(join(projectDir, 'inputs/voice.wav'))).toEqual(bytes);
  expect(readFileSync(sourcePath)).toEqual(bytes);
  expect(JSON.stringify(response)).toContain(sha256);
});

it('refuses changed or non-file reference sources before creating the project', async () => {
  const root = setup();
  const manifestPath = join(root, 'bundles/intake-test/bundle.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.inputs.push({ id: 'voice', kind: 'file', path: 'inputs/voice.wav', required: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const sourcePath = join(root, 'voice.wav');
  writeFileSync(sourcePath, 'changed');
  for (const source of [sourcePath, root, join(root, 'missing.wav')]) {
    const projectDir = join(root, 'rejected');
    const result = await executeProductionRequest({
      action: 'project.create',
      projectDir,
      name: 'Voice',
      bundleId: 'intake-test',
      inputs: {
        story: 'Brief',
        voice: { kind: 'localFile', sourcePath: source, expectedSha256: '0'.repeat(64) },
      },
    });
    expect(result.ok).toBe(false);
    expect(existsSync(projectDir)).toBe(false);
  }
});

it('rejects oversized references before reading them or creating a project', async () => {
  const root = setup();
  const { openSync, ftruncateSync, closeSync } = await import('node:fs');
  const sourcePath = join(root, 'large.bin');
  const fd = openSync(sourcePath, 'w');
  ftruncateSync(fd, 64 * 1024 * 1024 + 1);
  closeSync(fd);
  const projectDir = join(root, 'oversized');
  const result = await executeProductionRequest({
    action: 'project.create',
    projectDir,
    name: 'Large',
    bundleId: 'intake-test',
    inputs: { story: { kind: 'localFile', sourcePath, expectedSha256: '0'.repeat(64) } },
  });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toContain('64 MiB');
  expect(existsSync(projectDir)).toBe(false);
});
