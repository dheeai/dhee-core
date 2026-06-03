import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComfyUIClient, isComfyCloudUrl } from '../../../src/services/comfyui/ComfyUIClient.js';
import WebSocket from 'ws';

vi.mock('ws', () => {
  class MockWebSocket {
    static instances: MockWebSocket[] = [];
    static calls: Array<{ url: string; options: unknown }> = [];
    handlers: Record<string, ((arg?: any) => void) | undefined> = {};
    url: string;
    options: unknown;

    constructor(url: string, options?: unknown) {
      this.url = url;
      this.options = options;
      MockWebSocket.calls.push({ url, options });
      MockWebSocket.instances.push(this);
      queueMicrotask(() => this.handlers.open?.());
    }

    on(event: string, handler: (arg?: any) => void) {
      this.handlers[event] = handler;
    }

    close() {
      this.handlers.close?.();
    }

    emit(event: string, payload?: any) {
      this.handlers[event]?.(payload);
    }
  }

  return { default: MockWebSocket };
});

describe('ComfyUIClient cloud detection', () => {
  it('detects cloud.comfy.org as Comfy Cloud', () => {
    expect(isComfyCloudUrl('https://cloud.comfy.org')).toBe(true);
    expect(isComfyCloudUrl('http://localhost:8188')).toBe(false);
  });
});

