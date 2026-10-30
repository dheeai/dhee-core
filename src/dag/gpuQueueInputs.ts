import { randomInt } from 'node:crypto';
import type { GpuWorkflow } from './gpuQueue.js';
import { GpuQueueClient } from './gpuQueue.js';

/** Validate the public gateway schema; never pass undeclared workflow controls. */
export function validateQueueInputs(
  workflow: GpuWorkflow,
  supplied: Record<string, unknown>,
  seed = randomInt(0, 2 ** 32)
): Record<string, unknown> {
  if (!workflow.available)
    throw new Error(
      `Workflow ${workflow.name} is unavailable: ${workflow.reason ?? 'gateway preflight failed'}`
    );
  for (const key of Object.keys(supplied))
    if (!(key in workflow.inputs)) throw new Error(`Unknown workflow input: ${key}`);
  const result: Record<string, unknown> = {};
  for (const [name, schema] of Object.entries(workflow.inputs)) {
    const value = supplied[name] ?? (schema.random_default === true ? seed : schema.default);
    if (value === undefined) {
      if (schema.required === true) throw new Error(`Missing workflow input: ${name}`);
      continue;
    }
    const fail = (reason: string): never => {
      throw new Error(`Invalid ${name}: ${reason}`);
    };
    switch (schema.type) {
      case 'string':
        if (typeof value !== 'string') fail('expected text');
        break;
      case 'int':
        if (typeof value !== 'number' || !Number.isSafeInteger(value)) fail('expected an integer');
        break;
      case 'float':
      case 'number':
        if (typeof value !== 'number' || !Number.isFinite(value)) fail('expected a finite number');
        break;
      case 'bool':
        if (typeof value !== 'boolean') fail('expected true or false');
        break;
      case 'enum':
        if (!Array.isArray(schema.options) || !schema.options.includes(value))
          fail('choose a catalog option');
        break;
      case 'file':
        if (typeof value !== 'string' || !value.trim())
          fail('expected a file path, upload handle or URL');
        break;
      case 'file_list':
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || !item.trim()))
          fail('expected an ordered file list');
        break;
      default:
        fail(`unsupported gateway schema type ${String(schema.type)}`);
    }
    if (typeof value === 'number') {
      if (typeof schema.min === 'number' && value < schema.min) fail(`minimum ${schema.min}`);
      if (typeof schema.max === 'number' && value > schema.max) fail(`maximum ${schema.max}`);
      if (
        typeof schema.multiple_of === 'number' &&
        (schema.multiple_of <= 0 ||
          Math.abs(value / schema.multiple_of - Math.round(value / schema.multiple_of)) > 1e-8)
      )
        fail(`must be a multiple of ${schema.multiple_of}`);
    }
    if (typeof value === 'string') {
      if (typeof schema.max_length === 'number' && value.length > schema.max_length)
        fail('text is too long');
      if (typeof schema.min_length === 'number' && value.length < schema.min_length)
        fail('text is too short');
    }
    if (Array.isArray(value)) {
      if (typeof schema.max_items === 'number' && value.length > schema.max_items)
        fail('too many files');
      if (typeof schema.min_items === 'number' && value.length < schema.min_items)
        fail('not enough files');
    }
    result[name] = value;
  }
  return result;
}

export async function uploadQueueFile(
  endpoint: string,
  bytes: Uint8Array,
  filename: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<string> {
  signal?.throwIfAborted();
  const url = new URL('/upload', new GpuQueueClient(endpoint).endpoint);
  const body = new FormData();
  body.append('file', new Blob([new Uint8Array(bytes)]), filename);
  const response = await fetcher(url, {
    method: 'POST',
    body,
    redirect: 'error',
    signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(signal ? [signal] : [])]),
  });
  if (!response.ok) throw new Error(`Reference upload failed: HTTP ${response.status}`);
  const data = (await response.json()) as { ref?: unknown };
  if (typeof data.ref !== 'string' || !/^up_[A-Za-z0-9_-]+$/.test(data.ref))
    throw new Error('Gateway returned an invalid upload handle.');
  return data.ref;
}
