import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeProductionRequest as call } from '../../src/control/productionControl.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
const roots: string[] = [];
const old = process.env.DHEE_USER_BUNDLES_DIR;
afterEach(() => {
  if (old === undefined) delete process.env.DHEE_USER_BUNDLES_DIR;
  else process.env.DHEE_USER_BUNDLES_DIR = old;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'production-versions-'));
  roots.push(root);
  const bundles = join(root, 'bundles');
  mkdirSync(join(bundles, 'test'), { recursive: true });
  writeFileSync(
    join(bundles, 'test/bundle.json'),
    JSON.stringify({
      id: 'test',
      version: '1',
      goal: 'clip',
      inputs: [{ id: 'brief', kind: 'file', path: 'inputs/story.md', required: true }],
      nodes: [
        {
          id: 'story',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'md', pattern: 'inputs/story.md' },
        },
        {
          id: 'clip',
          kind: 'stage',
          inputs: [{ from: 'story', usage: 'input' }],
          outputs: { format: 'video', pattern: 'clip.mp4' },
        },
      ],
    })
  );
  process.env.DHEE_USER_BUNDLES_DIR = bundles;
  const projectDir = join(root, 'project');
  expect(
    (
      await call({
        action: 'project.create',
        projectDir,
        name: 'versions',
        bundleId: 'test',
        inputs: { brief: 'original' },
      })
    ).ok
  ).toBe(true);
  const request = { projectDir, inputId: 'brief', payload: { kind: 'text', content: 'new' } };
  const preview = await call({ action: 'input.preview', ...request });
  if (!preview.ok) throw Error(preview.error);
  expect(
    (
      await call({
        action: 'input.write',
        ...request,
        expectedFingerprint: (preview.result as any).fingerprint,
        humanAcknowledged: true,
      })
    ).ok
  ).toBe(true);
  return { projectDir, root };
}
it('lists preserved history, reads exact artifact and restores through preview without losing current bytes', async () => {
  const { projectDir } = await setup();
  const list = await call({ action: 'version.list', projectDir, nodeId: 'story' });
  expect(list.ok).toBe(true);
  if (!list.ok) throw Error(list.error);
  const versions = (list.result as any).versions;
  const saved = versions.find((v: any) => v.kind === 'preserved');
  expect(saved.path).toBe('inputs/story.v1.md');
  expect(versions[0].available).toBe(false);
  expect(
    (
      await call({
        action: 'artifact.read',
        projectDir,
        nodeId: 'story',
        versionId: versions[0].versionId,
      })
    ).ok
  ).toBe(false);
  const read = await call({
    action: 'artifact.read',
    projectDir,
    nodeId: 'story',
    versionId: saved.versionId,
  });
  expect(read.ok).toBe(true);
  expect((read as any).result.text).toBe('original');
  const req = { projectDir, nodeId: 'story', versionId: saved.versionId };
  const preview = await call({ action: 'version.restorePreview', ...req });
  expect(preview.ok).toBe(true);
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('new');
  const restored = await call({
    action: 'version.restore',
    ...req,
    expectedFingerprint: (preview as any).result.fingerprint,
    humanAcknowledged: true,
  });
  expect(restored.ok).toBe(true);
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('original');
  expect(readFileSync(join(projectDir, 'inputs/story.v2.md'), 'utf8')).toBe('new');
  expect((restored as any).result.started).toBe(false);
});
it('rejects changed candidate bytes after preview', async () => {
  const { projectDir } = await setup();
  const list = await call({ action: 'version.list', projectDir, nodeId: 'story' });
  const saved = (list as any).result.versions.find((v: any) => v.kind === 'preserved');
  const req = { projectDir, nodeId: 'story', versionId: saved.versionId };
  const preview = await call({ action: 'version.restorePreview', ...req });
  writeFileSync(join(projectDir, saved.path), 'changed outside');
  expect(
    (
      await call({
        action: 'version.restore',
        ...req,
        expectedFingerprint: (preview as any).result.fingerprint,
        humanAcknowledged: true,
      })
    ).ok
  ).toBe(false);
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('new');
});
it('refuses reading artifact paths outside the project or through symlinks', async () => {
  const { projectDir, root } = await setup();
  writeFileSync(join(root, 'outside.md'), 'outside');
  symlinkSync(join(root, 'outside.md'), join(projectDir, 'link.md'));
  for (const path of ['../outside.md', 'link.md']) {
    openEventLog(projectDir).append({
      kind: 'node.completed',
      actor: 'test',
      branchId: 'main',
      payload: { nodeId: 'story', versionId: path, outputPath: path },
    });
    expect(
      (await call({ action: 'artifact.read', projectDir, nodeId: 'story', versionId: path })).ok
    ).toBe(false);
  }
});

it('keeps media out of inline responses and refuses restore in branched projects', async () => {
  const { projectDir } = await setup();
  const log = openEventLog(projectDir);
  writeFileSync(join(projectDir, 'clip.mp4'), Buffer.from([0, 255, 128]));
  log.append({
    kind: 'node.completed',
    actor: 'test',
    branchId: 'main',
    payload: {
      nodeId: 'clip',
      versionId: 'clip-one',
      outputPath: 'clip.mp4',
      dependencies: [{ nodeId: 'story' }],
    },
  });
  const media = await call({ action: 'artifact.read', projectDir, nodeId: 'clip' });
  expect(media.ok).toBe(true);
  expect((media as any).result.inline).toBe(false);
  expect((media as any).result.text).toBeUndefined();
  const listing = await call({ action: 'version.list', projectDir, nodeId: 'story' });
  const saved = (listing as any).result.versions.find((v: any) => v.kind === 'preserved');
  log.append({
    kind: 'node.completed',
    actor: 'test',
    branchId: 'experiment',
    payload: { nodeId: 'clip', versionId: 'branch-clip', outputPath: 'clip.mp4' },
  });
  expect(
    (
      await call({
        action: 'version.restorePreview',
        projectDir,
        nodeId: 'story',
        versionId: saved.versionId,
      })
    ).ok
  ).toBe(false);
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('new');
});
it.each(['main', 'other-branch'])(
  'does not misidentify bytes overwritten on %s',
  async branchId => {
    const { projectDir } = await setup();
    const listed = await call({ action: 'version.list', projectDir, nodeId: 'story' });
    const current = (listed as any).result.versions.find((v: any) => v.selected);

    writeFileSync(join(projectDir, current.path), 'another producer');
    openEventLog(projectDir).append({
      kind: 'node.completed',
      actor: 'test',
      branchId,
      payload: {
        nodeId: branchId === 'main' ? 'clip' : 'story',
        versionId: 'collision-' + branchId,
        outputPath: current.path,
      },
    });
    const result = await call({
      action: 'artifact.read',
      projectDir,
      nodeId: 'story',
      versionId: current.versionId,
    });
    expect(result.ok).toBe(false);
  }
);
