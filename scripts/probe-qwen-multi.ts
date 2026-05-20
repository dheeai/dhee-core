/**
 * probe-qwen-multi.ts
 *
 * Probe: does qwen_edit work with 4-5 reference images via the
 * `TextEncodeQwenImageEditPlus_lrzjason` ComfyUI custom node
 * (already installed on the user's ComfyUI)?
 *
 * Hypothesis: lrzjason's drop-in replacement node accepts image1..image5,
 * so swapping it into qwen_edit's pipeline lets us reach Klein-level
 * (4+ ref) compositions without a separate workflow.
 *
 * Per the "experiment at N=1 first" rule, this runs a SINGLE seed
 * with 4 reference images, downloads the result, and prints the
 * output path. Inspect the output before scaling.
 *
 * Usage:
 *   tsx scripts/probe-qwen-multi.ts <project-name>
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

  const pick: string[] = [];
  if (charRefs[0]) pick.push(charRefs[0]);
  for (const f of sceneFrames) {
    if (pick.length >= 4) break;
    if (!pick.includes(f)) pick.push(f);
  }
  for (const f of candidates) {
    if (pick.length >= 4) break;
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

  const outDir = join(root, 'logs/probe-qwen-multi');
  mkdirSync(outDir, { recursive: true });

  const client = new ComfyUIClient({
    baseUrl: COMFY_URL,
    apiKey: process.env['COMFY_CLOUD_API_KEY'],
    outputDir: outDir,
  });

  // Upload images, capture server-side names.
  const uploaded: string[] = [];
  for (const filename of pick) {
    const filePath = join(imagesDir, filename);
    const result = await client.uploadImage(filePath);
    uploaded.push(result.name);
    console.log(`[probe] uploaded ${filename} → ${result.name}`);
  }

  // Qwen edit's CLIP encoder is trained on the unspaced ref tokens —
  // `image1`, `image2`, … — matching the input slot names. Spaces
  // ("image 1") tokenise differently and the model under-attends.
  const prompt = pick.length >= 4
    ? 'Combine these reference images into a single cohesive scene: place the character (image1) in the setting (image2), with the same composition style as image3 and the lighting/mood of image4. Maintain anime aesthetic.'
    : pick.length === 3
      ? 'Combine the character (image1) with the setting (image2) and the composition style of image3. Anime aesthetic.'
      : 'Combine the character (image1) with the setting (image2). Anime aesthetic.';

  // API-format workflow (object keyed by node id). Mirrors
  // qwen_edit-simple.json but with TextEncodeQwenImageEditPlus_lrzjason
  // for image1..image5 support.
  const apiWorkflow: Record<string, { class_type: string; inputs: Record<string, unknown> }> = {
    // FireRed Image Edit 1.1 — drop-in for Qwen Edit, paired with the
    // matching 8-step Lightning LoRA so we can run at cfg=1, steps=8
    // (instead of cfg=2.5, steps=20). Same VAE / CLIP as qwen edit.
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'FireRed-Image-Edit-1.1_fp8mixed_comfy.safetensors', weight_dtype: 'fp8_e4m3fn' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } },
    '4': { class_type: 'LoadImage', inputs: { image: uploaded[0] } },
    // LoraLoaderModelOnly — no CLIP routing required since the
    // distilled LoRA only patches the UNet. Strength 1.0 per the
    // model card.
    '5': {
      class_type: 'LoraLoaderModelOnly',
      inputs: {
        lora_name: 'FireRed-Image-Edit-v1.1-Lightning-8steps-v1.0.safetensors',
        strength_model: 1.0,
        model: ['1', 0],
      },
    },
    '7': { class_type: 'ImageScale', inputs: { upscale_method: 'lanczos', width: 1024, height: 1024, crop: 'center', image: ['4', 0] } },
    '8': { class_type: 'VAEEncode', inputs: { pixels: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3, model: ['5', 0] } },
    '10': { class_type: 'CFGNorm', inputs: { strength: 1, model: ['9', 0] } },
    '11': {
      class_type: 'TextEncodeQwenImageEditPlus_lrzjason',
      inputs: {
        clip: ['2', 0],
        vae: ['3', 0],
        prompt,
        image1: ['7', 0],
        enable_resize: true,
        enable_vl_resize: true,
        skip_first_image_resize: false,
        upscale_method: 'lanczos',
        crop: 'center',
        instruction: '',
      },
    },
    '12': {
      class_type: 'TextEncodeQwenImageEditPlus_lrzjason',
      inputs: {
        clip: ['2', 0],
        vae: ['3', 0],
        prompt: 'blurry, low quality, distorted, ugly',
        image1: ['4', 0],
        enable_resize: true,
        enable_vl_resize: true,
        skip_first_image_resize: false,
        upscale_method: 'lanczos',
        crop: 'center',
        instruction: '',
      },
    },
    // Lightning-LoRA params: 8 steps, cfg=1. The LoRA is distilled
    // for cfg=1 so anything higher introduces artifacts.
    '13': { class_type: 'KSampler', inputs: { seed: 12345, steps: 8, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['10', 0], positive: ['11', 0], negative: ['12', 0], latent_image: ['8', 0] } },
    '14': { class_type: 'VAEDecode', inputs: { samples: ['13', 0], vae: ['3', 0] } },
    '15': { class_type: 'SaveImage', inputs: { filename_prefix: 'FireRedEditMulti', images: ['14', 0] } },
  };

  // Wire image2..image5 of node 11 from upload[1..4]
  for (let i = 1; i < pick.length && i < 5; i += 1) {
    const refNodeId = String(20 + i);
    apiWorkflow[refNodeId] = { class_type: 'LoadImage', inputs: { image: uploaded[i] } };
    apiWorkflow['11'].inputs[`image${i + 1}`] = [refNodeId, 0];
  }

  const outputName = `qwen-multi-${pick.length}refs-${Date.now()}.png`;
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
