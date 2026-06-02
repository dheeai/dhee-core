#!/usr/bin/env tsx
/**
 * Submit Flux 2 dev + multi-angle LoRA workflow to Comfy Cloud (API format).
 *
 * The Comfy wiki template is in UI format (with subgraph) which can't be
 * submitted directly via the /prompt API. This script builds the flat
 * API format manually from the same node topology, lets us use ONE source
 * image (uploaded to both reference slots), and submits to cloud.
 *
 * Args:
 *   --image <path>    source image (used in both ref slots)
 *   --prompt "<text>" full prompt (should include <sks> LoRA prefix)
 *   --strength <n>    multi-angle LoRA strength (default 0.9)
 *   --out <name>      output filename
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

interface APINode { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }
type APIWorkflow = Record<string, APINode>;

function buildWorkflow(opts: {
  imageRefName: string;          // uploaded image filename (used for both refs)
  prompt: string;
  loraStrength: number;
}): APIWorkflow {
  const wf: APIWorkflow = {};

  // ── Load Image nodes (two refs, both pointing at the same upload) ──
  wf['LI_1'] = { class_type: 'LoadImage', inputs: { image: opts.imageRefName }, _meta: { title: 'Ref Image 1' } };
  wf['LI_2'] = { class_type: 'LoadImage', inputs: { image: opts.imageRefName }, _meta: { title: 'Ref Image 2' } };

  // ── Model + LoRAs ──
  wf['UNET']    = { class_type: 'UNETLoader', inputs: { unet_name: 'flux2_dev_fp8mixed.safetensors', weight_dtype: 'default' } };
  // Multi-Angles LoRA stacked on UNET.
  wf['LORA_MA'] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: 'flux2-multi_angles_lora-v2.safetensors', strength_model: opts.loraStrength, model: ['UNET', 0] }, _meta: { title: 'Multi-Angles LoRA' } };

  // ── CLIP + VAE ──
  wf['CLIP'] = { class_type: 'CLIPLoader', inputs: { clip_name: 'mistral_3_small_flux2_fp8.safetensors', type: 'flux2', device: 'default' } };
  wf['VAE']  = { class_type: 'VAELoader', inputs: { vae_name: 'flux2-vae.safetensors' } };

  // ── Image preprocessing (scale to 1MP per the template) ──
  wf['SCALE_1'] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['LI_1', 0], upscale_method: 'area', megapixels: 1.0, resolution_steps: 16 } };
  wf['SCALE_2'] = { class_type: 'ImageScaleToTotalPixels', inputs: { image: ['LI_2', 0], upscale_method: 'area', megapixels: 1.0, resolution_steps: 16 } };

  // ── VAE-encode each reference into a latent ──
  wf['ENC_1'] = { class_type: 'VAEEncode', inputs: { pixels: ['SCALE_1', 0], vae: ['VAE', 0] } };
  wf['ENC_2'] = { class_type: 'VAEEncode', inputs: { pixels: ['SCALE_2', 0], vae: ['VAE', 0] } };

  // ── Text encode ──
  wf['POS'] = { class_type: 'CLIPTextEncode', inputs: { text: opts.prompt, clip: ['CLIP', 0] } };

  // ── Apply Flux guidance ──
  wf['FG'] = { class_type: 'FluxGuidance', inputs: { conditioning: ['POS', 0], guidance: 4.0 } };

  // ── Reference latent injection (Flux 2 dev's edit-mode mechanism) ──
  wf['REF_1'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['FG', 0], latent: ['ENC_1', 0] } };
  wf['REF_2'] = { class_type: 'ReferenceLatent', inputs: { conditioning: ['REF_1', 0], latent: ['ENC_2', 0] } };

  // ── Empty latent for the generation ──
  wf['EMPTY'] = { class_type: 'EmptyFlux2LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } };

  // ── Sampler + scheduler ──
  wf['SCHED']     = { class_type: 'Flux2Scheduler', inputs: { steps: 20, width: 1024, height: 1024 } };
  wf['SAMPLER']   = { class_type: 'KSamplerSelect', inputs: { sampler_name: 'euler' } };
  wf['NOISE']     = { class_type: 'RandomNoise', inputs: { noise_seed: Math.floor(Math.random() * 0x7fffffff) } };
  wf['GUIDER']    = { class_type: 'BasicGuider', inputs: { model: ['LORA_MA', 0], conditioning: ['REF_2', 0] } };

  // ── Sample ──
  wf['KSAMPLER'] = { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['NOISE', 0], guider: ['GUIDER', 0], sampler: ['SAMPLER', 0], sigmas: ['SCHED', 0], latent_image: ['EMPTY', 0] } };

  // ── Decode ──
  wf['DEC'] = { class_type: 'VAEDecode', inputs: { samples: ['KSAMPLER', 0], vae: ['VAE', 0] } };

  // ── Save ──
  wf['SAVE'] = { class_type: 'SaveImage', inputs: { images: ['DEC', 0], filename_prefix: 'flux2dev_ma' } };

  return wf;
}

async function main() {
  const imagePath = arg('image', '');
  const prompt = arg('prompt', '');
  const strength = parseFloat(arg('strength', '0.9'));
  const outName = arg('out', '');
  if (!imagePath || !prompt) {
    console.error('Usage: flux2dev-multiangle-cloud --image <path> --prompt "<text>" [--strength 0.9] [--out <name>]');
    process.exit(1);
  }

  const cloudUrl = process.env['ENDPOINT_public_cloud'] ?? process.env['COMFY_CLOUD_URL']!;
  const apiKey = process.env['COMFY_CLOUD_API_KEY']!;

  const client = new ComfyUIClient({ outputDir: dirname(imagePath), baseUrl: cloudUrl });
  console.log(`Uploading ${basename(imagePath)} to cloud...`);
  const up = await client.uploadImage(imagePath, 'input', true);
  console.log(`  → ${up.name}`);

  const wf = buildWorkflow({ imageRefName: up.name, prompt, loraStrength: strength });
  writeFileSync('/tmp/last_flux2dev_wf.json', JSON.stringify(wf, null, 2));
  console.log(`Workflow built (${Object.keys(wf).length} nodes). Submitting...`);

  // Submit and poll directly (bypassing the WS waiter for clearer errors).
  const submit = await fetch(`${cloudUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ prompt: wf }),
  });
  const sj = await submit.json() as { prompt_id?: string; node_errors?: Record<string, { errors?: Array<{ message: string; details?: string }> }>; error?: { message?: string } };
  if (!sj.prompt_id) {
    console.error('Submit error:', JSON.stringify(sj, null, 2).slice(0, 2000));
    process.exit(1);
  }
  console.log(`prompt_id=${sj.prompt_id}`);

  // Poll.
  const start = Date.now();
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await (await fetch(`${cloudUrl}/jobs/${sj.prompt_id}`, { headers: { Authorization: `Bearer ${apiKey}` } })).json() as {
      status?: string; execution_error?: { exception_type?: string; exception_message?: string };
      outputs?: Record<string, { images?: Array<{ filename: string; subfolder?: string; type?: string }> }>;
    };
    if (j.status === 'failed') {
      const ee = j.execution_error ?? {};
      console.error(`failed: ${ee.exception_type}: ${ee.exception_message?.slice(0, 1500)}`);
      process.exit(1);
    }
    if (j.status === 'completed' || j.status === 'success') {
      const elapsed = Math.floor((Date.now() - start) / 1000);
      console.log(`completed in ${elapsed}s`);
      const outputs = j.outputs ?? {};
      for (const [nid, no] of Object.entries(outputs)) {
        for (const im of no.images ?? []) {
          const target = outName || `${basename(imagePath, '.png')}_flux2dev_ma_${Date.now()}.png`;
          const saved = await client.downloadImage(im.filename, im.subfolder ?? '', im.type ?? 'output', target);
          console.log(`Saved: ${saved}`);
        }
      }
      return;
    }
    process.stdout.write(`\r  polling (${i * 2}s, status=${j.status})              `);
  }
  console.error('\ntimed out polling after 180s');
}

main().catch((e) => { console.error(e); process.exit(1); });
