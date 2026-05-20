#!/usr/bin/env tsx
/**
 * Diagnostic: does BatchImagesNode (new workflow) aggregate images into
 * one multi-ref edit, or does it iterate one-edit-per-image like the
 * old AILab_ImageToList did?
 *
 * Sends exactly 2 images — S2.5 first_frame as base + Laila ref — and
 * counts the output files. Expected reading:
 *   - 1 output  → BatchImagesNode is a true multi-ref aggregator
 *   - 2 outputs → batch iterator (same failure mode as AILab)
 *
 * Uses model grok-imagine-image-beta (from the new workflow template).
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const PROJECT_DIR = join(REPO_ROOT, 'noir_detective_story_setup-3.dhee');

async function main() {
  const project = JSON.parse(readFileSync(join(PROJECT_DIR, 'project.json'), 'utf-8'));
  const nodes = project.executorState.nodes;
  const shotNode = nodes['shot_image:scene_2_shot_5'];
  const firstFrameRel = shotNode.outputPaths.first_frame;
  const baseAbs = join(PROJECT_DIR, firstFrameRel);
  // Use Laila ref only — she's the subject of the edit prompt
  const lailaRefAbs = join(PROJECT_DIR, nodes['character_image:laila'].outputPath);

  const shotPrompt = JSON.parse(readFileSync(join(PROJECT_DIR, 'prompts/images/shots/scene-2-shot-5.json'), 'utf-8'));
  const editPrompt = shotPrompt.frames.last_frame.imagePrompt;

  const outDir = join(PROJECT_DIR, 'assets/videos/compare_grok_vs_klein');
  mkdirSync(outDir, { recursive: true });

  console.log('=== Grok BatchImagesNode 2-image probe ===');
  console.log(`Base : ${baseAbs.split('/').pop()}`);
  console.log(`Ref  : ${lailaRefAbs.split('/').pop()} (Laila character ref)`);
  console.log('');

  const client = new ComfyUIClient({ outputDir: outDir });

  const baseUpload = await client.uploadImage(baseAbs, 'input', true);
  const lailaUpload = await client.uploadImage(lailaRefAbs, 'input', true);

  const seed = Math.floor(Math.random() * 1_000_000_000);

  // Workflow: 2 images via BatchImagesNode (images.image0 + images.image1)
  const workflow: Record<string, unknown> = {
    '3': {
      inputs: { filename_prefix: 'Grok_batch2', images: ['8', 0] },
      class_type: 'SaveImage',
      _meta: { title: 'Save Image' },
    },
    '6': {
      inputs: { image: baseUpload.name },
      class_type: 'LoadImage',
      _meta: { title: 'Load Image (base)' },
    },
    '10': {
      inputs: { image: lailaUpload.name },
      class_type: 'LoadImage',
      _meta: { title: 'Load Image (laila ref)' },
    },
    '13': {
      inputs: {
        'images.image0': ['6', 0],
        'images.image1': ['10', 0],
      },
      class_type: 'BatchImagesNode',
      _meta: { title: 'Batch Images' },
    },
    '8': {
      inputs: {
        model: 'grok-imagine-image-beta',
        prompt: editPrompt,
        resolution: '1K',
        number_of_images: 1,
        seed,
        aspect_ratio: 'auto',
        image: ['13', 0],
      },
      class_type: 'GrokImageEditNode',
      _meta: { title: 'Grok Image Edit' },
    },
  };

  console.log(`Submitting: 2 images, seed=${seed}...`);
  const start = Date.now();
  const { result: execResult, promptId, outputs } = await client.queueAndWaitWS(workflow, (info) => {
    const t = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  [${t}s] ${info.message ?? ''}                 `);
  });
  console.log(`\n  promptId=${promptId}, status=${execResult.status}`);

  if (execResult.status !== 'completed') {
    console.error('Job failed');
    process.exit(1);
  }

  console.log(`\n*** OUTPUT COUNT: ${outputs?.length ?? 0} ***\n`);
  for (const o of outputs ?? []) {
    console.log(`  node ${o.node_id ?? '?'}: ${o.filename}`);
  }

  // Download all outputs for inspection
  for (let i = 0; i < (outputs?.length ?? 0); i++) {
    const o = outputs![i]!;
    const localName = `s2s5_grok_batch2_${i + 1}.png`;
    await client.downloadImage(o.filename, o.subfolder ?? '', o.type ?? 'output', localName);
  }

  console.log('\nDownloaded outputs:');
  for (let i = 0; i < (outputs?.length ?? 0); i++) {
    const p = join(outDir, `s2s5_grok_batch2_${i + 1}.png`);
    console.log(`  ${p}`);
  }
  console.log('\nInterpretation:');
  console.log(`  1 output  → BatchImagesNode aggregates (true multi-ref) ✅`);
  console.log(`  2 outputs → batch iterator (same problem) ❌`);
  console.log(`Got: ${outputs?.length ?? 0}`);
}

main().catch(e => { console.error(e); process.exit(1); });
