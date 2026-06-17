import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  singleGpuEnabled,
  freeComfyForLlm,
  unloadLocalLlmForComfy,
} from '../../../src/dag/runners/gpuCoordinator.js';

const ORIG = { ...process.env };

function mockFetch() {
  const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
  const fn = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
    // /v1/models lists one loaded model so unload has something to do
    if (url.endsWith('/v1/models')) {
      return { json: async () => ({ data: [{ id: 'qwen-35b', status: { value: 'loaded' } }, { id: 'qwen-27b', status: { value: 'unloaded' } }] }) } as never;
    }
    return { ok: true, json: async () => ({ success: true }) } as never;
  });
  vi.stubGlobal('fetch', fn);
  return calls;
}

beforeEach(() => {
  process.env = { ...ORIG };
  delete process.env['DHEE_SINGLE_GPU'];
  delete process.env['COMFYUI_BASE_URL'];
  delete process.env['DHEE_LOCAL_LLM_URL'];
  delete process.env['VLM_BASE_URL'];
  delete process.env['ENDPOINT_self_local'];
});
afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...ORIG };
});

describe('gpuCoordinator gating', () => {
  it('singleGpuEnabled reflects DHEE_SINGLE_GPU', () => {
    expect(singleGpuEnabled()).toBe(false);
    process.env['DHEE_SINGLE_GPU'] = '1';
    expect(singleGpuEnabled()).toBe(true);
    process.env['DHEE_SINGLE_GPU'] = 'true';
    expect(singleGpuEnabled()).toBe(true);
  });

  it('is a no-op (no network) when single-GPU mode is OFF', async () => {
    const calls = mockFetch();
    process.env['COMFYUI_BASE_URL'] = 'http://host:8188';
    await freeComfyForLlm();
    await unloadLocalLlmForComfy();
    expect(calls).toHaveLength(0);
  });
});

describe('gpuCoordinator when enabled', () => {
  beforeEach(() => (process.env['DHEE_SINGLE_GPU'] = '1'));

  it('freeComfyForLlm POSTs /free to the comfy endpoint', async () => {
    const calls = mockFetch();
    await freeComfyForLlm('http://comfy:8188/');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://comfy:8188/free');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toMatchObject({ unload_models: true, free_memory: true });
  });

  it('unloadLocalLlmForComfy unloads only LOADED models at the llm base', async () => {
    const calls = mockFetch();
    process.env['DHEE_LOCAL_LLM_URL'] = 'http://box:8080/v1';
    await unloadLocalLlmForComfy();
    // first call lists models, then one unload for the single loaded model
    expect(calls[0]!.url).toBe('http://box:8080/v1/models');
    const unloads = calls.filter((c) => c.url.endsWith('/models/unload'));
    expect(unloads).toHaveLength(1);
    expect(unloads[0]!.body).toMatchObject({ model: 'qwen-35b' });
  });

  it('derives the llm base from the comfy host on :8080 when no explicit url', async () => {
    const calls = mockFetch();
    process.env['COMFYUI_BASE_URL'] = 'http://100.93.149.119:8188';
    await unloadLocalLlmForComfy();
    expect(calls[0]!.url).toBe('http://100.93.149.119:8080/v1/models');
  });
});
