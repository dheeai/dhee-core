#!/usr/bin/env tsx
/**
 * Test the FIXED ltx23_fl2v_cloud workflow end-to-end on a real shot.
 *
 * What changed in the fix: node 210 (`LTXVImgToVideoInplaceKJ`) declared
 * `num_images = "2"` but `num_images.image_2` was never wired. The
 * last_frame chain flowed only into the `VHS_VideoCombine` preview
 * output — it never reached the samplers. We added the missing wire:
 * `num_images.image_2 ← LTXVPreprocess(50) ← last_frame`. See
 * `ltx23_fl2v_cloud.json` diff.
 *
 * This probe proves the fix actually reaches the video: it submits a
 * real shot (real first_frame, real last_frame, real motion directive)
 * through the fixed workflow and saves the output beside the existing
 * last-frame-ignored version so they can be compared visually.
 *
 * Usage:
 *   pnpm tsx scripts/probe-ltx-fl2v-fixed.ts <project> <scene> <shot>
 *
 * Example:
 *   pnpm tsx scripts/probe-ltx-fl2v-fixed.ts sun_hadnt_yet_cleared-2 1 6
 *
 * Output:
 *   <project>/assets/videos/compare_fl2v_fixed/
 *     s{N}shot{M}_fl2v_old.mp4         (pre-fix baseline, copied)
 *     s{N}shot{M}_fl2v_fixed.mp4       (newly rendered with last_frame wired)
 *     s{N}shot{M}_first_frame.png      (source frame for both)
 *     s{N}shot{M}_last_frame.png       (last frame anchor — the one
 *                                       that previously did nothing)
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-ltx-fl2v-fixed.ts <project> <scene> <shot>');
  process.exit(1);
}

const scene = parseInt(sceneArg, 10);
const shot = parseInt(shotArg, 10);
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`,
);
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

const workflowPath = resolve(process.cwd(), 'workflows/cloud/ltx23_fl2v_cloud.json');
const manifestPath = resolve(process.cwd(), 'workflows/cloud/ltx23_fl2v_cloud.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));

// Belt-and-suspenders: confirm the on-disk workflow has the fix. If
// someone's running this against a stale copy we want to know before
// burning cloud compute.
const fixedNode = template['210']?.inputs;
if (!fixedNode?.['num_images.image_2']) {
  console.error('FAIL: ltx23_fl2v_cloud.json is missing the num_images.image_2 wire on node 210.');
  console.error('      The last_frame wire fix has not been applied. Re-apply before running.');
  process.exit(1);
}

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
  console.error(`Missing frame images for s${scene}shot${shot}:`);
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

// ── Upload both frames ──
const outputDir = join(projectRoot, 'assets/videos/compare_fl2v_fixed');
mkdirSync(outputDir, { recursive: true });
const client = new ComfyUIClient({ outputDir });

console.log('\nUploading first_frame...');
const upFirst = await client.uploadImage(firstFrame, 'input', true);
console.log(`  → ${upFirst.name}`);

console.log('Uploading last_frame...');
const upLast = await client.uploadImage(lastFrame, 'input', true);
console.log(`  → ${upLast.name}`);

// ── Parameterize + submit ──
const seed = Math.floor(Math.random() * 0x7FFFFFFF);
const workflow = parameterizeGeneric(template, manifest, {
  prompt,
  negative_prompt: '',
  first_frame: upFirst.name,
  last_frame: upLast.name,
  seed,
  filenamePrefix: `video/s${scene}shot${shot}_fl2vfixed`,
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

// ── Collect output ──
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
  const target = `s${scene}shot${shot}_fl2v_fixed.mp4`;
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
  const dst = join(outputDir, `s${scene}shot${shot}_fl2v_old.mp4`);
  copyFileSync(src, dst);
  console.log(`\nBaseline (last_frame ignored): ${dst}`);
}

// Also copy the source PNGs for full context.
copyFileSync(firstFrame, join(outputDir, `s${scene}shot${shot}_first_frame.png`));
copyFileSync(lastFrame, join(outputDir, `s${scene}shot${shot}_last_frame.png`));

console.log(`\nOpen in Finder: ${outputDir}`);
console.log('If the fix works, the "fl2v_fixed" video should visibly END at the last_frame pose,');
console.log('while the "fl2v_old" baseline ignored the last_frame entirely.');
