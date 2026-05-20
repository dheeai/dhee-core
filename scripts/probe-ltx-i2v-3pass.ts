#!/usr/bin/env tsx
/**
 * Run ONE shot through the experimental LTX 2.3 i2v 3-pass cloud
 * workflow and save it beside the existing fl2v output for side-by-side
 * comparison.
 *
 * Why: the existing fl2v pipeline generates a first_frame AND a
 * near-identical last_frame for every shot, which roughly doubles the
 * image-generation cost. The hypothesis is that for subtle-motion
 * shots (dialogue close-ups, reaction beats) the last frame is a waste
 * — the video model could produce an equivalent result from first
 * frame + motion directive alone. This probe isolates that question.
 *
 * What it does:
 *   1. Reads the shot's first_frame PNG from assets/images
 *   2. Reads the shot's motion directive from prompts/motion
 *   3. Uploads first_frame to ComfyUI Cloud
 *   4. Loads workflows/cloud/ltx23_i2v_3pass_cloud.json
 *   5. Parameterizes via the manifest + `parameterizeGeneric`
 *   6. Submits, waits, downloads
 *   7. Copies the existing fl2v video next to it for easy compare
 *
 * Usage:
 *   pnpm tsx scripts/probe-ltx-i2v-3pass.ts <project> <scene> <shot>
 *
 * Example:
 *   pnpm tsx scripts/probe-ltx-i2v-3pass.ts sun_hadnt_yet_cleared-2 3 5
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, copyFileSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-ltx-i2v-3pass.ts <project> <scene> <shot>');
  process.exit(1);
}

const scene = parseInt(sceneArg, 10);
const shot = parseInt(shotArg, 10);
if (!Number.isFinite(scene) || !Number.isFinite(shot)) {
  console.error('scene and shot must be integers');
  process.exit(1);
}

// Resolve project dir (accepts name or name.dhee)
const projectRoot = resolve(process.cwd(), projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`);
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

const workflowPath = resolve(process.cwd(), 'workflows/cloud/ltx23_i2v_3pass_cloud.json');
const manifestPath = resolve(process.cwd(), 'workflows/cloud/ltx23_i2v_3pass_cloud.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));

// ── 1. Locate the first_frame image on disk ──
// Filename convention after c5d3c19: s{N}shot{M}_first_frame_klein_{nanoid}.png
const imagesDir = join(projectRoot, 'assets/images');
const firstFrameCandidates = readdirSync(imagesDir)
  .filter(f => new RegExp(`^s${scene}shot${shot}_first_frame_`).test(f) && f.endsWith('.png'))
  .sort(); // stable order; multiple candidates means regenerated shot, take the most recent
if (firstFrameCandidates.length === 0) {
  console.error(`No first_frame image found for scene ${scene} shot ${shot} in ${imagesDir}`);
  console.error(`  Expected pattern: s${scene}shot${shot}_first_frame_*.png`);
  process.exit(1);
}
const firstFrame = join(imagesDir, firstFrameCandidates.at(-1)!);
console.log(`first_frame: ${firstFrame}`);

// ── 2. Read the motion directive ──
const motionPath = join(projectRoot, `prompts/motion/scene_${scene}_shot_${shot}.json`);
if (!existsSync(motionPath)) {
  console.error(`Motion directive not found: ${motionPath}`);
  process.exit(1);
}
const motion = JSON.parse(readFileSync(motionPath, 'utf-8'));
const prompt = typeof motion.motionDirective === 'string' ? motion.motionDirective : '';
if (!prompt) {
  console.error(`Motion directive JSON has no 'motionDirective' field`);
  process.exit(1);
}
// The pipeline's standard prefix that LTX expects — matches what the
// provider prepends in production so we're comparing apples to apples.
const fullPrompt = `Make this image come alive with cinematic motion, smooth animation.\n\n${prompt}`;
console.log(`prompt: ${fullPrompt.slice(0, 200)}${fullPrompt.length > 200 ? '...' : ''}`);

// ── 3. Read the declared shot duration from scene_video_prompt ──
const scenePromptPath = join(projectRoot, `prompts/videos/scenes/scene_${scene}.json`);
let durationSeconds = 5;
if (existsSync(scenePromptPath)) {
  try {
    const s = JSON.parse(readFileSync(scenePromptPath, 'utf-8'));
    const shotRec = (s.shots ?? []).find((sh: { shotNumber?: number }) => sh.shotNumber === shot);
    if (typeof shotRec?.duration === 'number') durationSeconds = shotRec.duration;
  } catch { /* fall through to default */ }
}
console.log(`duration: ${durationSeconds}s`);

// ── 4. Upload first_frame ──
const outputDir = join(projectRoot, 'assets/videos/compare_fl2v_vs_i2v');
mkdirSync(outputDir, { recursive: true });

const client = new ComfyUIClient({ outputDir });
console.log('Uploading first_frame to ComfyUI Cloud...');
const upload = await client.uploadImage(firstFrame, 'input', true);
console.log(`  → ${upload.name}`);

// ── 5. Parameterize + submit ──
const seed = Math.floor(Math.random() * 0x7FFFFFFF);
const workflow = parameterizeGeneric(template, manifest, {
  prompt: fullPrompt,
  negative_prompt: '',  // keep the baked-in negative for now; empty string means "don't override"
  first_frame: upload.name,
  seed,
  filenamePrefix: `video/s${scene}shot${shot}_i2v3pass`,
  width: 640,
  height: 480,
  durationSeconds,
}) as Record<string, unknown>;

console.log(`Submitting to ComfyUI Cloud (seed=${seed})...`);
const start = Date.now();
// queueAndWaitWS = queue + open websocket + wait for completion in one call.
// Same call path ComfyUIProvider uses for video gen, so behavior matches production.
const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, (p) => {
  if (p.percentage !== undefined && p.message) {
    console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
  }
});
console.log(`  complete in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

// queueAndWaitWS already returns a flat ImageInfo[]. Combine with a
// history-based fallback in case the WS missed a trailing SAVE event.
const histImages = await client.getOutputImages(promptId);
const seenNames = new Set<string>();
const allOutputs = [...wsOutputs, ...histImages]
  .filter(i => /\.(mp4|webm|mov)$/i.test(i.filename))
  .filter(i => !seenNames.has(i.filename) && (seenNames.add(i.filename), true));

if (allOutputs.length === 0) {
  console.error('No video output found after completion.');
  console.error('  ws outputs:', wsOutputs.map(i => i.filename).join(','));
  console.error('  history outputs:', histImages.map(i => i.filename).join(','));
  process.exit(1);
}

const saved: string[] = [];
for (const item of allOutputs) {
  const target = `s${scene}shot${shot}_i2v3pass.mp4`;
  const dl = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
  saved.push(dl);
  break; // one video is enough
}

// ── 8. Copy the existing fl2v output alongside for comparison ──
const existingVideos = readdirSync(join(projectRoot, 'assets/videos/shots'))
  .filter(f => new RegExp(`^s${scene}shot${shot}_ltx23_`).test(f) && f.endsWith('.mp4'))
  .sort();
if (existingVideos.length > 0) {
  const src = join(projectRoot, 'assets/videos/shots', existingVideos.at(-1)!);
  const dst = join(outputDir, `s${scene}shot${shot}_fl2v_baseline.mp4`);
  copyFileSync(src, dst);
  console.log(`\nBaseline fl2v video: ${dst}`);
}

console.log(`\nNew i2v 3-pass video: ${saved[0]}`);
console.log(`\nOpen both in Finder: ${outputDir}`);
