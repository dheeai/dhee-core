/**
 * comfy.fl2v — first/last-frame → video runner. Runs against the real
 * fl2v_cloud.json + manifest from narrative_shot_by_shot.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createComfyFl2vRunner } from '../../../src/dag/runners/comfyFl2v.js';
import type { ComfyImageClient } from '../../../src/dag/runners/comfyExecutor.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

const REAL_FL2V = resolve('src/dag/bundles/narrative_shot_by_shot/workflows/fl2v_cloud.json');
const REAL_FL2V_MANIFEST = resolve('src/dag/bundles/narrative_shot_by_shot/workflows/fl2v_cloud.manifest.json');

interface Stub {
  queued: Array<Record<string, { inputs: Record<string, unknown> }>>;
  uploads: string[];
}
function makeStubClient(stub: Stub): ComfyImageClient {
  return {
    async uploadImage(p) {
      stub.uploads.push(p);
      return { name: `up_${p.split('/').pop()}` };
    },
    async queueAndWait(wf) {
      stub.queued.push(wf as never);
      return { outputs: [{ filename: 'fl2v_out.mp4' }] };
    },
    async downloadOutput(_f, _s, destPath) {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(destPath, '..'), { recursive: true });
      await fs.writeFile(destPath, Buffer.from('mp4'));
    },
  };
}

let bundleDir: string;
let projectDir: string;
let savedMode: string | undefined;
let savedCas: string | undefined;
let savedSingleGpu: string | undefined;
let first: string;
let last: string;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'fl2v-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'fl2v-proj-'));
  mkdirSync(join(bundleDir, 'workflows'), { recursive: true });
  copyFileSync(REAL_FL2V, join(bundleDir, 'workflows/fl2v_cloud.json'));
  copyFileSync(REAL_FL2V_MANIFEST, join(bundleDir, 'workflows/fl2v_cloud.manifest.json'));
  first = join(projectDir, 'first.png');
  last = join(projectDir, 'last.png');
  writeFileSync(first, Buffer.from('f'));
  writeFileSync(last, Buffer.from('l'));
  savedMode = process.env['COMFY_MODE'];
  savedCas = process.env['DHEE_DISABLE_CAS'];
  savedSingleGpu = process.env['DHEE_SINGLE_GPU'];
  process.env['COMFY_MODE'] = 'cloud';
  process.env['DHEE_DISABLE_CAS'] = '1';
  // Isolate from ambient env: `.env` sets DHEE_SINGLE_GPU=1, which makes the
  // executor probe a local LLM server before every queue. Left on, a unit test
  // reaches the real GPU box and UNLOADS the operator's loaded model (and, when
  // the derived URL is dead, burns the 8s AbortSignal.timeout — the cause of the
  // 5s vitest failures in dheeai/dhee-core#203). These tests stub the Comfy
  // client; they must not touch a network at all.
  delete process.env['DHEE_SINGLE_GPU'];
  process.env['ENDPOINT_test_endpoint'] = 'http://stub.local:8188';
});
afterEach(() => {
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  delete process.env['ENDPOINT_test_endpoint'];
  if (savedMode === undefined) delete process.env['COMFY_MODE'];
  else process.env['COMFY_MODE'] = savedMode;
  if (savedCas === undefined) delete process.env['DHEE_DISABLE_CAS'];
  else process.env['DHEE_DISABLE_CAS'] = savedCas;
  if (savedSingleGpu === undefined) delete process.env['DHEE_SINGLE_GPU'];
  else process.env['DHEE_SINGLE_GPU'] = savedSingleGpu;
});

function makeCtx(config: Record<string, unknown>, inputs: Record<string, unknown> = {}): RunnerContext {
  const node: NodeDef = {
    id: 'shot_video',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'video', pattern: 'out.mp4' },
    runner: { tool: 'comfy.fl2v', config },
  };
  return { projectDir, bundleDir, node, inputs, itemId: 'scene_1_shot_1', log: () => {} };
}

const cfg = () => ({
  workflowPath: 'workflows/fl2v_cloud.json',
  manifestPath: 'workflows/fl2v_cloud.manifest.json',
  endpoint: 'test.endpoint',
  outputPath: 'out.mp4',
});

describe('comfy.fl2v', () => {
  it('wires first_frame + last_frame + motion prompt from upstream nodes', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyFl2vRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(
      makeCtx(cfg(), {
        shot_image: first,
        shot_image_last_frame: last,
        shot_motion_directive: { description: 'slow push-in toward the barn' },
      }),
    );

    expect(result.ok).toBe(true);
    const wf = stub.queued[0]!;
    // fl2v_cloud.json: first_frame→45, last_frame→47, prompt→16
    expect(wf['45']!.inputs['image']).toBe('up_first.png');
    expect(wf['47']!.inputs['image']).toBe('up_last.png');
    expect(wf['16']!.inputs['text']).toBe('slow push-in toward the barn');
    expect(stub.uploads.sort()).toEqual([first, last].sort());
    expect(existsSync(join(projectDir, 'out.mp4'))).toBe(true);
  });

  it('runs with only the required first_frame (last_frame optional)', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyFl2vRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(
      makeCtx(cfg(), { shot_image: first, shot_motion_directive: { description: 'static hold' } }),
    );
    expect(result.ok).toBe(true);
    expect(stub.queued[0]!['45']!.inputs['image']).toBe('up_first.png');
    expect(stub.uploads).toEqual([first]);
  });

  it('fails when the required first_frame is missing', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyFl2vRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(makeCtx(cfg(), { shot_motion_directive: { description: 'x' } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/required input 'first_frame'/);
    expect(stub.queued.length).toBe(0);
  });
});
