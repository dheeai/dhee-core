/**
 * resolveEndpointUrl — central routing for bundle-declared Comfy
 * endpoints. Replaces duplicated copies that lived across the comfy
 * runners (comfyExecutor, comfyLtxDirector, comfyQwenEditChain).
 *
 * Behavior:
 *   - When `COMFY_MODE=local` (or unset, which defaults to local):
 *     ALL endpoint lookups force the local Comfy URL — `ENDPOINT_self_local`
 *     first, then `COMFYUI_BASE_URL`. The bundle's `endpoint` label is
 *     IGNORED. This is how a user with local-only deployment runs a
 *     bundle whose author labeled some nodes `"public.cloud"`: the
 *     labels are intent metadata; the user's env wins.
 *
 *   - When `COMFY_MODE=cloud`: the bundle's endpoint label is honored.
 *     `endpoint: "public.cloud"` → looks up `ENDPOINT_public_cloud`
 *     env var, returns whatever URL is there (or null if unset).
 *
 * Returns null when no URL is resolvable; callers handle that as a
 * dispatch failure with a clear error.
 */

const LOCAL_MODE = 'local' as const;

function isMeaningful(s: string | undefined): s is string {
  return typeof s === 'string' && s.trim().length > 0;
}

export function resolveEndpointUrl(endpointName: string): string | null {
  const mode = (process.env['COMFY_MODE'] ?? LOCAL_MODE).trim();

  if (mode === LOCAL_MODE) {
    // Force-local: every bundle endpoint label resolves to the local
    // Comfy URL, regardless of what it's named.
    const localEndpoint = process.env['ENDPOINT_self_local'];
    if (isMeaningful(localEndpoint)) return localEndpoint.trim();
    const baseUrl = process.env['COMFYUI_BASE_URL'];
    if (isMeaningful(baseUrl)) return baseUrl.trim();
    return null;
  }

  // Cloud mode (or anything non-'local'): honor the bundle's label,
  // falling back to COMFYUI_BASE_URL when the specific ENDPOINT_<name>
  // is unset. Without this fallback every bundle endpoint label (self.public,
  // public.cloud, …) requires an explicit ENDPOINT_<label> env var, which
  // is brittle — adding a new bundle label silently breaks cloud routing
  // until the operator adds the matching var.
  const envKey = `ENDPOINT_${endpointName.replace(/\./g, '_')}`;
  const url = process.env[envKey];
  if (isMeaningful(url)) return url.trim();
  const baseUrl = process.env['COMFYUI_BASE_URL'];
  if (isMeaningful(baseUrl)) return baseUrl.trim();
  return null;
}
