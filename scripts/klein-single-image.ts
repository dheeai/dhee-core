#!/usr/bin/env tsx
/**
 * Klein with ONLY ONE source image as visual input.
 *
 * The bundle's Klein workflow has 4 LoadImage slots and a hard
 * "all 4 must exist" requirement on cloud Comfy. To effectively give
 * Klein "1 image input", we upload that single image and wire it to
 * all 4 slots — the model gets one source of visual information.
 *
 * Use case: "show me Side B / the reverse angle of this location."
 *
 * Args:
 *   --image <path>     required, path to the image
 *   --prompt "<text>"  required, the edit instruction
 *   --out <filename>   optional, output filename in same dir as input
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

const BUNDLE_DIR = resolve('src/dag/bundles/narrative_prompt_relay');
const WORKFLOW_FILE = 'klein.json';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

async function main() {
  const imagePath = arg('image', '');
  const prompt = arg('prompt', '');
  const outName = arg('out', '');
  if (!imagePath || !prompt) {
    console.error('Usage: klein-single-image --image <path> --prompt "<text>" [--out <name>]');
    process.exit(1);
  }

  const cloudUrl = process.env['ENDPOINT_public_cloud'] ?? 'https://cloud.comfy.org/api';

  const workflow = JSON.parse(
    readFileSync(join(BUNDLE_DIR, 'workflows', WORKFLOW_FILE), 'utf-8'),
  ) as Record<string, { inputs: Record<string, unknown>; class_type: string }>;

  const outputDir = dirname(imagePath);
  const client = new ComfyUIClient({ outputDir, baseUrl: cloudUrl });

  console.log(`Uploading ${basename(imagePath)} (single source)...`);
  const up = await client.uploadImage(imagePath, 'input', true);
  console.log(`  → ${up.name}`);

  workflow['109']!.inputs['text'] = prompt;
  // Wire the single image into all 4 LoadImage slots — Comfy doesn't
  // let us cleanly disconnect them, so we duplicate.
  workflow['76']!.inputs['image'] = up.name;
  workflow['81']!.inputs['image'] = up.name;
  workflow['82']!.inputs['image'] = up.name;
  workflow['83']!.inputs['image'] = up.name;

  const seed = Math.floor(Math.random() * 0x7fffffff);
  if (workflow['92:73']) workflow['92:73']!.inputs['noise_seed'] = seed;
  if (workflow['94']) workflow['94']!.inputs['filename_prefix'] = 'klein_single';
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
  if (all.length === 0) { console.error('No image output'); process.exit(1); }
  const item = all[0]!;
  const target = outName || `${basename(imagePath, '.png')}_edited_${Date.now()}.png`;
  const saved = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
  console.log(`Saved: ${saved}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
