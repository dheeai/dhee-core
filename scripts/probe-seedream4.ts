#!/usr/bin/env tsx
/**
 * N=1 probe for ByteDance Seedream 4.0 on the OTS failure case.
 *
 * Klein swapped roles 6/6 at 6 seeds on s1 shot 6 (mother/daughter
 * OTS). Klein+consistency LoRA collapsed both refs to one identity.
 * Klein+detail LoRA broke the OTS structure entirely. Grok got the
 * roles right but rendered in a non-anime style.
 *
 * Seedream4 is an API-based image-composition model that takes
 * up-to-4 batched reference images + text. The user has confirmed
 * it works on one shot; this probe validates 1 more case before any
 * wider use, per `feedback_experiment_n1_first`.
 *
 * Test target: s1 shot 6 first_frame at seed 13. If Seedream produces
 * Isha as the focal character (correct role assignment) AND preserves
 * the cel-shaded anime style, we expand to a second hard shot. If
 * either condition fails, we abort this line.
 */
import 'dotenv/config';
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const [projectArg, sceneArg, shotArg, seedArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-seedream4.ts <project> <scene> <shot> [seed]');
  process.exit(1);
}
const SCENE = parseInt(sceneArg, 10);
const SHOT = parseInt(shotArg, 10);
const SEED = seedArg ? parseInt(seedArg, 10) : 13;
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`,
);

const shotPromptPath = join(projectRoot, `prompts/images/shots/scene-${SCENE}-shot-${SHOT}.json`);
const shotPrompt = JSON.parse(readFileSync(shotPromptPath, 'utf-8'));
const frame = shotPrompt.frames.first_frame;
const prompt: string = frame.imagePrompt;
const refs = frame.references as Array<{ imageNumber: number; type: string; refId: string }>;

const projectJson = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8'));
const nodes = projectJson.executorState.nodes;
const resolveRef = (rid: string) => join(projectRoot, nodes[rid].outputPath);

const baseRef = refs.find(r => r.type === 'setting');
const charRefs = refs.filter(r => r.type === 'character');
if (!baseRef) {
  console.error('Need a setting ref. None on this shot.');
  process.exit(1);
}
const orderedRefs = [baseRef, ...charRefs];

console.log(`shot:    s${SCENE} shot ${SHOT} / first_frame`);
console.log(`refs:    ${refs.map(r => `${r.imageNumber}=${r.refId.split(':').at(-1)}`).join(', ')}`);
console.log(`prompt:  ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}`);

const outDir = join(projectRoot, 'assets/images/probe_seedream4');
mkdirSync(outDir, { recursive: true });

const client = new ComfyUIClient({ outputDir: outDir });

console.log(`\nUploading refs (base + ${charRefs.length} chars)...`);
const uploaded: Record<string, string> = {};
for (const r of orderedRefs) {
  const u = await client.uploadImage(resolveRef(r.refId), 'input', true);
  uploaded[r.refId] = u.name;
  console.log(`  ${r.refId} → ${u.name}`);
}

const workflowPath = resolve(process.cwd(), 'workflows/cloud/seedream4_cloud.json');
const manifestPath = resolve(process.cwd(), 'workflows/cloud/seedream4_cloud.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));

const baseImg = uploaded[baseRef.refId]!;
const charImgs = orderedRefs.slice(1, 4).map(r => uploaded[r.refId]!);

const params: Record<string, unknown> = {
  prompt,
  seed: SEED,
  // Seedream4 enforces width/height ≥ 1024. Use 1920×1088 — closest
  // valid 16:9 (1088 is the smallest even multiple ≥ 1080 that satisfies
  // step=2 from min=1024). Will be downscaled to the project's video
  // resolution at assembly time.
  width: 1920,
  height: 1088,
  base_image: baseImg,
  filenamePrefix: `seedream/probe/s${SCENE}s${SHOT}_seed${SEED}`,
};
// Seedream's BatchImagesNode has 4 image slots — fill unused with base
// (mirrors how the Klein probe handles fewer-than-4 char refs).
for (let i = 0; i < 3; i++) {
  params[`reference_image_${i + 1}`] = charImgs[i] ?? baseImg;
}

const workflow = parameterizeGeneric(template, manifest, params) as Record<string, unknown>;

console.log(`\nSubmitting Seedream4 (seed=${SEED})...`);
const start = Date.now();
const { result, promptId, outputs } = await client.queueAndWaitWS(workflow, info => {
  if (info.percentage !== undefined && info.message) {
    process.stdout.write(`\r  [${Math.round((Date.now() - start) / 1000)}s] ${Math.round(info.percentage)}%  ${info.message.slice(0, 60)}                       `);
  }
});
console.log(`\n  status=${result.status}, outputs=${outputs?.length ?? 0}, prompt_id=${promptId}`);

if (result.status !== 'completed' || !outputs || outputs.length === 0) {
  console.error('Job failed or returned no outputs.');
  process.exit(1);
}
const img = outputs.find(o => /\.(png|jpg|jpeg|webp)$/i.test(o.filename)) ?? outputs[0]!;
const target = `s${SCENE}shot${SHOT}_seedream4_seed${SEED}.png`;
await client.downloadImage(img.filename, img.subfolder ?? '', img.type ?? 'output', target);
console.log(`  → ${join(outDir, target)}`);

// Copy Klein baseline + LoRA outputs at the same seed for direct comparison.
const candidates = [
  ['klein_baseline', `assets/images/probe_klein_seed_variance/s${SCENE}shot${SHOT}/s${SCENE}shot${SHOT}_v0_baseline_seed${SEED}.png`],
  ['klein_consistency', `assets/images/probe_klein_consistency_lora/s${SCENE}shot${SHOT}_klein_consistency_seed${SEED}.png`],
  ['klein_detail', `assets/images/probe_klein_consistency_lora/s${SCENE}shot${SHOT}_klein_detail_seed${SEED}.png`],
];
for (const [label, rel] of candidates) {
  const p = join(projectRoot, rel);
  if (existsSync(p)) {
    copyFileSync(p, join(outDir, `s${SCENE}shot${SHOT}_${label}_seed${SEED}.png`));
    console.log(`  copied ${label}: ${join(outDir, `s${SCENE}shot${SHOT}_${label}_seed${SEED}.png`)}`);
  }
}
