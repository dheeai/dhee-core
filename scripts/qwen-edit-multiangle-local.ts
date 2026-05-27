#!/usr/bin/env tsx
/**
 * Qwen Image Edit 2511 + Multiple-Angles LoRA on local Comfy.
 *
 * Topology lifted from the official ComfyUI wiki template
 * (image_qwen_image_edit_2511.json) — uses TextEncodeQwenImageEditPlus
 * + FluxKontextMultiReferenceLatentMethod (the proper multi-ref edit
 * stack), with our Multi-Angles LoRA inserted before the optional
 * Lightning LoRA (which we keep disabled at 40 steps for quality).
 *
 * LoRA prompt format (fal HF page):
 *   <sks> {azimuth} {elevation} {distance}
 *   azimuths: front view | front-right quarter view | right side view |
 *             back-right quarter view | back view | back-left quarter view |
 *             left side view | front-left quarter view
 *   elevations: low-angle shot | eye-level shot | elevated shot | high-angle shot
 *   distances: close-up | medium shot | wide shot
 */
import 'dotenv/config';
import { dirname, basename } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

interface APINode { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }
type APIWorkflow = Record<string, APINode>;

function buildWorkflow(opts: {
  imageRefName: string;
  prompt: string;
  loraName: string;
  loraStrength: number;
  lightningLoraName: string;
  unetName: string;
  steps: number;
  cfg: number;
}): APIWorkflow {
  const wf: APIWorkflow = {};

  // ── Model + LoRAs (Multi-Angle stacked on top of Lightning distilled) ──
  wf['UNET']         = { class_type: 'UNETLoader', inputs: { unet_name: opts.unetName, weight_dtype: 'default' } };
  wf['LORA_MA']      = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: opts.loraName, strength_model: opts.loraStrength, model: ['UNET', 0] }, _meta: { title: 'Multi-Angles LoRA' } };
  wf['LORA_LIGHT']   = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: opts.lightningLoraName, strength_model: 1.0, model: ['LORA_MA', 0] }, _meta: { title: 'Lightning 4-step LoRA' } };
  wf['MSAF']         = { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3.1, model: ['LORA_LIGHT', 0] } };
  wf['CFGN']         = { class_type: 'CFGNorm', inputs: { strength: 1.0, model: ['MSAF', 0] } };

  // ── CLIP + VAE ──
  wf['CLIP'] = { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } };
  wf['VAE']  = { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } };

  // ── Load source image (used as the edit reference) ──
  wf['LI'] = { class_type: 'LoadImage', inputs: { image: opts.imageRefName } };

  // Resize per FluxKontextImageScale (snaps to Flux Kontext valid sizes).
  wf['SCALE'] = { class_type: 'FluxKontextImageScale', inputs: { image: ['LI', 0] } };

  // Encode the scaled reference as the starting latent.
  wf['ENC'] = { class_type: 'VAEEncode', inputs: { pixels: ['SCALE', 0], vae: ['VAE', 0] } };

  // ── Qwen edit text encoder with single reference image ──
  // (Multi-angle is one-source-image; we hand the same image to image1 only.)
  wf['POS'] = {
    class_type: 'TextEncodeQwenImageEditPlus',
    inputs: { prompt: opts.prompt, clip: ['CLIP', 0], vae: ['VAE', 0], image1: ['SCALE', 0] },
  };
  wf['NEG'] = {
    class_type: 'TextEncodeQwenImageEditPlus',
    inputs: { prompt: '', clip: ['CLIP', 0], vae: ['VAE', 0], image1: ['SCALE', 0] },
  };

  // ── Reference latent injection (Flux Kontext multi-ref) ──
  // 'index_timestep_zero' per the template default.
  wf['REF_POS'] = {
    class_type: 'FluxKontextMultiReferenceLatentMethod',
    inputs: { reference_latents_method: 'index_timestep_zero', conditioning: ['POS', 0] },
  };
  wf['REF_NEG'] = {
    class_type: 'FluxKontextMultiReferenceLatentMethod',
    inputs: { reference_latents_method: 'index_timestep_zero', conditioning: ['NEG', 0] },
  };

  // ── Sample ──
  wf['KS'] = {
    class_type: 'KSampler',
    inputs: {
      seed: Math.floor(Math.random() * 0x7fffffff),
      steps: opts.steps,
      cfg: opts.cfg,
      sampler_name: 'euler',
      scheduler: 'simple',
      denoise: 1,
      model: ['CFGN', 0],
      positive: ['REF_POS', 0],
      negative: ['REF_NEG', 0],
      latent_image: ['ENC', 0],
    },
  };

  wf['DEC']  = { class_type: 'VAEDecode', inputs: { samples: ['KS', 0], vae: ['VAE', 0] } };
  wf['SAVE'] = { class_type: 'SaveImage', inputs: { images: ['DEC', 0], filename_prefix: 'qwen_edit_ma' } };

  return wf;
}

async function main() {
  const imagePath = arg('image', '');
  const prompt = arg('prompt', '');
  const loraName = arg('lora', 'qwen-image-edit-2511-multiple-angles-lora.safetensors');
  const strength = parseFloat(arg('strength', '0.9'));
  const lightningLoraName = arg('lightning-lora', 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors');
  const unetName = arg('unet', 'qwen_image_edit_2511_bf16.safetensors');
  // With Lightning 4-step LoRA stacked, default to 4 steps + cfg 1.
  const steps = parseInt(arg('steps', '4'), 10);
  const cfg = parseFloat(arg('cfg', '1.0'));
  const outName = arg('out', '');
  if (!imagePath || !prompt) {
    console.error('Usage: qwen-edit-multiangle-local --image <path> --prompt "<text>" [--lora <filename>] [--strength 0.9] [--unet <filename>] [--steps 40] [--cfg 3.0] [--out <name>]');
    process.exit(1);
  }

  const localUrl = process.env['ENDPOINT_self_local'];
  if (!localUrl) { console.error('ENDPOINT_self_local not set'); process.exit(1); }

  const client = new ComfyUIClient({ outputDir: dirname(imagePath), baseUrl: localUrl });
  console.log(`Local Comfy: ${localUrl}`);
  console.log(`Uploading ${basename(imagePath)}...`);
  const up = await client.uploadImage(imagePath, 'input', true);
  console.log(`  → ${up.name}`);

  const wf = buildWorkflow({ imageRefName: up.name, prompt, loraName, loraStrength: strength, lightningLoraName, unetName, steps, cfg });
  console.log(`UNET:    ${unetName}`);
  console.log(`LoRAs:   ${loraName} @ ${strength} (multi-angle) + ${lightningLoraName} @ 1.0 (lightning)`);
  console.log(`Sampler: ${steps} steps, cfg ${cfg}, euler/simple`);
  console.log(`Prompt:  ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}`);
  console.log(`Submitting (${Object.keys(wf).length} nodes)...`);

  const start = Date.now();
  const { promptId, outputs } = await client.queueAndWaitWS(wf, (p) => {
    if (p.percentage !== undefined && p.message) {
      process.stdout.write(`\r  [${p.percentage.toFixed(0)}%] ${p.message}              `);
    }
  });
  console.log(`\n  done in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

  const hist = await client.getOutputImages(promptId);
  const all = [...outputs, ...hist].filter((o) => /\.png$/i.test(o.filename));
  if (all.length === 0) { console.error('No image output'); process.exit(1); }
  const item = all[0]!;
  const target = outName || `${basename(imagePath, '.png')}_qwen_ma_${Date.now()}.png`;
  const saved = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
  console.log(`Saved: ${saved}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
