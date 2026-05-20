/**
 * ComfyUI Client Service - HTTP-based integration with ComfyUI.
 *
 * Handles workflow submission, progress monitoring via HTTP polling,
 * and downloading generated images from the ComfyUI API.
 */

// Load environment variables (e.g., COMFYUI_BASE_URL) from .env when available
import 'dotenv/config';

import * as fs from 'fs';
import * as path from 'path';
import { nanoid } from 'nanoid';
import WebSocket from 'ws';
import { decideWsAction, type ComfyWsMessage } from './wsAction.js';
import { getLogsDir } from '../../utils/logsPath.js';
import { registerActiveJob, unregisterActiveJob, type CancellableComfyJob } from './activeJobs.js';

// Debug logging to file instead of console to avoid polluting Ink UI.
//
// Path is resolved per-call via getLogsDir() so a host that calls
// setLogsDir after import (e.g. kshana-desktop in a packaged build,
// pointing at app.getPath('userData')/logs) still wins. The previous
// implementation anchored on findKshanaCoreRoot at module load — fine
// for dev, broken in an asar bundle where the kshana-core package.json
// lives in a read-only path.
function debugLog(message: string): void {
  try {
    const logPath = path.join(getLogsDir(), 'debug.log');
    const timestamp = new Date().toISOString();
    fs.appendFileSync(logPath, `[${timestamp}] ${message}\n`);
  } catch {
    // Ignore logging errors
  }
}

/**
 * Translate Node's undici `TypeError: fetch failed` into a logged
 * Error whose message names the URL, method, and the underlying cause
 * chain (DNS / TLS / ECONNRESET / etc.). The original `cause` property
 * is preserved for callers that want to inspect it.
 *
 * Also writes one debug.log line per failure so the silent-failure
 * pattern (workflow strategy logged, then nothing) becomes traceable.
 */
function enrichFetchError(err: unknown, url: string, method: string): Error {
  const cause = (err as { cause?: unknown })?.cause;
  const causeCode = (cause as unknown as { code?: unknown } | null)?.code;
  const causeMsg =
    cause instanceof Error
      ? `${cause.name}: ${cause.message}${typeof causeCode === 'string' ? ` [${causeCode}]` : ''}`
      : cause !== undefined
        ? String(cause)
        : '';
  const baseMsg = err instanceof Error ? err.message : String(err);
  const enriched = `${method} ${url} failed: ${baseMsg}${causeMsg ? ` (cause: ${causeMsg})` : ''}`;
  debugLog(`[ComfyUIClient][fetch-error] ${enriched}`);
  const wrapped = new Error(enriched);
  if (err instanceof Error && err.stack) wrapped.stack = err.stack;
  if (cause !== undefined) {
    (wrapped as { cause?: unknown }).cause = cause;
  }
  return wrapped;
}

export interface ComfyUIClientConfig {
  baseUrl: string;
  outputDir: string;
  timeout: number; // seconds
  apiKey?: string; // ComfyUI Cloud API key (X-API-Key header)
  isCloud?: boolean;
}

export interface QueueWorkflowOptions {
  workflowId?: string;
}

/**
 * Build ComfyUI config from environment variables.
 * Supports two modes: local (default) and cloud.
 *
 * COMFYUI_BASE_URL is the canonical endpoint for both modes.
 * Local: COMFY_MODE=local/default, COMFYUI_BASE_URL defaults to localhost:8188.
 * Cloud: COMFY_MODE=cloud, COMFYUI_BASE_URL points at the Kshana Cloud route
 * or direct Comfy Cloud, and COMFY_CLOUD_API_KEY supplies auth.
 *
 */
export function getComfyConfig(
  env: Record<string, string | undefined> = process.env as any
): Partial<ComfyUIClientConfig> {
  const mode = env['COMFY_MODE'] || 'local';
  if (mode === 'cloud') {
    return {
      baseUrl: env['COMFYUI_BASE_URL'] || 'https://cloud.comfy.org/api',
      apiKey: env['COMFY_CLOUD_API_KEY'],
      timeout: parseInt(env['COMFYUI_TIMEOUT'] || '300', 10),
      isCloud: true,
    };
  }
  return {
    baseUrl: env['COMFYUI_BASE_URL'] || 'http://localhost:8188',
    timeout: parseInt(env['COMFYUI_TIMEOUT'] || '300', 10),
  };
}

export interface ImageInfo {
  filename: string;
  subfolder: string;
  type: string;
  node_id?: string;
}

export interface DownloadedOutput {
  buffer: Buffer;
  filename: string;
  subfolder: string;
  type: string;
}

export interface ProgressCallback {
  (percentage: number, message: string): void | Promise<void>;
}

export interface WSProgressInfo {
  percentage: number;
  message: string;
  step?: number;
  maxSteps?: number;
  currentNode?: string;
}

export interface CompletionResult {
  status: 'completed' | 'completed_with_timeout' | 'error' | 'cancelled';
  prompt_id: string;
  /**
   * Cloud's exception_message (or other error detail) when status is
   * 'error'. Without this, the upstream "ComfyUI job did not complete
   * (status: error)" hides the actual cause — missing model, foreign
   * lora_name, malformed input, etc.
   */
  errorMessage?: string;
}

const COMFY_CLOUD_HOST = 'cloud.comfy.org';

export function isComfyCloudUrl(value: string): boolean {
  try {
    return new URL(value).hostname.toLowerCase() === COMFY_CLOUD_HOST;
  } catch {
    return false;
  }
}

/**
 * Build the default config FRESH for each client instance.
 *
 * Why this isn't a top-level constant: the embedded desktop path loads
 * kshana-core via `require()` BEFORE setting `process.env['COMFY_MODE']`
 * etc. (the desktop sets those in `kshanaCoreManager.start()`, which
 * runs after the module graph is loaded). If we cached `getComfyConfig()`
 * at module load, every embedded ComfyUIClient would silently fall
 * back to `http://localhost:8188` and try to talk to a non-existent
 * local server — the `Failed to poll history: fetch failed` symptom.
 *
 * Reading env at construction guarantees the client honors whatever
 * the host has set up by the time it actually instantiates one.
 */
function buildDefaultConfig(): ComfyUIClientConfig {
  const envConfig = getComfyConfig();
  return {
    baseUrl: envConfig.baseUrl || 'http://localhost:8188',
    outputDir: './outputs',
    timeout: envConfig.timeout || 300,
    apiKey: envConfig.apiKey,
    isCloud: envConfig.isCloud,
  };
}

