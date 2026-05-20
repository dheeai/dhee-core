/**
 * Regression: `ComfyUIClient` must read env at *construction* time, not
 * at module load. The embedded desktop path requires the host
 * (dheeCoreManager) to set COMFY_MODE/COMFY_CLOUD_API_KEY into
 * process.env, but it does so AFTER dhee-core is imported. A
 * module-load `DEFAULT_CONFIG` froze `baseUrl='http://localhost:8188'`
 * before the host could speak — every embedded ComfyUI call then
 * silently fell into HTTP polling against a non-existent local server
 * and emitted a flood of `Failed to poll history: TypeError: fetch
 * failed`.
 *
 * Earlier fix: `DEFAULT_CONFIG` → `buildDefaultConfig()` invoked
 * inside the constructor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = [
  'COMFY_MODE',
  'COMFY_CLOUD_API_KEY',
  'COMFYUI_BASE_URL',
  'COMFYUI_TIMEOUT',
];

describe('ComfyUIClient — env read at construction time', () => {
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
  });

  it('picks up COMFY_MODE=cloud + key set after the module is first imported', async () => {
    // Force a fresh module evaluation so we know the cached config (if
    // any) reflects the current env.
    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');

    // Now set the env, MIRRORING the embedded boot order: import first,
    // then the host injects values into process.env.
    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFYUI_BASE_URL'] = 'https://cloud.comfy.org/api';
    process.env['COMFY_CLOUD_API_KEY'] = 'test-key-from-host';

    // Construct without explicit overrides — the embedded path uses
    // `new ComfyUIClient({ outputDir })`, which is what this exercises.
    const client = new ComfyUIClient({ outputDir: '/tmp' });

    // baseUrl is normalized by stripping trailing /api.
    expect((client as unknown as { baseUrl: string }).baseUrl).toBe('https://cloud.comfy.org');
    expect((client as unknown as { isCloud: boolean }).isCloud).toBe(true);
    expect((client as unknown as { apiKey?: string }).apiKey).toBe('test-key-from-host');
  });

  it('treats the dhee website Comfy route as cloud when COMFY_MODE=cloud', async () => {
    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');

    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFYUI_BASE_URL'] = 'http://localhost:3000/comfy/api';
    process.env['COMFY_CLOUD_API_KEY'] = 'desktop-jwt';

    const client = new ComfyUIClient({ outputDir: '/tmp' });

    expect((client as unknown as { baseUrl: string }).baseUrl).toBe('http://localhost:3000/comfy');
    expect((client as unknown as { isCloud: boolean }).isCloud).toBe(true);
    expect((client as any).buildUrl('/prompt')).toBe('http://localhost:3000/comfy/api/prompt');
    expect((client as any).buildWsUrl('client-1')).toBe(
      'ws://localhost:3000/comfy/ws?clientId=client-1'
    );
    expect((client as any).buildWsOptions()?.headers?.Authorization).toBe('Bearer desktop-jwt');
    expect((client as any).buildHeaders()).toEqual({
      Authorization: 'Bearer desktop-jwt',
    });
  });

  it('keeps X-API-Key auth for direct Comfy Cloud requests', async () => {
    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');

    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFYUI_BASE_URL'] = 'https://cloud.comfy.org/api';
    process.env['COMFY_CLOUD_API_KEY'] = 'comfy-cloud-key';

    const client = new ComfyUIClient({ outputDir: '/tmp' });

    expect((client as any).buildHeaders()).toEqual({
      'X-API-Key': 'comfy-cloud-key',
    });
  });

  it('throws a clear cloud-key error when env says cloud but key is missing', async () => {
    const { ComfyUIClient } = await import('../../src/services/comfyui/ComfyUIClient.js');
    process.env['COMFY_MODE'] = 'cloud';
    process.env['COMFYUI_BASE_URL'] = 'https://cloud.comfy.org/api';
    // intentionally NOT setting COMFY_CLOUD_API_KEY

    expect(() => new ComfyUIClient({ outputDir: '/tmp' })).toThrow(/COMFY_CLOUD_API_KEY/);
  });
});
