/**
 * importWorkflow — BYO workflow validation + parameter-mapping
 * suggestions. Pure functions over workflow JSON.
 */
import { describe, it, expect } from 'vitest';
import {
  validateApiWorkflow,
  suggestParameterMappings,
} from '../../src/dag/importWorkflow.js';
import type { ComfyWorkflow } from '../../src/dag/workflowVerify.js';

describe('validateApiWorkflow', () => {
  it('accepts API-format (flat map of nodes with class_type)', () => {
    expect(
      validateApiWorkflow({
        '3': { class_type: 'KSampler', inputs: { seed: 1 } },
        '6': { class_type: 'CLIPTextEncode', inputs: { text: 'hi' } },
      }),
    ).toEqual({ ok: true });
  });

  it('rejects UI-format (nodes array + links) with reason ui_format', () => {
    expect(
      validateApiWorkflow({ last_node_id: 9, nodes: [{ id: 1, type: 'KSampler' }], links: [] }),
    ).toEqual({ ok: false, reason: 'ui_format' });
  });

  it('rejects non-objects and empties as invalid', () => {
    expect(validateApiWorkflow(null).ok).toBe(false);
    expect(validateApiWorkflow([]).ok).toBe(false);
    expect(validateApiWorkflow({}).ok).toBe(false);
    expect(validateApiWorkflow('{}' as unknown).ok).toBe(false);
  });
});

describe('suggestParameterMappings', () => {
  const wf: ComfyWorkflow = {
    '3': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 576 } },
    '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'out' } },
  };

  it('maps prompt/seed/width/height/filename_prefix to the right nodes', () => {
    const m = suggestParameterMappings(wf);
    expect(m).toEqual([
      { input: 'prompt', nodeId: '6', field: 'text' },
      { input: 'seed', nodeId: '3', field: 'seed' },
      { input: 'width', nodeId: '5', field: 'width' },
      { input: 'height', nodeId: '5', field: 'height' },
      { input: 'filename_prefix', nodeId: '9', field: 'filename_prefix' },
    ]);
  });

  it('uses noise_seed when seed is absent', () => {
    const m = suggestParameterMappings({
      '22': { class_type: 'RandomNoise', inputs: { noise_seed: 5 } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: 'x' } },
    });
    expect(m.find((x) => x.input === 'seed')).toEqual({ input: 'seed', nodeId: '22', field: 'noise_seed' });
  });

  it('omits inputs it cannot place', () => {
    const m = suggestParameterMappings({ '1': { class_type: 'KSampler', inputs: { seed: 0 } } });
    expect(m.map((x) => x.input)).toEqual(['seed']); // no prompt/dims/save node present
  });
});
