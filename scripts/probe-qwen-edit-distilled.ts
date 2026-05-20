/**
 * probe-qwen-edit-distilled.ts
 *
 * Same probe as `probe-qwen-multi.ts` but with the actual Qwen-Image-Edit-2511
 * UNet (not FireRed) and its matching 4-step Lightning LoRA. Lets us
 * separate model identity (FireRed vs Qwen) from the multi-ref behavior
 * we already validated for the lrzjason 5-image encoder.
 *
 * Same 4 reference images, same prompt, same seed (12345) as the
 * earlier probes — straight A/B with FireRed and Klein.
 *
 * Note: the Qwen Lightning LoRA is calibrated for 4 steps (not 8),
 * so we drop steps to 4 to match its training.
 *
 * Usage:
 *   tsx scripts/probe-qwen-edit-distilled.ts <project-name>
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { finddheeCoreRoot } from '../src/agent/pi/paths.js';

async function main() {
  const projectName = process.argv[2] ?? 'chhaya_60s_anime';
  const root = finddheeCoreRoot(import.meta.url);
  const projectDir = join(root, `${projectName}.dhee`);
  const imagesDir = join(projectDir, 'assets/images');

  if (!existsSync(imagesDir)) {
    console.error(`No assets/images dir: ${imagesDir}`);
    process.exit(1);
  }

  const candidates = readdirSync(imagesDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const charRefs = candidates.filter((f) => /^CharRef_/i.test(f));
  const sceneFrames = candidates.filter((f) => /first_frame|last_frame/i.test(f));

  // Native TextEncodeQwenImageEditPlus has 3 image slots — pick 3.
  const pick: string[] = [];
  if (charRefs[0]) pick.push(charRefs[0]);
  for (const f of sceneFrames) {
    if (pick.length >= 3) break;
    if (!pick.includes(f)) pick.push(f);
  }
  for (const f of candidates) {
    if (pick.length >= 3) break;
    if (!pick.includes(f)) pick.push(f);
  }
  if (pick.length < 2) {
    console.error(`Need ≥2 images in ${imagesDir}; found ${pick.length}`);
    process.exit(1);
  }

  console.log('[probe] Using images:');
  pick.forEach((p, i) => console.log(`  image${i + 1}: ${p}`));

  const COMFY_URL = process.env['COMFYUI_BASE_URL'] || 'http://127.0.0.1:8188';
  console.log(`[probe] ComfyUI: ${COMFY_URL}`);

  const outDir = join(root, 'logs/probe-qwen-distilled');
  mkdirSync(outDir, { recursive: true });

  const client = new ComfyUIClient({
    baseUrl: COMFY_URL,
    apiKey: process.env['COMFY_CLOUD_API_KEY'],
    outputDir: outDir,
  });

  const uploaded: string[] = [];
  for (const filename of pick) {
    const filePath = join(imagesDir, filename);
    const result = await client.uploadImage(filePath);
    uploaded.push(result.name);
    console.log(`[probe] uploaded ${filename} → ${result.name}`);
  }

  // Same prompt across all probes for the A/B.
  // Qwen edit's CLIP encoder is trained on the unspaced ref tokens —
  // `image1`, `image2`, … — matching the input slot names. Spaces
  // ("image 1") tokenise differently and the model under-attends.
  const prompt = pick.length >= 4
    ? 'Combine these reference images into a single cohesive scene: place the character (image1) in the setting (image2), with the same composition style as image3 and the lighting/mood of image4. Maintain anime aesthetic.'
    : pick.length === 3
      ? 'Combine the character (image1) with the setting (image2) and the composition style of image3. Anime aesthetic.'
      : 'Combine the character (image1) with the setting (image2). Anime aesthetic.';

  const apiWorkflow: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    // Real Qwen-Image-Edit-2511 (the model FireRed is "the same as", per the user)
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors', weight_dtype: 'fp8_e4m3fn' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '4': { class_type: 'LoadImage', inputs: { image: uploaded[0] } },
    // Matching 4-step distilled LoRA — model-only patch.
    '5': {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        lora_name: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors',
        strength_model: 1.0,
        model: ['1', 0],
      },
    },
    '7': { class_type: 'ImageScale', inputs: { upscale_method: 'lanczos', width: 1024, height: 1024, crop: 'center', image: ['4', 0] } },
    '8': { class_type: 'VAEEncode', inputs: { pixels: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, model: ['5', 0] } },
    '10': { class_type: 'CFGNorm', inputs: { strength: 1, model: ['9', 0] } },
    // Standard `TextEncodeQwenImageEditPlus` (NOT the lrzjason variant)
    // — 3 image slots only, native ComfyUI node. We're testing whether
    // the lrzjason 5-image patcher was muddying the conditioning.
    '11': {
      class_type: 'TextEncodeQwenImageEditPlus',
      inputs: {
        clip: ['2', 0],
        vae: ['3', 0],
        prompt,
        image1: ['7', 0],
      },
    },
    '12': {
      class_type: 'TextEncodeQwenImageEditPlus',
      inputs: {
        clip: ['2', 0],
        vae: ['3', 0],
        prompt: 'blurry, low quality, distorted, ugly',
        image1: ['4', 0],
      },
    },
    // 8 steps + cfg=1 — match the FireRed probe's sampling regime.
    '13': { class_type: 'KSampler', inputs: { seed: 12345, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['10', 0], positive: ['11', 0], negative: ['12', 0], latent_image: ['8', 0] } },
    '14': { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['3', 0] } },
    '15': { class_type: 'SaveImage', inputs: { filename_prefix: 'QwenEditDistilled', images: ['14', 0] } },
  };

  // Native node has image1, image2, image3 — clamp to 3.
  for (let i = 1; i < pick.length && i < 3; i += 1) {
    const refNodeId = String(20 + i);
    apiWorkflow[refNodeId] = { class_type: 'LoadImage', inputs: { image: uploaded[i] } };
    apiWorkflow['11'].inputs[`image${i + 1}`] = [refNodeId, 0];
  }

  const outputName = `qwen-distilled-${pick.length}refs-${Date.now()}.png`;
  console.log('[probe] submitting…');
  const savedPath = await client.generateAndDownload(
    apiWorkflow,
    outputName,
    (percentage, message) => {
      process.stdout.write(`\r[probe] ${percentage.toFixed(0)}% ${message}      `);
    },
  );
  console.log();
  console.log(`[probe] saved: ${savedPath}`);
  console.log(`[probe] open: open "${savedPath}"`);
}

main().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});
