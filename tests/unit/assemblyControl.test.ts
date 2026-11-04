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
it('explicitly reports an unconfigured automatic check instead of delivery readiness', async () => {
  const projectDir = fixture();
  const control = createProductionControl({
    run: async () => ({
      ok: true,
      selectedOutput: {
        nodeId: 'final',
        outputRel: 'final.mp4',
        outputAbs: join(projectDir, 'final.mp4'),
      },
    }),
  });
  await control({ action: 'review.enable', projectDir });
  expect(
    await control({
      action: 'assembly.run',
      projectDir,
      nodeId: 'final',
      expectedSelectionId: null,
    })
  ).toMatchObject({
    ok: true,
    result: {
      deliveryReady: false,
      verification: { status: 'not-configured', deliveryReady: false },
    },
  });
});

async function checkedFixture(checkStatus: 'pass' | 'fail' = 'pass') {
  const { readFileSync, existsSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const projectDir = fixture();
  const bp = join(projectDir, 'bundles/test/bundle.json');
  const bundle = JSON.parse(readFileSync(bp, 'utf8'));
  bundle.nodes[1].runner.config.verificationNode = 'audit';
  const criteria = {
    videoInput: 'final',
    outputPath: 'audit.json',
    segments: [{ videoInput: 'clip', durationSec: 1, audioOffsetSec: 0 }],
  };
  bundle.nodes.push({
    id: 'audit',
    kind: 'stage',
    inputs: [
      { from: 'final', usage: 'input' },
      { from: 'clip', usage: 'input' },
    ],
    outputs: { format: 'json', pattern: 'audit.json' },
    runner: { tool: 'media.verify_assembly', config: criteria },
  });
  writeFileSync(bp, JSON.stringify(bundle));
  const complete = (nodeId: string, outputPath: string, format: 'video' | 'json') =>
    openEventLog(projectDir).append({
      kind: 'node.completed',
      actor: 'test',
      branchId: 'main',
      payload: {
        nodeId,
        versionId: 'v-' + nodeId,
        outputPath,
        artifact: { format },
        generation: {
          tool: nodeId === 'audit' ? 'media.verify_assembly' : 'fixture',
          toolVersion: '1',
          cached: false,
        },
      },
    });
  for (const id of ['clip', 'final']) {
    writeFileSync(join(projectDir, id + '.mp4'), 'source-' + id);
    complete(id, id + '.mp4', 'video');
  }
  const run = vi.fn(async (opts: any) => {
    const id = opts.targetInstance.nodeId;
    if (id === 'audit' && !existsSync(join(projectDir, 'audit.json'))) {
      const inputs = Object.fromEntries(
        ['final', 'clip'].map(key => [
          key,
          {
            path: key + '.mp4',
            sha256: createHash('sha256')
              .update(readFileSync(join(projectDir, key + '.mp4')))
              .digest('hex'),
          },
        ])
      );
      writeFileSync(
        join(projectDir, 'audit.json'),
        JSON.stringify({
          analyzerVersion: 3,
          status: checkStatus === 'fail' ? 'fail' : 'review',
          deliveryReady: false,
          inputs,
          criteria,
          checks: [
            { id: 'duration', status: checkStatus, detail: 'duration' },
            { id: 'decode', status: 'pass', detail: 'decode' },
            { id: 'picture:0', status: 'pass', detail: 'picture' },
            { id: 'voice:0', status: 'unchecked', detail: 'no narration' },
            { id: 'transcript', status: 'unchecked', detail: 'not integrated' },
            { id: 'scene-meaning', status: 'unchecked', detail: 'not integrated' },
            { id: 'creative-approval', status: 'unchecked', detail: 'separate' },
          ],
        })
      );
      complete('audit', 'audit.json', 'json');
    }
    return id === 'final'
      ? { ok: true, gatedAfter: 'review:rough-cut' }
      : {
          ok: true,
          selectedOutput: {
            nodeId: 'audit',
            outputRel: 'audit.json',
            outputAbs: join(projectDir, 'audit.json'),
          },
        };
  });
  const control = createProductionControl({ run });
  await control({ action: 'review.enable', projectDir });
  return {
    projectDir,
    control,
    run,
    request: { action: 'assembly.run', projectDir, nodeId: 'final', expectedSelectionId: null },
  };
}
it('automatically runs a declared check while retaining the rough-cut pause', async () => {
  const f = await checkedFixture();
  expect(await f.control(f.request)).toMatchObject({
    ok: true,
    result: {
      gatedAfter: 'review:rough-cut',
      deliveryReady: false,
      verification: {
        status: 'review',
        nodeId: 'audit',
        deliveryReady: false,
        reportPath: 'audit.json',
      },
    },
  });
  expect(
    [...openEventLog(f.projectDir).read()].filter(
      e => e.kind === 'node.completed' && e.payload.nodeId === 'audit'
    )
  ).toHaveLength(1);
});
it('surfaces measured failures and stale source bytes instead of promoting a saved report', async () => {
  const f = await checkedFixture('fail');
  expect(await f.control(f.request)).toMatchObject({
    ok: true,
    result: { verification: { status: 'fail', deliveryReady: false } },
  });
  writeFileSync(join(f.projectDir, 'clip.mp4'), 'changed clip');
  expect(await f.control(f.request)).toMatchObject({
    ok: true,
    result: { verification: { status: 'stale', deliveryReady: false } },
  });
});
it('does not run an unrelated node as an automatic check', async () => {
  const { readFileSync } = await import('node:fs');
  const f = await checkedFixture();
  const bp = join(f.projectDir, 'bundles/test/bundle.json');
  const b = JSON.parse(readFileSync(bp, 'utf8'));
  b.nodes.find((n: any) => n.id === 'audit').runner.tool = 'gpu.queue';
  writeFileSync(bp, JSON.stringify(b));
  expect(await f.control(f.request)).toMatchObject({
    ok: true,
    result: { verification: { status: 'unavailable', deliveryReady: false } },
  });
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('does not trust a report with missing checks or criteria changed after it ran', async () => {
  const { readFileSync } = await import('node:fs');
  const f = await checkedFixture();
  await f.control(f.request);
  const reportPath = join(f.projectDir, 'audit.json');
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  report.checks = report.checks.filter((c: any) => c.id !== 'duration');
  writeFileSync(reportPath, JSON.stringify(report));
  expect(await f.control(f.request)).toMatchObject({
    ok: true,
    result: { verification: { status: 'unavailable', deliveryReady: false } },
  });
  const g = await checkedFixture();
  await g.control(g.request);
  const bp = join(g.projectDir, 'bundles/test/bundle.json');
  const bundle = JSON.parse(readFileSync(bp, 'utf8'));
  bundle.nodes.find((n: any) => n.id === 'audit').runner.config.segments[0].durationSec = 2;
  writeFileSync(bp, JSON.stringify(bundle));
  expect(await g.control(g.request)).toMatchObject({
    ok: true,
    result: { verification: { status: 'stale', deliveryReady: false } },
  });
});
it('marks analyzer-v2 reports stale after the visual-review upgrade', async () => {
  const { readFileSync } = await import('node:fs');
  const f = await checkedFixture();
  await f.control(f.request);
  const path = join(f.projectDir, 'audit.json');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  report.analyzerVersion = 2;
  writeFileSync(path, JSON.stringify(report));
  expect(await f.control(f.request)).toMatchObject({ok:true,result:{verification:{status:'stale',deliveryReady:false}}});
});
it('invalidates saved review when scene requirements are added', async () => {
  const { readFileSync } = await import('node:fs');
  const f = await checkedFixture();
  await f.control(f.request);
  const path = join(f.projectDir, 'bundles/test/bundle.json');
  const bundle = JSON.parse(readFileSync(path, 'utf8'));
  bundle.nodes.find((n:any)=>n.id==='audit').runner.config.segments[0].visualRequirements=['Doctor stays seated.'];
  writeFileSync(path, JSON.stringify(bundle));
  expect(await f.control(f.request)).toMatchObject({ok:true,result:{verification:{status:'stale',deliveryReady:false}}});
});
it('reads detailed assembly reports beyond the ordinary text-preview limit', async () => {
  const { readFileSync } = await import('node:fs');
  const f = await checkedFixture();
  await f.control(f.request);
  const path = join(f.projectDir, 'audit.json');
  const report = JSON.parse(readFileSync(path, 'utf8'));
  // Detailed model evidence lives in the report, not in the compact MCP response.
  report.visualReviews = [{ evidence: 'Detailed sampled evidence. '.repeat(4000) }];
  writeFileSync(path, JSON.stringify(report));
  expect(await f.control(f.request)).toMatchObject({ok:true,result:{verification:{status:'review',deliveryReady:false}}});
});

it('keeps ordinary report previews at 64 KiB and bounds audit reads at 8 MiB', async () => {
 const {readFileSync}=await import('node:fs');
 const f=await checkedFixture();await f.control(f.request);
 const path=join(f.projectDir,'audit.json');const report=JSON.parse(readFileSync(path,'utf8'));
 report.visualReviews=[{evidence:'x'.repeat(70000)}];writeFileSync(path,JSON.stringify(report));
 expect(await f.control({action:'artifact.read',projectDir:f.projectDir,nodeId:'audit'})).toMatchObject({ok:true,result:{inline:false}});
 report.visualReviews=[{evidence:'x'.repeat(8*1024*1024)}];writeFileSync(path,JSON.stringify(report));
 expect(await f.control(f.request)).toMatchObject({ok:true,result:{verification:{status:'unavailable',deliveryReady:false}}});
});

it('invalidates a visual review when its model changes without changing media', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  vi.stubEnv('DHEE_REVIEW_VLM_BASE_URL', 'http://vision.invalid/v1');
  vi.stubEnv('DHEE_REVIEW_VLM_MODEL', 'model-a');
  try {
    const f = await checkedFixture();
    const bundlePath = join(f.projectDir, 'bundles/test/bundle.json');
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
    const criteria = bundle.nodes.find((n: any) => n.id === 'audit').runner.config;
    criteria.segments[0].visualRequirements = ['Doctor remains seated.'];
    writeFileSync(bundlePath, JSON.stringify(bundle));
    await f.control(f.request);
    const path = join(f.projectDir, 'audit.json');
    const report = JSON.parse(readFileSync(path, 'utf8'));
    report.criteria = criteria;
    report.visualReviewConfigSha256 = createHash('sha256').update(JSON.stringify(['http://vision.invalid/v1', 'model-a'])).digest('hex');
    writeFileSync(path, JSON.stringify(report));
    expect(await f.control(f.request)).toMatchObject({ok:true,result:{verification:{status:'review'}}});
    vi.stubEnv('DHEE_REVIEW_VLM_MODEL', 'model-b');
    expect(await f.control(f.request)).toMatchObject({ok:true,result:{verification:{status:'stale',reason:expect.stringMatching(/configuration/),deliveryReady:false}}});
  } finally { vi.unstubAllEnvs(); }
});
