import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';

const workflowSchema = z.object({
  name: z.string().min(1), description: z.string(), version: z.string().optional(),
  available: z.boolean(), status: z.string().default('unchecked'),
  reason: z.string().nullable().optional(), est_seconds: z.number().nonnegative().optional(),
  inputs: z.record(z.record(z.unknown())),
});
export type GpuWorkflow = z.infer<typeof workflowSchema>;
const acceptedSchema = z.object({
  job_id: z.string().min(1), position: z.number().nullable().optional(), eta_s: z.number().nullable().optional(),
});
const jobSchema = acceptedSchema.extend({
  state: z.enum(['queued', 'dispatching', 'running', 'done', 'failed', 'cancelled', 'expired']),
  error: z.string().nullable().optional(),
  outputs: z.array(z.object({ url: z.string().url() }).passthrough()).optional(),
}).passthrough();
export type GpuJob = z.infer<typeof jobSchema>;
export interface QueueConnection {
  call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  close(): Promise<void> | void;
}
export type QueueConnect = (endpoint: URL, signal?: AbortSignal) => Promise<QueueConnection>;
const REQUEST_TIMEOUT = 15_000;

/** Decode MCP tool payloads; transport success does not imply tool success. */
export function parseQueuePayload(raw: unknown): unknown {
  const result = z.object({
    isError: z.boolean().optional(), structuredContent: z.unknown().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional(),
  }).parse(raw);
  const text = result.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
  if (result.isError) throw new Error(text || 'GPU queue rejected the request.');
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!text) throw new Error('GPU queue returned no data.');
  return JSON.parse(text);
}

const connectMcp: QueueConnect = async (endpoint, signal) => {
  const client = new Client({ name: 'dhee-core', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(endpoint, {
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    requestInit: { redirect: 'error' },
    // The SDK's request deadline does not cover notifications/initialized.
    // Bound every HTTP exchange, including that final handshake notification.
    fetch: (url, init) => fetch(url, {
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(REQUEST_TIMEOUT),
        ...(signal ? [signal] : []),
        ...(init?.signal ? [init.signal] : []),
      ]),
    }),
  });
  try {
    await client.connect(transport, { signal, timeout: REQUEST_TIMEOUT });
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
  return {
    call: (name, args, callSignal) => client.callTool({ name, arguments: args }, undefined, { signal: callSignal, timeout: REQUEST_TIMEOUT }),
    close: () => client.close(),
  };
};

/** Shared queue transport. No direct ComfyUI calls and no automatic submission retries. */
export class GpuQueueClient {
  readonly endpoint: URL;
  constructor(endpoint: string, private readonly connect: QueueConnect = connectMcp) {
    this.endpoint = new URL(endpoint);
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.hash)
      throw new Error('Use an HTTP(S) GPU MCP endpoint without embedded credentials or fragments.');
  }
  private async invoke(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const connection = await this.connect(this.endpoint, signal);
    try { return parseQueuePayload(await connection.call(name, args, signal)); }
    finally { await Promise.resolve(connection.close()).catch(() => {}); }
  }
  async listWorkflows(signal?: AbortSignal): Promise<GpuWorkflow[]> {
    return z.object({ workflows: z.array(workflowSchema) }).parse(await this.invoke('list_workflows', {}, signal)).workflows;
  }
  async submit(name: string, inputs: Record<string, unknown>, signal?: AbortSignal) {
    return acceptedSchema.parse(await this.invoke('run_workflow', { name, inputs, wait: false }, signal));
  }
  async cancel(jobId: string, signal?: AbortSignal): Promise<unknown> {
    return this.invoke('cancel_job', { job_id: jobId }, signal);
  }
  async getJob(jobId: string, signal?: AbortSignal): Promise<GpuJob> {
    return jobSchema.parse(await this.invoke('get_job', { job_id: jobId }, signal));
  }
}
