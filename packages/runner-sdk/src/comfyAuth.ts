/**
 * Comfy HTTP auth — mirrors dhee-core ComfyUIClient rules.
 *
 * - Dhee Cloud proxy (any host except cloud.comfy.org) + key → Bearer
 * - Direct cloud.comfy.org + key → X-API-Key
 * - Local / no key → no auth headers
 */

const COMFY_CLOUD_HOST = 'cloud.comfy.org';

export function isComfyCloudUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === COMFY_CLOUD_HOST;
  } catch {
    return false;
  }
}

export function readComfyApiKey(): string | undefined {
  const key = process.env['COMFY_CLOUD_API_KEY'];
  return typeof key === 'string' && key.trim().length > 0 ? key.trim() : undefined;
}

export function useBearerComfyAuth(baseUrl: string, apiKey?: string): boolean {
  const key = apiKey ?? readComfyApiKey();
  return !!key && !isComfyCloudUrl(baseUrl);
}

/**
 * Build auth headers for a Comfy request. Does not set Content-Type.
 */
export function buildComfyAuthHeaders(
  baseUrl: string,
  apiKey?: string,
): Record<string, string> {
  const key = apiKey ?? readComfyApiKey();
  if (!key) return {};
  if (useBearerComfyAuth(baseUrl, key)) {
    return { Authorization: `Bearer ${key}` };
  }
  if (isComfyCloudUrl(baseUrl)) {
    return { 'X-API-Key': key };
  }
  return {};
}

export function requireComfyApiKeyForCloud(baseUrl: string, apiKey?: string): void {
  const mode = (process.env['COMFY_MODE'] ?? 'local').trim();
  const key = apiKey ?? readComfyApiKey();
  const isCloud =
    mode === 'cloud' || isComfyCloudUrl(baseUrl) || useBearerComfyAuth(baseUrl, key);
  if (isCloud && !key) {
    throw new Error(
      'COMFY_CLOUD_API_KEY is required when COMFY_MODE=cloud or the Comfy URL points to https://cloud.comfy.org',
    );
  }
}
