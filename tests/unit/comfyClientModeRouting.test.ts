/**
 * End-to-end mode-routing assertions for ComfyUIClient.
 *
 * Existing coverage:
 *   - dhee-desktop's `dheeCoreManager.test.ts` proves the
 *     env→COMFYUI_BASE_URL mapping for local / direct-cloud /
 *     dhee-Cloud-auth modes.
 *   - `comfyClientEmbeddedConfig.test.ts` proves env is read at
 *     construction time and the right header style is picked.
 *
 * The piece that wasn't covered: when `queueWorkflow` and
 * `uploadImage` actually run, do they hit the URL the env said?
 * That's what blew up in the wild — config looked right, but the
 * dhee Cloud override silently rerouted requests to a host the
 * user never configured. These tests pin the contract by mocking
 * fetch and asserting on the URL it was called with.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEYS = [
  'COMFY_MODE',
  'COMFY_CLOUD_API_KEY',
  'COMFYUI_BASE_URL',
  'COMFYUI_TIMEOUT',
];

const ORIG_FETCH = globalThis.fetch;
let saved: Record<string, string | undefined>;
let tempDir: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  tempDir = mkdtempSync(join(tmpdir(), 'dhee-mode-routing-'));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  globalThis.fetch = ORIG_FETCH;
  vi.restoreAllMocks();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

function makeFetchMock() {
  return vi.fn().mockImplementation(async (url: string) => {
    // Default OK responses for the two endpoints under test.
    if (url.endsWith('/upload/image')) {
      return new Response(
        JSON.stringify({ name: 'uploaded.png', subfolder: '', type: 'input' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify({ prompt_id: 'prompt-123' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
}

describe('ComfyUIClient mode routing — actual fetch URL', () => {
  it('local mode: queueWorkflow POSTs to the user-configured local /prompt endpoint', async () => {
    process.env['COMFY_MODE'] = 'local';
    process.env['COMFYUI_BASE_URL'] = 'http://127.0.0.1:8188';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');
    const client = new ComfyUIClient({ outputDir: tempDir });
    await client.queueWorkflow({ nodes: [], links: [] }, 'client-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe('http://127.0.0.1:8188/prompt');
    expect(calledInit.method).toBe('POST');
    // Local mode: NO auth header should be attached.
    const headers = calledInit.headers as Record<string, string>;
    expect(headers['Authorization']).toBeUndefined();
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('local mode: uploadImage POSTs to the user-configured local /upload/image endpoint', async () => {
    process.env['COMFY_MODE'] = 'local';
    process.env['COMFYUI_BASE_URL'] = 'http://127.0.0.1:8188';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');
    const client = new ComfyUIClient({ outputDir: tempDir });
    const fakeImage = join(tempDir, 'a.png');
    writeFileSync(fakeImage, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await client.uploadImage(fakeImage, 'input', true);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8188/upload/image');
    const headers = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(headers['X-API-Key']).toBeUndefined();
    expect(headers['Authorization']).toBeUndefined();
  });

  it('direct cloud mode: queueWorkflow hits cloud.comfy.org/api/prompt with X-API-Key auth', async () => {
    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFYUI_BASE_URL'] = 'https://cloud.comfy.org/api';
    process.env['COMFY_CLOUD_API_KEY'] = 'comfy-cloud-key';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');
    const client = new ComfyUIClient({ outputDir: tempDir });
    await client.queueWorkflow({ nodes: [], links: [] }, 'client-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe('https://cloud.comfy.org/api/prompt');
    const headers = calledInit.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe('comfy-cloud-key');
    // Direct cloud uses X-API-Key, not Bearer.
    expect(headers['Authorization']).toBeUndefined();
  });

  it('dhee Cloud proxy mode: queueWorkflow hits the proxy /comfy/api/prompt with Bearer auth', async () => {
    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFYUI_BASE_URL'] = 'https://dhee-website.example/comfy/api';
    process.env['COMFY_CLOUD_API_KEY'] = 'desktop-jwt';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');
    const client = new ComfyUIClient({ outputDir: tempDir });
    await client.queueWorkflow({ nodes: [], links: [] }, 'client-1');

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe('https://dhee-website.example/comfy/api/prompt');
    const headers = calledInit.headers as Record<string, string>;
    // Non-cloud-host cloud mode uses Bearer auth (dhee proxy expects JWT).
    expect(headers['Authorization']).toBe('Bearer desktop-jwt');
    expect(headers['X-API-Key']).toBeUndefined();
  });

  it('includes generic workflow metadata in queued prompts', async () => {
    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFYUI_BASE_URL'] = 'https://dhee-website.example/comfy/api';
    process.env['COMFY_CLOUD_API_KEY'] = 'desktop-jwt';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');
    const client = new ComfyUIClient({ outputDir: tempDir });
    await client.queueWorkflow({ nodes: [], links: [] }, 'client-1', false, {
      workflowId: 'workflow-ref-1',
    });

    const [, calledInit] = mockFetch.mock.calls[0];
    const body = JSON.parse(calledInit.body as string);
    expect(body.extra_data).toMatchObject({
      workflowId: 'workflow-ref-1',
      dhee: { workflowId: 'workflow-ref-1' },
    });
  });

  it('local mode: NEVER hits cloud.comfy.org (regression guard for the dhee-Cloud-override bug)', async () => {
    process.env['COMFY_MODE'] = 'local';
    process.env['COMFYUI_BASE_URL'] = 'http://127.0.0.1:8188';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');
    const client = new ComfyUIClient({ outputDir: tempDir });
    await client.queueWorkflow({ nodes: [], links: [] }, 'client-1');

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('cloud.comfy.org');
    expect(calledUrl).not.toContain('dhee-website');
    expect(calledUrl.startsWith('http://127.0.0.1:8188')).toBe(true);
  });

  it('cloud mode: NEVER falls back to localhost when env points at a real cloud URL', async () => {
    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFYUI_BASE_URL'] = 'https://cloud.comfy.org/api';
    process.env['COMFY_CLOUD_API_KEY'] = 'k';
    const mockFetch = makeFetchMock();
    globalThis.fetch = mockFetch;

    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');
    const client = new ComfyUIClient({ outputDir: tempDir });
    await client.queueWorkflow({ nodes: [], links: [] }, 'client-1');

    const calledUrl = mockFetch.mock.calls[0][0] as string;
    expect(calledUrl).not.toContain('localhost');
    expect(calledUrl).not.toContain('127.0.0.1');
    expect(calledUrl.startsWith('https://cloud.comfy.org/api')).toBe(true);
  });
});
