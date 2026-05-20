#!/usr/bin/env tsx
/**
 * One-shot Grok-edit probe for the OTS failure case (s1 shot 6).
 *
 * Klein failed this composition 6/6 at six seeds. Grok's image-edit
 * model has different conditioning (BatchImagesNode + grok-imagine-
 * image-beta) and may partition character refs better than Klein's
 * cross-attention. This script tries exactly one Grok render with the
 * SAME prose, SAME refs, and the setting as the base_image (matching
 * how Klein composes first_frame in production).
 *
 * Per feedback (feedback_experiment_n1_first): N=1 first. If this
 * single render shows correct OTS role assignment, extend to 3-6 seeds.
 * If it's swapped or blended like Klein, abort this line of
 * investigation.
 *
 * Usage:
 *   pnpm tsx scripts/probe-grok-ots.ts <project> <scene> <shot>
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { buildGrokEditWorkflow } from '../src/services/providers/comfyui/grokWorkflowBuilder.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-grok-ots.ts <project> <scene> <shot>');
  process.exit(1);
}
const scene = parseInt(sceneArg, 10);
const shot = parseInt(shotArg, 10);
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`,
);

// Load the same shot prompt that fed Klein.
const shotPromptPath = join(projectRoot, `prompts/images/shots/scene-${scene}-shot-${shot}.json`);
const shotPrompt = JSON.parse(readFileSync(shotPromptPath, 'utf-8'));
const frame = shotPrompt.frames.first_frame;
const prompt: string = frame.imagePrompt;
const refs = frame.references as Array<{ imageNumber: number; type: string; refId: string }>;

// Resolve refs to paths via project.json executorState.
const projectJson = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8'));
const nodes = projectJson.executorState.nodes;
const resolvePath = (refId: string) => join(projectRoot, nodes[refId].outputPath);

const baseRef = refs.find(r => r.type === 'setting');
const charRefs = refs.filter(r => r.type === 'character');
if (!baseRef) {
  console.error('Probe requires a setting ref (base image). None in this shot.');
  process.exit(1);
}

// Grok caps at 3 images total (1 base + 2 refs). Take the first 2 chars.
const baseImagePath = resolvePath(baseRef.refId);
const refImagePaths = charRefs.slice(0, 2).map(r => resolvePath(r.refId));

console.log(`shot:       s${scene} shot ${shot} / first_frame`);
console.log(`base:       ${baseRef.refId}`);
console.log(`refs:       ${charRefs.slice(0, 2).map(r => r.refId).join(', ')}`);
console.log(`prompt:     ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}`);

const outDir = join(projectRoot, 'assets/images/probe_grok_ots');
mkdirSync(outDir, { recursive: true });
copyFileSync(baseImagePath, join(outDir, `ref_setting.png`));
for (const r of charRefs.slice(0, 2)) {
  copyFileSync(resolvePath(r.refId), join(outDir, `ref_${r.refId.replace(/.*:/, '')}.png`));
}

const client = new ComfyUIClient({ outputDir: outDir });
console.log(`\nUploading base (setting) and 2 char refs...`);
const baseUpload = await client.uploadImage(baseImagePath, 'input', true);
const refUploads: string[] = [];
for (const p of refImagePaths) {
  const u = await client.uploadImage(p, 'input', true);
  refUploads.push(u.name);
}
console.log(`  base → ${baseUpload.name}`);
refUploads.forEach((n, i) => console.log(`  ref${i + 1} → ${n}`));

const seed = 13; // same seed as v0_baseline_seed13 for apples-to-apples (Klein swapped at this seed)
console.log(`\nSubmitting to Grok (seed=${seed}, matches Klein baseline at seed 13)...`);
const workflow = buildGrokEditWorkflow({
  baseImage: baseUpload.name,
  refs: refUploads,
  prompt,
  seed,
  filenamePrefix: `grok_ots_s${scene}s${shot}_seed${seed}`,
  resolution: '1K',
  aspectRatio: 'auto',
});

const start = Date.now();
const { result, promptId, outputs } = await client.queueAndWaitWS(workflow, info => {
  if (info.percentage !== undefined && info.message) {
    process.stdout.write(`\r  [${Math.round((Date.now() - start) / 1000)}s] ${Math.round(info.percentage)}%  ${info.message.slice(0, 60)}                       `);
  }
});
console.log(`\n  status=${result.status}, outputs=${outputs?.length ?? 0}`);

if (result.status !== 'completed' || !outputs || outputs.length === 0) {
  console.error(`Job failed or returned no outputs.`);
  process.exit(1);
}

const saveImage = outputs.find(o => /\.(png|jpg|jpeg|webp)$/i.test(o.filename)) ?? outputs[0]!;
const target = `s${scene}shot${shot}_grok_ots_seed${seed}.png`;
await client.downloadImage(saveImage.filename, saveImage.subfolder ?? '', saveImage.type ?? 'output', target);
console.log(`\n  → ${join(outDir, target)}`);

// Copy the Klein baseline at matching seed for direct comparison.
const kleinBaseline = join(
  projectRoot,
  `assets/images/probe_klein_seed_variance/s${scene}shot${shot}/s${scene}shot${shot}_v0_baseline_seed${seed}.png`,
);
if (existsSync(kleinBaseline)) {
  copyFileSync(kleinBaseline, join(outDir, `s${scene}shot${shot}_klein_baseline_seed${seed}.png`));
  console.log(`\nKlein baseline at matching seed copied alongside:`);
  console.log(`  klein: ${outDir}/s${scene}shot${shot}_klein_baseline_seed${seed}.png`);
  console.log(`  grok:  ${outDir}/${target}`);
}