describe('ComfyUIClient.clearQueue cloud-safety', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env['COMFY_CLOUD_API_KEY'];
  });

  it('LOCAL mode: clearQueue() POSTs /queue {clear:true} — single-tenant queue is safe to drain', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock as typeof fetch;
    const client = new ComfyUIClient({
      baseUrl: 'http://localhost:8188',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: undefined,
      isCloud: false,
    });

    await client.clearQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8188/queue');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ clear: true });
  });

  it('CLOUD mode: clearQueue() is a no-op — the shared queue belongs to other tenants too', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'cloud-key';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    global.fetch = fetchMock as typeof fetch;
    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.comfy.org',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'cloud-key',
    });

    await client.clearQueue();

    // Critical: NO fetch should fire. Wiping the cloud queue would
    // delete pending prompts that belong to other users of the same
    // Comfy Cloud instance.
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ComfyUIClient request behavior', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env['COMFY_CLOUD_API_KEY'];
    (WebSocket as unknown as { instances: unknown[]; calls: unknown[] }).instances.length = 0;
    (WebSocket as unknown as { instances: unknown[]; calls: unknown[] }).calls.length = 0;
  });

  it('adds X-API-Key and /api prefix for Comfy Cloud queue requests', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'cloud-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ prompt_id: 'prompt-1' }),
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.comfy.org',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'cloud-key',
    });

    await client.queueWorkflow({ '1': { class_type: 'Test', inputs: {} } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.comfy.org/api/prompt');
    expect(new Headers(init.headers).get('X-API-Key')).toBe('cloud-key');
  });

  it('does not add X-API-Key or /api prefix for local ComfyUI queue requests', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'cloud-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ prompt_id: 'prompt-1' }),
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new ComfyUIClient({
      baseUrl: 'http://localhost:8188',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: undefined,
      isCloud: false,
    });

    await client.queueWorkflow({ '1': { class_type: 'Test', inputs: {} } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8188/prompt');
    expect(new Headers(init.headers).get('X-API-Key')).toBeNull();
  });

  it('hits /api/prompt when COMFYUI_BASE_URL has trailing /api (regression)', async () => {
    // Regression: stripping `/api` from baseUrl in the constructor (commit ad042ef)
    // accidentally broke queueWorkflow, which built `${baseUrl}/prompt` directly
    // without going through getPath(). Result: every cloud submit hit
    // `https://cloud.comfy.org/prompt` (404), the WS got "status" then closed,
    // and reference image gen reported `→ error` for every node.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ prompt_id: 'p' }),
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.comfy.org/api',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'cloud-key',
    });

    await client.queueWorkflow({ '1': { class_type: 'Test', inputs: {} } });

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe('https://cloud.comfy.org/api/prompt');
  });

  it('keeps /comfy/api and uses bearer auth for authenticated Comfy endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ prompt_id: 'p' }),
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new ComfyUIClient({
      baseUrl: 'https://example.com/comfy/api',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'bearer-token',
    });

    await client.queueWorkflow({ '1': { class_type: 'Test', inputs: {} } });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe('https://example.com/comfy/api/prompt');
    expect(headers.get('Authorization')).toBe('Bearer bearer-token');
    expect(headers.get('X-API-Key')).toBeNull();
  });

  it('requires COMFY_CLOUD_API_KEY for Comfy Cloud urls', () => {
    expect(
      () =>
        new ComfyUIClient({
          baseUrl: 'https://cloud.comfy.org',
          outputDir: '/tmp',
          timeout: 300,
          apiKey: undefined,
        }),
    ).toThrow(/COMFY_CLOUD_API_KEY/);
  });

  it('uses the cloud history_v2 endpoint and auth header', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'cloud-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ outputs: { '9': { images: [] } } }),
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.comfy.org',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'cloud-key',
    });

    await client.getOutputImages('prompt-1');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.comfy.org/api/history_v2/prompt-1');
    expect(new Headers(init.headers).get('X-API-Key')).toBe('cloud-key');
  });

  it('uses the cloud view endpoint and auth header for downloads', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'cloud-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.comfy.org',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'cloud-key',
    });

    await client.downloadOutput('output.png', '', 'output');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://cloud.comfy.org/api/view?filename=output.png&type=output');
    expect(new Headers(init.headers).get('X-API-Key')).toBe('cloud-key');
  });

  it('completes cloud websocket waits on execution_success', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'cloud-key';
    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.comfy.org',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'cloud-key',
    });

    const waitPromise = client.waitForCompletionWS('prompt-1', 'client-1');
    const wsInstance = (WebSocket as unknown as { instances: Array<{ emit: (event: string, payload?: any) => void }> }).instances[0]!;

    wsInstance.emit('message', JSON.stringify({ type: 'execution_success', data: { prompt_id: 'prompt-1' } }));

    await expect(waitPromise).resolves.toEqual({
      status: 'completed',
      prompt_id: 'prompt-1',
    });
  });

  it('uses /comfy/ws and bearer auth for authenticated Comfy websockets', async () => {
    const client = new ComfyUIClient({
      baseUrl: 'https://example.com/comfy/api',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'bearer-token',
    });

    const waitPromise = client.waitForCompletionWS('prompt-1', 'client-1');
    const wsInstance = (WebSocket as unknown as {
      instances: Array<{
        url: string;
        options?: { headers?: Record<string, string> };
        emit: (event: string, payload?: any) => void;
      }>;
    }).instances.at(-1)!;

    expect(wsInstance.url).toBe('wss://example.com/comfy/ws?clientId=client-1');
    expect(wsInstance.options?.headers?.Authorization).toBe('Bearer bearer-token');

    wsInstance.emit('message', JSON.stringify({ type: 'execution_success', data: { prompt_id: 'prompt-1' } }));

    await expect(waitPromise).resolves.toEqual({
      status: 'completed',
      prompt_id: 'prompt-1',
    });
  });

  it('uses token query without bearer websocket headers for direct Comfy Cloud', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'cloud-key';
    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.comfy.org',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'cloud-key',
    });

    const waitPromise = client.waitForCompletionWS('prompt-1', 'client-1');
    const wsInstance = (WebSocket as unknown as { instances: Array<{ emit: (event: string, payload?: any) => void }> }).instances[0]!;
    wsInstance.emit('message', JSON.stringify({ type: 'execution_success', data: { prompt_id: 'prompt-1' } }));
    await waitPromise;

    const call = (WebSocket as unknown as { calls: Array<{ url: string; options: unknown }> }).calls[0]!;
    expect(call.url).toBe('wss://cloud.comfy.org/ws?clientId=client-1&token=cloud-key');
    expect(call.options).toBeUndefined();
  });

  it('falls back to HTTP polling when cloud queue websocket closes before completion', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'cloud-key';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ prompt_id: 'prompt-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          'prompt-1': {
            status: { completed: true, status_str: 'success' },
            outputs: {
              '9': {
                images: [{ filename: 'cloud.png', subfolder: '', type: 'output' }],
              },
            },
          },
        }),
      });
    global.fetch = fetchMock as typeof fetch;

    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.comfy.org',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'cloud-key',
    });

    const waitPromise = client.queueAndWaitWS({ '1': { class_type: 'Test', inputs: {} } });
    await Promise.resolve();
    await Promise.resolve();
    const wsInstance = (WebSocket as unknown as { instances: Array<{ emit: (event: string, payload?: any) => void }> }).instances[0]!;
    wsInstance.emit('close');

    await expect(waitPromise).resolves.toMatchObject({
      result: { status: 'completed', prompt_id: 'prompt-1' },
      promptId: 'prompt-1',
      outputs: [],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://cloud.comfy.org/api/history_v2/prompt-1',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'cloud-key' }),
      }),
    );
  });

  it('uses cached cloud outputs from executed websocket messages', async () => {
    process.env['COMFY_CLOUD_API_KEY'] = 'cloud-key';
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ outputs: {} }),
    });
    global.fetch = fetchMock as typeof fetch;

    const client = new ComfyUIClient({
      baseUrl: 'https://cloud.comfy.org',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: 'cloud-key',
    });

    const waitPromise = client.waitForCompletionWS('prompt-1', 'client-1');
    const wsInstance = (WebSocket as unknown as { instances: Array<{ emit: (event: string, payload?: any) => void }> }).instances.at(-1)!;

    wsInstance.emit('message', JSON.stringify({
      type: 'executed',
      data: {
        prompt_id: 'prompt-1',
        node: '9',
        output: {
          images: [
            { filename: 'cloud.png', subfolder: '', type: 'output' },
          ],
        },
      },
    }));
    wsInstance.emit('message', JSON.stringify({ type: 'execution_success', data: { prompt_id: 'prompt-1' } }));

    await waitPromise;

    await expect(client.getOutputImages('prompt-1')).resolves.toEqual([
      {
        filename: 'cloud.png',
        subfolder: '',
        type: 'output',
        node_id: '9',
      },
    ]);
  });
});

