/**
 * comfyExecutor — the workflow-agnostic core shared by comfy.klein /
 * comfy.tti / comfy.fl2v. Tests cover the generic graph prune+redirect
 * algorithm and the manifest-driven required-input enforcement.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  pruneAndRedirect,
  executeComfyWorkflow,
  type ComfyImageClient,
  type ComfyWorkflow,
} from '../../../src/dag/runners/comfyExecutor.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

// ── pruneAndRedirect (pure graph surgery) ──────────────────────────────

describe('pruneAndRedirect', () => {
  it('deletes a node and repoints its consumer to the redirect target', () => {
    const wf: ComfyWorkflow = {
      base: { class_type: 'RL', inputs: {} },
      refB: { class_type: 'RL', inputs: { conditioning: ['base', 0] } },
      guider: { class_type: 'CFG', inputs: { positive: ['refB', 0] } },
    };
    const deleted = pruneAndRedirect(wf, { deleteNodes: ['refB'], redirects: [{ from: 'refB', to: 'base' }] });
    expect(deleted.has('refB')).toBe(true);
    expect(wf['refB']).toBeUndefined();
    expect(wf['guider']!.inputs['positive']).toEqual(['base', 0]);
  });

  it('follows redirects transitively when a chain is deleted', () => {
    const wf: ComfyWorkflow = {
      base: { class_type: 'RL', inputs: {} },
      r1: { class_type: 'RL', inputs: { c: ['base', 0] } },
      r2: { class_type: 'RL', inputs: { c: ['r1', 0] } },
      guider: { class_type: 'CFG', inputs: { p: ['r2', 0] } },
    };
    pruneAndRedirect(wf, {
      deleteNodes: ['r1', 'r2'],
      redirects: [
        { from: 'r2', to: 'r1' },
        { from: 'r1', to: 'base' },
      ],
    });
    expect(wf['r1']).toBeUndefined();
    expect(wf['r2']).toBeUndefined();
    // Consumer of r2 falls all the way back to base.
    expect(wf['guider']!.inputs['p']).toEqual(['base', 0]);
  });

  it('preserves the slot index when repointing', () => {
    const wf: ComfyWorkflow = {
      base: { class_type: 'X', inputs: {} },
      refB: { class_type: 'X', inputs: {} },
      consumer: { class_type: 'Y', inputs: { latent: ['refB', 3] } },
    };
    pruneAndRedirect(wf, { deleteNodes: ['refB'], redirects: [{ from: 'refB', to: 'base' }] });
    expect(wf['consumer']!.inputs['latent']).toEqual(['base', 3]);
  });

  it('is a no-op when there is nothing to delete', () => {
    const wf: ComfyWorkflow = { a: { class_type: 'X', inputs: { l: ['b', 0] } }, b: { class_type: 'X', inputs: {} } };
    const before = JSON.stringify(wf);
    const deleted = pruneAndRedirect(wf, { deleteNodes: [], redirects: [] });
    expect(deleted.size).toBe(0);
    expect(JSON.stringify(wf)).toBe(before);
  });
});

// ── executeComfyWorkflow: required-input enforcement ───────────────────

function makeStubClient(queued: Array<Record<string, unknown>>): ComfyImageClient {
  return {
    async uploadImage(p) {
      return { name: `up_${p.split('/').pop()}` };
    },
    async queueAndWait(wf) {
      queued.push(wf);
      return { outputs: [{ filename: 'out.png' }] };
    },
    async downloadOutput(_f, _s, destPath) {
      const fs = await import('node:fs/promises');
      await fs.mkdir(join(destPath, '..'), { recursive: true });
      await fs.writeFile(destPath, Buffer.from('png'));
    },
  };
}

describe('executeComfyWorkflow — required inputs (manifest-driven)', () => {
  let bundleDir: string;
  let projectDir: string;
  let savedMode: string | undefined;
  let savedCas: string | undefined;

  beforeEach(() => {
    bundleDir = mkdtempSync(join(tmpdir(), 'exec-bundle-'));
    projectDir = mkdtempSync(join(tmpdir(), 'exec-proj-'));
    mkdirSync(join(bundleDir, 'workflows'), { recursive: true });
    writeFileSync(
      join(bundleDir, 'workflows/wf.json'),
      JSON.stringify({
        '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } },
        '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
        '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'out' } },
      }),
    );
    writeFileSync(
      join(bundleDir, 'workflows/wf.manifest.json'),
      JSON.stringify({
        inputRequirements: [
          { id: 'prompt', type: 'text', source: 'llm', required: true },
          { id: 'base_image', type: 'image', source: 'upstream', required: true },
        ],
        parameterMappings: [
          { input: 'prompt', nodeId: '1', field: 'text' },
          { input: 'base_image', nodeId: '2', field: 'image' },
        ],
      }),
    );
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

  function makeCtx(): RunnerContext {
    const node: NodeDef = {
      id: 'n',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'image', pattern: 'out.png' },
      runner: { tool: 'comfy.test', config: {} },
    };
    return { projectDir, bundleDir, node, inputs: {}, log: () => {} };
  }

  it('fails clearly when a manifest-required image input is absent', async () => {
    const queued: Array<Record<string, unknown>> = [];
    const result = await executeComfyWorkflow({
      ctx: makeCtx(),
      tool: 'comfy.test',
      workflowPath: 'workflows/wf.json',
      manifestPath: 'workflows/wf.manifest.json',
      endpoint: 'test.endpoint',
      outputPath: 'out.png',
      prompt: 'hello',
      imageInputs: {}, // base_image (required) missing
      clientFactory: () => makeStubClient(queued),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/required input 'base_image'/);
    }
    expect(queued.length).toBe(0); // never queued a doomed workflow
  });

  it('runs when all required inputs resolve, injecting prompt + uploaded image', async () => {
    const img = join(projectDir, 'base.png');
    writeFileSync(img, Buffer.from('img'));
    const queued: Array<Record<string, unknown>> = [];
    const result = await executeComfyWorkflow({
      ctx: makeCtx(),
      tool: 'comfy.test',
      workflowPath: 'workflows/wf.json',
      manifestPath: 'workflows/wf.manifest.json',
      endpoint: 'test.endpoint',
      outputPath: 'out.png',
      prompt: 'a dragon',
      imageInputs: { base_image: img },
      clientFactory: () => makeStubClient(queued),
    });
    expect(result.ok).toBe(true);
    expect(queued.length).toBe(1);
    const wf = queued[0]!;
    expect((wf['1'] as { inputs: { text: string } }).inputs.text).toBe('a dragon');
    expect((wf['2'] as { inputs: { image: string } }).inputs.image).toBe('up_base.png');
    expect(existsSync(join(projectDir, 'out.png'))).toBe(true);
  });
});
