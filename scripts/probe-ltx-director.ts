#!/usr/bin/env tsx
/**
 * Probe the WhatDreamsCost-ComfyUI LTX Director plugin on a contiguous
 * shot sequence from a real project. Direct A/B target: the same
 * shots' per-shot mp4s already in <project>/assets/videos/shots/.
 *
 * Pulls each shot's local prompt from the project's
 * prompts/videos/scenes/scene_<N>.json (description + cameraWork +
 * audio) so the probe is testing the live shot prose, not hand-curated
 * prompts. Global prompt = project style + scene title + (optional)
 * scene description so cross-shot coherence is anchored on real
 * scene-level context.
 *
 * Differences from probe-ltx-promptrelay-custom.ts:
 *
 *   - Workflow: workflows/built-in/ltx23_director_local.json
 *     (LTXDirector, dhee-canonical loader stack:
 *     UNET transformer-only fp8 distilled + VBVR 1.0 + OmniNFT-RL 0.8).
 *   - No segment_N_image / segment_N_frames parameters — the director
 *     takes a single `timeline_data` JSON string with image segments
 *     anchored by `start` in pixel-frame space.
 *
 * Usage:
 *   pnpm tsx scripts/probe-ltx-director.ts
 *   pnpm tsx scripts/probe-ltx-director.ts "<projectPath>" <scene> <start> <end>
 *
 * Defaults: Better Image, scene 1, shots 1..3.
 *
 * Output:
 *   <project>/assets/videos/promptrelay_probe/
 *     director_s<scene>_<start>-<end>_<ts>.mp4
 *     director_s<scene>_<start>-<end>_<ts>.meta.json
 */
