/**
 * comfy.tti.cloud — contract tests for the cloud-pinned variant.
 *
 * These pin the behavior that distinguishes it from generic comfy.tti:
 *   - it forces COMFY_MODE=cloud and defaults ENDPOINT_public_cloud
 *     (the gap that broke cloud routing) without clobbering an explicit value,
 *   - it fails fast with a clear RunnerResult error when
 *     COMFY_CLOUD_API_KEY is absent (never throws),
 *   - it otherwise delegates to the same zimage plumbing as comfy.tti.
 *
 * No network: a stub ComfyImageClient captures the submitted workflow.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createComfyTtiCloudRunner } from '../../../src/dag/runners/comfyTtiCloud.js';
import type { ComfyImageClient } from '../../../src/dag/runners/comfyExecutor.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

const REAL_TTI = resolve('src/dag/bundles/narrative_prompt_relay/workflows/zimage_tti.json');
const REAL_TTI_MANIFEST = resolve(
  'src/dag/bundles/narrative_prompt_relay/workflows/zimage_tti.manifest.json',
);

interface Stub {
  queued: Array<Record<string, { inputs: Record<string, unknown> }>>;
  baseUrlsSeen: string[];
}
function makeStubClient(stub: Stub): ComfyImageClient {
  return {
    async uploadImage() {
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
let saved: Record<string, string | undefined>;

const ENV_KEYS = ['COMFY_MODE', 'COMFY_CLOUD_API_KEY', 'ENDPOINT_public_cloud', 'COMFYUI_BASE_URL'];

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'tti-cloud-bundle-'));
  projectDir = mkdtempSync(join(tmpdir(), 'tti-cloud-proj-'));
  mkdirSync(join(bundleDir, 'workflows'), { recursive: true });
  copyFileSync(REAL_TTI, join(bundleDir, 'workflows/zimage_tti.json'));
  copyFileSync(REAL_TTI_MANIFEST, join(bundleDir, 'workflows/zimage_tti.manifest.json'));
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(bundleDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function makeCtx(): RunnerContext {
  const node: NodeDef = {
    id: 'character_image',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'image', pattern: 'out.png' },
    runner: {
      tool: 'comfy.tti.cloud',
      config: {
        workflowPath: 'workflows/zimage_tti.json',
        manifestPath: 'workflows/zimage_tti.manifest.json',
        endpoint: 'public.cloud',
        width: 1024,
        height: 1024,
        prompt: 'a portrait of joyce',
        outputPath: 'out.png',
      },
    },
  };
  return { projectDir, bundleDir, node, inputs: {}, log: () => {} };
}

describe('comfy.tti.cloud', () => {
  it('forces cloud mode + defaults ENDPOINT_public_cloud, then delegates + writes output', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'comfyui-test-key';
    // Simulate the common cloud-plan gap: COMFYUI_BASE_URL set, ENDPOINT unset.
    process.env['COMFYUI_BASE_URL'] = 'https://cloud.comfy.org/api';
    const stub: Stub = { queued: [], baseUrlsSeen: [] };
    const runner = createComfyTtiCloudRunner({
      clientFactory: (o) => {
        if (o.baseUrl) stub.baseUrlsSeen.push(o.baseUrl);
        return makeStubClient(stub);
      },
    });

    const result = await runner.run(makeCtx());

    expect(result.ok).toBe(true);
    expect(process.env['COMFY_MODE']).toBe('cloud');
    expect(process.env['ENDPOINT_public_cloud']).toBe('https://cloud.comfy.org/api');
    // The endpoint resolved (the executor only passes baseUrl when it does) → cloud URL.
    expect(stub.baseUrlsSeen).toContain('https://cloud.comfy.org/api');
    // Prompt reached the zimage prompt node (node 6 .text).
    expect(stub.queued[0]!['6']!.inputs['text']).toBe('a portrait of joyce');
    expect(existsSync(join(projectDir, 'out.png'))).toBe(true);
  });

  it('defaults ENDPOINT_public_cloud to the canonical cloud URL when COMFYUI_BASE_URL is absent', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'comfyui-test-key';
    delete process.env['COMFYUI_BASE_URL'];
    const runner = createComfyTtiCloudRunner({ clientFactory: () => makeStubClient({ queued: [], baseUrlsSeen: [] }) });
    const result = await runner.run(makeCtx());
    expect(result.ok).toBe(true);
    expect(process.env['ENDPOINT_public_cloud']).toBe('https://cloud.comfy.org/api');
  });

  it('does NOT clobber an explicitly-configured ENDPOINT_public_cloud', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'comfyui-test-key';
    process.env['ENDPOINT_public_cloud'] = 'https://my.proxy/comfy/api';
    const stub: Stub = { queued: [], baseUrlsSeen: [] };
    const runner = createComfyTtiCloudRunner({
      clientFactory: (o) => {
        if (o.baseUrl) stub.baseUrlsSeen.push(o.baseUrl);
        return makeStubClient(stub);
      },
    });
    const result = await runner.run(makeCtx());
    expect(result.ok).toBe(true);
    expect(process.env['ENDPOINT_public_cloud']).toBe('https://my.proxy/comfy/api');
    expect(stub.baseUrlsSeen).toContain('https://my.proxy/comfy/api');
  });

  it('fails fast with a clear error (never throws) when COMFY_CLOUD_API_KEY is unset', async () => {
    delete process.env['COMFY_CLOUD_API_KEY'];
    const runner = createComfyTtiCloudRunner({ clientFactory: () => makeStubClient({ queued: [], baseUrlsSeen: [] }) });
    const result = await runner.run(makeCtx());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/COMFY_CLOUD_API_KEY/);
  });

  it('describes itself as comfy.tti.cloud', () => {
    const runner = createComfyTtiCloudRunner();
    expect(runner.describe().id).toBe('comfy.tti.cloud');
  });
});
