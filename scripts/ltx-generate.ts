#!/usr/bin/env tsx
/**
 * Re-run a single shot through LTX-2.3 (ComfyUI) using the same first-frame
 * image and motion prompt as an existing LTX shot. Companion to
 * scripts/seedance-generate.ts so both models can be compared side-by-side.
 *
 * Defaults to noir_detective_story_setup-3 scene 1 shot 3.
 *
 * Usage:
 *   pnpm tsx scripts/ltx-generate.ts \
 *     --image path/to/first_frame.png \
 *     --prompt "..." \
 *     --out-name ltx_rerun_scene_1_shot_3.mp4
 */

import 'dotenv/config';
import { existsSync, mkdirSync, renameSync } from 'fs';
import { dirname, resolve } from 'path';
import { ComfyUIProvider } from '../src/services/providers/comfyui/ComfyUIProvider.js';
import { getComfyConfig } from '../src/services/comfyui/ComfyUIClient.js';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

const DEFAULTS = {
  prompt:
    'Vikram at table, surges to his feet shoving chair backward scraping across floor, quick upward tilt from low angle, flickering torch atmosphere, cinematic tone, emphasis on rising motion and chair slide',
  image: resolve(
    REPO_ROOT,
    'noir_detective_story_setup-3.dhee/assets/images/3EM5uGKF_4a8e0293e3a8d48aab3b3ff7da43b6792fd9c5b05f45aa595e116657ad4e8068.png',
  ),
  lastFrame: resolve(
    REPO_ROOT,
    'noir_detective_story_setup-3.dhee/assets/images/jEVt3EYI_c480c09fc914c21debde5f83d54b44daed83fa98f723b8e5e4e4173aca6b1c6d.png',
  ),
  outDir: resolve(REPO_ROOT, 'noir_detective_story_setup-3.dhee/assets/videos/compare_seedance_vs_ltx'),
  outName: 'ltx_rerun_scene_1_shot_3.mp4',
  duration: 4,
  width: 848,
  height: 480,
};

function arg(name: string): string | undefined {
  const idx = process.argv.findIndex(a => a === `--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

async function main() {
  const prompt = arg('prompt') ?? DEFAULTS.prompt;
  const imagePath = resolve(arg('image') ?? DEFAULTS.image);
  const lastFrameArg = arg('last-frame') ?? DEFAULTS.lastFrame;
  const lastFramePath = lastFrameArg === 'none' ? undefined : resolve(lastFrameArg);
  const outDir = resolve(arg('out-dir') ?? DEFAULTS.outDir);
  const outName = arg('out-name') ?? DEFAULTS.outName;
  const duration = Number(arg('duration') ?? DEFAULTS.duration);
  const width = Number(arg('width') ?? DEFAULTS.width);
  const height = Number(arg('height') ?? DEFAULTS.height);
  const seedArg = arg('seed');
  const seed = seedArg ? Number(seedArg) : undefined;

  if (!existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const comfy = getComfyConfig();
  console.log('Model       : LTX-2.3 (ComfyUI)');
  console.log('COMFY_MODE  :', process.env.COMFY_MODE ?? 'local');
  console.log('ComfyUI URL :', comfy.baseUrl);
  console.log('Prompt      :', prompt);
  console.log('First frame :', imagePath);
  console.log('Last frame  :', lastFramePath ?? '(none — pure i2v)');
  console.log('Size        :', `${width}x${height}`);
  console.log('Duration    :', duration, 's');
  if (seed !== undefined) console.log('Seed        :', seed);
  console.log('Out         :', resolve(outDir, outName));
  console.log('');

  const provider = new ComfyUIProvider();
  if (!provider.isAvailable()) {
    console.error('ComfyUIProvider not available (check COMFYUI_BASE_URL).');
    process.exit(1);
  }

  const started = Date.now();
  let lastPct = -1;

  const result = await provider.generateVideo(
    {
      sourceImagePath: imagePath,
      prompt,
      durationSeconds: duration,
      width,
      height,
      seed,
      outputDir: outDir,
      filenamePrefix: 'ltx_rerun',
      modeId: lastFramePath ? 'flfv' : 'i2v',
      frameImages: lastFramePath ? { last_frame: lastFramePath } : undefined,
    },
    info => {
      const pct = Math.round(info.percentage ?? 0);
      if (pct !== lastPct) {
        const elapsed = Math.round((Date.now() - started) / 1000);
        console.log(`[${elapsed}s] ${pct}% ${info.message ?? ''}`);
        lastPct = pct;
      }
    },
  );

  const finalPath = resolve(outDir, outName);
  if (result.filePath !== finalPath) {
    renameSync(result.filePath, finalPath);
  }

  console.log('');
  console.log('Wrote:', finalPath);
  console.log('Raw provider output:', result.filePath);
  console.log('Workflow:', result.metadata?.workflowName ?? 'ltx23');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
