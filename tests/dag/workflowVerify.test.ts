/**
 * Tests for the workflow checker — a dumb data tool. The agent does
 * the matching/judgment; we only verify the parser + the diff + the
 * shape returned.
 *
 * Failure modes:
 *  - workflow with no loader nodes → empty refs
 *  - loader nodes of various classes → extract every *_name string
 *    that looks like a model filename
 *  - non-string fields (wire arrays) → ignored
 *  - all refs available on Comfy → ok: true, missing_refs is empty
 *  - some refs missing → listed in missing_refs verbatim
 *  - endpointAliases pre-applied — refs whose aliased target IS on
 *    Comfy are NOT reported missing
 *  - fetchObjectInfo throws → ok: false, error populated, but
 *    workflow_refs still returned (the parse is independent of HTTP)
 *  - available_by_class exposes every class the user's Comfy has so
 *    the agent can see cross-class candidates (e.g. UnetLoaderGGUF)
 *    without us declaring equivalences anywhere
 */
import { describe, it, expect, vi } from 'vitest';
import {
  extractModelRefs,
  checkWorkflow,
  type ComfyWorkflow,
  type ObjectInfo,
} from '../../src/dag/workflowVerify.js';

function wf(nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }>): ComfyWorkflow {
  return nodes as unknown as ComfyWorkflow;
}

function objectInfo(byClass: Record<string, Record<string, string[]>>): ObjectInfo {
  const obj: Record<string, unknown> = {};
  for (const [cls, fields] of Object.entries(byClass)) {
    const required: Record<string, unknown> = {};
    for (const [field, names] of Object.entries(fields)) {
      required[field] = [names, {}];
    }
    obj[cls] = { input: { required } };
  }
  return obj as ObjectInfo;
}

describe('extractModelRefs', () => {
  it('returns empty when no loader nodes are present', () => {
    expect(
      extractModelRefs(wf({
        sampler: { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } },
      })),
    ).toEqual([]);
  });

  it('extracts unet_name from UNETLoader', () => {
    const refs = extractModelRefs(wf({
      UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.safetensors', weight_dtype: 'default' } },
    }));
    expect(refs).toEqual([
      { nodeType: 'UNETLoader', nodeId: 'UNET', inputField: 'unet_name', current_value: 'qwen.safetensors' },
    ]);
  });

  it('extracts chained loras + multi-kind loaders', () => {
    const refs = extractModelRefs(wf({
      A: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'a.safetensors' } },
      B: { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'b.safetensors' } },
      V: { class_type: 'VAELoader', inputs: { vae_name: 'v.safetensors' } },
      C: { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'c.safetensors' } },
    }));
    expect(refs.map((r) => r.inputField).sort()).toEqual(['ckpt_name', 'lora_name', 'lora_name', 'vae_name']);
  });

  it('ignores non-string *_name fields (upstream wire arrays)', () => {
    expect(
      extractModelRefs(wf({
        K: { class_type: 'KSampler', inputs: { model: ['UNET', 0], prompt_name: ['node', 0] as unknown } },
      })),
    ).toEqual([]);
  });

  it('ignores *_name strings that do not have a model file extension', () => {
    expect(
      extractModelRefs(wf({
        N: { class_type: 'SomeNode', inputs: { display_name: 'My Cool Setting' } },
      })),
    ).toEqual([]);
  });
});

describe('checkWorkflow', () => {
  const fetch = (info: ObjectInfo) => vi.fn(async () => info);

  it('returns ok: true when every referenced model is on Comfy', async () => {
    const r = await checkWorkflow({
      workflow: wf({ UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.safetensors' } } }),
      endpoint: 'http://comfy/',
      fetchObjectInfo: fetch(objectInfo({ UNETLoader: { unet_name: ['qwen.safetensors'] } })),
    });
    expect(r.ok).toBe(true);
    expect(r.missing_refs).toEqual([]);
    expect(r.workflow_refs).toHaveLength(1);
  });

  it('lists missing refs verbatim when the model is absent', async () => {
    const r = await checkWorkflow({
      workflow: wf({ UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'bundle_canonical.safetensors' } } }),
      endpoint: 'http://comfy/',
      fetchObjectInfo: fetch(objectInfo({ UNETLoader: { unet_name: ['something_else.safetensors'] } })),
    });
    expect(r.ok).toBe(false);
    expect(r.missing_refs).toHaveLength(1);
    expect(r.missing_refs[0]!.current_value).toBe('bundle_canonical.safetensors');
  });

  it('exposes available_by_class so the agent sees every class (including GGUF / NF4 variants)', async () => {
    const r = await checkWorkflow({
      workflow: wf({ UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.safetensors' } } }),
      endpoint: 'http://comfy/',
      fetchObjectInfo: fetch(objectInfo({
        UNETLoader: { unet_name: ['other.safetensors'] },
        UnetLoaderGGUF: { unet_name: ['qwen-Q4_K_M.gguf'] },
      })),
    });
    expect(r.available_by_class['UNETLoader.unet_name']).toEqual(['other.safetensors']);
    expect(r.available_by_class['UnetLoaderGGUF.unet_name']).toEqual(['qwen-Q4_K_M.gguf']);
  });

  it('applies endpointAliases before diffing — aliased name that is on Comfy is NOT reported missing', async () => {
    const r = await checkWorkflow({
      workflow: wf({ UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'bundle.safetensors' } } }),
      endpoint: 'http://comfy/',
      endpointAliases: { 'bundle.safetensors': 'local.safetensors' },
      fetchObjectInfo: fetch(objectInfo({ UNETLoader: { unet_name: ['local.safetensors'] } })),
    });
    expect(r.ok).toBe(true);
    expect(r.missing_refs).toEqual([]);
  });

  it('returns workflow_refs even when /object_info fails (the parse is independent of HTTP)', async () => {
    const r = await checkWorkflow({
      workflow: wf({ UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.safetensors' } } }),
      endpoint: 'http://comfy/',
      fetchObjectInfo: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/ECONNREFUSED/);
    expect(r.workflow_refs).toHaveLength(1);
    expect(r.available_by_class).toEqual({});
  });
});
