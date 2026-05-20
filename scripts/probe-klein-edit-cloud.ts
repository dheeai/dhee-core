#!/usr/bin/env tsx
/**
 * N=1 probe for the `flux2_klein_edit_cloud` workflow on ComfyUI Cloud.
 *
 * Goal: reproduce the error the BurgerEating run is hitting:
 *   `Shot image failed: Error: ComfyUI job did not complete (status: error)`
 *
 * The executor swallows the cloud-side reason. By driving the same
 * workflow + manifest directly we should see the real
 * `execution_error` payload from cloud (it surfaces via the WS
 * `execution_error` message in `queueAndWaitWS`).
 *
 * Uses BurgerEating assets as inputs:
 *   base = first-frame qwen output for s1 shot 1 (already on disk)
 *   ref_1 = arthur character ref
 *   ref_2 = maya character ref
 */
import 'dotenv/config';
import { readFileSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const projectDir = resolve(
  process.cwd(),
  '..',
  'BurgerEating.dhee',
);
const imagesDir = join(projectDir, 'assets/images');

function pickFirst(prefix: string): string {
  const files = readdirSync(imagesDir).filter(f =>
    f.startsWith(prefix) && /\.(png|jpe?g|webp)$/i.test(f),
  );
  if (files.length === 0) {
    throw new Error(`No file in ${imagesDir} matching prefix '${prefix}'`);
  }
  return join(imagesDir, files[0]!);
}

const basePath = pickFirst('s1shot1_first_frame_qwen_');
const arthurPath = pickFirst('CharRef_arthur_zimage_');
const mayaPath = pickFirst('CharRef_maya_zimage_');

console.log(`Klein cloud edit probe`);
console.log(`  base:    ${basePath}`);
console.log(`  ref_1:   ${arthurPath}`);
console.log(`  ref_2:   ${mayaPath}`);

const baseUrl = process.env['COMFYUI_BASE_URL'] ?? 'https://cloud.comfy.org/api';
const apiKey = process.env['COMFY_CLOUD_API_KEY'];
if (!apiKey) {
  console.error('COMFY_CLOUD_API_KEY is not set in env. Aborting.');
  process.exit(1);
}

const outDir = resolve(process.cwd(), 'logs/probe-klein-edit-cloud');
mkdirSync(outDir, { recursive: true });

const client = new ComfyUIClient({ baseUrl, apiKey, outputDir: outDir });

console.log(`\nUploading inputs to cloud…`);
const baseUp = await client.uploadImage(basePath, 'input', true);
const arthurUp = await client.uploadImage(arthurPath, 'input', true);
const mayaUp = await client.uploadImage(mayaPath, 'input', true);
console.log(`  base   → ${baseUp.name}`);
console.log(`  ref_1  → ${arthurUp.name}`);
console.log(`  ref_2  → ${mayaUp.name}`);

const workflowPath = resolve(
  process.cwd(),
  'workflows/cloud/flux2_klein_edit_cloud.json',
);
const manifestPath = resolve(
  process.cwd(),
  'workflows/cloud/flux2_klein_edit_cloud.manifest.json',
);
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

const PROMPT =
  'A weary detective sits at the diner counter, neon glow through the rain-streaked window, the waitress pouring coffee. Cinematic, 35mm.';
const SEED = 13;

const workflow = parameterizeGeneric(template, manifest, {
  prompt: PROMPT,
  base_image: baseUp.name,
  reference_image_1: arthurUp.name,
  reference_image_2: mayaUp.name,
  reference_image_3: baseUp.name, // fill unused slot (mirrors provider behaviour)
  seed: SEED,
  width: 1280,
  height: 720,
  filenamePrefix: 'klein_edit_probe/composite',
}) as Record<string, unknown>;

console.log(`\nSubmitting Klein edit (seed=${SEED})…`);
const t0 = Date.now();
let lastMsg = '';
const { result, promptId, outputs } = await client.queueAndWaitWS(
  workflow,
  info => {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const summary = `${info.percentage ?? 0}% ${info.message ?? ''}`.trim();
    if (summary !== lastMsg) {
      lastMsg = summary;
      process.stdout.write(
        `\r  [${elapsed}s] ${summary.slice(0, 90).padEnd(90)}`,
      );
    }
  },
);
const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n\nResult:`);
console.log(`  status:    ${result.status}`);
console.log(`  prompt_id: ${promptId}`);
console.log(`  outputs:   ${outputs?.length ?? 0}`);
console.log(`  total:     ${totalSec}s`);

if (result.status !== 'completed') {
  console.error(
    '\nProbe FAILED — see WS-level error log line above (look for `execution_error`).',
  );
  console.error(
    `Tail logs/debug.log for the cloud-side error payload that the executor swallows.`,
  );
  process.exit(1);
}

for (const o of outputs) {
  if (!/\.(png|jpe?g|webp)$/i.test(o.filename)) continue;
  const target = `seed_${SEED}_${o.filename.split('/').pop()}`;
  await client.downloadImage(
    o.filename,
    o.subfolder ?? '',
    o.type ?? 'output',
    target,
  );
  console.log(`  saved → ${join(outDir, target)}`);
}

console.log(`\nklein-edit cloud probe OK`);
