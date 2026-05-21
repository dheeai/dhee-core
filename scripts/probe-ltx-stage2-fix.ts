#!/usr/bin/env tsx
/**
 * Validate the Stage-2 conditioning fix for ltx23_fl2v_cloud.
 *
 * Bug: node 35 (LTXVImgToVideoInplace) feeds first_frame ONLY into the
 * high-res refinement pass. Stage 1's FL2V conditioning (node 210) is
 * applied to the initial latent, but Stage 2 re-injects first-frame-only
 * conditioning on the upsampled latent — diluting the last_frame anchor.
 * The final pixels drift away from the intended endpoint.
 *
 * Patch (applied in-memory; production workflow untouched until
 * validation passes): swap node 35 to LTXVImgToVideoInplaceKJ mirroring
 * node 210 — multi-frame conditioning with index_1=0, index_2=-1, using
 * the already-existing preprocessed frames at nodes 31 (first) and 50
 * (last).
 *
 * Usage:
 *   pnpm tsx scripts/probe-ltx-stage2-fix.ts <project> <scene> <shot>
 *
 * Example:
 *   pnpm tsx scripts/probe-ltx-stage2-fix.ts Ruby 2 17
 *
 * Output:
 *   <project>/assets/videos/compare_stage2_fix/
 *     s{N}shot{M}_stage2_old.mp4     (existing buggy render)
 *     s{N}shot{M}_stage2_fixed.mp4   (newly rendered with node-35 patch)
 *     s{N}shot{M}_first_frame.png
 *     s{N}shot{M}_last_frame.png
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-ltx-stage2-fix.ts <project> <scene> <shot>');
  process.exit(1);
}

const scene = parseInt(sceneArg, 10);
const shot = parseInt(shotArg, 10);
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.kshana') ? projectArg : `${projectArg}.kshana`,
);
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

const workflowPath = resolve(process.cwd(), 'workflows/cloud/ltx23_fl2v_cloud.json');
const manifestPath = resolve(process.cwd(), 'workflows/cloud/ltx23_fl2v_cloud.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));

// ── Apply Stage-2 conditioning patch in-memory ──
//
// Stage 1 (node 210, LTXVImgToVideoInplaceKJ) is correct: it takes both
// first (image_1=31) and last (image_2=50) frames with indices 0 and -1.
// Stage 2 (node 35) currently uses LTXVImgToVideoInplace with image=42
// (first frame only). The patch mirrors node 210's structure on node 35.
const originalNode35 = template['35'];
if (!originalNode35 || originalNode35.class_type !== 'LTXVImgToVideoInplace') {
  console.error('FAIL: node 35 missing or not LTXVImgToVideoInplace — workflow may have changed.');
  console.error(`  found: ${originalNode35?.class_type ?? '<missing>'}`);
  process.exit(1);
}

template['35'] = {
  class_type: 'LTXVImgToVideoInplaceKJ',
  _meta: { title: 'LTXVImgToVideoInplaceKJ (Stage 2 — patched)' },
  inputs: {
    num_images: '2',
    'num_images.strength_1': 1,
    'num_images.strength_2': 1,
    'num_images.index_1': 0,
    'num_images.index_2': -1,
    vae: ['181', 0],
    latent: ['25', 0],
    'num_images.image_1': ['31', 0],   // preprocessed first frame
    'num_images.image_2': ['50', 0],   // preprocessed last frame
  },
};

// Persist the patched workflow alongside outputs for inspection.
const outputDir = join(projectRoot, 'assets/videos/compare_stage2_fix');
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'patched_workflow.json'), JSON.stringify(template, null, 2));

// ── Locate real first/last frame PNGs ──
const imagesDir = join(projectRoot, 'assets/images');
const pickLatest = (prefix: string) => {
  const hits = readdirSync(imagesDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.png'))
    .sort();
  return hits.at(-1);
};
const firstFrameFile = pickLatest(`s${scene}shot${shot}_first_frame_`);
const lastFrameFile = pickLatest(`s${scene}shot${shot}_last_frame_`);
if (!firstFrameFile || !lastFrameFile) {
  console.error(`Missing frame images for s${scene}shot${shot}`);
  console.error(`  first_frame: ${firstFrameFile ?? 'NOT FOUND'}`);
  console.error(`  last_frame:  ${lastFrameFile ?? 'NOT FOUND'}`);
  process.exit(1);
}
const firstFrame = join(imagesDir, firstFrameFile);
const lastFrame = join(imagesDir, lastFrameFile);

// ── Read the real motion directive ──
const motionPath = join(projectRoot, `prompts/motion/scene_${scene}_shot_${shot}.json`);
if (!existsSync(motionPath)) {
  console.error(`Motion directive not found: ${motionPath}`);
  process.exit(1);
}
const motionJson = JSON.parse(readFileSync(motionPath, 'utf-8'));
const directive = typeof motionJson.motionDirective === 'string' ? motionJson.motionDirective : '';
if (!directive) {
  console.error(`motionDirective field missing in ${motionPath}`);
  process.exit(1);
}
const prompt = `Make this image come alive with cinematic motion, smooth animation.\n\n${directive}`;

// ── Read duration from scene_video_prompt ──
const sceneJsonPath = join(projectRoot, `prompts/videos/scenes/scene_${scene}.json`);
let durationSeconds = 5;
if (existsSync(sceneJsonPath)) {
  try {
    const sj = JSON.parse(readFileSync(sceneJsonPath, 'utf-8'));
    const shotRec = (sj.shots ?? []).find((s: { shotNumber?: number }) => s.shotNumber === shot);
    if (typeof shotRec?.duration === 'number') durationSeconds = shotRec.duration;
  } catch { /* keep default */ }
}

