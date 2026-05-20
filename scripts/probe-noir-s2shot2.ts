/**
 * probe-noir-s2shot2.ts
 *
 * Re-run noir scene 2 shot 2 first-frame using the EXACT production
 * prompt from `prompts/images/shots/scene-2-shot-2.json` (the prompt
 * the executor would use). Compares Qwen-Image-Edit-2511 vs FireRed
 * with the same inputs.
 *
 * Slot mapping for the 3-slot native TextEncodeQwenImageEditPlus:
 *   image1 = Vikram (production prompt's image 1)
 *   image2 = Cloaked Figure (production prompt's image 3)
 *   image3 = Crumbling Temple by the Ganges (production prompt's image 5)
 *
 * Production prompt's "image 1/3/5" tokens are rewritten to
 * "image1/image2/image3" to match the 3 ordered slots actually wired
 * into the encoder.
 */
import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { finddheeCoreRoot } from '../src/agent/pi/paths.js';

const COMFY_URL = process.env['COMFYUI_BASE_URL'] || 'http://127.0.0.1:8188';
const PROJECT = 'noir_detective_story_setup-3';
const SEED = 12345;

// 3 reference images, identified visually:
const VIKRAM_PATH = 'assets/images/y4ohrFMZ_946f8c72fc68912cddad838558ceb27a0d1f4c510613c0c6ef34b8c0efe887e8.png';
const CLOAKED_PATH = 'assets/images/tcSt3zT4_de2385975f70c475901d98e62acde7f06894c9201aaf8c49fe9d99bb96995f75.png';
const TEMPLE_PATH = 'assets/images/-qxY5xNW_5500890953a4df8d38aa70484c2920621a7fdc515528204902ea7b15dad4c88d.png';

// Exact production prompt from prompts/images/shots/scene-2-shot-2.json
// (first_frame), with image numbers remapped 1→1, 3→2, 5→3 and the
// 'image N' tokens compacted to imageN to match the encoder's slot
// names.
const PROMPT = `Wide establishing shot at eye level of the crumbling temple by the Ganges from image3, full environment head-to-toe with vine-choked moss-cracked pillars blurred in the distant background lashed by sheets of rain, discarded veil draped behind a pillar. Stone altar in softly blurred foreground strewn with wilted marigolds turned to sodden pulp, water pooling around its base. Vikram from image1 enters frame from the left through dense fog, soaked kurta plastered to his broad scarred frame, cynical glare on his face with jaw beginning to tighten, right hand raised chest-high palm open holding the palm-sized bronze seal pulsing faint red light with pitted edges glinting wetly, left hand outstretched toward the altar gripping the hilt of the katar plunged deep into the figure's chest, legs planted apart with left foot forward mid-stride. The Cloaked Figure from image2 hunches seated near the altar in blurred background, hood starting to fall back revealing a dying face contorted in agony, left hand clutching at chest around the embedded katar, right hand loose with curved dagger slipping toward the ground amid sparks, knees slightly buckling. Vikram razor-sharp in primary focus with moderate depth of field, Cloaked Figure and stone altar softly blurred. Diffused misty lighting from overhead overcast evening sky through heavy fog and rain, soft quality with cool blue-gray temperature casting desaturated shadows on wet stone. Cinematic realism, tense mood of violent confrontation.`;

const NEGATIVE_PROMPT = `blurry, deformed, ugly, mutated hands, extra fingers, missing limbs, poorly drawn face, bad anatomy, watermark, text, signature, error, cropped, worst quality, low quality, jpeg artifacts, cartoon, anime, painting, illustration, abstract, overexposed, underexposed, bright sunlight, clear weather, no rain, no fog, indoor dhaba, modern clothing, inconsistent character appearance, wrong facial features, no temple pillars, no altar, static poses, motion blur`;

