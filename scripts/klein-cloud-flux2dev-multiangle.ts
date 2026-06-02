#!/usr/bin/env tsx
/**
 * Try the lovis93 Multi-Angles LoRA on Comfy Cloud with Flux-2-dev as
 * the base model (the LoRA's actual training base).
 *
 * Strategy:
 *   - Load the local Klein workflow as a template (same graph topology)
 *   - Swap UNETLoader's unet_name from 'flux-2-klein-9b-kv.safetensors'
 *     to 'flux2-dev.safetensors' (the Flux 2 dev base)
 *   - Inject a LoraLoader between UNET/CLIP loaders and consumers
 *   - Submit to cloud Comfy
 *
 * If the cloud doesn't have flux2-dev or the multi-angle LoRA, the
 * call returns a clear "file not found" execution error we can read.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

const TEMPLATE_WORKFLOW = resolve('workflows/built-in/flux2_klein_edit_local.json');
const FLUX2_DEV_UNET = 'flux2-dev.safetensors';
const LORA_NAME = 'flux-multi-angles-v2-72poses-comfy.safetensors';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

async function main() {
  const imagePath = arg('image', '');
  const userPrompt = arg('prompt', '');
  const view = arg('view', 'back');
  const elevation = arg('elevation', 'eye-level');
  const distance = arg('distance', 'wide');
  const loraStrength = parseFloat(arg('lora-strength', '0.9'));
  const outName = arg('out', '');
  const unetName = arg('unet', FLUX2_DEV_UNET);
  if (!imagePath || !userPrompt) {
    console.error('Usage: klein-cloud-flux2dev-multiangle --image <path> --prompt "<text>" [--view back] [--elevation eye-level] [--distance wide] [--lora-strength 0.9] [--unet <filename>] [--out <name>]');
    process.exit(1);
  }

  const cloudUrl = process.env['ENDPOINT_public_cloud'] ?? process.env['COMFY_CLOUD_URL'] ?? 'https://cloud.comfy.org/api';

  const workflow = JSON.parse(readFileSync(TEMPLATE_WORKFLOW, 'utf-8')) as Record<
    string,
    { inputs: Record<string, unknown>; class_type: string; _meta?: { title?: string } }
  >;

  // Swap UNET to Flux 2 dev (the LoRA's actual training base).
  workflow['92:70']!.inputs['unet_name'] = unetName;

  // Inject LoraLoader between UNET+CLIP loaders and their consumers.
  const loraNodeId = 'LORA_MA';
  workflow[loraNodeId] = {
    class_type: 'LoraLoader',
    _meta: { title: `Multi-Angles LoRA (${loraStrength})` },
    inputs: {
      lora_name: LORA_NAME,
      strength_model: loraStrength,
      strength_clip: loraStrength,
      model: ['92:70', 0],
      clip: ['92:71', 0],
    },
  };
  workflow['92:63']!.inputs['model'] = [loraNodeId, 0];
  workflow['92:74']!.inputs['clip'] = [loraNodeId, 1];

  const prefix = `<sks> ${view} ${elevation} shot ${distance}`;
  const fullPrompt = `${prefix}, ${userPrompt}`;
  console.log(`Endpoint:    ${cloudUrl}`);
  console.log(`UNET:        ${unetName}`);
  console.log(`LoRA:        ${LORA_NAME} @ ${loraStrength}`);
  console.log(`LoRA prefix: ${prefix}`);
  console.log(`Full prompt: ${fullPrompt.slice(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);

  const outputDir = dirname(imagePath);
  const client = new ComfyUIClient({ outputDir, baseUrl: cloudUrl });
  console.log(`Uploading ${basename(imagePath)}...`);
  const up = await client.uploadImage(imagePath, 'input', true);
  console.log(`  → ${up.name}`);

  workflow['109']!.inputs['text'] = fullPrompt;
  for (const nodeId of ['76', '81', '82', '83']) {
    if (workflow[nodeId]) workflow[nodeId]!.inputs['image'] = up.name;
  }

  const seed = Math.floor(Math.random() * 0x7fffffff);
  if (workflow['92:73']) workflow['92:73']!.inputs['noise_seed'] = seed;
  if (workflow['94']) workflow['94']!.inputs['filename_prefix'] = 'cloud_flux2dev_ma';
  for (const nodeId of ['92:66', '92:62']) {
    if (workflow[nodeId]) {
      workflow[nodeId]!.inputs['width'] = 1920;
      workflow[nodeId]!.inputs['height'] = 1080;
    }
  }

  console.log(`Submitting (seed=${seed})...`);
  const start = Date.now();
  const { promptId, outputs } = await client.queueAndWaitWS(workflow, (p) => {
    if (p.percentage !== undefined && p.message) {
      process.stdout.write(`\r  [${p.percentage.toFixed(0)}%] ${p.message}              `);
    }
  });
  console.log(`\n  done in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

  const hist = await client.getOutputImages(promptId);
  const all = [...outputs, ...hist].filter((o) => /\.png$/i.test(o.filename));
  if (all.length === 0) {
    // Surface the execution error from the cloud history.
    console.error('No image output. Querying cloud for execution error...');
    const apiKey = process.env['COMFY_CLOUD_API_KEY'];
    if (apiKey) {
      const r = await fetch(`${cloudUrl}/jobs/${promptId}`, { headers: { Authorization: `Bearer ${apiKey}` } });
      const j = await r.json() as { execution_error?: { exception_message?: string; exception_type?: string } };
      if (j.execution_error) {
        console.error(`  ${j.execution_error.exception_type}: ${j.execution_error.exception_message}`);
      }
    }
    process.exit(1);
  }
  const item = all[0]!;
  const target = outName || `${basename(imagePath, '.png')}_cloud_f2d_${view.replace(/\s+/g, '_')}_${Date.now()}.png`;
  const saved = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
  console.log(`Saved: ${saved}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
