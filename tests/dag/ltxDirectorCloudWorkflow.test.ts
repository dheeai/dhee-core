/**
 * Verifies the shipped LTX Director cloud graph is cloud-valid:
 *  - node 84 DualCLIPLoader.clip_name1 uses the cloud-available gemma encoder
 *    (the local "heretic" build is absent from Comfy Cloud — the 400 in #173).
 *  - every OTHER model ref is identical to the local graph (1-field diff).
 *  - all node class_types are present (the graph structure is intact).
 *
 * Reads the actual shipped JSON and exercises extractModelRefs — no source
 * grepping.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { extractModelRefs, type ComfyWorkflow } from '../../src/dag/workflowVerify.js';

const REPO_ROOT = resolve(__dirname, '..', '..');
const CLOUD_WF = REPO_ROOT + '/workflows/cloud/ltx23_director_cloud.json';
const LOCAL_WF = REPO_ROOT + '/src/dag/bundles/narrative_prompt_relay/workflows/ltx_director_local.json';

function load(p: string): ComfyWorkflow {
  return JSON.parse(readFileSync(p, 'utf-8')) as ComfyWorkflow;
}

function refMap(wf: ComfyWorkflow): Map<string, string> {
  const m = new Map<string, string>();
  for (const r of extractModelRefs(wf)) m.set(`${r.nodeId}.${r.inputField}`, r.current_value);
  return m;
}

describe('ltx23_director_cloud.json (issue #173)', () => {
  const cloud = load(CLOUD_WF);
  const local = load(LOCAL_WF);
  const cloudRefs = refMap(cloud);
  const localRefs = refMap(local);

  it('uses the cloud gemma encoder at node 84 clip_name1', () => {
    expect(cloudRefs.get('84.clip_name1')).toBe('gemma_3_12B_it_fp8_scaled.safetensors');
  });

  it('does NOT reference the local-only heretic encoder', () => {
    expect(cloudRefs.get('84.clip_name1')).not.toBe('gemma_3_12B_it_heretic_fp8_e4m3fn.safetensors');
    const all = [...cloudRefs.values()];
    expect(all).not.toContain('gemma_3_12B_it_heretic_fp8_e4m3fn.safetensors');
  });

  it('keeps the LTXDirector node and the runner-driven node ids intact', () => {
    expect(cloud['46']?.class_type).toBe('LTXDirector');
    for (const id of ['28', '30', '46']) {
      expect(cloud[id], `node ${id} missing`).toBeTruthy();
    }
    expect(cloud['28']?.class_type).toBe('RandomNoise');
    expect(cloud['30']?.class_type).toBe('SaveVideo');
  });

  it('differs from the local graph ONLY at node 84 clip_name1', () => {
    const diffs: string[] = [];
    for (const [k, v] of cloudRefs) {
      const lv = localRefs.get(k);
      if (lv !== v) diffs.push(`${k}: cloud=${v} local=${lv}`);
    }
    // Exactly one model ref differs — the gemma encoder swap.
    expect(diffs).toEqual([
      '84.clip_name1: cloud=gemma_3_12B_it_fp8_scaled.safetensors local=gemma_3_12B_it_heretic_fp8_e4m3fn.safetensors',
    ]);
  });

  it('preserves cloud-present loaders unchanged (lora, VAEs, unet, upscaler, clip_name2)', () => {
    // All verified present on the live cloud catalog — must not be altered.
    expect(cloudRefs.get('81.lora_name')).toBe('LTX-2.3-OmniNFT-RL-Lora_bf16.safetensors');
    expect(cloudRefs.get('4.vae_name')).toBe('LTX23_audio_vae_bf16.safetensors');
    expect(cloud['4']?.class_type).toBe('VAELoaderKJ');
    expect(cloudRefs.get('3.vae_name')).toBe('LTX23_video_vae_bf16.safetensors');
    expect(cloudRefs.get('77.unet_name')).toBe('ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors');
    expect(cloudRefs.get('57.model_name')).toBe('ltx-2.3-spatial-upscaler-x2-1.1.safetensors');
    expect(cloudRefs.get('84.clip_name2')).toBe('ltx-2.3_text_projection_bf16.safetensors');
  });
});
