/**
 * probe-noir-s1shot3.ts
 *
 * Final A/B: noir scene 1 shot 3 first-frame using the production
 * prompt verbatim (image numbers remapped 1→1, 2→2, 4→3 for the
 * 3-slot native TextEncodeQwenImageEditPlus node).
 *
 *   image1 = Vikram
 *   image2 = Laila
 *   image3 = Torch-lit dhaba (setting)
 */
import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { finddheeCoreRoot } from '../src/agent/pi/paths.js';

const COMFY_URL = process.env['COMFYUI_BASE_URL'] || 'http://127.0.0.1:8188';
const PROJECT = 'noir_detective_story_setup-3';
const SEED = 12345;

// Visually identified earlier:
const VIKRAM_PATH = 'assets/images/y4ohrFMZ_946f8c72fc68912cddad838558ceb27a0d1f4c510613c0c6ef34b8c0efe887e8.png';
const LAILA_PATH = 'assets/images/FEumoHCV_d3d9fc302c60a8b64028b9098455d412e9a6bccbf0fe0ca15392bc030d46e3d6.png';
const DHABA_PATH = 'assets/images/D4HanlI5_9ba55d021dc806b05a70bc16e88656cceb2d7490693ce3c49efdde7e2a1b5c8d.png';

// Production prompt from prompts/images/shots/scene-1-shot-3.json (first_frame)
// with image numbers remapped 1→1, 2→2, 4→3 for the 3-slot native node.
const PROMPT = `Medium shot over Vikram's shoulder from image1, his broad shoulder in soaked dark kurta softly blurred in the shallow depth of field near foreground. Laila from image2 glides into frame from the gloom on the right: waist-up razor-sharp in moderate shallow depth of field, crimson sari wet and translucent clinging to her lithe form, hennaed left hand visible extended slightly forward, right hand at her side, fierce expression emerging on her face with kohl-rimmed eyes locked toward camera, head neutral, legs in mid-stride with sari folds suspended dynamically. The torch-lit dhaba interior from image3 fills the blurred background: mud walls with jagged shadows softly out of focus, steam wisps curling amid flickering torchlight. Flickering torchlight source from camera-left and behind subjects, harsh dancing quality casting sharp shadows, warm amber temperature highlighting wet fabrics and henna patterns. Moody tension of a dim rainy evening.`;

const NEGATIVE_PROMPT = `blurry, low resolution, deformed, ugly, mutated hands, extra limbs, poorly drawn face, bad anatomy, watermark, text, signature, cartoon, anime, painting, illustration, extra fingers, fused fingers, oversaturated, underexposed, grainy, distorted proportions, floating limbs`;

async function main() {
  const root = finddheeCoreRoot(import.meta.url);
  const projectDir = join(root, `${PROJECT}.dhee`);
  if (!existsSync(projectDir)) {
    console.error(`No project: ${projectDir}`);
    process.exit(1);
  }

  const refPaths = [VIKRAM_PATH, LAILA_PATH, DHABA_PATH];
  for (const p of refPaths) {
    if (!existsSync(join(projectDir, p))) {
      console.error(`Missing ref: ${p}`);
      process.exit(1);
    }
  }

  console.log('[probe] noir s1 shot 3 — production prompt:');
  console.log('  image1 = Vikram');
  console.log('  image2 = Laila');
  console.log('  image3 = Torch-lit dhaba');
  console.log(`[probe] ComfyUI: ${COMFY_URL}`);

  const outDir = join(root, 'logs/probe-noir-s1shot3');
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
  const qwenName = `noir-s1s3-prod-qwen-${Date.now()}.png`;
  const qwenPath = await client.generateAndDownload(
    buildWorkflow(
      'Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors',
      'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors',
      8,
      'NoirS1S3Qwen',
    ),
    qwenName,
    (pct, msg) => { process.stdout.write(`\r[qwen] ${pct.toFixed(0)}% ${msg}      `); },
  );
  console.log(`\n[probe] qwen saved: ${qwenPath}`);

  console.log('\n[probe] === FireRed-Image-Edit-1.1 + FireRed Lightning-8steps LoRA + 8 sampling steps ===');
  const fireName = `noir-s1s3-prod-firered-${Date.now()}.png`;
  const firePath = await client.generateAndDownload(
    buildWorkflow(
      'FireRed-Image-Edit-1.1_fp8mixed_comfy.safetensors',
      'FireRed-Image-Edit-v1.1-Lightning-8steps-v1.0.safetensors',
      8,
      'NoirS1S3FireRed',
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
