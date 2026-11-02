import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProductionControl } from '../../src/control/productionControl.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
const dirs: string[] = [];
const old = process.env.DHEE_USER_BUNDLES_DIR;
afterEach(() => {
  dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true }));
  if (old === undefined) delete process.env.DHEE_USER_BUNDLES_DIR;
  else process.env.DHEE_USER_BUNDLES_DIR = old;
});
function fixture() {
  const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'assembly-control-')));
  dirs.push(projectDir);
  const root = join(projectDir, 'bundles');
  mkdirSync(join(root, 'test'), { recursive: true });
  process.env.DHEE_USER_BUNDLES_DIR = root;
  writeFileSync(
    join(root, 'test/bundle.json'),
    JSON.stringify({
      id: 'test',
      version: '1',
      goal: 'final',
      nodes: [
        {
          id: 'clip',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'video', pattern: 'clip.mp4' },
          runner: { tool: 'gpu.queue', config: {} },
        },
        {
          id: 'final',
          kind: 'stage',
          inputs: [{ from: 'clip', scope: 'all' }],
          outputs: { format: 'video', pattern: 'final.mp4' },
          runner: { tool: 'ffmpeg.concat', config: {} },
        },
      ],
    })
  );
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ bundleSource: 'user:test' }));
  return projectDir;
}
it('lists only local concat targets and executes the exact pinned assembly', async () => {
  const projectDir = fixture();
  const run = vi.fn(async () => ({
    ok: true,
    selectedOutput: {
      nodeId: 'final',
      outputRel: 'final.mp4',
      outputAbs: join(projectDir, 'final.mp4'),
    },
  }));
  const control = createProductionControl({ run });
  expect(await control({ action: 'assembly.targets', projectDir })).toMatchObject({
    ok: true,
    result: { targets: [{ nodeId: 'final', tool: 'ffmpeg.concat', selectionId: null }] },
  });
  expect(
    await control({
      action: 'assembly.run',
      projectDir,
      nodeId: 'final',
      expectedSelectionId: null,
    })
  ).toMatchObject({ ok: false, error: expect.stringMatching(/approval/) });
  await control({ action: 'review.enable', projectDir });
  expect(
    await control({
      action: 'assembly.run',
      projectDir,
      nodeId: 'final',
      expectedSelectionId: null,
    })
  ).toMatchObject({ ok: true });
  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      requireProductionReviews: true,
      targetInstance: {
        nodeId: 'final',
        itemId: undefined,
        selectionId: null,
        expectedTool: 'ffmpeg.concat',
      },
    })
  );
});
it('rejects GPU, unknown and changed selections without execution', async () => {
  const projectDir = fixture();
  const run = vi.fn();
  const control = createProductionControl({ run });
  await control({ action: 'review.enable', projectDir });
  for (const nodeId of ['clip', 'missing'])
    expect(
      await control({ action: 'assembly.run', projectDir, nodeId, expectedSelectionId: null })
    ).toMatchObject({ ok: false });
  openEventLog(projectDir).append({
    kind: 'runner.swapped',
    actor: 'test',
    branchId: 'main',
    payload: {
      nodeId: 'final',
      fromTool: 'ffmpeg.concat',
      toTool: 'gpu.queue',
      configOverride: {},
    },
  });
  expect(
    await control({
      action: 'assembly.run',
      projectDir,
      nodeId: 'final',
      expectedSelectionId: null,
    })
  ).toMatchObject({ ok: false });
  expect(run).not.toHaveBeenCalled();
});
it('assembles two real clips only, pauses for rough-cut approval and checks the resulting media', async () => {
  const { execFileSync } = await import('node:child_process');
  const { ffmpegBin } = await import('../../src/dag/runners/ffmpegBin.js');
  const projectDir = fixture();
  const nodes = [
    ['story', 'md', []],
    ['scenes_plan', 'json', ['story']],
    ['character_image', 'image', ['story', 'scenes_plan']],
    ['voice_reference', 'audio', ['story', 'scenes_plan']],
    ['scene_clip', 'video', ['character_image', 'voice_reference', 'scenes_plan']],
    ['second_clip', 'video', ['character_image', 'voice_reference', 'scenes_plan']],
    ['final_video', 'video', ['scene_clip', 'second_clip']],
  ] as const;
  writeFileSync(
    join(projectDir, 'bundles/test/bundle.json'),
    JSON.stringify({
      id: 'test',
      version: '1',
      goal: 'final_video',
      nodes: nodes.map(([id, format, from]) => ({
        id,
        kind: 'stage',
        inputs: from.map(source => ({ from: source, scope: 'all' })),
        outputs: {
          format,
          pattern: `${id}.${format === 'video' ? 'mp4' : format === 'audio' ? 'wav' : format === 'image' ? 'png' : format}`,
        },
        runner: { tool: id === 'final_video' ? 'ffmpeg.concat' : 'test.must-not-run', config: {} },
      })),
    })
  );
  for (const [id, format, from] of nodes) {
    if (id === 'final_video') continue;
    const outputPath = `${id}.${format === 'video' ? 'mp4' : format === 'audio' ? 'wav' : format === 'image' ? 'png' : format}`;
    if (format === 'video')
      execFileSync(
        ffmpegBin(),
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          `color=c=${id === 'scene_clip' ? 'blue' : 'red'}:s=64x64:r=12:d=1`,
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:duration=1',
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          join(projectDir, outputPath),
        ],
        { stdio: 'pipe' }
      );
    else writeFileSync(join(projectDir, outputPath), format === 'json' ? '{}' : 'fixture');
    openEventLog(projectDir).append({
      kind: 'node.completed',
      actor: 'test',
      branchId: 'main',
      payload: {
        nodeId: id,
        dependencies: from.map(nodeId => ({ nodeId, role: 'input' as const })),
        versionId: `v-${id}`,
        outputPath,
        artifact: { format },
        generation: { tool: 'fixture', toolVersion: '1', cached: false },
      },
    });
  }
  const control = createProductionControl();
  await control({ action: 'review.enable', projectDir });
  const approve = async (gate: string) => {
    const review = await control({ action: 'review.read', projectDir, gate });
    expect(review.ok, JSON.stringify(review)).toBe(true);
    if ((review as any).result.status === 'unavailable') throw new Error(JSON.stringify(review));
    const fingerprint = (review as { ok: true; result: { fingerprint: string } }).result
      .fingerprint;
    const decision = await control({
      action: 'review.decide',
      projectDir,
      gate,
      expectedFingerprint: fingerprint,
      decision: 'approved',
      humanAcknowledged: true,
    });
    expect(decision, JSON.stringify({ review, decision })).toMatchObject({
      ok: true,
      result: { status: 'approved' },
    });
  };
  await approve('storyboard');
  await approve('references');
  const request = {
    action: 'assembly.run',
    projectDir,
    nodeId: 'final_video',
    expectedSelectionId: null,
  };
  const first = await control(request);
  expect(first).toMatchObject({ ok: true, result: { gatedAfter: 'review:rough-cut' } });
  await approve('rough-cut');
  expect(await control(request)).toMatchObject({
    ok: true,
    result: {
      selectedOutput: { nodeId: 'final_video', outputRel: expect.stringMatching(/\.mp4$/) },
    },
  });
  expect(
    await control({
      action: 'media.check',
      projectDir,
      nodeId: 'final_video',
      expectedAudio: true,
      expectedDurationSec: 2,
    })
  ).toMatchObject({ ok: true, result: { technicalStatus: 'passed' } });
  const completed = [...openEventLog(projectDir).read()].filter(e => e.kind === 'node.completed');
  expect(completed.filter(e => e.payload.nodeId === 'final_video')).toHaveLength(1);
  expect(completed.filter(e => e.payload.nodeId !== 'final_video')).toHaveLength(6);
});
it.each(['ffmpeg.replace_audio', 'ffmpeg.normalize'])(
  'lists and pins %s as a local assembly operation',
  async tool => {
    const projectDir = fixture();
    openEventLog(projectDir).append({
      kind: 'runner.swapped',
      actor: 'test',
      branchId: 'main',
      payload: {
        nodeId: 'final',
        fromTool: 'ffmpeg.concat',
        toTool: tool,
        configOverride: {},
      },
    });
    const run = vi.fn(async () => ({ ok: true }));
    const control = createProductionControl({ run });
    const listed = await control({ action: 'assembly.targets', projectDir });
    expect(listed).toMatchObject({
      ok: true,
      result: { targets: [{ nodeId: 'final', tool: tool }] },
    });
    const selectionId = (listed as any).result.targets[0].selectionId;
    await control({ action: 'review.enable', projectDir });
    expect(
      await control({
        action: 'assembly.run',
        projectDir,
        nodeId: 'final',
        expectedSelectionId: selectionId,
      })
    ).toMatchObject({ ok: true });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        targetInstance: expect.objectContaining({
          expectedTool: tool,
          selectionId,
        }),
      })
    );
  }
);
