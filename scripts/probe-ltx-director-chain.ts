#!/usr/bin/env tsx
/**
 * Probe the A3 director-chain workflow — extend a prior director
 * bundle's mp4 with another N shots via LTXVAddLatentGuide anchoring.
 *
 * The graft (workflows/built-in/ltx23_director_chain_local.json) inserts
 * LTXVAddLatentGuide between LTXDirectorGuide and the sampler chain.
 * The source mp4's last 8 pixel frames are halved (to match pass-1
 * scale_by=0.5), encoded via the video VAE, and fed as the
 * guiding_latent at latent_idx=0. With strength=1.0 the model is forced
 * to start the new bundle from the source tail's encoded latent.
 *
 * The new bundle's prompt-relay timeline picks up the next contiguous
 * shots and the Director's per-segment first-frame anchors handle
 * everything past the boundary frame.
 *
 * Usage:
 *   pnpm tsx scripts/probe-ltx-director-chain.ts <sourceMp4> [<projectPath> <scene> <start> <end>]
 *
 * Example:
 *   pnpm tsx scripts/probe-ltx-director-chain.ts \
 *     "/Users/ganaraj/dhee-studios/Better Image/assets/videos/promptrelay_probe/director_s1_1-3_1779729475612.mp4" \
 *     "/Users/ganaraj/dhee-studios/Better Image" 1 4 5
 *
 * Output:
 *   <project>/assets/videos/promptrelay_probe/
 *     director_chain_s<scene>_<start>-<end>_<ts>.mp4
 *     director_chain_s<scene>_<start>-<end>_<ts>.meta.json
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
import { join, resolve, basename } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

process.env['COMFY_MODE'] = 'local';
process.env['COMFYUI_BASE_URL'] =
  process.env['COMFY_LOCAL_URL'] ?? 'https://comfyui.share.zrok.io';

// ── CLI ──────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.length < 1) {
  console.error(
    'Usage: pnpm tsx scripts/probe-ltx-director-chain.ts <sourceMp4> [<projectPath> <scene> <start> <end>]',
  );
  process.exit(1);
}
const sourceMp4 = resolve(args[0]);
if (!existsSync(sourceMp4)) {
  console.error(`Source mp4 not found: ${sourceMp4}`);
  process.exit(1);
}

const DEFAULT_PROJECT = '/Users/ganaraj/dhee-studios/Better Image';
const projectRoot = resolve(args[1] ?? DEFAULT_PROJECT);
const sceneNumber = parseInt(args[2] ?? '1', 10);
const startShot = parseInt(args[3] ?? '4', 10);
const endShot = parseInt(args[4] ?? '5', 10);

if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

// ── Prompt-shaping helpers (mirrors probe-ltx-director.ts) ───────────
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

// ── Read project + scene + selected shots ────────────────────────────
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

const projectStyle = (() => {
  try {
    const pj = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8')) as {
      style?: string;
    };
    return pj.style ?? 'cinematic';
  } catch {
    return 'cinematic';
  }
})();
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
if (selectedShots.length !== endShot - startShot + 1) {
  console.error(
    `Expected ${endShot - startShot + 1} contiguous shots, got ${selectedShots.length} — non-contiguous shot numbers in plan`,
  );
  process.exit(1);
}

function buildLocalPrompt(s: ShotPlan): string {
  const parts: string[] = [];
  if (s.description) {
    const cleaned = stripDialogueParaphrase(s.description.trim());
    if (cleaned.length > 0) parts.push(cleaned);
  }
  if (s.cameraWork) parts.push(s.cameraWork.trim());
  if (s.audio && s.audio.trim().length > 0) {
    parts.push(`Audio: ${reformatDialogue(s.audio.trim())}`);
  }
  return parts.join(' ');
}

const FPS = 24;
function alignToLTX(rawFrames: number[]): number[] {
  const rounded = rawFrames.map((f) => Math.max(8, Math.round(f / 8) * 8));
  rounded[0] = rounded[0] + 1;
  return rounded;
}
const segmentFrames = alignToLTX(selectedShots.map((s) => s.duration * FPS));
const totalFrames = segmentFrames.reduce((a, b) => a + b, 0);
const segmentStarts: number[] = [];
{
  let acc = 0;
  for (const f of segmentFrames) {
    segmentStarts.push(acc);
    acc += f;
  }
}

if (totalFrames > 1000) {
  console.error(
    `\nTotal frames ${totalFrames} exceeds LTX 2.3 audio-latent cap (1000). Pick fewer/shorter shots for this bundle.`,
  );
  process.exit(1);
}

const globalPrompt = `${projectStyle} style. Cinematic continuity across shots, consistent character identity and lighting.${scenePlan.sceneTitle ? ` Scene: ${scenePlan.sceneTitle}.` : ''}`;

// ── First-frame picker (same logic as the regular probe) ─────────────
const imagesDir = join(projectRoot, 'assets/images');
const projectManifestPath = join(projectRoot, 'assets/manifest.json');
type ManifestAsset = { type?: string; path: string; createdAt?: number };
const projectManifest = existsSync(projectManifestPath)
  ? (JSON.parse(readFileSync(projectManifestPath, 'utf-8')) as {
      assets?: ManifestAsset[];
    })
  : { assets: [] as ManifestAsset[] };
function pickFirstFrame(s: number, shot: number): string {
  const re = new RegExp(`/s${s}shot${shot}_first_frame_[^/]+\\.png$`);
  const matches = (projectManifest.assets ?? [])
    .filter((a) => a.type === 'scene_image' && re.test(a.path))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (matches.length > 0) return join(projectRoot, matches[0].path);
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

// ── Workflow + client ────────────────────────────────────────────────
const workflowPath = resolve(
  process.cwd(),
  'workflows/built-in/ltx23_director_chain_local.json',
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

console.log(`LTX Director CHAIN probe — ${projectRoot.split('/').pop()}`);
console.log(`Source bundle: ${basename(sourceMp4)}`);
console.log(`Extending with scene ${sceneNumber} shots ${startShot}..${endShot}`);
console.log(`Style: ${projectStyle}`);
console.log(`Global prompt: ${globalPrompt}\n`);

const localPrompts = selectedShots.map(buildLocalPrompt);
for (let i = 0; i < selectedShots.length; i++) {
  const s = selectedShots[i];
  console.log(
    `shot ${s.shotNumber} (${segmentFrames[i]} frames = ${(segmentFrames[i] / FPS).toFixed(2)}s, start@${segmentStarts[i]}, purpose=${s.purpose ?? 'n/a'}):`,
  );
  console.log(
    `  ${localPrompts[i].slice(0, 240)}${localPrompts[i].length > 240 ? '...' : ''}\n`,
  );
}
console.log(
  `Total: ${totalFrames} frames = ${(totalFrames / FPS).toFixed(2)}s @ ${FPS}fps`,
);

// ── Upload source mp4 + per-shot first-frames ────────────────────────
console.log('\nUploading source bundle...');
const sourceUpload = await client.uploadImage(sourceMp4, 'input', true);
console.log(`  ${basename(sourceMp4)} → ${sourceUpload.name}`);

const firstFrames = selectedShots.map((s) =>
  pickFirstFrame(sceneNumber, s.shotNumber),
);
console.log('\nUploading first frames...');
const uploadedFrames: string[] = [];
for (let i = 0; i < firstFrames.length; i++) {
  const u = await client.uploadImage(firstFrames[i], 'input', true);
  console.log(
    `  shot ${selectedShots[i].shotNumber}: ${basename(firstFrames[i])} → ${u.name}`,
  );
  uploadedFrames.push(u.name);
}

// ── Build timeline_data + inject params ──────────────────────────────
const timelineData = {
  segments: selectedShots.map((_, i) => ({
    type: 'image',
    imageFile: uploadedFrames[i],
    start: segmentStarts[i],
  })),
  audioSegments: [] as unknown[],
};

const seed = Math.floor(Math.random() * 0x7fffffff);
const filenamePrefix = `promptrelay_probe/director_chain_${slug}`;

const workflow: Record<
  string,
  { inputs: Record<string, unknown>; class_type: string }
> = JSON.parse(JSON.stringify(baseWorkflow));

// LTX Director (node 46) — same as the regular probe.
const director = workflow['46'];
if (!director || director.class_type !== 'LTXDirector') {
  console.error('Workflow missing LTXDirector at node 46');
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
director.inputs['custom_width'] = 854;
director.inputs['custom_height'] = 480;
director.inputs['divisible_by'] = 32;
director.inputs['img_compression'] = 18;

// VHS_LoadVideo (node 200) — point at uploaded source filename.
const loadVideo = workflow['200'];
if (loadVideo && loadVideo.class_type === 'VHS_LoadVideo') {
  loadVideo.inputs['video'] = sourceUpload.name;
}

// Negative prompt (node 90) — dialogue-mode.
const negativeNode = workflow['90'];
if (negativeNode && negativeNode.class_type === 'CLIPTextEncode') {
  negativeNode.inputs['text'] = [
    'blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, compression artifacts, jpeg artifacts, glitches, watermark, text, logo, signature, copyright, subtitles',
    'distorted sound, saturated sound, loud',
    'narration, voice over, voiceover, monologue, singing, vocals, background music, music score',
    'improvised speech, additional dialogue, extra phrases, extra sentences, rambling, made-up words, freestyle speech, ad-lib, hallucinated speech, speech beyond the quoted line, continued talking, mumbling',
  ].join(', ');
}

// Seed + filename prefix.
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

const targetName = `director_chain_${slug}.mp4`;
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
      probe: 'ltx-director-chain',
      workflow: 'workflows/built-in/ltx23_director_chain_local.json',
      project: projectRoot,
      sourceMp4,
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
      uploadedFrames,
      uploadedSource: sourceUpload.name,
      anchor: {
        type: 'LTXVAddLatentGuide',
        latent_idx: 0,
        strength: 1.0,
        source_tail_frames: 8,
      },
    },
    null,
    2,
  ),
);

console.log(`\nVideo:    ${dl}`);
console.log(`Metadata: ${metaPath}`);
console.log(
  `\nA/B target: ffmpeg-concat with the source bundle to compare seam continuity:`,
);
console.log(`  ffmpeg -y -i ${sourceMp4} -i ${dl} \\`);
console.log(
  `    -filter_complex "[0:v][1:v]concat=n=2:v=1[out]" -map "[out]" /tmp/chain_concat.mp4`,
);
