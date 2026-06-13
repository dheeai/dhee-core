/**
 * comfyLtxDirector — opt-in lora-chain rebuild + the shipped-workflow
 * invariants that keep the audio/lora features backward-compatible:
 *   - rebuildLoraChain reconstructs base→lora…→director for any N loras,
 *     and an empty list points the director straight at the base model.
 *   - the shipped ltx_director_local.json has transition removed globally
 *     (OmniNFT now reads the UNET directly) and STILL wires CreateVideo.audio
 *     to the generated-audio path (node 16) on disk — the runner only swaps
 *     to combined_audio in-memory when custom audio is supplied, so a
 *     no-audio bundle renders exactly as before.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, it, expect } from 'vitest';

import { rebuildLoraChain } from '../../../src/dag/runners/comfyLtxDirector.js';

type Wf = Record<string, { inputs: Record<string, unknown>; class_type: string }>;

/** UNET(77) → transition(80) → OmniNFT(81) → LTXDirector(46).model */
function baseWorkflow(): Wf {
  return {
    '77': { class_type: 'UNETLoader', inputs: { unet_name: 'base.safetensors' } },
    '80': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'transition.safetensors', strength_model: 1.0, model: ['77', 0] } },
    '81': { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'omni.safetensors', strength_model: 0.8, model: ['80', 0] } },
    '46': { class_type: 'LTXDirector', inputs: { model: ['81', 0] } },
  };
}

function loraNodes(wf: Wf): Array<{ name: unknown; strength: unknown; model: unknown }> {
  return Object.values(wf)
    .filter((n) => n.class_type === 'LoraLoaderModelOnly')
    .map((n) => ({ name: n.inputs['lora_name'], strength: n.inputs['strength_model'], model: n.inputs['model'] }));
}

describe('rebuildLoraChain', () => {
  it('empty list → director points straight at the base model, no lora nodes', () => {
    const wf = baseWorkflow();
    rebuildLoraChain(wf, []);
    expect(loraNodes(wf)).toEqual([]);
    expect(wf['46']!.inputs['model']).toEqual(['77', 0]); // base UNET
  });

  it('rebuilds a fresh chain for N loras (base → l0 → l1 → director)', () => {
    const wf = baseWorkflow();
    rebuildLoraChain(wf, [
      { name: 'id-lora-celebvhq-3k.safetensors', strength: 0.8 },
      { name: 'LTX-2.3-22b-AV-LoRA-talking-head-v1.safetensors', strength: 0.7 },
      { name: 'LTX2.3-IC-LORA-Dual-Character.safetensors' }, // default strength 0.8
    ]);
    // old transition/omni nodes are gone
    const names = loraNodes(wf).map((l) => l.name);
    expect(names).toEqual([
      'id-lora-celebvhq-3k.safetensors',
      'LTX-2.3-22b-AV-LoRA-talking-head-v1.safetensors',
      'LTX2.3-IC-LORA-Dual-Character.safetensors',
    ]);
    expect(names).not.toContain('transition.safetensors');
    // chain: ltxlora_0.model ← base(77); ltxlora_1 ← ltxlora_0; director ← last
    expect(wf['ltxlora_0']!.inputs['model']).toEqual(['77', 0]);
    expect(wf['ltxlora_1']!.inputs['model']).toEqual(['ltxlora_0', 0]);
    expect(wf['ltxlora_2']!.inputs['model']).toEqual(['ltxlora_1', 0]);
    expect(wf['ltxlora_2']!.inputs['strength_model']).toBe(0.8); // default applied
    expect(wf['46']!.inputs['model']).toEqual(['ltxlora_2', 0]);
  });
});

describe('shipped ltx_director_local.json invariants', () => {
  const wf = JSON.parse(
    readFileSync(join(__dirname, '../../../src/dag/bundles/narrative_prompt_relay/workflows/ltx_director_local.json'), 'utf-8'),
  ) as Wf;

  it('transition lora removed globally; OmniNFT reads the UNET directly', () => {
    const loras = Object.values(wf).filter((n) => n.class_type === 'LoraLoaderModelOnly');
    const names = loras.map((n) => n.inputs['lora_name']);
    expect(names).not.toContain('ltx2.3-transition.safetensors');
    const omni = loras.find((n) => n.inputs['lora_name'] === 'LTX-2.3-OmniNFT-RL-Lora_bf16.safetensors');
    expect(omni).toBeTruthy();
    const src = omni!.inputs['model'] as [string, number];
    expect(wf[src[0]]!.class_type).toBe('UNETLoader'); // no transition lora in between
  });

  it('CreateVideo.audio stays on the generated-audio path on disk (no-audio default unchanged)', () => {
    const cv = Object.entries(wf).find(([, n]) => n.class_type === 'CreateVideo');
    expect(cv).toBeTruthy();
    const audioSrc = cv![1].inputs['audio'] as [string, number];
    // node 16 = LTXVAudioVAEDecode (generated path), NOT the director combined_audio
    expect(wf[audioSrc[0]]!.class_type).toBe('LTXVAudioVAEDecode');
  });
});