/**
 * Async HTTP client for ComfyUI API.
 */
export class ComfyUIClient {
  private baseUrl: string;
  private outputDir: string;
  private timeout: number;
  private apiKey?: string;
  private isCloud: boolean;
  private cloudApiKey?: string;
  private useBearerCloudAuth: boolean;
  private cloudOutputs = new Map<string, Record<string, unknown>>();

  constructor(config: Partial<ComfyUIClientConfig> = {}) {
    const merged = { ...buildDefaultConfig(), ...config };
    const hasExplicitBaseUrl = config.baseUrl !== undefined;
    // Normalize baseUrl: strip trailing slash AND a trailing `/api` segment
    // so `getPath` (which prepends `/api` in cloud mode) doesn't produce
    // a double `/api/api/...` path. Users routinely set
    // `COMFYUI_BASE_URL=https://cloud.comfy.org/api` thinking that's the
    // canonical base — and the `/upload/image` endpoint then 401s.
    this.baseUrl = merged.baseUrl.replace(/\/$/, '').replace(/\/api$/, '');
    this.outputDir = merged.outputDir;
    this.timeout = merged.timeout;
    this.apiKey = merged.apiKey;
    this.isCloud =
      config.isCloud ??
      ((!hasExplicitBaseUrl && Boolean(merged.isCloud)) || isComfyCloudUrl(this.baseUrl));
    this.cloudApiKey = merged.apiKey;
    this.useBearerCloudAuth = !!this.apiKey && !isComfyCloudUrl(this.baseUrl);

    if (this.isCloud && !this.cloudApiKey) {
      throw new Error(
        'COMFY_CLOUD_API_KEY is required when COMFY_MODE=cloud or the Comfy URL points to https://cloud.comfy.org'
      );
    }
  }

  private getPath(pathname: string): string {
    const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
    return (this.isCloud || !!this.apiKey) ? `/api${normalized}` : normalized;
  }

  private buildUrl(pathname: string, searchParams?: URLSearchParams): string {
    const url = new URL(`${this.baseUrl}${this.getPath(pathname)}`);
    if (searchParams) {
      url.search = searchParams.toString();
    }
    return url.toString();
  }

