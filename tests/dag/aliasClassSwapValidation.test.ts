/**
 * class_swap hardening — validate that a persisted class_swap doesn't
 * rewrite a node to a class whose REQUIRED inputs the node can't satisfy
 * (the stale-alias failure mode: LoraLoaderModelOnly → "Load Lora", which
 * needs `clip`, producing a cryptic ComfyUI 400 deep in validation).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateClassSwaps,
  applyEndpointAliases,
  writeAliases,
} from '../../src/dag/workflowAliases.js';

// ComfyUI /object_info-shaped fixture: the two Lora loader classes.
const OBJECT_INFO = {
  LoraLoaderModelOnly: { input: { required: { model: ['MODEL'], lora_name: ['x'], strength_model: ['FLOAT'] } } },
  'Load Lora': {
    input: {
      required: { model: ['MODEL'], clip: ['CLIP'], lora_name: ['x'], strength_model: ['FLOAT'], strength_clip: ['FLOAT'] },
    },
  },
};

// A model-only Lora node (no clip wired) — exactly the LTX node 80 shape.
const modelOnlyNode = () => ({
  '80': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'ltx.safetensors', strength_model: 1.0, model: ['77', 0] } },
});

describe('validateClassSwaps', () => {
  it('flags a swap to a class whose required inputs the node lacks', () => {
    // Node 80 already reclassed to "Load Lora" (post-applyAliases state).
    const wf = { '80': { class_type: 'Load Lora', inputs: modelOnlyNode()['80'].inputs } };
    const problems = validateClassSwaps(wf as never, [{ nodeId: '80', from: 'LoraLoaderModelOnly', to: 'Load Lora' }], OBJECT_INFO);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ nodeId: '80', to: 'Load Lora', issue: 'missing-required-inputs' });
    expect(problems[0]!.missing!.sort()).toEqual(['clip', 'strength_clip']);
  });

  it('passes a swap whose new class is fully satisfied', () => {
    const wf = modelOnlyNode();
    const problems = validateClassSwaps(wf as never, [{ nodeId: '80', from: 'X', to: 'LoraLoaderModelOnly' }], OBJECT_INFO);
    expect(problems).toEqual([]);
  });

  it('flags a swap to a class not installed on the endpoint', () => {
    const wf = { '80': { class_type: 'Ghost', inputs: {} } };
    const problems = validateClassSwaps(wf as never, [{ nodeId: '80', from: 'X', to: 'Ghost' }], OBJECT_INFO);
    expect(problems[0]).toMatchObject({ nodeId: '80', to: 'Ghost', issue: 'class-not-on-endpoint' });
  });
});

describe('applyEndpointAliases — logs + validates', () => {
  let aliasesDir: string;
  const ENDPOINT = 'http://100.93.149.119:8188';
  const WF_KEY = 'workflows/ltx_director_local.json';

  beforeEach(() => {
    aliasesDir = mkdtempSync(join(tmpdir(), 'alias-validate-'));
  });
  afterEach(() => rmSync(aliasesDir, { recursive: true, force: true }));

  it('fails (with an actionable error) on the bad LoraLoaderModelOnly → "Load Lora" swap, logging the swap', async () => {
    writeAliases(aliasesDir, ENDPOINT, { class_swaps: { [WF_KEY]: { '80': 'Load Lora' } } });
    const logs: string[] = [];
    const res = await applyEndpointAliases({
      workflow: modelOnlyNode() as never,
      workflowKey: WF_KEY,
      aliasesDir,
      endpointUrl: ENDPOINT,
      log: (m) => logs.push(m),
      fetchObjectInfo: async () => OBJECT_INFO,
    });
    expect(res.error).toBeDefined();
    expect(res.error).toMatch(/node 80/);
    expect(res.error).toMatch(/clip/);
    // Each applied swap is logged.
    expect(logs.some((l) => l.includes("class_swap: node 80 'LoraLoaderModelOnly' → 'Load Lora'"))).toBe(true);
  });

  it('applies + passes a valid swap with no error', async () => {
    // Swap node 80 to a class it satisfies → no error, workflow reclassed.
    writeAliases(aliasesDir, ENDPOINT, { class_swaps: { [WF_KEY]: { '80': 'LoraLoaderModelOnly' } } });
    const res = await applyEndpointAliases({
      workflow: { '80': { class_type: 'OldLora', inputs: modelOnlyNode()['80'].inputs } } as never,
      workflowKey: WF_KEY,
      aliasesDir,
      endpointUrl: ENDPOINT,
      fetchObjectInfo: async () => OBJECT_INFO,
    });
    expect(res.error).toBeUndefined();
    expect((res.workflow as never as Record<string, { class_type: string }>)['80']!.class_type).toBe('LoraLoaderModelOnly');
  });

  it('is best-effort when /object_info is unreachable (no error, swap still applied)', async () => {
    writeAliases(aliasesDir, ENDPOINT, { class_swaps: { [WF_KEY]: { '80': 'Load Lora' } } });
    const res = await applyEndpointAliases({
      workflow: modelOnlyNode() as never,
      workflowKey: WF_KEY,
      aliasesDir,
      endpointUrl: ENDPOINT,
      fetchObjectInfo: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    expect(res.error).toBeUndefined(); // can't validate → don't block
  });
});