async function main() {
  const root = finddheeCoreRoot(import.meta.url);
  const projectDir = join(root, `${PROJECT}.dhee`);
  if (!existsSync(projectDir)) {
    console.error(`No project: ${projectDir}`);
    process.exit(1);
  }

  const refPaths = [VIKRAM_PATH, CLOAKED_PATH, TEMPLE_PATH];
  for (const p of refPaths) {
    if (!existsSync(join(projectDir, p))) {
      console.error(`Missing ref: ${p}`);
      process.exit(1);
    }
  }

  console.log('[probe] noir s2 shot 2 — production prompt:');
  console.log('  image1 = Vikram');
  console.log('  image2 = Cloaked Figure');
  console.log('  image3 = Crumbling Temple by the Ganges');
  console.log(`[probe] ComfyUI: ${COMFY_URL}`);

  const outDir = join(root, 'logs/probe-noir-s2shot2');
  mkdirSync(outDir, { recursive: true });

  const client = new ComfyUIClient({
    baseUrl: COMFY_URL,
    apiKey: process.env['COMFY_CLOUD_API_KEY'],
    outputDir: outDir,
  });

  const uploaded: string[] = [];
  for (const p of refPaths) {
    const r = await client.uploadImage(join(projectDir, p));
    uploaded.push(r.name);
    console.log(`[probe] uploaded ${p.split('/').pop()} → ${r.name}`);
  }

  const buildWorkflow = (
    unetName: string,
    loraName: string,
    steps: number,
    prefix: string,
  ): Record<string, { class_type: string; inputs: Record<string, unknown> }> => {
    const wf: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: unetName, weight_dtype: 'fp8_e4m3fn' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
      '4': { class_type: 'LoadImage', inputs: { image: uploaded[0] } },
      '5': {
        class_type: 'LoraLoaderModelOnly',
        inputs: { lora_name: loraName, strength_model: 1.0, model: ['1', 0] },
      },
      // 16:9 — production aspect ratio. 1024 short edge → 1920×1080 ish;
      // qwen edit's encoder downscales internally, so we feed a 1024
      // long-edge tile with 16:9 framing.
      '7': { class_type: 'ImageScale', inputs: { upscale_method: 'lanczos', width: 1280, height: 720, crop: 'center', image: ['4', 0] } },
      '8': { class_type: 'VAEEncode', inputs: { pixels: ['7', 0], vae: ['3', 0] } },
      '9': { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, model: ['5', 0] } },
      '10': { class_type: 'CFGNorm', inputs: { strength: 1, model: ['9', 0] } },
      '11': {
        class_type: 'TextEncodeQwenImageEditPlus',
        inputs: { clip: ['2', 0], vae: ['3', 0], prompt: PROMPT, image1: ['7', 0] },
      },
      '12': {
        class_type: 'TextEncodeQwenImageEditPlus',
        inputs: { clip: ['2', 0], vae: ['3', 0], prompt: NEGATIVE_PROMPT, image1: ['4', 0] },
      },
      '13': { class_type: 'KSampler', inputs: { seed: SEED, steps, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['10', 0], positive: ['11', 0], negative: ['12', 0], latent_image: ['8', 0] } },
      '14': { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['3', 0] } },
      '15': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['14', 0] } },
      '21': { class_type: 'LoadImage', inputs: { image: uploaded[1] } },
      '22': { class_type: 'LoadImage', inputs: { image: uploaded[2] } },
    };
    wf['11'].inputs['image2'] = ['21', 0];
    wf['11'].inputs['image3'] = ['22', 0];
    return wf;
  };

  console.log('\n[probe] === Qwen-Image-Edit-2511 + Lightning-4steps LoRA + 8 sampling steps ===');
  const qwenName = `noir-s2s2-prod-qwen-${Date.now()}.png`;
  const qwenPath = await client.generateAndDownload(
    buildWorkflow(
      'Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors',
      'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors',
      8,
      'NoirS2S2Qwen',
    ),
    qwenName,
    (pct, msg) => { process.stdout.write(`\r[qwen] ${pct.toFixed(0)}% ${msg}      `); },
  );
  console.log(`\n[probe] qwen saved: ${qwenPath}`);

  console.log('\n[probe] === FireRed-Image-Edit-1.1 + FireRed Lightning-8steps LoRA + 8 sampling steps ===');
  const fireName = `noir-s2s2-prod-firered-${Date.now()}.png`;
  const firePath = await client.generateAndDownload(
    buildWorkflow(
      'FireRed-Image-Edit-1.1_fp8mixed_comfy.safetensors',
      'FireRed-Image-Edit-v1.1-Lightning-8steps-v1.0.safetensors',
      8,
      'NoirS2S2FireRed',
    ),
    fireName,
    (pct, msg) => { process.stdout.write(`\r[firered] ${pct.toFixed(0)}% ${msg}      `); },
  );
  console.log(`\n[probe] firered saved: ${firePath}`);

  console.log('\n[probe] both done. open both with:');
  console.log(`  open "${qwenPath}" "${firePath}"`);
}

main().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});