  /**
   * Build HTTP headers with API key auth if configured (cloud mode).
   * Returns Record<string, string> shape (callers spread it into fetch's
   * headers init). Driven by `this.apiKey` from config — does NOT read
   * env directly so tests can set up clean instances.
   */
  private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (this.apiKey) {
      if (this.useBearerCloudAuth) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      } else {
        headers['X-API-Key'] = this.apiKey;
      }
    }
    return headers;
  }

  /**
   * Cloud-aware request wrapper that prepends baseUrl, applies search
   * params, and attaches auth headers.
   *
   * Wraps fetch with a diagnostic catch: Node's undici throws a bare
   * `TypeError: fetch failed` for any TCP/TLS-layer error, with the real
   * reason buried on the unenumerable `cause` property. Re-throws an
   * Error whose message names the URL, method, and cause chain so the
   * executor's surfaced error and the debug log both pin the call site.
   */
  private async request(
    pathname: string,
    init: RequestInit = {},
    searchParams?: URLSearchParams
  ): Promise<Response> {
    const url = this.buildUrl(pathname, searchParams);
    const method = (init.method as string | undefined) ?? 'GET';
    try {
      return await fetch(url, {
        ...init,
        headers: { ...this.buildHeaders(), ...(init.headers as Record<string, string> | undefined) },
      });
    } catch (err) {
      throw enrichFetchError(err, url, method);
    }
  }

  /**
   * Build WebSocket URL with token param if configured (cloud mode).
   */
  private buildWsUrl(clientId: string): string {
    // Strip /api suffix for WebSocket (cloud WS is at /ws, not /api/ws)
    const wsBase = this.baseUrl.replace(/\/api\/?$/, '').replace(/^http/, 'ws');
    let url = `${wsBase}/ws?clientId=${clientId}`;
    if (this.isCloud && this.apiKey && !this.useBearerCloudAuth) {
      url += `&token=${this.apiKey}`;
    }
    return url;
  }

  private buildWsOptions(): WebSocket.ClientOptions | undefined {
    if (!this.apiKey || !this.useBearerCloudAuth) return undefined;
    return {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    };
  }

  /**
   * Interrupt the currently running ComfyUI generation.
   * Calls POST /interrupt to stop the active prompt immediately.
   */
  async interrupt(): Promise<void> {
    try {
      await fetch(this.buildUrl('/interrupt'), { method: 'POST', headers: this.buildHeaders() });
    } catch {
      // Best effort — ComfyUI may not be reachable
    }
  }

  /**
   * Upload an image to ComfyUI input directory.
   */
  async uploadImage(
    filePath: string,
    imageType: string = 'input',
    overwrite: boolean = true
  ): Promise<{ name: string; subfolder: string; type: string }> {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Image file not found: ${filePath}`);
    }

    const formData = new FormData();
    const fileBuffer = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);

    formData.append('image', new Blob([fileBuffer]), fileName);
    formData.append('type', imageType);
    formData.append('overwrite', overwrite.toString());

    const response = await this.request('/upload/image', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Failed to upload image: ${response.statusText}`);
    }

    return response.json() as Promise<{ name: string; subfolder: string; type: string }>;
  }

  /**
   * Queue a workflow for execution via HTTP POST to /prompt.
   */
  async queueWorkflow(workflowJson: Record<string, unknown>, clientId?: string): Promise<string>;
  async queueWorkflow(
    workflowJson: Record<string, unknown>,
    clientId: string | undefined,
    returnMeta: true,
    options?: QueueWorkflowOptions
  ): Promise<{ promptId: string; clientId: string }>;
  async queueWorkflow(
    workflowJson: Record<string, unknown>,
    clientId?: string,
    returnMeta?: boolean,
    options: QueueWorkflowOptions = {}
  ): Promise<string | { promptId: string; clientId: string }> {
    clientId = clientId || nanoid();

    // Convert LiteGraph format to API format if needed
    let promptPayload = workflowJson;
    if ('nodes' in workflowJson && 'links' in workflowJson) {
      promptPayload = this.workflowToPrompt(workflowJson as unknown as WorkflowFormat);
    }

    const payload: Record<string, unknown> = {
      prompt: promptPayload,
      client_id: clientId,
    };

    // ComfyUI Cloud vendor nodes (GrokImageEditNode, etc.) check the
    // service key from `extra_data.api_key_comfy_org` for billing. Without
    // it, vendor-backed jobs submit cleanly but never execute — silent
    // timeout, no execution_error. Non-vendor nodes (Klein, LTX) ignore
    // the field, so it's safe to always include it on cloud runs.
    if (this.apiKey) {
      const extraDataPayload: Record<string, unknown> = { api_key_comfy_org: this.apiKey };
      if (options.workflowId) {
        // Back-compat: older/newer Kshana Cloud routes have accepted either field.
        extraDataPayload['kshana_workflow_id'] = options.workflowId;
        extraDataPayload['workflowId'] = options.workflowId;
      }
      payload['extra_data'] = extraDataPayload;
    }

    const promptUrl = this.buildUrl('/prompt');
    let response: Response;
    try {
      response = await fetch(promptUrl, {
        method: 'POST',
        headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
    } catch (err) {
      throw enrichFetchError(err, promptUrl, 'POST');
    }

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ComfyUI returned ${response.status}: ${errorText}`);
    }

    const result = (await response.json()) as { prompt_id?: string };
    const promptId = result.prompt_id;

    if (!promptId) {
      throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(result)}`);
    }

    if (returnMeta) {
      return { promptId, clientId };
    }
    return promptId;
  }

  /**
   * Wait for workflow completion using HTTP polling.
   */
  async waitForCompletion(
    promptId: string,
    progressCallback?: ProgressCallback,
    pollInterval: number = 10
  ): Promise<CompletionResult> {
    // Register the in-flight prompt so the cancel path can call
    // POST /interrupt on this client and stop the GPU job. Always
    // unregister in finally so completion / error / interrupt all
    // clean up.
    //
    // The AbortController on the handle is what makes cancel ACTUALLY
    // fast: `cancelAllActiveJobs` aborts it BEFORE awaiting the
    // (best-effort, sometimes-slow) `/interrupt` HTTP call, and the
    // poll loop below treats the abort signal as a first-class loop
    // exit — bailing out of mid-sleep and returning a `cancelled`
    // status the caller treats as failure. Without this, the 10-second
    // poll interval is the floor on "how long does Stopping… stay
    // stuck"; with it, abort-to-loop-exit is sub-millisecond.
    const abortController = new AbortController();
    const cancelHandle: CancellableComfyJob = {
      promptId,
      interrupt: () => this.interrupt(),
      abortController,
    };
    registerActiveJob(cancelHandle);
    try {
      return await this.waitForCompletionInner(
        promptId,
        progressCallback,
        pollInterval,
        abortController.signal,
      );
    } finally {
      unregisterActiveJob(cancelHandle);
    }
  }

  /**
   * Sleep for `ms` milliseconds OR until `signal` fires `abort`,
   * whichever comes first. Resolves silently in both cases — callers
   * inspect `signal.aborted` themselves on the next loop top.
   *
   * Without this, the poll loop's plain `setTimeout(... 10_000)`
   * blocks the cancel path for up to a full poll interval. With it,
   * abort wakes the sleep within milliseconds.
   */
  private sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async waitForCompletionInner(
    promptId: string,
    progressCallback?: ProgressCallback,
    _pollInterval: number = 10,
    abortSignal?: AbortSignal,
  ): Promise<CompletionResult> {
    const startTime = Date.now();

    // Emit initial progress
    if (progressCallback) {
      await this.callProgressCallback(
        progressCallback,
        20,
        'Generating image (polling for status)...'
      );
    }

    while (true) {
      // Cancel-aware loop top. Check BEFORE any HTTP call: if cancel
      // fired during the previous sleep, we want to exit without
      // talking to ComfyUI again — the GPU release happens via the
      // separate `interrupt()` call dispatched from
      // `cancelAllActiveJobs`. We just have to stop waiting.
      if (abortSignal?.aborted) {
        debugLog(`[waitForCompletion] Abort received for ${promptId} — exiting poll loop`);
        return { status: 'cancelled', prompt_id: promptId };
      }
      const elapsed = (Date.now() - startTime) / 1000;

      // Emit progress update during polling
      if (progressCallback) {
        const estimatedPct = Math.min(Math.floor((elapsed / 60) * 80), 80);
        await this.callProgressCallback(
          progressCallback,
          estimatedPct,
          `Generating... (${Math.floor(elapsed)}s elapsed)`
        );
      }

      // Log progress periodically (every ~60s)
      if (Math.floor(elapsed) % 60 === 0 && Math.floor(elapsed) > 0) {
        debugLog(
          `[waitForCompletion] Still waiting for ${promptId}... (${Math.floor(elapsed)}s elapsed)`
        );
      }

      try {
        if (this.isCloud) {
          if (await this.cloudHasOutputs(promptId)) {
            debugLog(`[waitForCompletion] Completed via cloud history outputs for ${promptId}`);
            if (progressCallback) {
              await this.callProgressCallback(progressCallback, 100, 'Complete!');
            }
            return { status: 'completed', prompt_id: promptId };
          }

          const status = await this.getCloudJobStatus(promptId);
          debugLog(`[waitForCompletion] Cloud status for ${promptId}: ${status ?? 'unknown'}`);
          if (status === 'completed' || status === 'done' || status === 'success') {
            if (progressCallback) {
              await this.callProgressCallback(progressCallback, 100, 'Complete!');
            }
            return { status: 'completed', prompt_id: promptId };
          }
          if (status === 'failed' || status === 'cancelled' || status === 'error') {
            return { status: 'error', prompt_id: promptId };
          }

          // Fallback: check history_v2 status flags (covers VHS_VideoCombine and other
          // nodes that don't populate history.outputs)
          const cloudHistory = await this.getHistory(promptId);
          if (cloudHistory?.status?.completed || cloudHistory?.status?.status_str === 'success') {
            debugLog(
              `[waitForCompletion] Cloud completed via history_v2 status flag. completed=${cloudHistory.status?.completed}, status_str=${cloudHistory.status?.status_str}`
            );
            if (progressCallback) {
              await this.callProgressCallback(progressCallback, 100, 'Complete!');
            }
            // Cache any outputs found so getOutputImages can use them
            if (cloudHistory.outputs) {
              this.cloudOutputs.set(promptId, cloudHistory.outputs as Record<string, unknown>);
            }
            return { status: 'completed', prompt_id: promptId };
          }
        } else {
          const history = await this.getHistory(promptId);

          if (history) {
            const outputs = history.outputs || {};

            if (Object.keys(outputs).length > 0) {
              debugLog(
                `[waitForCompletion] Completed via outputs. Node IDs: ${Object.keys(outputs).join(', ')}`
              );
              if (progressCallback) {
                await this.callProgressCallback(progressCallback, 100, 'Complete!');
              }
              return { status: 'completed', prompt_id: promptId };
            }

            // Check status.completed or status_str === 'success'
            if (history.status?.completed || history.status?.status_str === 'success') {
              debugLog(
                `[waitForCompletion] Completed via status flag (no outputs in history). completed=${history.status?.completed}, status_str=${history.status?.status_str}, messages=${JSON.stringify(history.status?.messages?.map(m => m[0]))}`
              );
              if (progressCallback) {
                await this.callProgressCallback(progressCallback, 100, 'Complete!');
              }
              return { status: 'completed', prompt_id: promptId };
            }
          }
        }
      } catch (e) {
        console.warn(`Failed to poll history: ${e}`);
      }

      // Abortable sleep: if cancel fires during this 10s window, we
      // wake immediately instead of waiting out the full interval.
      // Falls back to a plain sleep when no abort signal is provided
      // (legacy callers / tests).
      if (abortSignal) {
        await this.sleepAbortable(_pollInterval * 1000, abortSignal);
      } else {
        await this.sleep(_pollInterval * 1000);
      }
    }
  }

  /**
   * Queue a workflow AND wait for completion via WebSocket.
   * Connects WS first, then submits prompt inside onOpen — prevents missing
   * fast cloud execution events that fire before WS connects.
   */
  async queueAndWaitWS(
    workflowJson: Record<string, unknown>,
    progressCallback?: (info: WSProgressInfo) => void,
    options: QueueWorkflowOptions = {}
  ): Promise<{
    result: CompletionResult;
    promptId: string;
    clientId: string;
    outputs: ImageInfo[];
  }> {
    const clientId = nanoid();
    const wsUrl = this.buildWsUrl(clientId);
    debugLog(`[queueAndWaitWS] Connecting WS first: ${wsUrl}`);

    return new Promise((resolve, reject) => {
      let promptId = '';
      let resolved = false;
      let lastActivityTime = Date.now();
      const collectedOutputs: ImageInfo[] = [];
      let submitPromise: Promise<{ promptId: string; clientId: string }> | null = null;
      // Inactivity timeout — seconds from env COMFYUI_WS_TIMEOUT (default 60).
      // Direct Comfy Cloud supports WS, but the Kshana Cloud route currently
      // relies on HTTP polling. Keep WS as the fast path and fall back quickly
      // when the socket is silent or unavailable.
      const INACTIVITY_TIMEOUT_MS =
        Math.max(30, parseInt(process.env['COMFYUI_WS_TIMEOUT'] || '60', 10)) * 1000;
      let ws: WebSocket;

      const inactivityCheck = setInterval(() => {
        if (resolved) return;
        const inactiveSec = Math.round((Date.now() - lastActivityTime) / 1000);
        if (inactiveSec > INACTIVITY_TIMEOUT_MS / 1000) {
          clearInterval(inactivityCheck);
          if (!resolved) {
            resolved = true;
            try { ws?.close(); } catch { /* */ }
            // Both local AND cloud fall back to HTTP polling. The
            // common cold-start case on cloud (GPU allocating, no
            // WS messages for several minutes) used to hard-fail
            // here; polling lets it land when the cold-start
            // finishes.
            const fallbackMsg = this.isCloud
              ? `Cloud WS silent for ${inactiveSec}s — falling back to HTTP polling (likely a GPU cold-start)`
              : `WS silent for ${inactiveSec}s — falling back to HTTP polling`;
            debugLog(`[queueAndWaitWS] ${fallbackMsg}`);
            try { progressCallback?.({ percentage: 0, message: fallbackMsg }); } catch { /* */ }
            fallbackToHttpPolling();
          }
        }
      }, 10_000);

      const cleanup = () => {
        clearInterval(inactivityCheck);
        try {
          ws?.close();
        } catch {
          /* */
        }
      };
      const finish = (result: CompletionResult) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve({ result, promptId, clientId, outputs: collectedOutputs });
      };
      const fallbackToHttpPolling = () => {
        const promptReady =
          submitPromise ??
          this.queueWorkflow(workflowJson, clientId, true, options).then(meta => {
            promptId = meta.promptId;
            return meta;
          });

        promptReady
          .then(meta => {
            promptId = meta.promptId;
            return this.waitForCompletion(
              promptId,
              progressCallback
                ? (pct, msg) => progressCallback({ percentage: pct, message: msg })
                : undefined
            );
          })
          .then(result => resolve({ result, promptId, clientId, outputs: collectedOutputs }))
          .catch(reject);
      };

      try {
        ws = new WebSocket(wsUrl, this.buildWsOptions());
      } catch (err) {
        debugLog(`[queueAndWaitWS] WS failed: ${err}`);
        // Fall back: submit then poll
        this.queueWorkflow(workflowJson, clientId, true, options)
          .then(meta => {
            promptId = meta.promptId;
            return this.waitForCompletion(
              promptId,
              progressCallback
                ? (pct, msg) => progressCallback({ percentage: pct, message: msg })
                : undefined
            );
          })
          .then(result => resolve({ result, promptId, clientId, outputs: collectedOutputs }))
          .catch(reject);
        return;
      }

      ws.on('open', async () => {
        debugLog(`[queueAndWaitWS] WS connected — now submitting prompt`);
        try {
          submitPromise = this.queueWorkflow(workflowJson, clientId, true, options);
          const meta = await submitPromise;
          promptId = meta.promptId;
          debugLog(`[queueAndWaitWS] Prompt submitted: ${promptId}`);
        } catch (err) {
          cleanup();
          reject(err);
        }
      });

      ws.on('close', () => {
        if (!resolved) {
          resolved = true;
          // WS drops on cloud happen mid-allocation (idle proxy,
          // transient network); polling the /history endpoint
          // reliably catches the eventual completion or surfaces a
          // real error.
          const fallbackMsg = this.isCloud
            ? 'Cloud WS closed unexpectedly — falling back to HTTP polling'
            : 'WS closed — falling back to HTTP polling';
          debugLog(`[queueAndWaitWS] ${fallbackMsg}`);
          try { progressCallback?.({ percentage: 0, message: fallbackMsg }); } catch { /* */ }
          fallbackToHttpPolling();
        }
      });

      ws.on('error', err => {
        debugLog(`[queueAndWaitWS] WS error: ${err}`);
        if (!resolved) {
          resolved = true;
          cleanup();
          fallbackToHttpPolling();
        }
      });

      ws.on('message', (raw: Buffer | string) => {
        // Skip binary messages (preview images)
        if (Buffer.isBuffer(raw) && raw.length > 0 && raw[0] !== 0x7b) {
          lastActivityTime = Date.now();
          return;
        }
        let msg: ComfyWsMessage;
        try {
          msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
        } catch {
          return; /* non-JSON */
        }
        lastActivityTime = Date.now();
        debugLog(`[queueAndWaitWS] WS msg: ${msg.type} prompt=${msg.data?.prompt_id || 'n/a'}`);
        const action = decideWsAction(msg, promptId);
        switch (action.kind) {
          case 'progress':
            progressCallback?.({
              percentage: action.percentage,
              message: action.message,
              ...(action.step !== undefined ? { step: action.step } : {}),
              ...(action.maxSteps !== undefined ? { maxSteps: action.maxSteps } : {}),
            });
            return;
          case 'executing':
            progressCallback?.({
              percentage: 0,
              message: `Node: ${action.node}`,
              currentNode: String(action.node),
            });
            return;
          case 'queued':
            progressCallback?.({ percentage: 0, message: `Queued (${action.remaining} ahead)` });
            return;
          case 'capture_output':
            for (const item of action.items) {
              collectedOutputs.push({
                filename: item.filename,
                subfolder: item.subfolder,
                type: item.type,
                ...(item.node_id !== undefined ? { node_id: String(item.node_id) } : {}),
              });
              debugLog(
                `[queueAndWaitWS] Captured output: ${item.filename} from node ${item.node_id}`
              );
            }
            return;
          case 'finish_completed':
            finish({ status: 'completed', prompt_id: promptId });
            return;
          case 'finish_error': {
            const payloadStr = JSON.stringify(action.payload);
            debugLog(`[queueAndWaitWS] Execution error: ${payloadStr}`);
            // Pull out the most actionable bits the cloud sends back.
            // exception_message is the python-side error string ("Value
            // not in list: lora_name: ..."); exception_type narrows it
            // ("ServiceError"); node_id pins which workflow node blew up.
            const p = action.payload ?? {};
            const parts: string[] = [];
            if (typeof p['exception_type'] === 'string') parts.push(p['exception_type'] as string);
            if (typeof p['exception_message'] === 'string')
              parts.push(p['exception_message'] as string);
            const nodeId = p['node_id'] ?? p['node'];
            if (nodeId !== undefined && nodeId !== null) parts.push(`node=${String(nodeId)}`);
            const errorMessage = parts.length ? parts.join(' — ') : payloadStr;
            finish({ status: 'error', prompt_id: promptId, errorMessage });
            return;
          }
          case 'ignore_foreign_output':
            debugLog(
              `[queueAndWaitWS] Ignoring output from foreign prompt ${action.eventPromptId} (ours=${promptId})`
            );
            return;
          case 'ignore_foreign_success':
            debugLog(
              `[queueAndWaitWS] Ignoring execution_success from foreign prompt ${action.eventPromptId} (ours=${promptId})`
            );
            return;
          case 'ignore_foreign_error':
            debugLog(
              `[queueAndWaitWS] Ignoring execution_error from foreign prompt ${action.eventPromptId} (ours=${promptId})`
            );
            return;
          case 'ignore':
            return;
        }
      });
    });
  }

  /**
   * Wait for workflow completion using ComfyUI's WebSocket API.
   * Provides real-time step-by-step progress. Falls back to HTTP polling on WS failure.
   */
  async waitForCompletionWS(
    promptId: string,
    clientId: string,
    progressCallback?: (info: WSProgressInfo) => void
  ): Promise<CompletionResult> {
    // Same active-jobs registration as the HTTP wait path so cancel
    // reaches WS-tracked prompts too. The AbortController is the
    // signal `cancelAllActiveJobs` fires to wake the WS inner loop
    // out of any sleep/wait state immediately.
    const abortController = new AbortController();
    const cancelHandle: CancellableComfyJob = {
      promptId,
      interrupt: () => this.interrupt(),
      abortController,
    };
    registerActiveJob(cancelHandle);
    try {
      return await this.waitForCompletionWSInner(
        promptId,
        clientId,
        progressCallback,
        abortController.signal,
      );
    } finally {
      unregisterActiveJob(cancelHandle);
    }
  }

  private async waitForCompletionWSInner(
    promptId: string,
    clientId: string,
    progressCallback?: (info: WSProgressInfo) => void,
    abortSignal?: AbortSignal,
  ): Promise<CompletionResult> {
    const wsUrl = this.buildWsUrl(clientId);
    debugLog(`[waitForCompletionWS] Connecting to ${wsUrl} for prompt=${promptId}`);

    return new Promise<CompletionResult>((resolve, reject) => {
      let resolved = false;
      let currentNode: string | undefined;
      let ws: WebSocket;
      let lastActivityTime = Date.now();

      // WS inactivity timeout before falling back to HTTP polling.
      // When going through a Kshana proxy the WS isn't forwarded, so the
      // socket goes silent immediately — use a short 30s timeout so we
      // kick to HTTP polling quickly.
      const WS_INACTIVITY_TIMEOUT_MS =
        Math.max(30, parseInt(process.env['COMFYUI_WS_TIMEOUT'] || '60', 10)) * 1000;
      const inactivityCheck = setInterval(() => {
        if (resolved) return;
        const inactiveSec = Math.round((Date.now() - lastActivityTime) / 1000);
        if (inactiveSec > WS_INACTIVITY_TIMEOUT_MS / 1000) {
          clearInterval(inactivityCheck);
          if (!resolved) {
            resolved = true;
            try {
              ws?.close();
            } catch {
              /* ignore */
            }
            debugLog(
              `[waitForCompletionWS] No progress for ${inactiveSec}s — falling back to HTTP polling`
            );
            this.waitForCompletion(
              promptId,
              progressCallback
                ? (pct, msg) => progressCallback({ percentage: pct, message: msg })
                : undefined
            )
              .then(resolve)
              .catch(reject);
          }
        }
      }, 10_000);

      const onAbort = () => {
        debugLog(`[waitForCompletionWS] Abort received for ${promptId} — bailing out of WS wait`);
        finish({ status: 'cancelled', prompt_id: promptId });
      };

      const cleanup = () => {
        clearInterval(inactivityCheck);
        if (abortSignal) {
          abortSignal.removeEventListener('abort', onAbort);
        }
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
      };

      const finish = (result: CompletionResult) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(result);
      };

      // Listen for cancel-from-registry. Wired BEFORE the WS opens so
      // an abort that fires during the connect handshake still wakes
      // us. Removed in cleanup so we don't leak a listener on the
      // signal after the promise resolves normally.
      if (abortSignal) {
        if (abortSignal.aborted) {
          // Already cancelled before we even started — short-circuit.
          queueMicrotask(() => {
            if (!resolved) finish({ status: 'cancelled', prompt_id: promptId });
          });
        } else {
          abortSignal.addEventListener('abort', onAbort, { once: true });
        }
      }

      try {
        ws = new WebSocket(wsUrl, this.buildWsOptions());
      } catch (err) {
        debugLog(
          `[waitForCompletionWS] Failed to create WebSocket: ${err}. Falling back to HTTP polling.`
        );
        this.waitForCompletion(
          promptId,
          progressCallback
            ? (pct, msg) => progressCallback({ percentage: pct, message: msg })
            : undefined
        )
          .then(resolve)
          .catch(reject);
        return;
      }

      ws.on('open', () => {
        debugLog(`[waitForCompletionWS] WebSocket connected for prompt=${promptId}`);
      });

      ws.on('error', err => {
        debugLog(`[waitForCompletionWS] WebSocket error: ${err}. Falling back to HTTP polling.`);
        if (!resolved) {
          resolved = true;
          cleanup();
          this.waitForCompletion(
            promptId,
            progressCallback
              ? (pct, msg) => progressCallback({ percentage: pct, message: msg })
              : undefined
          )
            .then(resolve)
            .catch(reject);
        }
      });

      ws.on('close', () => {
        debugLog(`[waitForCompletionWS] WebSocket closed for prompt=${promptId}`);
        if (!resolved) {
          resolved = true;
          debugLog(`[waitForCompletionWS] WS closed unexpectedly — falling back to HTTP polling`);
          this.waitForCompletion(
            promptId,
            progressCallback
              ? (pct, msg) => progressCallback({ percentage: pct, message: msg })
              : undefined
          )
            .then(resolve)
            .catch(reject);
        }
      });

      ws.on('message', (raw: Buffer | string) => {
        try {
          const payload = typeof raw === 'string' ? raw : raw.toString();
          const trimmed = payload.replace(/^\u0000+/, '');
          const jsonStart = trimmed.indexOf('{');
          if (jsonStart === -1) {
            debugLog('[waitForCompletionWS] Skipping non-JSON WebSocket message');
            return;
          }

          const data = JSON.parse(trimmed.slice(jsonStart));
          lastActivityTime = Date.now(); // Reset inactivity timer on valid message
          const msgType: string = data.type;

          if (msgType === 'status' && data.data) {
            // Queue/server status updates
            const statusData = data.data as {
              status?: { exec_info?: { queue_remaining?: number } };
            };
            const queueRemaining = statusData.status?.exec_info?.queue_remaining;
            if (queueRemaining !== undefined && queueRemaining > 0) {
              debugLog(`[waitForCompletionWS] status: queue_remaining=${queueRemaining}`);
              progressCallback?.({
                percentage: 0,
                message: `Queued (${queueRemaining} job${queueRemaining > 1 ? 's' : ''} ahead)`,
              });
            }
          } else if (msgType === 'execution_start' && data.data) {
            const execPromptId = (data.data as { prompt_id?: string }).prompt_id;
            if (execPromptId && execPromptId !== promptId) return;
            debugLog(`[waitForCompletionWS] execution_start for prompt=${promptId}`);
            progressCallback?.({
              percentage: 0,
              message: 'Execution started',
            });
          } else if (msgType === 'progress' && data.data) {
            const { value, max } = data.data as { value: number; max: number };
            const pct = max > 0 ? Math.round((value / max) * 100) : 0;
            debugLog(`[waitForCompletionWS] progress: step ${value}/${max} (${pct}%)`);
            progressCallback?.({
              percentage: pct,
              message: `Step ${value}/${max} (${pct}%)`,
              step: value,
              maxSteps: max,
              currentNode,
            });
          } else if (msgType === 'executing' && data.data) {
            const nodeId = data.data.node as string | null;
            const execPromptId = data.data.prompt_id as string | undefined;

            // Only track messages for our prompt
            if (execPromptId && execPromptId !== promptId) return;

            if (nodeId) {
              currentNode = nodeId;
              debugLog(`[waitForCompletionWS] executing node=${nodeId}`);
              // Relay node execution to UI so user sees activity
              progressCallback?.({
                percentage: 0,
                message: `Processing node ${nodeId}`,
                currentNode: nodeId,
              });
            } else {
              // node is null → execution finished for this prompt
              debugLog(`[waitForCompletionWS] Execution finished for prompt=${promptId}`);
              progressCallback?.({
                percentage: 100,
                message: 'Complete!',
                currentNode: undefined,
                done: true,
              } as WSProgressInfo & { done: boolean });
              finish({ status: 'completed', prompt_id: promptId });
            }
          } else if (msgType === 'executed' && data.data) {
            const execPromptId = data.data.prompt_id as string | undefined;
            if (execPromptId && execPromptId !== promptId) return;
            const nodeId = data.data.node as string | undefined;
            const output = data.data.output as Record<string, unknown> | undefined;
            if (nodeId && output) {
              const currentOutputs = this.cloudOutputs.get(promptId) || {};
              currentOutputs[nodeId] = output;
              this.cloudOutputs.set(promptId, currentOutputs);
              debugLog(
                `[waitForCompletionWS] cached executed output for node=${nodeId} prompt=${promptId}`
              );
            }
            debugLog(
              `[waitForCompletionWS] executed node=${nodeId ?? 'unknown'} prompt=${promptId}`
            );
          } else if (msgType === 'execution_success' && data.data) {
            const execPromptId = data.data.prompt_id as string | undefined;
            if (execPromptId && execPromptId !== promptId) return;
            debugLog(`[waitForCompletionWS] execution_success for prompt=${promptId}`);
            progressCallback?.({
              percentage: 100,
              message: 'Complete!',
              currentNode: undefined,
            });
            finish({ status: 'completed', prompt_id: promptId });
          } else if (msgType === 'execution_error' && data.data) {
            const execPromptId = data.data.prompt_id as string | undefined;
            if (execPromptId && execPromptId !== promptId) return;
            debugLog(`[waitForCompletionWS] Execution error: ${JSON.stringify(data.data)}`);
            finish({ status: 'error', prompt_id: promptId });
          }
        } catch (e) {
          debugLog(`[waitForCompletionWS] Failed to parse WS message: ${e}`);
        }
      });
    });
  }

  /**
   * Get output images from completed workflow.
   */
  async getOutputImages(promptId: string): Promise<ImageInfo[]> {
    const cachedOutputs = this.cloudOutputs.get(promptId);
    if (cachedOutputs) {
      const cachedImages = this.collectOutputFiles(cachedOutputs);
      if (cachedImages.length > 0) {
        debugLog(
          `[getOutputImages] Using ${cachedImages.length} cached cloud output(s) for ${promptId}`
        );
        return cachedImages;
      }
    }

    const history = await this.getHistory(promptId);
    if (!history) {
      console.warn(`No history found for prompt_id=${promptId}`);
      return [];
    }

    const outputs = history.outputs || {};
    const images = this.collectOutputFiles(outputs);

    debugLog(
      `[getOutputImages] prompt=${promptId} outputNodeIds=${JSON.stringify(Object.keys(outputs))}`
    );

    // Fallback: if no outputs found via standard keys, check status messages.
    // SaveVideo nodes don't populate history.outputs but ComfyUI includes
    // saved file info in status.messages under "execution_cached" or via
    // the prompt's executed node output metadata.
    if (images.length === 0 && history.status?.messages) {
      for (const [msgType, msgData] of history.status.messages) {
        if (msgType === 'executed' && msgData) {
          const output = msgData['output'] as Record<string, unknown> | undefined;
          if (output) {
            // Check for videos/images/gifs in the executed node output
            for (const key of ['videos', 'images', 'gifs']) {
              const items = output[key] as
                | Array<{ filename: string; subfolder?: string; type?: string }>
                | undefined;
              if (items) {
                for (const item of items) {
                  images.push({
                    filename: item.filename,
                    subfolder: item.subfolder || '',
                    type: item.type || 'output',
                    node_id: String(msgData['node'] || ''),
                  });
                }
              }
            }
          }
        }
      }
      if (images.length > 0) {
        debugLog(`[getOutputImages] Found ${images.length} output(s) via status messages fallback`);
      }
    }

    debugLog(
      `[getOutputImages] Total outputs found: ${images.length}${images.length > 0 ? ` files: ${images.map(i => i.filename).join(', ')}` : ''}`
    );
    return images;
  }

  /**
   * Download an image from ComfyUI to local storage.
   */
  async downloadOutput(
    filename: string,
    subfolder: string = '',
    outputType: string = 'output'
  ): Promise<DownloadedOutput> {
    const params = new URLSearchParams({
      filename,
      type: outputType,
    });
    if (subfolder) {
      params.append('subfolder', subfolder);
    }

    const url = this.buildUrl('/view', params);

    // Comfy Cloud /view returns a 302 redirect to a signed storage URL.
    // Fetch the redirect manually and follow the signed URL WITHOUT auth
    // headers (extra headers cause S3 signature validation to fail).
    const viewResponse = await fetch(url, {
      headers: this.buildHeaders(),
      redirect: 'manual',
    });

    let buffer: Buffer;
    if (viewResponse.status === 302 || viewResponse.status === 301) {
      const signedUrl = viewResponse.headers.get('location');
      if (!signedUrl) {
        throw new Error('Failed to download image: redirect with no Location header');
      }
      const fileResponse = await fetch(signedUrl);
      if (!fileResponse.ok) {
        throw new Error(`Failed to download image from storage: ${fileResponse.status} ${fileResponse.statusText}`);
      }
      buffer = Buffer.from(await fileResponse.arrayBuffer());
    } else if (viewResponse.ok) {
      // Local ComfyUI (or proxy that already resolved the redirect) returns bytes directly
      buffer = Buffer.from(await viewResponse.arrayBuffer());
    } else {
      throw new Error(`Failed to download image: ${viewResponse.status} ${viewResponse.statusText}`);
    }

    return {
      buffer,
      filename,
      subfolder,
      type: outputType,
    };
  }

  /**
   * Download an image from ComfyUI to local storage.
   */
  async downloadImage(
    filename: string,
    subfolder: string = '',
    outputType: string = 'output',
    outputFilename?: string
  ): Promise<string> {
    const downloaded = await this.downloadOutput(filename, subfolder, outputType);
    const finalFilename = outputFilename || filename;
    const outputPath = path.join(this.outputDir, finalFilename);
    const outputDir = path.dirname(outputPath);

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    fs.writeFileSync(outputPath, downloaded.buffer);

    return outputPath;
  }

  /**
   * Complete workflow: Queue, wait for completion, and download first image.
   */
  async generateAndDownload(
    workflowJson: Record<string, unknown>,
    outputFilename?: string,
    progressCallback?: ProgressCallback,
    pollInterval: number = 10,
    options: QueueWorkflowOptions = {}
  ): Promise<string> {
    const clientId = nanoid();
    debugLog(`Starting generate_and_download | client_id=${clientId}`);

    // Step 1: Queue workflow
    const queueResult = await this.queueWorkflow(workflowJson, clientId, true, options);
    const promptId = queueResult.promptId;
    debugLog(`Workflow queued | prompt_id=${promptId}`);

    // Step 2: Wait for completion
    try {
      await this.waitForCompletionWS(
        promptId,
        queueResult.clientId,
        progressCallback
          ? async info => {
              await this.callProgressCallback(progressCallback, info.percentage, info.message);
            }
          : undefined
      );
    } catch (e) {
      if (e instanceof Error && e.message.includes('did not complete')) {
        console.warn(
          `Timeout waiting for completion, but checking for outputs anyway: ${e.message}`
        );
      } else {
        throw e;
      }
    }

    // Step 3: Get output images
    const images = await this.resolveOutputImages(promptId);
    if (!images.length) {
      throw new Error(`No output images found for prompt_id=${promptId}`);
    }

    // Step 4: Download first image
    const firstImage = images[0]!;
    const savedPath = await this.downloadImage(
      firstImage.filename,
      firstImage.subfolder,
      firstImage.type,
      outputFilename
    );

    debugLog(`generate_and_download complete | prompt_id=${promptId} | saved=${savedPath}`);
    return savedPath;
  }

  // Helper methods

  private async getHistory(promptId: string): Promise<HistoryEntry | null> {
    const response = await this.request(
      this.isCloud ? `/history_v2/${promptId}` : `/history/${promptId}`
    );
    if (!response.ok) {
      return null;
    }
    const history = (await response.json()) as Record<string, HistoryEntry>;
    // Both local /history/{id} and cloud /history_v2/{id} wrap the entry under the prompt_id key
    return history[promptId] || null;
  }

  private async getCloudJobStatus(promptId: string): Promise<string | null> {
    const response = await this.request(`/job/${promptId}/status`);
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { status?: string };
    return body.status ?? null;
  }

  private async cloudHasOutputs(promptId: string): Promise<boolean> {
    if (this.cloudOutputs.has(promptId)) {
      const cachedOutputs = this.cloudOutputs.get(promptId);
      if (cachedOutputs && this.collectOutputFiles(cachedOutputs).length > 0) {
        return true;
      }
    }

    const history = await this.getHistory(promptId);
    if (!history) {
      return false;
    }

    const outputs = history.outputs || {};
    return Object.keys(outputs).length > 0;
  }

  private async resolveOutputImages(promptId: string): Promise<ImageInfo[]> {
    const attempts = this.isCloud ? 10 : 1;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      const images = await this.getOutputImages(promptId);
      if (images.length > 0) {
        return images;
      }

      if (attempt < attempts) {
        debugLog(
          `[resolveOutputImages] No outputs yet for ${promptId}; retry ${attempt}/${attempts - 1}`
        );
        await this.sleep(1000);
      }
    }

    return [];
  }

  private collectOutputFiles(outputs: Record<string, unknown>): ImageInfo[] {
    const images: ImageInfo[] = [];

    for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
      const output = nodeOutput as Record<string, unknown>;
      debugLog(
        `[getOutputImages] Node ${nodeId} output keys: ${JSON.stringify(Object.keys(output))}`
      );

      for (const key of ['images', 'image', 'gifs', 'videos', 'video', 'audio']) {
        const value = output[key];
        const items = Array.isArray(value) ? value : value ? [value] : [];
        for (const item of items) {
          const file = item as {
            filename?: string;
            subfolder?: string;
            type?: string;
          };
          if (!file.filename) continue;
          images.push({
            filename: file.filename,
            subfolder: file.subfolder || '',
            type: file.type || 'output',
            node_id: nodeId,
          });
        }
      }
    }

    return images;
  }

  private async callProgressCallback(
    callback: ProgressCallback,
    pct: number,
    msg: string
  ): Promise<void> {
    try {
      const result = callback(pct, msg);
      if (result instanceof Promise) {
        await result;
      }
    } catch (e) {
      console.warn(`Progress callback error: ${e}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Convert ComfyUI workflow (UI format) into the API prompt format.
   */
  private workflowToPrompt(workflow: WorkflowFormat): Record<string, unknown> {
    const prompt: Record<string, unknown> = {};
    const nodes = workflow.nodes || [];
    const links = workflow.links || [];

    // Map link id -> (source_node_id, source_output_index)
    const linkLookup: Map<number, [number, number]> = new Map();
    for (const link of links) {
      if (Array.isArray(link) && link.length >= 6) {
        const [linkId, fromNode, fromSlot] = link;
        linkLookup.set(linkId, [fromNode, fromSlot]);
      }
    }

    for (const node of nodes) {
      const nodeId = String(node.id);
      if (nodeId === 'None') continue;

      const nodeType = node.type;
      const inputsSpec = node.inputs || [];
      const widgetValues = node.widgets_values || [];

      const convertedInputs: Record<string, unknown> = {};

      // Special handling for KSampler
      if (nodeType === 'KSampler' && widgetValues.length === 7) {
        convertedInputs['seed'] = widgetValues[0];
        convertedInputs['steps'] = widgetValues[2];
        convertedInputs['cfg'] = widgetValues[3];
        convertedInputs['sampler_name'] = widgetValues[4];
        convertedInputs['scheduler'] = widgetValues[5];
        convertedInputs['denoise'] = widgetValues[6];
      } else {
        let widgetIndex = 0;
        for (const inputSpec of inputsSpec) {
          const name = inputSpec.name;
          if (!name) continue;

          const linkId = inputSpec.link;
          if (linkId !== null && linkId !== undefined) {
            const source = linkLookup.get(linkId);
            if (source) {
              const [fromNode, fromSlot] = source;
              convertedInputs[name] = [String(fromNode), fromSlot];
            }
          } else {
            let value = undefined;
            if (widgetIndex < widgetValues.length) {
              value = widgetValues[widgetIndex];
              widgetIndex++;
            } else if ('default' in inputSpec) {
              value = inputSpec.default;
            } else if ('value' in inputSpec) {
              value = inputSpec.value;
            }
            convertedInputs[name] = value;
          }
        }
      }

      // Add linked inputs for KSampler
      if (nodeType === 'KSampler') {
        for (const inputSpec of inputsSpec) {
          const name = inputSpec.name;
          const linkId = inputSpec.link;
          if (linkId !== null && linkId !== undefined && name) {
            const source = linkLookup.get(linkId);
            if (source) {
              const [fromNode, fromSlot] = source;
              convertedInputs[name] = [String(fromNode), fromSlot];
            }
          }
        }
      }

      prompt[nodeId] = {
        class_type: nodeType,
        inputs: convertedInputs,
      };
    }

    return prompt;
  }
}

// Type definitions for ComfyUI workflow format

interface WorkflowNode {
  id: number;
  type: string;
  inputs?: Array<{
    name: string;
    link?: number | null;
    default?: unknown;
    value?: unknown;
  }>;
  widgets_values?: unknown[];
}

interface WorkflowFormat {
  nodes: WorkflowNode[];
  links: Array<[number, number, number, number, number, string]>;
}

interface HistoryEntry {
  outputs?: Record<string, unknown>;
  status?: {
    completed?: boolean;
    status_str?: string;
    messages?: Array<[string, Record<string, unknown>]>;
  };
}
