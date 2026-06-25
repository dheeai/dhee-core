/**
 * Shared ComfyUI HTTP client for external runners — polling-based, with
 * cloud auth from COMFY_CLOUD_API_KEY (desktop JWT on Dhee Cloud proxy).
 */

import {
  buildComfyAuthHeaders,
  readComfyApiKey,
  requireComfyApiKeyForCloud,
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

const OUTPUT_KEYS = ['images', 'gifs', 'videos', 'audio'] as const;

export class ComfyClient {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly apiKey?: string;

  constructor(baseUrlOrOpts: string | ComfyClientOptions, clientId?: string) {
    if (typeof baseUrlOrOpts === 'string') {
      this.baseUrl = baseUrlOrOpts.replace(/\/$/, '');
      this.clientId = clientId ?? defaultClientId(this.baseUrl);
      this.apiKey = readComfyApiKey();
    } else {
      this.baseUrl = baseUrlOrOpts.baseUrl.replace(/\/$/, '');
      this.clientId = baseUrlOrOpts.clientId ?? defaultClientId(this.baseUrl);
      this.apiKey = baseUrlOrOpts.apiKey ?? readComfyApiKey();
    }
    requireComfyApiKeyForCloud(this.baseUrl, this.apiKey);
  }

  private authHeaders(): Record<string, string> {
    return buildComfyAuthHeaders(this.baseUrl, this.apiKey);
  }

  private async request(
    pathname: string,
    init: RequestInit = {},
    searchParams?: URLSearchParams,
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}${pathname.startsWith('/') ? pathname : `/${pathname}`}`);
    if (searchParams) url.search = searchParams.toString();
    const extra = (init.headers ?? {}) as Record<string, string>;
    return fetch(url.toString(), {
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
    if (!res.ok) throw new Error(`upload failed: ${res.status} ${res.statusText}`);
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
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`/prompt failed: ${res.status} ${res.statusText} ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { prompt_id?: string };
    if (!json.prompt_id) throw new Error('/prompt response missing prompt_id');
    return json.prompt_id;
  }

  async waitForOutputs(promptId: string, opts: RunOpts = {}): Promise<ComfyOutput[]> {
    const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    const pollMs = opts.pollMs ?? 1500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) throw new Error('aborted');
      const res = await this.request(`/history/${promptId}`, { signal: opts.signal });
      if (res.ok) {
        const hist = (await res.json()) as Record<string, HistoryEntry>;
        const entry = hist[promptId];
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
    if (!res.ok) throw new Error(`/view failed: ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength === 0) throw new Error('downloaded file was empty');
    await writeFile(destAbs, buf);
  }

  async run(workflow: Record<string, unknown>, opts: RunOpts = {}): Promise<ComfyOutput[]> {
    const promptId = await this.queuePrompt(workflow, opts.signal);
    return this.waitForOutputs(promptId, opts);
  }
}

function collectOutputs(entry: HistoryEntry): ComfyOutput[] {
  const outs: ComfyOutput[] = [];
  const byNode = entry.outputs ?? {};
  for (const nodeOut of Object.values(byNode)) {
    for (const key of OUTPUT_KEYS) {
      const list = (nodeOut as Record<string, unknown>)[key];
      if (Array.isArray(list)) {
        for (const item of list as Array<Record<string, unknown>>) {
          const filename = item['filename'];
          if (typeof filename === 'string') {
            outs.push({
              filename,
              subfolder: typeof item['subfolder'] === 'string' ? item['subfolder'] : '',
              type: typeof item['type'] === 'string' ? item['type'] : 'output',
            });
          }
        }
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
