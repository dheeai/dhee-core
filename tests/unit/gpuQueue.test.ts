import { describe, it, expect, vi } from 'vitest';
import { GpuQueueClient, parseQueuePayload } from '../../src/dag/gpuQueue.js';

const workflow = { name: 'example', description: 'Example', version: 'v1', available: true, status: 'unchecked', inputs: {}, est_seconds: 30 };
const envelope = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
function harness(value: unknown) {
  const call = vi.fn().mockResolvedValue(envelope(value));
  const close = vi.fn();
  const client = new GpuQueueClient('http://localhost:9000/mcp', async () => ({ call, close }));
  return { client, call, close };
}
describe('GPU queue client', () => {
  it('preserves unchecked availability without claiming render verification', async () => {
    const { client, call, close } = harness({ workflows: [workflow] });
    expect(await client.listWorkflows()).toEqual([workflow]);
    expect(call).toHaveBeenCalledWith('list_workflows', {}, undefined);
    expect(close).toHaveBeenCalledOnce();
  });
  it('rejects malformed catalogs and still closes the connection', async () => {
    const { client, close } = harness({ workflows: [{ name: 'bad', available: 'yes' }] });
    await expect(client.listWorkflows()).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
  it('surfaces tool errors even when text contains valid JSON', () => {
    expect(() => parseQueuePayload({ ...envelope({ error: 'GPU unavailable' }), isError: true })).toThrow('GPU unavailable');
  });
  it('accepts structured content', () => {
    expect(parseQueuePayload({ structuredContent: { workflows: [] } })).toEqual({ workflows: [] });
  });
  it('rejects unknown job states', async () => {
    const { client } = harness({ job_id: 'j1', state: 'maybe' });
    await expect(client.getJob('j1')).rejects.toThrow();
  });
  it('does not retry ambiguous submission failures', async () => {
    const { client, call, close } = harness({});
    call.mockRejectedValue(new Error('connection lost'));
    await expect(client.submit('example', { refs: ['up_a', 'up_b'] })).rejects.toThrow('connection lost');
    expect(call).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
  });
  it('preserves ordered references and returns the accepted job id', async () => {
    const { client, call } = harness({ job_id: 'j1', position: 2, eta_s: 30 });
    expect(await client.submit('example', { refs: ['up_b', 'up_a'] })).toEqual({ job_id: 'j1', position: 2, eta_s: 30 });
    expect(call).toHaveBeenCalledWith('run_workflow', { name: 'example', inputs: { refs: ['up_b', 'up_a'] }, wait: false }, undefined);
  });
  it('rejects URLs with embedded credentials or unsupported protocols', () => {
    expect(() => new GpuQueueClient('file:///tmp/mcp')).toThrow();
    expect(() => new GpuQueueClient('http://user:secret@localhost/mcp')).toThrow();
  });
  it('does not connect if already aborted', async () => {
    const connect = vi.fn();
    const client = new GpuQueueClient('http://localhost/mcp', connect);
    const controller = new AbortController(); controller.abort();
    await expect(client.listWorkflows(controller.signal)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});

it.each(['cancel', 'timeout'])('bounds a stalled initialized notification: %s', async (mode) => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  const realTimeout = AbortSignal.timeout;
  const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => realTimeout(20));
  let notificationStarted = false;
  globalThis.fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (body.method === 'initialize') return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'test', version: '1' } } }), { headers: { 'Content-Type': 'application/json' } });
    notificationStarted = true;
    if (mode === 'cancel') queueMicrotask(() => controller.abort(new Error('stop handshake')));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;
  try {
    await expect(new GpuQueueClient('http://localhost/mcp').listWorkflows(controller.signal)).rejects.toThrow(mode === 'cancel' ? 'stop handshake' : /timeout/i);
    expect(notificationStarted).toBe(true);
  } finally { globalThis.fetch = originalFetch; timeoutSpy.mockRestore(); }
}, 200);