import 'dotenv/config';
import {
  readFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

// ── Force local LTX 2.3 endpoint ─────────────────────────────────────
// The workflow uses model files (transformer_only distilled fp8,
// VBVR/OmniNFT LoRAs, gemma_3_12B heretic fp8, LTX VAEs) that only
// live on the local box. The user's "local" ComfyUI is a zrok tunnel
// per `reference_local_comfyui_url.md`. Override BEFORE the client is
// constructed — .env defaults to cloud and ComfyUIClient checks URL
// in its constructor.
process.env['COMFY_MODE'] = 'local';
process.env['COMFYUI_BASE_URL'] =
  process.env['COMFY_LOCAL_URL'] ?? 'https://comfyui.share.zrok.io';

// ── CLI args ─────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const DEFAULT_PROJECT = '/Users/ganaraj/dhee-studios/Better Image';
const projectRoot = resolve(args[0] ?? DEFAULT_PROJECT);
const sceneNumber = parseInt(args[1] ?? '1', 10);
const startShot = parseInt(args[2] ?? '1', 10);
const endShot = parseInt(args[3] ?? '3', 10);

if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

// ── Read project + scene + shot data ─────────────────────────────────
const projectStyle = (() => {
  try {
    const pj = JSON.parse(
      readFileSync(join(projectRoot, 'project.json'), 'utf-8'),
    ) as { style?: string };
    return pj.style ?? 'cinematic';
  } catch {
    return 'cinematic';
  }
})();

interface ShotPlan {
  shotNumber: number;
  duration: number;
  purpose?: string;
  description?: string;
  cameraWork?: string;
  audio?: string;
}
interface ScenePlan {
  sceneNumber?: number;
  sceneTitle?: string;
  totalDuration?: number;
  shots: ShotPlan[];
}

const scenePath = join(
  projectRoot,
  `prompts/videos/scenes/scene_${sceneNumber}.json`,
);
if (!existsSync(scenePath)) {
  console.error(`Scene plan not found: ${scenePath}`);
  process.exit(1);
}
const scenePlan = JSON.parse(readFileSync(scenePath, 'utf-8')) as ScenePlan;

const selectedShots = scenePlan.shots.filter(
  (s) => s.shotNumber >= startShot && s.shotNumber <= endShot,
);
if (selectedShots.length === 0) {
  console.error(
    `No shots in range ${startShot}..${endShot} for scene ${sceneNumber}`,
  );
  process.exit(1);
}
if (selectedShots.length !== endShot - startShot + 1) {
  console.error(
    `Requested ${endShot - startShot + 1} contiguous shots but found ${selectedShots.length} — non-contiguous shot numbers in plan`,
  );
  process.exit(1);
}

// Build per-shot local prompts from real scene plan prose.
//
// Important: LTX 2.3's audio model hallucinates speech when it sees
// references to dialogue without an exact quoted line. Reformat any
// `SPEAKER: text` in the audio field into `Speaker says: "text"`
// (capitalized normal name) so LTX honors the exact words instead of
// improvising.
// Drop sentences from the description that paraphrase dialogue. LTX 2.3
// treats prose like "She asks if X" as a prompt to GENERATE speech about X
// — and when the audio also has the canonical quoted line, the model
// produces both, sounding improvised. Heuristic: drop any sentence whose
// subject is a pronoun + a dialogue verb.
function stripDialogueParaphrase(description: string): string {
  const dialogueVerbs =
    /\b(asks?|says?|tells?|told|explains?|dismisses?|deflects?|whispers?|shouts?|speaks?|spoke|states?|declares?|replies|responds?|answers?|emphasi[sz]es?|insists?|argues?|mutters?|comments?|notes?|remarks?|adds?|continues?|sneers?|smirks?|grunts?)\b/i;
  const pronounSubject = /^\s*(?:He|She|They|It|Him|Her|His|Their)\b/i;
  const sentences = description.split(/(?<=[.!?])\s+/);
  return sentences
    .filter((s) => {
      if (!dialogueVerbs.test(s)) return true;
      if (pronounSubject.test(s)) return false;
      return true;
    })
    .join(' ')
    .trim();
}

function reformatDialogue(audio: string): string {
  // Match repeated `NAME: line` patterns. Names are typically all-caps in
  // scene plans (SERA:, MALACHOR:). Split lines on newlines AND comma
  // boundaries between distinct utterances.
  const speakerRe = /\b([A-Z][A-Z0-9_ ]{1,30}):\s*([^.!?]*[.!?])/g;
  let m: RegExpExecArray | null;
  const replacements: { full: string; speaker: string; line: string }[] = [];
  while ((m = speakerRe.exec(audio)) !== null) {
    replacements.push({ full: m[0], speaker: m[1], line: m[2] });
  }
  if (replacements.length === 0) return audio;
  let out = audio;
  for (const r of replacements) {
    const name = r.speaker
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim();
    out = out.replace(r.full, `${name} says: "${r.line.trim()}".`);
  }
  return out;
}

function buildLocalPrompt(s: ShotPlan): string {
  const parts: string[] = [];
  if (s.description) {
    const cleaned = stripDialogueParaphrase(s.description.trim());
    if (cleaned.length > 0) parts.push(cleaned);
  }
  if (s.cameraWork) parts.push(s.cameraWork.trim());
  if (s.audio && s.audio.trim().length > 0) {
    const reformatted = reformatDialogue(s.audio.trim());
    parts.push(`Audio: ${reformatted}`);
  }
  return parts.join(' ');
}

const FPS = 24;

// LTX latent alignment: each segment a multiple of 8 pixel-frames,
// total satisfies (total - 1) % 8 = 0 — mirror the kijai probe.
function alignToLTX(rawFrames: number[]): number[] {
  const rounded = rawFrames.map((f) => Math.max(8, Math.round(f / 8) * 8));
  rounded[0] = rounded[0] + 1;
  return rounded;
}
const segmentFrames = alignToLTX(selectedShots.map((s) => s.duration * FPS));
const totalFrames = segmentFrames.reduce((a, b) => a + b, 0);

// Cumulative start offsets in pixel-frame space for timeline_data.segments[].start
const segmentStarts: number[] = [];
{
  let acc = 0;
  for (const f of segmentFrames) {
    segmentStarts.push(acc);
    acc += f;
  }
}

const globalPrompt = `${projectStyle} style. Cinematic continuity across shots, consistent character identity and lighting.${scenePlan.sceneTitle ? ` Scene: ${scenePlan.sceneTitle}.` : ''}`;

// ── Pick first-frame for each shot ────────────────────────────────────
const imagesDir = join(projectRoot, 'assets/images');
const projectManifestPath = join(projectRoot, 'assets/manifest.json');
type ManifestAsset = { type?: string; path: string; createdAt?: number };
const projectManifest = existsSync(projectManifestPath)
  ? (JSON.parse(readFileSync(projectManifestPath, 'utf-8')) as {
      assets?: ManifestAsset[];
    })
  : { assets: [] as ManifestAsset[] };

function pickFirstFrame(s: number, shot: number): string {
  // Manifest path (preferred when present): assets tagged scene_image
  // matching s{N}shot{M}_first_frame_*.png, sorted by createdAt desc.
  const re = new RegExp(`/s${s}shot${shot}_first_frame_[^/]+\\.png$`);
  const matches = (projectManifest.assets ?? [])
    .filter((a: ManifestAsset) => a.type === 'scene_image' && re.test(a.path))
    .sort(
      (a: ManifestAsset, b: ManifestAsset) =>
        (b.createdAt ?? 0) - (a.createdAt ?? 0),
    );
  if (matches.length > 0) return join(projectRoot, matches[0].path);
  // Fallback to disk-mtime sort.
  const hits = readdirSync(imagesDir)
    .filter(
      (f) =>
        new RegExp(`^s${s}shot${shot}_first_frame_`).test(f) &&
        f.endsWith('.png'),
    )
    .map((f) => ({ f, mtime: statSync(join(imagesDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (hits.length === 0) {
    console.error(`No first_frame for s${s}shot${shot}`);
    process.exit(1);
  }
  return join(imagesDir, hits[0].f);
}

const localPrompts = selectedShots.map(buildLocalPrompt);

// ── Workflow ─────────────────────────────────────────────────────────
const workflowPath = resolve(
  process.cwd(),
  'workflows/built-in/ltx23_director_local.json',
);
const baseWorkflow = JSON.parse(readFileSync(workflowPath, 'utf-8')) as Record<
  string,
  { inputs: Record<string, unknown>; class_type: string }
>;

const outputDir = join(projectRoot, 'assets/videos/promptrelay_probe');
mkdirSync(outputDir, { recursive: true });
const client = new ComfyUIClient({ outputDir });

const ts = Date.now();
const slug = `s${sceneNumber}_${startShot}-${endShot}_${ts}`;
const filenamePrefix = `promptrelay_probe/director_${slug}`;

console.log(`LTX Director probe — ${projectRoot.split('/').pop()}`);
console.log(
  `Scene ${sceneNumber}${scenePlan.sceneTitle ? ` (${scenePlan.sceneTitle})` : ''}, shots ${startShot}..${endShot}`,
);
console.log(`Style: ${projectStyle}`);
console.log(`Global prompt: ${globalPrompt}`);
for (let i = 0; i < selectedShots.length; i++) {
  const s = selectedShots[i];
  console.log(
    `\nshot ${s.shotNumber} (${segmentFrames[i]} frames = ${(segmentFrames[i] / FPS).toFixed(2)}s, start@${segmentStarts[i]}, purpose=${s.purpose ?? 'n/a'}):`,
  );
  console.log(`  ${localPrompts[i].slice(0, 240)}${localPrompts[i].length > 240 ? '...' : ''}`);
}
console.log(
  `\nTotal: ${totalFrames} frames = ${(totalFrames / FPS).toFixed(2)}s @ ${FPS}fps`,
);

if (totalFrames > 1000) {
  console.error(
    `\nTotal frames ${totalFrames} exceeds LTX 2.3 audio-latent cap (1000). Pick fewer/shorter shots.`,
  );
  process.exit(1);
}

const firstFrames = selectedShots.map((s) =>
  pickFirstFrame(sceneNumber, s.shotNumber),
);
console.log('\nUploading first frames...');
const uploadedNames: string[] = [];
for (let i = 0; i < firstFrames.length; i++) {
  const u = await client.uploadImage(firstFrames[i], 'input', true);
  console.log(
    `  shot ${selectedShots[i].shotNumber}: ${firstFrames[i].split('/').pop()} → ${u.name}`,
  );
  uploadedNames.push(u.name);
}

// ── timeline_data — schema reverse-engineered from ltx_director.py ───
// img segs: { type: "image", imageFile, start (pixel-frame), strength? }
// audio segs: empty for the first probe (no ACE-Step yet).
const timelineData = {
  segments: selectedShots.map((_, i) => ({
    type: 'image',
    imageFile: uploadedNames[i],
    start: segmentStarts[i],
  })),
  audioSegments: [] as unknown[],
};

const seed = Math.floor(Math.random() * 0x7fffffff);

// ── Inject director params (clone first to keep the cached parse) ────
const workflow: Record<
  string,
  { inputs: Record<string, unknown>; class_type: string }
> = JSON.parse(JSON.stringify(baseWorkflow));

const director = workflow['46'];
if (!director || director.class_type !== 'LTXDirector') {
  console.error('Workflow does not contain LTXDirector node at id 46');
  process.exit(1);
}
director.inputs['global_prompt'] = globalPrompt;
director.inputs['duration_frames'] = totalFrames;
director.inputs['duration_seconds'] = totalFrames / FPS;
director.inputs['timeline_data'] = JSON.stringify(timelineData);
director.inputs['local_prompts'] = localPrompts.join(' | ');
director.inputs['segment_lengths'] = segmentFrames.join(', ');
director.inputs['frame_rate'] = FPS;
director.inputs['epsilon'] = 0.001;
director.inputs['guide_strength'] = selectedShots.map(() => '1.0').join(', ');
director.inputs['use_custom_audio'] = false;
// Force 480p (16:9) for fast iteration. With divisible_by=32 the director
// will snap 854→832, so the actual output is 832×480 ≈ 16:9.
director.inputs['custom_width'] = 854;
director.inputs['custom_height'] = 480;
director.inputs['divisible_by'] = 32;
director.inputs['img_compression'] = 18;

// Negative prompt (node 90). Dialogue-mode negative: visual + audio
// quality + ban improv narration/voiceover/monologue/singing/music but
// KEEP "speech, dialogue, talking" allowed since we want scripted lines.
const negativeNode = workflow['90'];
if (negativeNode && negativeNode.class_type === 'CLIPTextEncode') {
  negativeNode.inputs['text'] = [
    'blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, compression artifacts, jpeg artifacts, glitches, watermark, text, logo, signature, copyright, subtitles',
    'distorted sound, saturated sound, loud',
    // Anti-improv: kill voiceover/narration and any extra speech beyond the quoted line.
    'narration, voice over, voiceover, monologue, singing, vocals, background music, music score',
    'improvised speech, additional dialogue, extra phrases, extra sentences, rambling, made-up words, freestyle speech, ad-lib, hallucinated speech, speech beyond the quoted line, continued talking, mumbling',
  ].join(', ');
}

const noiseNode = workflow['28'];
if (noiseNode && noiseNode.class_type === 'RandomNoise') {
  noiseNode.inputs['noise_seed'] = seed;
}

const saveNode = workflow['30'];
if (saveNode && saveNode.class_type === 'SaveVideo') {
  saveNode.inputs['filename_prefix'] = filenamePrefix;
}

console.log(`\nSubmitting to ${process.env['COMFYUI_BASE_URL']}...`);
const startTime = Date.now();
const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(
  workflow,
  (p) => {
    if (p.percentage !== undefined && p.message) {
      console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
    }
  },
);
console.log(
  `  complete in ${Math.floor((Date.now() - startTime) / 1000)}s (prompt_id=${promptId})`,
);

const histImages = await client.getOutputImages(promptId);
const seen = new Set<string>();
const allOutputs = [...wsOutputs, ...histImages]
  .filter((i) => /\.(mp4|webm|mov)$/i.test(i.filename))
  .filter((i) => !seen.has(i.filename) && (seen.add(i.filename), true));

if (allOutputs.length === 0) {
  console.error('No video output');
  process.exit(1);
}

const targetName = `director_${slug}.mp4`;
const item = allOutputs[0];
const dl = await client.downloadImage(
  item.filename,
  item.subfolder ?? '',
  item.type ?? 'output',
  targetName,
);

const metaPath = join(outputDir, targetName.replace(/\.mp4$/, '.meta.json'));
writeFileSync(
  metaPath,
  JSON.stringify(
    {
      probe: 'ltx-director',
      workflow: 'workflows/built-in/ltx23_director_local.json',
      project: projectRoot,
      scene: sceneNumber,
      shotRange: [startShot, endShot],
      style: projectStyle,
      sceneTitle: scenePlan.sceneTitle,
      globalPrompt,
      localPrompts,
      segmentFrames,
      segmentStarts,
      totalFrames,
      fps: FPS,
      seed,
      promptId,
      timelineData,
      firstFrames: firstFrames.map((p) => p.replace(projectRoot + '/', '')),
      uploadedNames,
      compareWith: `assets/videos/shots/s${sceneNumber}shot{${startShot}..${endShot}}_ltx23_*.mp4 (per_shot baselines)`,
    },
    null,
    2,
  ),
);

console.log(`\nVideo:    ${dl}`);
console.log(`Metadata: ${metaPath}`);
