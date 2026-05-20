#!/usr/bin/env tsx
/**
 * N=1 probe for the Klein-9b-consistency LoRA workflow on the OTS
 * failure case (s1 shot 6, seed 13).
 *
 * Background: standard Klein swaps character roles 6/6 at six seeds
 * for this shot (mother + daughter, both tan-skinned and dark-haired).
 * The user added a consistency LoRA that's supposed to help preserve
 * per-ref features. Per `feedback_experiment_n1_first`, validate at
 * N=1 before scaling.
 *
 * Compares against the existing klein baseline at the same seed so the
 * only variable is the LoRA's presence in the sampling path.
 */
import 'dotenv/config';
import { readFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const [projectArg, sceneArg, shotArg, seedArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-klein-consistency-lora.ts <project> <scene> <shot> [seed]');
  process.exit(1);
}
const SCENE = parseInt(sceneArg, 10);
const SHOT = parseInt(shotArg, 10);
const SEED = seedArg ? parseInt(seedArg, 10) : 13;
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`,
);

// Load shot prompt + refs
const shotPromptPath = join(projectRoot, `prompts/images/shots/scene-${SCENE}-shot-${SHOT}.json`);
const shotPrompt = JSON.parse(readFileSync(shotPromptPath, 'utf-8'));
const frame = shotPrompt.frames.first_frame;
const prompt: string = frame.imagePrompt;
const negative: string = shotPrompt.negativePrompt ?? '';
const refs = frame.references as Array<{ imageNumber: number; type: string; refId: string }>;

const projectJson = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8'));
const nodes = projectJson.executorState.nodes;
const resolvePath = (refId: string) => join(projectRoot, nodes[refId].outputPath);

const baseRef = refs.find(r => r.type === 'setting')!;
const charRefs = refs.filter(r => r.type === 'character');
const orderedRefs = [baseRef, ...charRefs];

const outDir = join(projectRoot, 'assets/images/probe_klein_consistency_lora');
mkdirSync(outDir, { recursive: true });

const client = new ComfyUIClient({ outputDir: outDir });

console.log(`Uploading refs (base + ${charRefs.length} chars)...`);
const uploaded: Record<string, string> = {};
for (const r of orderedRefs) {
  const u = await client.uploadImage(resolvePath(r.refId), 'input', true);
  uploaded[r.refId] = u.name;
  console.log(`  ${r.refId} → ${u.name}`);
}

// `LORA_VARIANT` env: 'consistency' (default), 'detail', or 'off'.
// 'off' uses the base flux2_klein_edit_cloud workflow (no LoRA at all) so
// you can A/B against either LoRA at the same seed.
const variant = (process.env['LORA_VARIANT'] ?? 'consistency').toLowerCase();
const variantSlug =
  variant === 'detail' ? 'detail' :
  variant === 'off' || variant === 'baseline' ? 'baseline' :
  'consistency';
const workflowFile = variantSlug === 'baseline'
  ? 'flux2_klein_edit_cloud.json'
  : `flux2_klein_edit_${variantSlug}_cloud.json`;
const manifestFile = variantSlug === 'baseline'
  ? 'flux2_klein_edit_cloud.manifest.json'
  : `flux2_klein_edit_${variantSlug}_cloud.manifest.json`;
const workflowPath = resolve(process.cwd(), `workflows/cloud/${workflowFile}`);
const manifestPath = resolve(process.cwd(), `workflows/cloud/${manifestFile}`);
console.log(`LoRA variant: ${variantSlug}`);
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));

const baseImageName = uploaded[baseRef.refId]!;
const refImageNames = orderedRefs.slice(1, 4).map(r => uploaded[r.refId]!);

const params: Record<string, unknown> = {
  prompt,
  negative_prompt: negative,
  base_image: baseImageName,
  seed: SEED,
  filenamePrefix: `klein_lora/probe/seed${SEED}`,
};
for (let i = 0; i < 3; i++) {
  params[`reference_image_${i + 1}`] = refImageNames[i] ?? baseImageName;
}

const workflow = parameterizeGeneric(template, manifest, params) as Record<string, unknown>;
// Same placeholder safety as production.
for (const n of Object.values(workflow)) {
  const node = n as { class_type?: string; inputs?: Record<string, unknown> };
  if (node.class_type === 'LoadImage' && typeof node.inputs?.['image'] === 'string') {
    const img = node.inputs['image'] as string;
    if (img.startsWith('ref_image_') || img === '') node.inputs['image'] = baseImageName;
  }
}

console.log(`\nSubmitting Klein + consistency LoRA at seed ${SEED}...`);
const start = Date.now();
const { result, promptId, outputs } = await client.queueAndWaitWS(workflow, info => {
  if (info.percentage !== undefined && info.message) {
    process.stdout.write(`\r  [${Math.round((Date.now() - start) / 1000)}s] ${Math.round(info.percentage)}%  ${info.message.slice(0, 60)}                     `);
  }
});
console.log(`\n  status=${result.status}, outputs=${outputs?.length ?? 0}, prompt_id=${promptId}`);

if (result.status !== 'completed' || !outputs || outputs.length === 0) {
  console.error('Job failed or returned no outputs.');
  process.exit(1);
}

const img = outputs.find(o => /\.(png|jpg|jpeg|webp)$/i.test(o.filename)) ?? outputs[0]!;
const target = `s${SCENE}shot${SHOT}_klein_${variantSlug}_seed${SEED}.png`;
await client.downloadImage(img.filename, img.subfolder ?? '', img.type ?? 'output', target);
console.log(`  → ${join(outDir, target)}`);

// Copy the standard-Klein baseline at the same seed for direct A/B.
const klein = join(
  projectRoot,
  `assets/images/probe_klein_seed_variance/s${SCENE}shot${SHOT}/s${SCENE}shot${SHOT}_v0_baseline_seed${SEED}.png`,
);
if (existsSync(klein)) {
  copyFileSync(klein, join(outDir, `s${SCENE}shot${SHOT}_klein_baseline_seed${SEED}.png`));
  console.log(`\nKlein baseline (no LoRA) at same seed copied alongside.`);
  console.log(`  baseline: ${outDir}/s${SCENE}shot${SHOT}_klein_baseline_seed${SEED}.png`);
  console.log(`  with LoRA: ${outDir}/${target}`);
}
