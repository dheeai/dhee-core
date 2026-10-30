import { describe, it, expect, vi } from 'vitest';
import { validateQueueInputs, uploadQueueFile } from '../../src/dag/gpuQueueInputs.js';
const workflow = {
  name: 'image',
  description: '',
  available: true,
  status: 'unchecked',
  version: 'v1',
  inputs: {
    prompt: { type: 'string', required: true },
    width: { type: 'int', min: 512, max: 2048, multiple_of: 16 },
    refs: { type: 'file_list', max_items: 2 },
    seed: { type: 'int', random_default: true, min: 0, max: 4294967295 },
  },
};
describe('queue inputs', () => {
  it('validates required fields, unknown inputs, ranges and list limits before upload', () => {
    expect(() => validateQueueInputs(workflow, { width: 1024 })).toThrow(/prompt/);
    expect(() => validateQueueInputs(workflow, { prompt: 'x', secret: 1 })).toThrow(/secret/);
    expect(() => validateQueueInputs(workflow, { prompt: 'x', width: 513 })).toThrow(/width/);
    expect(() =>
      validateQueueInputs(workflow, { prompt: 'x', refs: ['up_a', 'up_b', 'up_c'] })
    ).toThrow(/refs/);
    expect(() => validateQueueInputs(workflow, { prompt: 'x', seed: NaN })).toThrow(/seed/);
  });
  it('materializes random seeds and preserves ordered references', () => {
    const inputs = validateQueueInputs(workflow, { prompt: 'x', refs: ['up_b', 'up_a'] });
    expect(Number.isInteger(inputs.seed)).toBe(true);
    expect(inputs.refs).toEqual(['up_b', 'up_a']);
  });
  it('rejects unavailable workflows and unsupported schema types', () => {
    expect(() => validateQueueInputs({ ...workflow, available: false }, { prompt: 'x' })).toThrow(
      /unavailable/
    );
    expect(() =>
      validateQueueInputs({ ...workflow, inputs: { x: { type: 'mystery' } } }, { x: 1 })
    ).toThrow(/unsupported/i);
  });
  it('uploads exact file bytes to the gateway and validates the returned handle', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ref: 'up_abc' })));
    expect(
      await uploadQueueFile(
        'http://gpu/mcp',
        Buffer.from('reference'),
        'ref.png',
        undefined,
        fetcher as typeof fetch
      )
    ).toBe('up_abc');
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.href).toBe('http://gpu/upload');
    const file = (init.body as FormData).get('file') as File;
    expect(await file.text()).toBe('reference');
    expect(init.redirect).toBe('error');
  });
});
