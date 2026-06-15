/**
 * gpuCoordinator — single-GPU lane swap.
 *
 * When the local LLM/VLM and ComfyUI share ONE GPU (the user's 5090 deployment),
 * they evict each other from VRAM. The walker only ORDERS lanes; it never frees a
 * model off the GPU. So before using a lane we must free the OTHER lane's model:
 *   - before a ComfyUI render  → unload the local LLM/VLM (`POST :8080/models/unload`)
 *   - before a VLM judge call   → free ComfyUI (`POST <comfy>/free`)
 *
 * OPT-IN via `DHEE_SINGLE_GPU=1` (off by default, so cloud / multi-GPU / separate-box
 * deployments are unaffected). Every call is best-effort and never throws — a swap
 * failure must not abort a render or a judge.
 *
 * Endpoints (env):
 *   - Comfy base    : arg (resolved endpoint URL) ?? COMFYUI_BASE_URL
 *   - Local LLM base: DHEE_LOCAL_LLM_URL ?? VLM_BASE_URL ?? (comfy host @ :8080)
 *     (strip a trailing `/v1`; the proxy serves `/v1/models` + `/models/unload`).
 */

export function singleGpuEnabled(): boolean {
  const v = process.env['DHEE_SINGLE_GPU'];
  return v === '1' || v === 'true';
}

function trimSlash(u: string): string {
  return u.replace(/\/+$/, '');
}

/** Resolve the local LLM/VLM server base (no `/v1`). */
function resolveLlmBase(explicit?: string): string | null {
  const raw = explicit || process.env['DHEE_LOCAL_LLM_URL'] || process.env['VLM_BASE_URL'] || '';
  if (raw) return trimSlash(raw).replace(/\/v1$/, '');
  // Derive from the Comfy host on the conventional llama.cpp port.
  const comfy = process.env['COMFYUI_BASE_URL'] || process.env['ENDPOINT_self_local'] || '';
  if (!comfy) return null;
  try {
    const u = new URL(comfy);
    return `${u.protocol}//${u.hostname}:8080`;
  } catch {
    return null;
  }
}

async function post(url: string, body: unknown, timeoutMs = 20000): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    /* best-effort */
  }
}

/** Free ComfyUI's VRAM (unload checkpoints) so the GPU is clear for the LLM/VLM. */
export async function freeComfyForLlm(comfyBaseUrl?: string, log?: (m: string) => void): Promise<void> {
  if (!singleGpuEnabled()) return;
  const base = trimSlash(comfyBaseUrl || process.env['COMFYUI_BASE_URL'] || process.env['ENDPOINT_self_local'] || '');
  if (!base) return;
  log?.(`gpu-swap: freeing ComfyUI VRAM at ${base} before VLM/LLM call`);
  await post(`${base}/free`, { unload_models: true, free_memory: true });
}

/** Unload all loaded local LLM/VLM models so the GPU is clear for ComfyUI. */
export async function unloadLocalLlmForComfy(llmBaseUrl?: string, log?: (m: string) => void): Promise<void> {
  if (!singleGpuEnabled()) return;
  const base = resolveLlmBase(llmBaseUrl);
  if (!base) return;
  let loaded: string[] = [];
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(8000) });
    const data = (await res.json()) as { data?: Array<{ id?: string; status?: { value?: string } }> };
    loaded = (data.data ?? []).filter((m) => m.status?.value === 'loaded' && m.id).map((m) => m.id!) ;
  } catch {
    return; // proxy unreachable / not a swap proxy — nothing to do
  }
  if (loaded.length === 0) return;
  log?.(`gpu-swap: unloading local model(s) [${loaded.join(', ')}] at ${base} before ComfyUI render`);
  for (const id of loaded) await post(`${base}/models/unload`, { model: id });
}
