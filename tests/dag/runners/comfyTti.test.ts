/**
 * comfy.tti — text-to-image runner. Runs against the real zimage_tti.json.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createComfyTtiRunner } from '../../../src/dag/runners/comfyTti.js';
import type { ComfyImageClient } from '../../../src/dag/runners/comfyExecutor.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

const REAL_TTI = resolve('src/dag/bundles/narrative_prompt_relay/workflows/zimage_tti.json');
const REAL_TTI_MANIFEST = resolve('src/dag/bundles/narrative_prompt_relay/workflows/zimage_tti.manifest.json');

interface Stub {
  queued: Array<Record<string, { inputs: Record<string, unknown> }>>;
  uploads: string[];
}
function makeStubClient(stub: Stub): ComfyImageClient {
  return {
    async uploadImage(p) {
      stub.uploads.push(p);
      return { name: 'up.png' };
    },
    async queueAndWait(wf) {
      stub.queued.push(wf as never);
      return { outputs: [{ filename: 'tti_out.png' }] };
    },
    async downloadOutput(_f, _s, destPath) {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(destPath, '..'), { recursive: true });
      await fs.writeFile(destPath, Buffer.from('png'));
    },
  };
}

let bundleDir: string;
let projectDir: string;
let savedMode: string | undefined;
let savedCas: string | undefined;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'tti-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'tti-proj-'));
  mkdirSync(join(bundleDir, 'workflows'), { recursive: true });
  copyFileSync(REAL_TTI, join(bundleDir, 'workflows/zimage_tti.json'));
  copyFileSync(REAL_TTI_MANIFEST, join(bundleDir, 'workflows/zimage_tti.manifest.json'));
  savedMode = process.env['COMFY_MODE'];
  savedCas = process.env['DHEE_DISABLE_CAS'];
  process.env['COMFY_MODE'] = 'cloud';
  process.env['DHEE_DISABLE_CAS'] = '1';
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
});

function makeCtx(config: Record<string, unknown>, inputs: Record<string, unknown> = {}): RunnerContext {
  const node: NodeDef = {
    id: 'character_image',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'image', pattern: 'out.png' },
    runner: { tool: 'comfy.tti', config },
  };
  return { projectDir, bundleDir, node, inputs, itemId: 'joyce', log: () => {} };
}

const cfg = () => ({
  workflowPath: 'workflows/zimage_tti.json',
  manifestPath: 'workflows/zimage_tti.manifest.json',
  endpoint: 'test.endpoint',
  width: 1024,
  height: 1024,
  outputPath: 'out.png',
});

describe('comfy.tti', () => {
  it('injects the prompt and runs with no image uploads', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyTtiRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(makeCtx({ ...cfg(), prompt: 'a portrait of joyce' }));

    expect(result.ok).toBe(true);
    expect(stub.uploads).toEqual([]); // TTI uploads nothing
    // zimage_tti.json maps prompt → node 6 .text
    expect(stub.queued[0]!['6']!.inputs['text']).toBe('a portrait of joyce');
    expect(existsSync(join(projectDir, 'out.png'))).toBe(true);
  });

  it('resolves the prompt from an upstream {imagePrompt} object', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyTtiRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(
      makeCtx(cfg(), { character_image_prompt: { imagePrompt: 'freckled redhead, soft light' } }),
    );
    expect(result.ok).toBe(true);
    expect(stub.queued[0]!['6']!.inputs['text']).toBe('freckled redhead, soft light');
  });

  it('fails when the required prompt cannot be resolved', async () => {
    const stub: Stub = { queued: [], uploads: [] };
    const runner = createComfyTtiRunner({ clientFactory: () => makeStubClient(stub) });
    const result = await runner.run(makeCtx(cfg(), {})); // no prompt anywhere
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/required input 'prompt'/);
    expect(stub.queued.length).toBe(0);
  });
});
