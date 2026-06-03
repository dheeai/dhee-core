const LOCAL_MODE = 'local' as const;

function isMeaningful(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

export function resolveEndpointUrl(endpointName: string): string | null {
  const mode = (process.env['COMFY_MODE'] ?? LOCAL_MODE).trim();

  if (mode === LOCAL_MODE) {
    const localEndpoint = process.env['ENDPOINT_self_local'];
    if (isMeaningful(localEndpoint)) return localEndpoint.trim();
    const baseUrl = process.env['COMFYUI_BASE_URL'];
    if (isMeaningful(baseUrl)) return baseUrl.trim();
    return null;
  }

  const envKey = `ENDPOINT_${endpointName.replace(/\./g, '_')}`;
  const url = process.env[envKey];
  return isMeaningful(url) ? url.trim() : null;
}