console.log(`project:       ${projectArg}`);
console.log(`shot:          scene ${scene}, shot ${shot}`);
console.log(`first_frame:   ${firstFrameFile}`);
console.log(`last_frame:    ${lastFrameFile}`);
console.log(`duration:      ${durationSeconds}s`);
console.log(`directive:     ${directive.slice(0, 160)}${directive.length > 160 ? '...' : ''}`);
console.log(`PATCH:         node 35 ${originalNode35.class_type} → LTXVImgToVideoInplaceKJ (both frames)`);

const client = new ComfyUIClient({ outputDir });

console.log('\nUploading first_frame...');
const upFirst = await client.uploadImage(firstFrame, 'input', true);
console.log(`  → ${upFirst.name}`);

console.log('Uploading last_frame...');
const upLast = await client.uploadImage(lastFrame, 'input', true);
console.log(`  → ${upLast.name}`);

const seed = Math.floor(Math.random() * 0x7FFFFFFF);
const workflow = parameterizeGeneric(template, manifest, {
  prompt,
  negative_prompt: '',
  first_frame: upFirst.name,
  last_frame: upLast.name,
  seed,
  filenamePrefix: `video/s${scene}shot${shot}_stage2fix`,
  width: 640,
  height: 480,
  durationSeconds,
}) as Record<string, unknown>;

console.log(`\nSubmitting to ComfyUI Cloud (seed=${seed})...`);
const start = Date.now();
const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, p => {
  if (p.percentage !== undefined && p.message) {
    console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
  }
});
console.log(`  complete in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

const histImages = await client.getOutputImages(promptId);
const seen = new Set<string>();
const videoOutputs = [...wsOutputs, ...histImages]
  .filter(i => /\.(mp4|webm|mov)$/i.test(i.filename))
  .filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));

if (videoOutputs.length === 0) {
  console.error('No video output found. WS outputs:', wsOutputs.map(i => i.filename).join(','));
  console.error('  history outputs:', histImages.map(i => i.filename).join(','));
  process.exit(1);
}

console.log('\nDownloading...');
for (const item of videoOutputs) {
  const target = `s${scene}shot${shot}_stage2_fixed.mp4`;
  const dl = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
  console.log(`  → ${dl}`);
  break;
}

// ── Copy baseline (pre-fix) video for side-by-side ──
const existingVideos = readdirSync(join(projectRoot, 'assets/videos/shots'))
  .filter(f => new RegExp(`^s${scene}shot${shot}_ltx23_`).test(f) && f.endsWith('.mp4'))
  .sort();
if (existingVideos.length > 0) {
  const src = join(projectRoot, 'assets/videos/shots', existingVideos.at(-1)!);
  const dst = join(outputDir, `s${scene}shot${shot}_stage2_old.mp4`);
  copyFileSync(src, dst);
  console.log(`\nBaseline (Stage-2 buggy): ${dst}`);
}

copyFileSync(firstFrame, join(outputDir, `s${scene}shot${shot}_first_frame.png`));
copyFileSync(lastFrame, join(outputDir, `s${scene}shot${shot}_last_frame.png`));

console.log(`\nOpen in Finder: ${outputDir}`);
console.log('If the fix works, the "_stage2_fixed" video should visibly END close to the last_frame composition');
console.log('and the motion should track toward that endpoint, while the "_stage2_old" baseline drifts away.');
