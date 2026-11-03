import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeProductionRequest } from '../../src/control/productionControl.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
import { acquireWalkLock, isWalkLockResult } from '../../src/dag/projectWalkLock.js';
const roots: string[] = [];
const old = process.env.DHEE_USER_BUNDLES_DIR;
afterEach(() => {
  if (old === undefined) delete process.env.DHEE_USER_BUNDLES_DIR;
  else process.env.DHEE_USER_BUNDLES_DIR = old;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'input-update-'));
  roots.push(root);
  const b = join(root, 'bundles/update-test');
  mkdirSync(b, { recursive: true });
  writeFileSync(
    join(b, 'bundle.json'),
    JSON.stringify({
      id: 'update-test',
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
          inputs: [{ from: 'story' }],
          outputs: { format: 'video', pattern: 'clip.mp4' },
        },
        { id: 'other', kind: 'stage', inputs: [], outputs: { format: 'md', pattern: 'other.md' } },
      ],
    })
  );
  process.env.DHEE_USER_BUNDLES_DIR = join(root, 'bundles');
  const projectDir = join(root, 'project');
  const result = await executeProductionRequest({
    action: 'project.create',
    projectDir,
    name: 'Test',
    bundleId: 'update-test',
    inputs: { brief: 'Original' },
  });
  expect(result.ok).toBe(true);
  for (const [nodeId, outputPath] of [
    ['clip', 'clip.mp4'],
    ['other', 'other.md'],
  ]) {
    writeFileSync(join(projectDir, outputPath), nodeId);
    openEventLog(projectDir).append({
      kind: 'node.completed',
      actor: 'test',
      branchId: 'main',
      payload: {
        nodeId,
        versionId: 'v1-' + nodeId,
        outputPath,
        generation: { tool: 'test', toolVersion: '1', cached: false },
      },
    });
  }
  return {
    projectDir,
    request: { projectDir, inputId: 'brief', payload: { kind: 'text', content: 'Changed' } },
  };
}
it('previews without changing content, then writes and preserves history with an exact confirmation', async () => {
  const { projectDir, request } = await setup();
  const preview = await executeProductionRequest({ action: 'input.preview', ...request });
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error(preview.error);
  const detail = preview.result as { fingerprint: string; downstream: unknown[] };
  expect(JSON.stringify(detail.downstream)).toContain('clip');
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('Original');
  const result = await executeProductionRequest({
    action: 'input.write',
    ...request,
    expectedFingerprint: detail.fingerprint,
    humanAcknowledged: true,
  });
  expect(result.ok).toBe(true);
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('Changed');
  expect(readFileSync(join(projectDir, 'inputs/story.v1.md'), 'utf8')).toBe('Original');
  expect(readFileSync(join(projectDir, 'other.md'), 'utf8')).toBe('other');
  const status = await executeProductionRequest({ action: 'project.status', projectDir });
  expect(
    (status as { result: { state: { lastInvalidatedIds: string[] } } }).result.state
      .lastInvalidatedIds
  ).toContain('clip');
  expect(JSON.stringify(status)).toContain('"reviewsRequired":true');
  expect(readdirSync(projectDir)).toContain('clip.mp4');
});
it('rejects a stale preview after a file edit and requires a fresh confirmation', async () => {
  const { projectDir, request } = await setup();
  const preview = await executeProductionRequest({ action: 'input.preview', ...request });
  if (!preview.ok) throw new Error(preview.error);
  writeFileSync(join(projectDir, 'inputs/story.md'), 'Concurrent edit');
  const result = await executeProductionRequest({
    action: 'input.write',
    ...request,
    expectedFingerprint: (preview.result as { fingerprint: string }).fingerprint,
    humanAcknowledged: true,
  });
  expect(result.ok).toBe(false);
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('Concurrent edit');
});
it('refuses input mutation while a walk holds the project lock', async () => {
  const { projectDir, request } = await setup();
  const lock = acquireWalkLock(projectDir);
  if (isWalkLockResult(lock)) throw new Error('Unexpected lock');
  try {
    expect((await executeProductionRequest({ action: 'input.preview', ...request })).ok).toBe(
      false
    );
  } finally {
    lock.release();
  }
});

