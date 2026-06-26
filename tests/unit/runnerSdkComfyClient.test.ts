/**
 * ComfyClient auth routing — mirrors dhee-core comfyClientModeRouting.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = ['COMFY_MODE', 'COMFY_CLOUD_API_KEY', 'COMFYUI_BASE_URL'] as const;

const ORIG_FETCH = globalThis.fetch;
let saved: Record<string, string | undefined>;

beforeEach(() => {
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
  globalThis.fetch = ORIG_FETCH;
  vi.restoreAllMocks();
});

function makeFetchMock() {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.includes('/upload/image')) {
      return new Response(JSON.stringify({ name: 'uploaded.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/prompt')) {
      return new Response(JSON.stringify({ prompt_id: 'p-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  });
}

describe('@dhee_ai/runner-sdk ComfyClient auth', () => {
  it('local mode: no auth on upload', async () => {
    process.env['COMFY_MODE'] = 'local';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyClient } = await import('../../packages/runner-sdk/src/comfyClient.js');
    const client = new ComfyClient('http://127.0.0.1:8188');
    const dir = mkdtempSync(join(tmpdir(), 'sdk-comfy-'));
    const img = join(dir, 'a.png');
    writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await client.uploadFile(img);

    const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['X-API-Key']).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });

  it('dhee Cloud proxy: Bearer JWT on prompt', async () => {
    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFY_CLOUD_API_KEY'] = 'desktop-jwt';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyClient } = await import('../../packages/runner-sdk/src/comfyClient.js');
    const client = new ComfyClient('https://dhee.studio/comfy/api');
    await client.queuePrompt({ n: { class_type: 'X', inputs: {} } });

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe('https://dhee.studio/comfy/api/prompt');
    const headers = init!.headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer desktop-jwt');
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('direct cloud.comfy.org: X-API-Key on prompt', async () => {
    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFY_CLOUD_API_KEY'] = 'comfy-cloud-key';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyClient } = await import('../../packages/runner-sdk/src/comfyClient.js');
    const client = new ComfyClient('https://cloud.comfy.org/api');
    await client.queuePrompt({ n: { class_type: 'X', inputs: {} } });

    const headers = mockFetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('comfy-cloud-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('cloud mode without key throws at construction', async () => {
    process.env['COMFY_MODE'] = 'cloud';
    const { ComfyClient } = await import('../../packages/runner-sdk/src/comfyClient.js');
    expect(() => new ComfyClient('https://dhee.studio/comfy/api')).toThrow(/COMFY_CLOUD_API_KEY/);
  });
});
