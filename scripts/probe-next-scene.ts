/**
 * probe-next-scene.ts
 *
 * Test the `next-scene_lora-v2-3000.safetensors` LoRA — a different
 * class of LoRA from Lightning. Lightning compresses sampling steps;
 * next-scene LoRA modifies SEMANTICS, transforming a "current frame"
 * into the "next moment" of the same scene per a "Next Scene:"
 * prompt prefix.
 *
 * Use case in dhee: generate the LAST frame of a shot from the
 * FIRST frame (FLFV pipeline) — instead of running a separate FLFV
 * pass, give the next-scene LoRA the first frame plus a camera-
 * movement directive.
 *
 * Two variants run back-to-back:
 *   A. next-scene LoRA alone, 20 steps, cfg=2.5 (full quality)
 *   B. next-scene + Lightning stacked, 8 steps, cfg=1 (fast)
 *
 * Input: noir s1 shot 3's existing first frame.
 * Compare against the project's actual s1shot3_last_frame_*.png.
 */
import 'dotenv/config';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { finddheeCoreRoot } from '../src/agent/pi/paths.js';

const COMFY_URL = process.env['COMFYUI_BASE_URL'] || 'http://127.0.0.1:8188';
const PROJECT = 'noir_detective_story_setup-3';
const SEED = 12345;

// Slot 1 = s1 shot 3 first frame (the scene we're rotating around).
// Slot 2 = Vikram's character ref (anchor his identity — turban, kurta,
//          tattoos — to fix the drift the bare-prompt run showed).
const FIRST_FRAME_PATH = 'assets/images/s1shot3_first_frame_klein_fXEHgd.png';
const VIKRAM_REF_PATH = 'assets/images/y4ohrFMZ_946f8c72fc68912cddad838558ceb27a0d1f4c510613c0c6ef34b8c0efe887e8.png';

// Multiple-angles LoRA uses a canonical training-format prompt:
//   <sks> {azimuth} {elevation} {distance}
// Bare — scene/subject description goes in the input image, not the
// prompt. We're asking it to rotate 90° to Laila's right side, same
// eye level, same distance.
const NEXT_SCENE_PROMPT = `<sks> right side view eye-level shot medium shot`;

const NEGATIVE_PROMPT = `blurry, low resolution, deformed, ugly, mutated hands, extra limbs, poorly drawn face, bad anatomy, watermark, text, signature, cartoon, anime, painting, illustration`;

async function main() {
  const root = finddheeCoreRoot(import.meta.url);
  const projectDir = join(root, `${PROJECT}.dhee`);
  const inputPath = join(projectDir, FIRST_FRAME_PATH);
  if (!existsSync(inputPath)) {
    console.error(`Missing first-frame: ${inputPath}`);
    process.exit(1);
  }

  console.log('[probe] next-scene LoRA test on noir s1 shot 3 first frame');
  console.log(`[probe] input: ${FIRST_FRAME_PATH}`);
  console.log(`[probe] ComfyUI: ${COMFY_URL}`);

  const outDir = join(root, 'logs/probe-next-scene');
  mkdirSync(outDir, { recursive: true });

  const client = new ComfyUIClient({
    baseUrl: COMFY_URL,
    apiKey: process.env['COMFY_CLOUD_API_KEY'],
    outputDir: outDir,
  });

  const uploaded = await client.uploadImage(inputPath);
  console.log(`[probe] uploaded scene → ${uploaded.name}`);
  const vikramRefPath = join(projectDir, VIKRAM_REF_PATH);
  if (!existsSync(vikramRefPath)) {
    console.error(`Missing Vikram ref: ${vikramRefPath}`);
    process.exit(1);
  }
  const vikramRef = await client.uploadImage(vikramRefPath);
  console.log(`[probe] uploaded Vikram ref → ${vikramRef.name}`);

  const buildWorkflow = (
    label: string,
    loraStack: Array<{ name: string; strength: number }>,
    steps: number,
    cfg: number,
    scheduler: string,
    prefix: string,
  ): Record<string, { class_type: string; inputs: Record<string, unknown> }> => {
    const wf: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors', weight_dtype: 'fp8_e4m3fn' } },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
      '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
      '4': { class_type: 'LoadImage', inputs: { image: uploaded.name } },
      '7': { class_type: 'ImageScale', inputs: { upscale_method: 'lanczos', width: 1280, height: 720, crop: 'center', image: ['4', 0] } },
      '8': { class_type: 'VAEEncode', inputs: { pixels: ['7', 0], vae: ['3', 0] } },
      '11': {
        class_type: 'TextEncodeQwenImageEditPlus',
        inputs: {
          clip: ['2', 0],
          vae: ['3', 0],
          prompt: NEXT_SCENE_PROMPT,
          image1: ['7', 0],
          // image2 = Vikram character ref (anchors his identity).
          image2: ['25', 0],
        },
      },
      '25': { class_type: 'LoadImage', inputs: { image: vikramRef.name } },
      '12': {
        class_type: 'TextEncodeQwenImageEditPlus',
        inputs: { clip: ['2', 0], vae: ['3', 0], prompt: NEGATIVE_PROMPT, image1: ['4', 0] },
      },
      '13': { class_type: 'KSampler', inputs: { seed: SEED, steps, cfg, sampler_name: 'euler', scheduler, denoise: 1, positive: ['11', 0], negative: ['12', 0], latent_image: ['8', 0] } },
      '14': { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['3', 0] } },
      '15': { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: ['14', 0] } },
      '9': { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3 } },
      '10': { class_type: 'CFGNorm', inputs: { strength: 1, model: ['9', 0] } },
    };
    // Chain LoRAs: model[1] → lora1 → lora2 → ModelSamplingAuraFlow → CFGNorm
    let modelOut: [string, number] = ['1', 0];
    let nextNodeId = 30;
    for (const lora of loraStack) {
      const id = String(nextNodeId++);
      wf[id] = {
        class_type: 'LoraLoaderModelOnly',
        inputs: { lora_name: lora.name, strength_model: lora.strength, model: modelOut },
      };
      modelOut = [id, 0];
    }
    wf['9'].inputs['model'] = modelOut;
    wf['13'].inputs['model'] = ['10', 0];
    console.log(`[probe] [${label}] LoRA stack: ${loraStack.map((l) => `${l.name}@${l.strength}`).join(' + ') || '(none)'}, steps=${steps}, cfg=${cfg}`);
    return wf;
  };

  // multiple-angles @ 0.75 + Lightning @ 1.0 stacked. Bare canonical
  // <sks> prompt format from the LoRA training spec.
  console.log('\n[probe] === multiple-angles@0.75 + Lightning@1.0 stacked, 8 steps, cfg=1, +Vikram ref ===');
  const aName = `multi-angles-0.75-vikram-ref-${Date.now()}.png`;
  const aPath = await client.generateAndDownload(
    buildWorkflow(
      'multi-angles',
      [
        { name: 'qwen-image-edit-2511-multiple-angles-lora.safetensors', strength: 0.75 },
        { name: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors', strength: 1.0 },
      ],
      8,
      1,
      'simple',
      'MultiAngles',
    ),
    aName,
    (pct, msg) => { process.stdout.write(`\r[multi-angles] ${pct.toFixed(0)}% ${msg}      `); },
  );
  console.log(`\n[probe] saved: ${aPath}`);
  const bPath = aPath;

  console.log('\n[probe] both done. compare against project last_frame:');
  console.log(`  open "${aPath}" "${bPath}" "${join(projectDir, 'assets/images/s1shot3_last_frame_klein_SOc8Z3.png')}"`);
}

main().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});