it('keeps main-branch cascade dependencies when another branch completes the same node', async () => {
  const { projectDir, request } = await setup();
  const log = openEventLog(projectDir);
  const complete = (
    nodeId: string,
    branchId: string,
    dependencies: Array<{ nodeId: string; versionId: string }>
  ) =>
    log.append({
      kind: 'node.completed',
      actor: 'test',
      branchId,
      payload: {
        nodeId,
        versionId: `${branchId}-${nodeId}`,
        outputPath: nodeId + '.mp4',
        dependencies,
        generation: { tool: 'test', toolVersion: '1', cached: false },
      },
    });
  complete('clip', 'main', [{ nodeId: 'story', versionId: 'user-init-story' }]);
  complete('tail', 'main', [{ nodeId: 'clip', versionId: 'main-clip' }]);
  complete('clip', 'alternative', [{ nodeId: 'other', versionId: 'v1-other' }]);
  complete('direct', 'main', [{ nodeId: 'story', versionId: 'user-init-story' }]);
  const { writeNodeContent } = await import('../../src/dag/writeNodeContent.js');
  const preview = writeNodeContent({
    projectDir,
    nodeId: 'story',
    content: Buffer.from('Changed'),
    previewOnly: true,
  });
  expect(preview.ok).toBe(true);
  if (!preview.ok || preview.status !== 'preview') throw new Error('Expected preview');
  expect(preview.downstream.map(n => n.nodeId)).toContain('tail');
  expect((await executeProductionRequest({ action: 'input.preview', ...request })).ok).toBe(false);
});

it('rejects derived-stage inputs when their upstream lineage is unavailable', async () => {
  const { projectDir, request } = await setup();
  const path = join(process.env.DHEE_USER_BUNDLES_DIR!, 'update-test/bundle.json');
  const bundle = JSON.parse(readFileSync(path, 'utf8'));
  bundle.nodes[0].inputs = [{ from: 'missing-upstream' }];
  writeFileSync(path, JSON.stringify(bundle));
  expect((await executeProductionRequest({ action: 'input.preview', ...request })).ok).toBe(false);
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('Original');
});

it('stales the changed source approval while preserving an unrelated approval', async () => {
  const { projectDir, request } = await setup();
  const { readProductionReview, recordProductionReview } =
    await import('../../src/dag/productionReviews.js');
  const scope = { projectDir, gate: 'storyboard', targets: [{ nodeId: 'story' }] };
  const unrelated = { projectDir, gate: 'references', targets: [{ nodeId: 'other' }] };
  for (const current of [scope, unrelated]) {
    const review = await readProductionReview(current);
    await recordProductionReview({
      ...current,
      expectedFingerprint: review.fingerprint!,
      decision: 'approved',
    });
  }
  const preview = await executeProductionRequest({ action: 'input.preview', ...request });
  if (!preview.ok) throw new Error(preview.error);
  const written = await executeProductionRequest({
    action: 'input.write',
    ...request,
    expectedFingerprint: (preview.result as { fingerprint: string }).fingerprint,
    humanAcknowledged: true,
  });
  expect(written.ok).toBe(true);
  expect((await readProductionReview(scope)).status).toBe('stale');
  expect((await readProductionReview(unrelated)).status).toBe('approved');
});

