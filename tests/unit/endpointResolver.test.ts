/**
 * resolveEndpointUrl — TDD coverage.
 *
 * Used by comfy.image, comfy.ltx_director, comfy.qwen_edit_chain to
 * map the bundle's named endpoint (e.g. "public.cloud", "self.local")
 * to a real URL.
 *
 * Critical behavior under test: when `COMFY_MODE=local` (which is also
 * the default), EVERY endpoint resolves to the local Comfy URL,
 * regardless of what the bundle labels it as. Bundle authors can tag
 * a node `endpoint: "public.cloud"` but the user's local-mode
 * deployment ignores that and routes to the local Comfy. The override
 * only relaxes when COMFY_MODE=cloud — then the bundle's labels are
 * honored.
 *
 * Failure modes:
 *  1. COMFY_MODE=local + ENDPOINT_self_local set → returns local URL
 *     even when the bundle says "public.cloud".
 *  2. COMFY_MODE=local + bundle says "self.local" → still returns local
 *     (same result, no surprise).
 *  3. COMFY_MODE=cloud + bundle says "public.cloud" + ENDPOINT_public_cloud
 *     set → returns the cloud URL (override does NOT fire).
 *  4. COMFY_MODE=cloud + bundle says "self.local" + ENDPOINT_self_local
 *     set → returns local URL (cloud mode honors bundle labels).
 *  5. COMFY_MODE unset → defaults to local (force-local override fires).
 *  6. COMFY_MODE=local + no ENDPOINT_self_local + COMFYUI_BASE_URL set
 *     → falls back to COMFYUI_BASE_URL.
 *  7. COMFY_MODE=local + no env at all → returns null (caller handles).
 *  8. COMFY_MODE=cloud + bundle endpoint with no env mapping → null.
 *  9. COMFY_MODE=local with empty-string ENDPOINT_self_local → falls
 *     through to COMFYUI_BASE_URL (whitespace/empty is "unset").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { resolveEndpointUrl } from '../../src/dag/runners/endpointResolver.js';

const ENV_KEYS = [
  'COMFY_MODE',
  'COMFYUI_BASE_URL',
  'ENDPOINT_self_local',
  'ENDPOINT_public_cloud',
] as const;

describe('resolveEndpointUrl', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
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

  it('1. COMFY_MODE=local, bundle says "public.cloud" → returns local URL', () => {
    process.env['COMFY_MODE'] = 'local';
    process.env['ENDPOINT_self_local'] = 'https://comfyui.share.zrok.io';
    process.env['ENDPOINT_public_cloud'] = 'https://cloud.comfy.org/api';
    expect(resolveEndpointUrl('public.cloud')).toBe('https://comfyui.share.zrok.io');
  });

  it('2. COMFY_MODE=local, bundle says "self.local" → returns local URL', () => {
    process.env['COMFY_MODE'] = 'local';
    process.env['ENDPOINT_self_local'] = 'https://comfyui.share.zrok.io';
    expect(resolveEndpointUrl('self.local')).toBe('https://comfyui.share.zrok.io');
  });

  it('3. COMFY_MODE=cloud, bundle "public.cloud" → returns cloud URL (no override)', () => {
    process.env['COMFY_MODE'] = 'cloud';
    process.env['ENDPOINT_self_local'] = 'https://comfyui.share.zrok.io';
    process.env['ENDPOINT_public_cloud'] = 'https://cloud.comfy.org/api';
    expect(resolveEndpointUrl('public.cloud')).toBe('https://cloud.comfy.org/api');
  });

  it('4. COMFY_MODE=cloud, bundle "self.local" → returns local URL (label honored)', () => {
    process.env['COMFY_MODE'] = 'cloud';
    process.env['ENDPOINT_self_local'] = 'https://comfyui.share.zrok.io';
    expect(resolveEndpointUrl('self.local')).toBe('https://comfyui.share.zrok.io');
  });

  it('5. COMFY_MODE unset → defaults to local (force-local fires)', () => {
    process.env['ENDPOINT_self_local'] = 'https://comfyui.share.zrok.io';
    process.env['ENDPOINT_public_cloud'] = 'https://cloud.comfy.org/api';
    expect(resolveEndpointUrl('public.cloud')).toBe('https://comfyui.share.zrok.io');
  });

  it('6. COMFY_MODE=local + no ENDPOINT_self_local + COMFYUI_BASE_URL → falls back', () => {
    process.env['COMFY_MODE'] = 'local';
    process.env['COMFYUI_BASE_URL'] = 'http://localhost:8188';
    expect(resolveEndpointUrl('public.cloud')).toBe('http://localhost:8188');
  });

  it('7. COMFY_MODE=local + no env at all → null', () => {
    process.env['COMFY_MODE'] = 'local';
    expect(resolveEndpointUrl('public.cloud')).toBeNull();
  });

  it('8. COMFY_MODE=cloud + bundle endpoint with no env mapping → null', () => {
    process.env['COMFY_MODE'] = 'cloud';
    expect(resolveEndpointUrl('unmapped.endpoint')).toBeNull();
  });

  it('9. COMFY_MODE=local + empty-string ENDPOINT_self_local → falls back to COMFYUI_BASE_URL', () => {
    process.env['COMFY_MODE'] = 'local';
    process.env['ENDPOINT_self_local'] = '   ';
    process.env['COMFYUI_BASE_URL'] = 'http://localhost:8188';
    expect(resolveEndpointUrl('public.cloud')).toBe('http://localhost:8188');
  });
});
