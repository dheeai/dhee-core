/**
 * Shared ComfyUI HTTP client for external runners — polling-based, with
 * cloud auth from COMFY_CLOUD_API_KEY (desktop JWT on Dhee Cloud proxy).
 */

import {
  buildComfyAuthHeaders,
  isComfyCloudUrl,
  readComfyApiKey,
  requireComfyApiKeyForCloud,
  useBearerComfyAuth,
} from './comfyAuth.js';

export interface ComfyOutput {
  filename: string;
  subfolder: string;
  type: string;
}

export interface ComfyClientOptions {
  baseUrl: string;
  clientId?: string;
  /** Override COMFY_CLOUD_API_KEY from env. */
  apiKey?: string;
}

export interface RunOpts {
  signal?: AbortSignal;
  /** Overall wait budget (ms). Default 10 min. */
  timeoutMs?: number;
  /** Poll interval (ms). Default 1500. */
  pollMs?: number;
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean; messages?: Array<[string, unknown]> };
  outputs?: Record<string, Record<string, unknown>>;
}

const OUTPUT_KEYS = ['images', 'image', 'gifs', 'videos', 'video', 'audio'] as const;

export class ComfyClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly apiKey?: string;
  private readonly useCloudPaths: boolean;

  constructor(baseUrlOrOpts: string | ComfyClientOptions, clientId?: string) {
    let rawBase: string;
    if (typeof baseUrlOrOpts === 'string') {
      rawBase = baseUrlOrOpts;
      this.clientId = clientId ?? defaultClientId(rawBase);
      this.apiKey = readComfyApiKey();
    } else {
      rawBase = baseUrlOrOpts.baseUrl;
      this.clientId = baseUrlOrOpts.clientId ?? defaultClientId(rawBase);
      this.apiKey = baseUrlOrOpts.apiKey ?? readComfyApiKey();
    }
    // Mirror dhee-core ComfyUIClient: strip trailing /api so cloud paths
    // can be re-applied consistently via requestPath().
    this.baseUrl = normalizeComfyBaseUrl(rawBase);
    this.useCloudPaths = isCloudComfyClient(this.baseUrl, this.apiKey);
    requireComfyApiKeyForCloud(this.baseUrl, this.apiKey);
  }

  private authHeaders(): Record<string, string> {
    return buildComfyAuthHeaders(this.baseUrl, this.apiKey);
  }

  private requestPath(pathname: string): string {
    const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return this.useCloudPaths ? `/api${normalized}` : normalized;
  }

  private buildUrl(pathname: string, searchParams?: URLSearchParams): string {
    const url = new URL(`${this.baseUrl}${this.requestPath(pathname)}`);
    if (searchParams) url.search = searchParams.toString();
    return url.toString();
  }

  private async request(
    pathname: string,
    init: RequestInit = {},
    searchParams?: URLSearchParams,
  ): Promise<Response> {
    const extra = (init.headers ?? {}) as Record<string, string>;
    return fetch(this.buildUrl(pathname, searchParams), {
      ...init,
      headers: { ...this.authHeaders(), ...extra },
    });
  }

  /** Upload a local file to Comfy's input store; returns the stored name. */
  async uploadFile(absPath: string, type: 'input' | 'temp' = 'input'): Promise<{ name: string }> {
    const { readFile } = await import('node:fs/promises');
    const { basename } = await import('node:path');
    const bytes = await readFile(absPath);
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(bytes)]), basename(absPath));
    form.append('type', type);
    form.append('overwrite', 'true');
    const res = await this.request('/upload/image', { method: 'POST', body: form });
    if (!res.ok) await throwComfyHttpError(res, 'upload failed');
    const json = (await res.json()) as { name?: string };
    if (!json.name) throw new Error('upload response missing name');
    return { name: json.name };
  }

  async queuePrompt(workflow: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const res = await this.request('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
      signal,
    });
    if (!res.ok) await throwComfyHttpError(res, '/prompt failed');
    const json = (await res.json()) as { prompt_id?: string };
    if (!json.prompt_id) throw new Error('/prompt response missing prompt_id');
    return json.prompt_id;
  }

  /**
   * Fetch the history entry for a prompt. Comfy Cloud exposes completion via
   * /history_v2 (classic /history is unreliable for some output types, e.g.
   * SaveAudio); local ComfyUI uses classic /history.
   */
  private async fetchHistoryEntry(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<HistoryEntry | null> {
    const path = this.useCloudPaths ? `/history_v2/${promptId}` : `/history/${promptId}`;
    const res = await this.request(path, { signal });
    if (!res.ok) return null;
    const hist = (await res.json()) as Record<string, HistoryEntry>;
    return hist[promptId] ?? null;
  }

  /** Comfy Cloud only: GET /job/<id>/status → { status }. null on miss. */
  private async getCloudJobStatus(
    promptId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const res = await this.request(`/job/${promptId}/status`, { signal });
    if (!res.ok) return null;
    const body = (await res.json()) as { status?: string };
    return body.status ?? null;
  }

  /**
   * After cloud reports completion, resolve output files. history_v2 can lag
   * the status endpoint significantly — observed 30–120s+ in the dhee-website
   * proxy logs when Comfy Cloud is under load — so re-fetch for a generous
   * window before giving up (mirrors dhee-core ComfyUIClient.resolveOutputImages).
   */
  private async resolveCloudOutputs(
    promptId: string,
    entry: HistoryEntry | null,
    opts: RunOpts,
  ): Promise<ComfyOutput[]> {
    let current = entry;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (opts.signal?.aborted) throw new Error('aborted');
      if (current) {
        const outs = collectOutputs(current);
        if (outs.length > 0) return outs;
      }
      await delay(1500, opts.signal);
      current = await this.fetchHistoryEntry(promptId, opts.signal);
    }
    return [];
  }

  async waitForOutputs(promptId: string, opts: RunOpts = {}): Promise<ComfyOutput[]> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const pollMs = opts.pollMs ?? 1500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('aborted');

      if (this.useCloudPaths) {
        // Mirror dhee-core ComfyUIClient's cloud precedence: outputs first,
        // then /job/<id>/status, then the history_v2 status flag (covers
        // nodes like SaveAudio that may not populate outputs immediately).
        const entry = await this.fetchHistoryEntry(promptId, opts.signal);
        if (entry) {
          if (entry.status?.status_str === 'error') {
            throw new Error(`workflow errored: ${describeError(entry)}`);
          }
          const outs = collectOutputs(entry);
          if (outs.length > 0) return outs;
        }
        const status = await this.getCloudJobStatus(promptId, opts.signal);
        if (status === 'failed' || status === 'cancelled' || status === 'error') {
          throw new Error(`workflow ${status} for prompt ${promptId}`);
        }
        const historyDone =
          status === 'completed' ||
          status === 'done' ||
          status === 'success' ||
          entry?.status?.completed === true ||
          entry?.status?.status_str === 'success';
        if (historyDone) {
          // Cloud can report completion a beat before the output files surface
          // in history_v2 — retry for up to ~90s. If still empty, keep polling
          // the main loop until the overall deadline (outputs can lag minutes).
          const outs = await this.resolveCloudOutputs(promptId, entry, opts);
          if (outs.length > 0) return outs;
        }
      } else {
        const entry = await this.fetchHistoryEntry(promptId, opts.signal);
        if (entry) {
          if (entry.status?.status_str === 'error') {
            throw new Error(`workflow errored: ${describeError(entry)}`);
          }
          const outs = collectOutputs(entry);
          if (outs.length > 0) return outs;
          if (entry.status?.completed) return outs;
        }
      }

      await delay(pollMs, opts.signal);
    }
    throw new Error(`timed out after ${timeoutMs}ms waiting for prompt ${promptId}`);
  }

  async download(out: ComfyOutput, destAbs: string): Promise<void> {
    const { writeFile } = await import('node:fs/promises');
    const params = new URLSearchParams({
      filename: out.filename,
      subfolder: out.subfolder ?? '',
      type: out.type || 'output',
    });
    const res = await this.request('/view', { method: 'GET' }, params);
    if (!res.ok) await throwComfyHttpError(res, '/view failed');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error('downloaded file was empty');
    await writeFile(destAbs, buf);
  }

  async run(workflow: Record<string, unknown>, opts: RunOpts = {}): Promise<ComfyOutput[]> {
    const promptId = await this.queuePrompt(workflow, opts.signal);
    return this.waitForOutputs(promptId, opts);
  }
}

