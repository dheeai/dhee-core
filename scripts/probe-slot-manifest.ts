#!/usr/bin/env tsx
/**
 * Test theory: prepending a static slot manifest (e.g. "Ruby from image 1.
 * Angel from image 2. Owner from image 3.") at the top of the prompt and
 * stripping inline "from image X" references from the prose produces
 * cleaner image-edit output than the current inline approach.
 *
 * Hypothesis: Flux Klein may parse the inline "from image N" tokens as
 * scene elements rather than reference pointers, causing it to render
 * the descriptive text into the frame in odd ways. A leading manifest
 * frees the descriptive prose from this overhead.
 *
 * Renders TWO variants of the SAME shot from the SAME refs and seed:
 *   variant A: original prompt with inline "from image N"
 *   variant B: static manifest at top + prose stripped of "from image N"
 *
 * Usage:
 *   pnpm tsx scripts/probe-slot-manifest.ts <project> <scene> <shot>
 *
 * Example:
 *   pnpm tsx scripts/probe-slot-manifest.ts Ruby 2 2
 *
 * Output:
 *   <project>/assets/images/compare_slot_manifest/
 *     s{N}shot{M}_inline.png       (original — inline refs)
 *     s{N}shot{M}_manifest.png     (modified — leading manifest, clean prose)
 *     prompt_inline.txt
 *     prompt_manifest.txt
 */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-slot-manifest.ts <project> <scene> <shot>');
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

// Load the existing prompt JSON for this shot.
const promptPath = join(projectRoot, `prompts/images/shots/scene-${scene}-shot-${shot}.json`);
if (!existsSync(promptPath)) {
  console.error(`Prompt JSON not found: ${promptPath}`);
  process.exit(1);
}
const promptJson = JSON.parse(readFileSync(promptPath, 'utf-8'));
const inlinePrompt: string = promptJson.frames?.first_frame?.imagePrompt ?? promptJson.imagePrompt ?? '';
if (!inlinePrompt) {
  console.error('No first_frame.imagePrompt found.');
  process.exit(1);
}
const negativePrompt: string = promptJson.negativePrompt ?? '';

// Refs: imageNumber → refId. We need both the slot label and the actual
// PNG path for each (resolved against the assets/images dir).
const refs: Array<{ imageNumber: number; type: string; refId: string }> =
  promptJson.frames?.first_frame?.references ?? promptJson.references ?? [];
if (refs.length === 0) {
  console.error('No references on first_frame.');
  process.exit(1);
}

// Resolve each refId to its rendered PNG file.
const imagesDir = join(projectRoot, 'assets/images');
const findRef = (refId: string): string | null => {
  // refId is like "character_image:angel" or "setting_image:inside_pawn_shop"
  const [type, name] = refId.split(':');
  const prefix = type === 'character_image' ? 'CharRef_' : type === 'setting_image' ? 'SettingRef_' : 'ObjectRef_';
  const normalizedName = name.replace(/_/g, '');
  const candidates = readdirSync(imagesDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.png') && f.toLowerCase().includes(normalizedName.toLowerCase()))
    .sort();
  return candidates.length > 0 ? join(imagesDir, candidates.at(-1)!) : null;
};

// Pretty short label for the slot manifest (e.g. "Ruby", "Pawn shop owner").
const refLabel = (refId: string): string => {
  const [, name] = refId.split(':');
  return name.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
};

const refPaths: Record<number, string> = {};
const manifestLines: string[] = [];
for (const r of refs.sort((a, b) => a.imageNumber - b.imageNumber)) {
  const p = findRef(r.refId);
  if (!p) {
    console.error(`Failed to resolve refId ${r.refId}`);
    process.exit(1);
  }
  refPaths[r.imageNumber] = p;
  manifestLines.push(`${refLabel(r.refId)} from image ${r.imageNumber}.`);
}

// Build the manifest-variant prompt.
// 1. Strip every "from image N" inline reference from the prose.
// 2. Prepend the static manifest.
const stripPattern = / from image \d+/gi;
const proseClean = inlinePrompt.replace(stripPattern, '');
const manifestPrompt = `${manifestLines.join(' ')}\n\n${proseClean}`;

console.log(`shot: scene ${scene}, shot ${shot}`);
console.log(`refs: ${Object.keys(refPaths).length}`);
for (const [n, p] of Object.entries(refPaths)) {
  console.log(`  image ${n}: ${p.split('/').pop()}`);
}
console.log();
console.log('=== inline prompt (original) ===');
console.log(inlinePrompt.slice(0, 200) + '...');
console.log();
console.log('=== manifest prompt (modified) ===');
console.log(manifestPrompt.slice(0, 200) + '...');

// Load workflow + manifest.
const workflowPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.json');
const manifestPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.manifest.json');
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));
const wfManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

const outputDir = join(projectRoot, 'assets/images/compare_slot_manifest');
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, `s${scene}shot${shot}_prompt_inline.txt`), inlinePrompt);
writeFileSync(join(outputDir, `s${scene}shot${shot}_prompt_manifest.txt`), manifestPrompt);

const client = new ComfyUIClient({ outputDir });

// Upload all ref images (max 3 in this workflow).
const uploadedRefs: Record<number, string> = {};
for (const [n, p] of Object.entries(refPaths)) {
  console.log(`\nUploading image ${n}: ${p.split('/').pop()}`);
  const up = await client.uploadImage(p, 'input', true);
  uploadedRefs[parseInt(n, 10)] = up.name;
  console.log(`  → ${up.name}`);
}

// SAME seed for both variants so any difference is from prompt only.
const seed = Math.floor(Math.random() * 0x7FFFFFFF);

const renderVariant = async (label: string, prompt: string) => {
  console.log(`\n=== render ${label} ===`);
  const params: Record<string, unknown> = {
    prompt,
    seed,
    filenamePrefix: `compare_slot_manifest/s${scene}shot${shot}_${label}`,
    width: 1024,
    height: 576,
  };
  if (negativePrompt) params.negative_prompt = negativePrompt;
  for (const [n, name] of Object.entries(uploadedRefs)) {
    params[`reference_image_${n}`] = name;
    // base_image defaults to ref 1 in the klein edit workflow (slot 1 = setting/canvas)
    if (n === '1') params.base_image = name;
  }
  const workflow = parameterizeGeneric(template, wfManifest, params) as Record<string, unknown>;

  const t0 = Date.now();
  const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, p => {
    if (p.percentage !== undefined && p.message) {
      console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
    }
  });
  console.log(`  complete in ${Math.floor((Date.now() - t0) / 1000)}s (prompt_id=${promptId})`);

  const histImages = await client.getOutputImages(promptId);
  const seen = new Set<string>();
  const imageOutputs = [...wsOutputs, ...histImages]
    .filter(i => /\.(png|jpg|jpeg|webp)$/i.test(i.filename))
    .filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));

  if (imageOutputs.length === 0) {
    console.error(`No image output for ${label}.`);
    return;
  }
  const target = `s${scene}shot${shot}_${label}.png`;
  for (const item of imageOutputs) {
    const dl = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
    console.log(`  → ${dl}`);
    break;
  }
};

await renderVariant('inline', inlinePrompt);
await renderVariant('manifest', manifestPrompt);

console.log(`\nOpen ${outputDir} in Finder. seed=${seed} (both variants used same seed; differences are from the prompt structure only).`);