it('preserves complete reference dependency history and allows a fresh reference review', async () => {
  const { projectDir } = await setup();
  const manifest = join(process.env.DHEE_USER_BUNDLES_DIR!, 'update-test/bundle.json');
  const bundle = JSON.parse(readFileSync(manifest, 'utf8'));
  bundle.inputs.push({ id: 'voice', kind: 'file', path: 'inputs/voice.wav', required: false });
  bundle.nodes.push(
    {
      id: 'voice_reference',
      kind: 'stage',
      inputs: [{ from: 'story', usage: 'input' }],
      outputs: { format: 'audio', pattern: 'inputs/voice.wav' },
    },
    {
      id: 'character_image',
      kind: 'stage',
      inputs: [{ from: 'story', usage: 'input' }],
      outputs: { format: 'image', pattern: 'inputs/character.png' },
    },
    {
      id: 'scenes_plan',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'json', pattern: 'plans/scenes.json' },
    },
    {
      id: 'final_video',
      kind: 'stage',
      inputs: [{ from: 'voice_reference' }],
      outputs: { format: 'video', pattern: 'final.mp4' },
    }
  );
  writeFileSync(manifest, JSON.stringify(bundle));
  const log = openEventLog(projectDir);
  for (const [nodeId, outputPath] of [
    ['voice_reference', 'inputs/voice.wav'],
    ['character_image', 'inputs/character.png'],
  ]) {
    writeFileSync(join(projectDir, outputPath), 'previous ' + nodeId);
    log.append({
      kind: 'node.completed',
      actor: 'test',
      branchId: 'main',
      payload: {
        nodeId,
        versionId: 'initial-' + nodeId,
        outputPath,
        dependencies: [{ nodeId: 'story', role: 'input' }],
      },
    });
  }
  const { createHash } = await import('node:crypto');
  const sourcePath = join(projectDir, 'new-voice.wav');
  writeFileSync(sourcePath, Buffer.from([0, 255, 1, 128]));
  const request = {
    projectDir,
    inputId: 'voice',
    payload: {
      kind: 'localFile',
      sourcePath,
      expectedSha256: createHash('sha256').update(readFileSync(sourcePath)).digest('hex'),
    },
  };
  const { readProductionReview, recordProductionReview } =
    await import('../../src/dag/productionReviews.js');
  const referenceScope = {
    projectDir,
    gate: 'references',
    targets: [{ nodeId: 'voice_reference' }, { nodeId: 'character_image' }],
  };
  const storyScope = { projectDir, gate: 'storyboard', targets: [{ nodeId: 'story' }] };
  for (const scope of [referenceScope, storyScope]) {
    const review = await readProductionReview(scope);
    await recordProductionReview({
      ...scope,
      expectedFingerprint: review.fingerprint!,
      decision: 'approved',
    });
  }
  const preview = await executeProductionRequest({ action: 'input.preview', ...request });
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw new Error(preview.error);
  const result = await executeProductionRequest({
    action: 'input.write',
    ...request,
    expectedFingerprint: (preview.result as { fingerprint: string }).fingerprint,
    humanAcknowledged: true,
  });
  expect(result.ok).toBe(true);
  const completion = [...log.read()]
    .filter(
      e =>
        e.kind === 'node.completed' &&
        (e.payload as { nodeId: string }).nodeId === 'voice_reference'
    )
    .at(-1)!;
  expect((completion.payload as { dependencies: unknown[] }).dependencies).toEqual([
    { nodeId: 'story', role: 'input' },
  ]);
  const { loadBundle } = await import('../../src/dag/walker.js');
  const { resolveProductionReviewGate } = await import('../../src/dag/productionReviewGates.js');
  const gate = await resolveProductionReviewGate({
    projectDir,
    bundle: loadBundle(manifest),
    gate: 'references',
    instances: new Map(
      ['story', 'character_image', 'voice_reference'].map(id => [id, [{ status: 'completed' }]])
    ),
  });
  expect((await readProductionReview(referenceScope)).status).toBe('stale');
  expect((await readProductionReview(storyScope)).status).toBe('approved');
  expect(gate.reason).toBeUndefined();
  expect(gate.targets.map(t => t.nodeId)).toContain('voice_reference');
  expect(readFileSync(join(projectDir, 'inputs/voice.v1.wav'), 'utf8')).toBe(
    'previous voice_reference'
  );
  expect(readFileSync(join(projectDir, 'inputs/character.png'), 'utf8')).toBe(
    'previous character_image'
  );
});

it('refuses a partial cascade in mixed legacy and recorded dependency history', async () => {
  const { projectDir, request } = await setup();
  const path = join(process.env.DHEE_USER_BUNDLES_DIR!, 'update-test/bundle.json');
  const bundle = JSON.parse(readFileSync(path, 'utf8'));
  bundle.nodes.push({
    id: 'reference',
    kind: 'stage',
    inputs: [{ from: 'story', usage: 'input' }],
    outputs: { format: 'audio', pattern: 'reference.wav' },
  });
  writeFileSync(path, JSON.stringify(bundle));
  writeFileSync(join(projectDir, 'reference.wav'), 'reference');
  openEventLog(projectDir).append({
    kind: 'node.completed',
    actor: 'test',
    branchId: 'main',
    payload: {
      nodeId: 'reference',
      versionId: 'r1',
      outputPath: 'reference.wav',
      dependencies: [{ nodeId: 'story', role: 'input' }],
    },
  });
  const before = readFileSync(join(projectDir, '.dhee/events.jsonl'), 'utf8');
  const result = await executeProductionRequest({ action: 'input.preview', ...request });
  expect(result.ok).toBe(false);
  expect(JSON.stringify(result)).toContain('Downstream dependency lineage');
  expect(readFileSync(join(projectDir, '.dhee/events.jsonl'), 'utf8')).toBe(before);
  expect(readFileSync(join(projectDir, 'inputs/story.md'), 'utf8')).toBe('Original');
});
