#!/usr/bin/env tsx
/**
 * Klein on local Comfy with the lovis93/Flux-2-Multi-Angles-LoRA-v2
 * stacked on top, for "give me side B / reverse angle" experiments.
 *
 * The LoRA expects this prompt prefix:
 *   <sks> {view} {elevation} shot {distance}
 *
 * Views: front, front-right quarter, right side, back-right quarter,
 *        back, back-left quarter, left side, front-left quarter
 * Elevations: eye-level, low-angle, mid-low, mid-angle, high-mid,
 *             high-angle, steep-mid, steep-angle, overhead
 * Distances: close-up, medium, wide
 *
 * Recommended strength: 0.8 – 1.0
 *
 * The local Klein workflow is patched at submission time to insert a
 * LoraLoader between UNETLoader+CLIPLoader and their downstream
 * consumers (CFGGuider, CLIPTextEncode), so the bundle's on-disk
 * workflow doesn't have to change.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

const LOCAL_WORKFLOW = resolve('workflows/built-in/flux2_klein_edit_local.json');
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
  if (!imagePath || !userPrompt) {
    console.error('Usage: klein-local-multiangle --image <path> --prompt "<text>" [--view back] [--elevation eye-level] [--distance wide] [--lora-strength 0.9] [--out name]');
    process.exit(1);
  }

  const localUrl = process.env['ENDPOINT_self_local'];
  if (!localUrl) {
    console.error('ENDPOINT_self_local env not set');
    process.exit(1);
  }

  // Load workflow.
  const workflow = JSON.parse(readFileSync(LOCAL_WORKFLOW, 'utf-8')) as Record<
    string,
    { inputs: Record<string, unknown>; class_type: string; _meta?: { title?: string } }
  >;

  // ── Patch in a LoraLoader between UNETLoader/CLIPLoader and their consumers.
  // Original wiring (verified):
  //   - 92:63 (CFGGuider).model      → 92:70 (UNETLoader)
  //   - 92:74 (CLIPTextEncode).clip  → 92:71 (CLIPLoader)
  // After patch:
  //   - new node "LORA_MA" = LoraLoader(model=92:70[0], clip=92:71[0], lora_name=..., strength=...)
  //   - 92:63.model      → LORA_MA[0]
  //   - 92:74.clip       → LORA_MA[1]
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
  // Rewire CFGGuider.model and CLIPTextEncode.clip.
  workflow['92:63']!.inputs['model'] = [loraNodeId, 0];
  workflow['92:74']!.inputs['clip'] = [loraNodeId, 1];

  // ── Compose the multi-angle prefix + user prompt.
  const prefix = `<sks> ${view} ${elevation} shot ${distance}`;
  const fullPrompt = `${prefix}, ${userPrompt}`;
  console.log(`LoRA prefix: ${prefix}`);
  console.log(`Full prompt: ${fullPrompt.slice(0, 200)}${fullPrompt.length > 200 ? '…' : ''}`);

  // Upload + wire image to all 4 LoadImage slots (avoids placeholder crash).
  const outputDir = dirname(imagePath);
  const client = new ComfyUIClient({ outputDir, baseUrl: localUrl });
  console.log(`Uploading ${basename(imagePath)} to ${localUrl}...`);
  const up = await client.uploadImage(imagePath, 'input', true);
  console.log(`  → ${up.name}`);

  workflow['109']!.inputs['text'] = fullPrompt;
  for (const nodeId of ['76', '81', '82', '83']) {
    if (workflow[nodeId]) workflow[nodeId]!.inputs['image'] = up.name;
  }

  const seed = Math.floor(Math.random() * 0x7fffffff);
  if (workflow['92:73']) workflow['92:73']!.inputs['noise_seed'] = seed;
  if (workflow['94']) workflow['94']!.inputs['filename_prefix'] = 'klein_local_multiangle';
  for (const nodeId of ['92:66', '92:62']) {
    if (workflow[nodeId]) {
      workflow[nodeId]!.inputs['width'] = 1920;
      workflow[nodeId]!.inputs['height'] = 1080;
    }
  }

  console.log(`Submitting to local Comfy (seed=${seed})...`);
  const start = Date.now();
  const { promptId, outputs } = await client.queueAndWaitWS(workflow, (p) => {
    if (p.percentage !== undefined && p.message) {
      process.stdout.write(`\r  [${p.percentage.toFixed(0)}%] ${p.message}              `);
    }
  });
  console.log(`\n  done in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

  const hist = await client.getOutputImages(promptId);
  const all = [...outputs, ...hist].filter((o) => /\.png$/i.test(o.filename));
  if (all.length === 0) { console.error('No image output'); process.exit(1); }
  const item = all[0]!;
  const target = outName || `${basename(imagePath, '.png')}_local_${view.replace(/\s+/g, '_')}_${Date.now()}.png`;
  const saved = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
  console.log(`Saved: ${saved}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
