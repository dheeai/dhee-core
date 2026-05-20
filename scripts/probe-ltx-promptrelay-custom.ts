#!/usr/bin/env tsx
/**
 * One-off probe: hardcoded local_prompts in the style the user
 * specified (action + speech verb + accent + quoted dialogue +
 * atmospheric line). 3 shots from Parvati scene 2 — picked to
 * exercise three audio modes: silent ambient, scolding dialogue,
 * fierce whisper.
 *
 * Usage:
 *   pnpm tsx scripts/probe-ltx-promptrelay-custom.ts
 *
 * Output:
 *   sun_hadnt_yet_cleared-2.dhee/assets/videos/promptrelay_probe/
 *     custom_3shot_<timestamp>.mp4
 */
import 'dotenv/config';
import { readFileSync, mkdirSync, existsSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';
import { expandPromptRelayWorkflow } from '../src/services/providers/promptRelayWorkflowExpander.js';

process.env['COMFY_MODE'] = 'local';

const projectRoot = resolve(process.cwd(), 'sun_hadnt_yet_cleared-2.dhee');
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

// Three shots from scene 2 chunk 0:
//   shot 1 — chappals (silent, ambient)
//   shot 2 — Mrs. Singh speaks (scolding dialogue)
//   shot 7 — Parvati whispers vow (fierce low whisper)
const SHOTS = [
  {
    scene: 2,
    shot: 1,
    durationSec: 3,
    localPrompt:
      "Worn leather chappals step onto cool concrete kitchen floor of an Indian bungalow's servant entrance. Faint dust motes rise. Static low-angle close-up. " +
      "Quiet ambient room tone — soft slap of sandals on tile, faint distant traffic outside. No voices, no dialogue."
  },
  {
    scene: 2,
    shot: 2,
    durationSec: 4,
    localPrompt:
      "An older Indian woman in a silk sari, seated at a polished teak dining table with a newspaper spread open. She looks up sharply at the kitchen doorway. " +
      "She speaks in clipped, imperious Indian-English, her tone condescending and dismissive. She says: " +
      "\"Late again, Parvati. And spending good money on those running shoes? That's a fool's dream.\" " +
      "Static medium shot, soft late-morning light through wide windows, faint ceiling-fan hum behind the voice."
  },
  {
    scene: 2,
    shot: 7,
    durationSec: 5,
    localPrompt:
      "An older Indian woman in a faded cotton sari kneels on the tiled mudroom floor, scrubbing dried mud and paw prints with a wet rag. Handheld camera, low floor angle. " +
      "She whispers fiercely in a low, soft Indian-English accent — almost a prayer to herself. She says: " +
      "\"She will run. She will run until she leaves this dust behind.\" " +
      "Atmospheric: wet scrubbing sound, water dripping into a metal bucket, distant traffic outside."
  },
];

// Sceene-summary-driven global prompt. No characters block.
const projectStyle = (() => {
  try {
    const pj = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8')) as { style?: string };
    return pj.style ?? 'cinematic';
  } catch { return 'cinematic'; }
})();
const sceneSummary = (() => {
  try {
    const d = JSON.parse(readFileSync(join(projectRoot, 'prompts/scene_summaries.json'), 'utf-8')) as Record<string, string>;
    return d['scene_2'] ?? '';
  } catch { return ''; }
})();
const globalPrompt = `${projectStyle} style. Cinematic continuity across shots, consistent character identity and lighting.${sceneSummary ? ' Scene: ' + sceneSummary : ''}`;

// Looser negative prompt — no anti-speech tokens (we WANT dialogue).
const negativePrompt = 'blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, compression artifacts, jpeg artifacts, glitches, watermark, text, logo, signature, copyright, subtitles, distorted sound, saturated sound, loud';

// Pick first frame for each shot (manifest createdAt-sort).
const imagesDir = join(projectRoot, 'assets/images');
const projectManifestPath = join(projectRoot, 'assets/manifest.json');
type ManifestAsset = { type?: string; path: string; createdAt?: number };
const projectManifest = existsSync(projectManifestPath)
  ? (JSON.parse(readFileSync(projectManifestPath, 'utf-8')) as { assets?: ManifestAsset[] })
  : { assets: [] as ManifestAsset[] };
function pickFirstFrame(s: number, shot: number): string {
  const re = new RegExp(`/s${s}shot${shot}_first_frame_[^/]+\\.png$`);
  const matches = (projectManifest.assets ?? [])
    .filter((a: ManifestAsset) => a.type === 'scene_image' && re.test(a.path))
    .sort((a: ManifestAsset, b: ManifestAsset) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (matches.length > 0) return join(projectRoot, matches[0].path);
  const hits = readdirSync(imagesDir)
    .filter(f => new RegExp(`^s${s}shot${shot}_first_frame_`).test(f) && f.endsWith('.png'))
    .map(f => ({ f, mtime: statSync(join(imagesDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (hits.length === 0) {
    console.error(`No first_frame for s${s}shot${shot}`);
    process.exit(1);
  }
  return join(imagesDir, hits[0].f);
}

const FPS = 24;
function alignToLTX(rawFrames: number[]): number[] {
  const rounded = rawFrames.map(f => Math.max(8, Math.round(f / 8) * 8));
  rounded[0] = rounded[0] + 1;
  return rounded;
}
const segmentFrames = alignToLTX(SHOTS.map(s => s.durationSec * FPS));
const totalFrames = segmentFrames.reduce((a, b) => a + b, 0);

// Workflow
const baseWorkflowPath = resolve(process.cwd(), 'workflows/built-in/ltx23_promptrelay_4seg_local.json');
const baseTemplate = JSON.parse(readFileSync(baseWorkflowPath, 'utf-8'));
const { workflow: template, parameterMappings } = expandPromptRelayWorkflow(baseTemplate, SHOTS.length);
const manifest = { parameterMappings };

const outputDir = join(projectRoot, 'assets/videos/promptrelay_probe');
mkdirSync(outputDir, { recursive: true });
const client = new ComfyUIClient({ outputDir });

console.log('Custom prompts probe (3 shots, scene 2)');
console.log(`Global prompt:\n  ${globalPrompt.slice(0, 240)}${globalPrompt.length > 240 ? '...' : ''}`);
for (let i = 0; i < SHOTS.length; i++) {
  console.log(`\nshot ${SHOTS[i].shot} (${segmentFrames[i]} frames = ${(segmentFrames[i] / FPS).toFixed(2)}s):`);
  console.log(`  ${SHOTS[i].localPrompt}`);
}
console.log(`\nTotal: ${totalFrames} frames = ${(totalFrames / FPS).toFixed(2)}s @ ${FPS}fps`);

const firstFrames = SHOTS.map(s => pickFirstFrame(s.scene, s.shot));
console.log('\nUploading first frames...');
const uploadedNames: string[] = [];
for (let i = 0; i < firstFrames.length; i++) {
  const u = await client.uploadImage(firstFrames[i], 'input', true);
  console.log(`  ${SHOTS[i].shot}: ${firstFrames[i].split('/').pop()} → ${u.name}`);
  uploadedNames.push(u.name);
}

const seedPass1 = Math.floor(Math.random() * 0x7FFFFFFF);
const seedPass2 = Math.floor(Math.random() * 0x7FFFFFFF);
const ts = Date.now();
const filenamePrefix = `promptrelay/custom_3shot_${ts}`;

const segmentParams: Record<string, unknown> = {};
for (let i = 0; i < SHOTS.length; i++) {
  segmentParams[`segment_${i + 1}_image`] = uploadedNames[i];
  segmentParams[`segment_${i + 1}_frames`] = segmentFrames[i];
}
const localPrompts = SHOTS.map(s => s.localPrompt);
const workflow = parameterizeGeneric(template, manifest, {
  global_prompt: globalPrompt,
  local_prompts: localPrompts.join(' | '),
  negative_prompt: negativePrompt,
  segment_lengths: segmentFrames.join(', '),
  total_frames: totalFrames,
  ...segmentParams,
  seed_pass1: seedPass1,
  seed_pass2: seedPass2,
  filenamePrefix,
}) as Record<string, unknown>;

console.log('\nSubmitting to LOCAL ComfyUI...');
const start = Date.now();
const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, (p) => {
  if (p.percentage !== undefined && p.message) {
    console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
  }
});
console.log(`  complete in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

const histImages = await client.getOutputImages(promptId);
const seen = new Set<string>();
const allOutputs = [...wsOutputs, ...histImages]
  .filter(i => /\.(mp4|webm|mov)$/i.test(i.filename))
  .filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));

if (allOutputs.length === 0) {
  console.error('No video output');
  process.exit(1);
}

const targetName = `custom_3shot_${ts}.mp4`;
const item = allOutputs[0];
const dl = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', targetName);

const metaPath = join(outputDir, targetName.replace(/\.mp4$/, '.meta.json'));
writeFileSync(metaPath, JSON.stringify({ globalPrompt, localPrompts, segmentFrames, totalFrames, fps: FPS, seedPass1, seedPass2, promptId }, null, 2));

console.log(`\nVideo:    ${dl}`);
console.log(`Metadata: ${metaPath}`);
