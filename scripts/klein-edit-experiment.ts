#!/usr/bin/env tsx
/**
 * One-off experiment: ask Flux Klein to "edit" shot 1's image into shot 2,
 * using maya + tom character refs as additional reference images.
 *
 * Compares against the bundle-generated shot_2_first.png (which Klein
 * produced from setting + char refs only, without seeing shot_1).
 *
 * Outputs to: <project>/assets/images/shots/scene_1_shot_2_from_shot_1.png
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

const PROJECT_DIR = '/Users/ganaraj/dhee-studios/Coffee Shop Meet';
const BUNDLE_DIR = resolve('src/dag/bundles/narrative_prompt_relay');
// Bundle ships `klein.json` (renamed from flux2_klein_edit_cloud.json).
const WORKFLOW_FILE = 'klein.json';

// CLI args:
//   --base <shotId>        base image to edit (default: scene_1_shot_1)
//   --target <shotId>      borrow this shot's prompt (default: scene_1_shot_2)
//   --prompt "<text>"      OR override the prompt entirely with this text
//   --out <filename>       output filename (default: derived from args)
function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}
const BASE_SHOT = arg('base', 'scene_1_shot_1');
const TARGET_SHOT = arg('target', 'scene_1_shot_2');
const CUSTOM_PROMPT = arg('prompt', '');
const OUT_NAME = arg('out', '');

async function main() {
  const cloudUrl = process.env['ENDPOINT_public_cloud'];
  if (!cloudUrl) {
    console.error('ENDPOINT_public_cloud env not set');
    process.exit(1);
  }

  // Resolve prompt: explicit --prompt wins, else fall back to target shot's prompt.
  let promptText: string;
  if (CUSTOM_PROMPT) {
    promptText = CUSTOM_PROMPT;
    console.log(`Editing ${BASE_SHOT}.png with CUSTOM prompt:`);
    console.log(`  "${promptText}"`);
  } else {
    const targetPromptFile = JSON.parse(
      readFileSync(join(PROJECT_DIR, `prompts/shot_image/${TARGET_SHOT}.json`), 'utf-8'),
    ) as { imagePrompt: string };
    promptText = targetPromptFile.imagePrompt;
    console.log(`Editing ${BASE_SHOT}.png → ${TARGET_SHOT} (using ${TARGET_SHOT}'s prompt)`);
  }

  const workflow = JSON.parse(
    readFileSync(join(BUNDLE_DIR, 'workflows', WORKFLOW_FILE), 'utf-8'),
  ) as Record<string, { inputs: Record<string, unknown>; class_type: string }>;

  const shot1Path = join(PROJECT_DIR, `assets/images/shots/${BASE_SHOT}_first.png`);
  const mayaPath = join(PROJECT_DIR, 'assets/images/characters/maya.png');
  const tomPath = join(PROJECT_DIR, 'assets/images/characters/tom.png');
  const settingPath = join(PROJECT_DIR, 'assets/images/settings/sunlit_coffee_shop.png');

  const client = new ComfyUIClient({
    outputDir: join(PROJECT_DIR, 'assets/images/shots'),
    baseUrl: cloudUrl,
  });

  console.log('Uploading reference images to cloud Comfy...');
  const shot1Up = await client.uploadImage(shot1Path, 'input', true);
  console.log(`  shot_1 (base): ${shot1Up.name}`);
  const mayaUp = await client.uploadImage(mayaPath, 'input', true);
  console.log(`  maya (ref):    ${mayaUp.name}`);
  const tomUp = await client.uploadImage(tomPath, 'input', true);
  console.log(`  tom (ref):     ${tomUp.name}`);
  const settingUp = await client.uploadImage(settingPath, 'input', true);
  console.log(`  setting (ref): ${settingUp.name}`);

  // Per manifest: prompt→109.text, base→76.image, ref1→81.image, ref2→82.image, ref3→83.image
  // ALL 4 LoadImage slots MUST be set; the workflow JSON hardcodes placeholder
  // filenames as defaults and Comfy fails the workflow if any slot points
  // at a non-existent placeholder.
  workflow['109']!.inputs['text'] = promptText;
  workflow['76']!.inputs['image'] = shot1Up.name;       // base = shot 1
  workflow['81']!.inputs['image'] = mayaUp.name;        // ref 1 = maya
  workflow['82']!.inputs['image'] = tomUp.name;         // ref 2 = tom
  workflow['83']!.inputs['image'] = settingUp.name;     // ref 3 = setting (avoids placeholder)

  // Seed + filename prefix.
  const seed = Math.floor(Math.random() * 0x7fffffff);
  if (workflow['92:73']) workflow['92:73']!.inputs['noise_seed'] = seed;
  if (workflow['94']) workflow['94']!.inputs['filename_prefix'] = 'klein_edit_experiment';

  // 16:9 at 1920x1080.
  const w = 1920, h = 1080;
  for (const nodeId of ['92:66', '92:62']) {
    if (workflow[nodeId]) {
      workflow[nodeId]!.inputs['width'] = w;
      workflow[nodeId]!.inputs['height'] = h;
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
    console.error('No image output from Comfy');
    process.exit(1);
  }
  const item = all[0]!;
  const target = OUT_NAME || (CUSTOM_PROMPT
    ? `${BASE_SHOT}_edited_${Date.now()}.png`
    : `${TARGET_SHOT}_from_${BASE_SHOT}.png`);
  const downloaded = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
  console.log(`\nSaved: ${downloaded}`);
  console.log(`Compare against: ${join(PROJECT_DIR, 'assets/images/shots/scene_1_shot_2_first.png')}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
