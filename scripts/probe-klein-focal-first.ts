#!/usr/bin/env tsx
/**
 * FLUX 2 Klein focal-first experiment — does rewriting the prose to
 * introduce the FOCAL character before the OTS anchor (and dropping
 * the phrase "over-the-shoulder of X" entirely) flip Klein back to
 * honoring intended roles?
 *
 * Prior experiment (probe-klein-seed-variance) showed v0_baseline
 * failed 6/6 with `"Over-the-shoulder of Parvati from image 2, ...
 * Isha from image 3 in razor-sharp focus"`. Hypothesis: Klein reads
 * "over-the-shoulder of X" as "X is the character visible past a
 * shoulder" (focal), the opposite of the cinematography meaning.
 *
 * This probe renders v4_focal_first at the SAME 6 seeds so we can
 * direct-compare against the prior v0 results. If v4 flips a majority
 * of seeds to correct, the guide rule is: "focal character first,
 * never use 'OTS of <anchor>' phrasing."
 *
 * The v4 prose is hand-authored here (rather than derived by regex
 * from v0) because the rewrite is a substantive restructure, not a
 * word substitution. That's the point of the test.
 */
import 'dotenv/config';
import { readFileSync, mkdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const PROJECT = 'sun_hadnt_yet_cleared-2';
const SCENE = 1;
const SHOT = 6;
const SEEDS = [13, 2027, 441, 98765, 1234567, 88888];
const projectRoot = resolve(process.cwd(), `${PROJECT}.dhee`);

// ── Hand-written focal-first prose ──────────────────────────────────────
// Same shot content (s1 shot 6), same refs, same atmosphere — the ONLY
// changes from baseline:
//   1. Isha (focal) is introduced FIRST, described at the gate in sharp
//      focus with her action.
//   2. Parvati (anchor) is introduced SECOND as a "soft blurred foreground
//      element" — NEVER as "over-the-shoulder of Parvati".
//   3. Phrase "over-the-shoulder of" is entirely absent.
// Negative prompt stays pulled from the shot JSON to keep that controlled.
const V4_FOCAL_FIRST = `Isha from image 3 in razor-sharp focus, standing at the rustic gate of the district sports complex from image 1, her body beginning to rotate left, weight shifting to her right foot, left foot lifting slightly off the ground, head angled downward with a dismissive expression, mouth slightly open as if saying 'I know'. In the near foreground of the composition, Parvati from image 2's shoulder and back of head appear as a softly blurred silhouette, her coaching hand gestures blurred at the edge of frame. The gate is bathed in golden dawn haze with swirling dust motes, neem trees silhouetted in the background. Warm golden light from the right casts soft shadows on Isha's face and the ground. Shallow depth of field with Isha razor-sharp and the foreground figure heavily blurred. Mood: impatience giving way to action, a moment of dismissal before movement., anime style, anime art, vibrant colors, detailed anime, studio quality anime, anime aesthetic`;

// ── Load the shot's refs, paths, and negative prompt ──────────────────
const shotJson = JSON.parse(
  readFileSync(join(projectRoot, `prompts/images/shots/scene-${SCENE}-shot-${SHOT}.json`), 'utf-8'),
);
const frame = shotJson.frames.first_frame;
const refs = frame.references as Array<{ imageNumber: number; type: string; refId: string }>;
const negative = shotJson.negativePrompt ?? '';

const projectJson = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8'));
const nodes = projectJson.executorState.nodes;
const resolveRefPath = (refId: string) =>
  join(projectRoot, nodes[refId].outputPath);

const baseRef = refs.find(r => r.type === 'setting')!;
const charRefs = refs.filter(r => r.type === 'character');
const orderedRefs = [baseRef, ...charRefs];

const outputDir = join(
  projectRoot,
  `assets/images/probe_klein_seed_variance/s${SCENE}shot${SHOT}`,
);
mkdirSync(outputDir, { recursive: true });

// Write the v4 prose alongside the earlier prompts.txt for reference.
copyFileSync(
  join(outputDir, 'prompts.txt'),
  join(outputDir, 'prompts.txt.bak'),
);
const fs = await import('fs');
fs.appendFileSync(
  join(outputDir, 'prompts.txt'),
  `\n\n=== v4_focal_first ===\n${V4_FOCAL_FIRST}\n`,
);

const client = new ComfyUIClient({ outputDir });

// ── Upload refs once ─────────────────────────────────────────────────
console.log('Uploading refs...');
const uploaded: Record<string, string> = {};
for (const r of orderedRefs) {
  const u = await client.uploadImage(resolveRefPath(r.refId), 'input', true);
  uploaded[r.refId] = u.name;
  console.log(`  ${r.refId} → ${u.name}`);
}

// ── Klein workflow ───────────────────────────────────────────────────
const workflowPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.json');
const manifestPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));

const baseImageName = uploaded[baseRef.refId]!;
const refImageNames = orderedRefs.slice(1, 4).map(r => uploaded[r.refId]!);

console.log(`\nRunning v4_focal_first at ${SEEDS.length} seeds...`);
for (const seed of SEEDS) {
  console.log(`\n  seed=${seed}`);
  const params: Record<string, unknown> = {
    prompt: V4_FOCAL_FIRST,
    negative_prompt: negative,
    base_image: baseImageName,
    seed,
    filenamePrefix: `klein/variance/v4_focal_first_${seed}`,
    width: 1024,
    height: 576,
  };
  for (let i = 0; i < 3; i++) {
    params[`reference_image_${i + 1}`] = refImageNames[i] ?? baseImageName;
  }
  const workflow = parameterizeGeneric(template, manifest, params) as Record<string, unknown>;
  for (const n of Object.values(workflow)) {
    const node = n as { class_type?: string; inputs?: Record<string, unknown> };
    if (node.class_type === 'LoadImage' && typeof node.inputs?.['image'] === 'string') {
      const img = node.inputs['image'] as string;
      if (img.startsWith('ref_image_') || img === '') node.inputs['image'] = baseImageName;
    }
  }

  const start = Date.now();
  const { promptId, outputs } = await client.queueAndWaitWS(workflow, () => {});
  const secs = Math.floor((Date.now() - start) / 1000);
  const hist = await client.getOutputImages(promptId);
  const imgs = [...outputs, ...hist].filter(i => /\.(png|jpg|jpeg|webp)$/i.test(i.filename));
  if (imgs.length === 0) {
    console.log(`    ❌ no output after ${secs}s`);
    continue;
  }
  const target = `s${SCENE}shot${SHOT}_v4_focal_first_seed${seed}.png`;
  await client.downloadImage(imgs[0]!.filename, imgs[0]!.subfolder ?? '', imgs[0]!.type ?? 'output', target);
  console.log(`    ✓ ${secs}s → ${target}`);
}

console.log(`\nDone. Grid in ${outputDir}.`);
console.log(`Compare v0_baseline_seedN vs v4_focal_first_seedN at matching seeds.`);