function normalizeComfyBaseUrl(value: string): string {
  return value.replace(/\/$/, '').replace(/\/api$/, '');
}

function isCloudComfyClient(baseUrl: string, apiKey?: string): boolean {
  const mode = (process.env['COMFY_MODE'] ?? 'local').trim();
  return (
    mode === 'cloud' ||
    isComfyCloudUrl(baseUrl) ||
    useBearerComfyAuth(baseUrl, apiKey)
  );
}

async function throwComfyHttpError(res: Response, label: string): Promise<never> {
  const body = await res.text().catch(() => '');
  let hint = '';
  if (res.status === 401) {
    hint =
      ' — Dhee Cloud authentication failed. Sign out and sign back in under Settings → Account.';
    try {
      const parsed = JSON.parse(body) as { error?: unknown };
      if (parsed.error === 'Unauthorized') {
        hint =
          ' — Dhee Cloud session expired or invalid. Sign in again under Settings → Account.';
      }
    } catch {
      // ignore non-JSON body
    }
  }
  const detail = body.trim() ? ` ${body.trim().slice(0, 240)}` : '';
  throw new Error(`${label}: ${res.status} ${res.statusText}${hint}${detail}`);
}

function collectOutputs(entry: HistoryEntry): ComfyOutput[] {
  const outs: ComfyOutput[] = [];
  const seen = new Set<string>();

  const collectFrom = (container: unknown) => {
    if (!container || typeof container !== 'object') return;
    const record = container as Record<string, unknown>;
    for (const key of OUTPUT_KEYS) {
      const value = record[key];
      const list = Array.isArray(value) ? value : value ? [value] : [];
      for (const item of list as Array<Record<string, unknown>>) {
        const filename = item['filename'];
        if (typeof filename === 'string' && !seen.has(filename)) {
          seen.add(filename);
          outs.push({
            filename,
            subfolder: typeof item['subfolder'] === 'string' ? item['subfolder'] : '',
            type: typeof item['type'] === 'string' ? item['type'] : 'output',
          });
        }
      }
    }
  };

  // Primary: per-node outputs in history.outputs.
  for (const nodeOut of Object.values(entry.outputs ?? {})) {
    collectFrom(nodeOut);
  }

  // Fallback: Comfy Cloud nodes (SaveAudio/SaveVideo) often DON'T populate
  // history.outputs — saved-file info surfaces only in status.messages
  // 'executed' entries (data.output). Scan any message carrying an `output`
  // object. Mirrors dhee-core ComfyUIClient.getOutputImages' messages fallback.
  if (outs.length === 0) {
    const messages = entry.status?.messages;
    if (Array.isArray(messages)) {
      for (const msg of messages) {
        if (!Array.isArray(msg) || msg.length < 2) continue;
        const data = msg[1] as Record<string, unknown> | undefined;
        collectFrom(data?.['output']);
      }
    }
  }

  return outs;
}

function describeError(entry: HistoryEntry): string {
  const messages = entry.status?.messages ?? [];
  const kinds = messages.map((m) => m[0]).join(', ');
  return kinds || 'unknown error';
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        rej(new Error('aborted'));
      },
      { once: true },
    );
  });
}

function defaultClientId(baseUrl: string): string {
  return `dhee-${Math.abs(hashString(baseUrl + Date.now().toString()))}`;
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