describe('ComfyUIClient.waitForCompletion local error detection', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns {status:error} when /history reports status_str=error (OOM) instead of polling a dead prompt forever', async () => {
    // Regression: a local prompt that OOMs reports status_str=error in
    // /history with no outputs. The HTTP-polling fallback used to match
    // none of the completion branches (outputs empty, not "success") AND
    // never hit the missing-poll fast-fail (which only fires when
    // /history is ABSENT) — so it looped indefinitely, leaving the node
    // stuck in_progress. waitForCompletion must surface the error.
    const promptId = 'oom-prompt-1';
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (String(url).includes(`/history/${promptId}`)) {
        return {
          ok: true,
          json: async () => ({
            [promptId]: {
              status: {
                status_str: 'error',
                completed: false,
                messages: [
                  ['execution_start', { prompt_id: promptId }],
                  ['execution_error', { exception_type: 'torch.OutOfMemoryError', node_id: '47' }],
                ],
              },
              outputs: {},
            },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new ComfyUIClient({
      baseUrl: 'http://localhost:8188',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: undefined,
      isCloud: false,
    });
    // poll interval 1s: with the bug this never returns (loops every 1s),
    // so the 4s test timeout trips. With the fix it returns on the first
    // poll, before any sleep.
    const result = await client.waitForCompletion(promptId, undefined, 1);
    expect(result.status).toBe('error');
    expect(result.prompt_id).toBe(promptId);
  }, 4000);
});

describe('ComfyUIClient.getGpuVramTotalBytes', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  function makeClient(): ComfyUIClient {
    return new ComfyUIClient({
      baseUrl: 'http://localhost:8188',
      outputDir: '/tmp',
      timeout: 300,
      apiKey: undefined,
      isCloud: false,
    });
  }

  it('returns the device vram_total from /system_stats', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        devices: [
          {
            name: 'NVIDIA GeForce RTX 3060',
            vram_total: 12_884_246_528,
            vram_free: 3_300_000_000,
          },
        ],
      }),
    });
    global.fetch = fetchMock as typeof fetch;
    await expect(makeClient().getGpuVramTotalBytes()).resolves.toBe(12_884_246_528);
  });

  it('returns null when /system_stats reports no device with vram_total', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ devices: [{ name: 'cpu' }] }),
    });
    global.fetch = fetchMock as typeof fetch;
    await expect(makeClient().getGpuVramTotalBytes()).resolves.toBeNull();
  });

  it('returns null when /system_stats fails (non-ok)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    global.fetch = fetchMock as typeof fetch;
    await expect(makeClient().getGpuVramTotalBytes()).resolves.toBeNull();
  });

  it('returns null when the request throws (unreachable Comfy)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    global.fetch = fetchMock as typeof fetch;
    await expect(makeClient().getGpuVramTotalBytes()).resolves.toBeNull();
  });
});
