#!/usr/bin/env tsx
/**
 * Probe the LTX 2.3 + kijai/ComfyUI-PromptRelay multi-segment workflow
 * on a real project. Picks N consecutive shots from a scene, uploads
 * their first-frame images, builds a pipe-separated prompt timeline
 * from each shot's motion directive, and submits to the LOCAL ComfyUI
 * server. Two workflow variants ship: 4-segment and 9-segment.
 *
 * The point: prompt-relay claims to keep coherence across long
 * multi-shot flows by patching one model with a temporal prompt schedule
 * — not by stitching independent renders. This probe puts that claim on
 * a real story.
 *
 * Usage:
 *   pnpm tsx scripts/probe-ltx-promptrelay.ts <project> <scene> [startShot] [Nseg]
 *
 * Examples:
 *   pnpm tsx scripts/probe-ltx-promptrelay.ts woman_medieval_village_betrothed 1 1
 *   pnpm tsx scripts/probe-ltx-promptrelay.ts noir_detective_story_setup-3 1 1 9
 *
 * Output:
 *   <project>/assets/videos/promptrelay_probe/
 *     s{N}shots{A}-{B}_promptrelay.mp4
 *     s{N}shots{A}-{B}_promptrelay.meta.json   (the exact params used)
 *
 * Forces local mode regardless of COMFY_MODE — the workflow uses local
 * model files (LTX23_audio_vae_bf16, gemma_3_12B_it_heretic_fp8_e4m3fn,
 * ltx-2.3-22b-distilled-1.1) that aren't on cloud.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';
import { expandPromptRelayWorkflow } from '../src/services/providers/promptRelayWorkflowExpander.js';
import { stripSpeechVerbs } from '../src/services/providers/stripSpeechVerbs.js';
import { buildPromptRelayGlobalPrompt } from '../src/services/providers/promptRelayGlobalPrompt.js';

// ── Force local mode for this probe ──────────────────────────────────
// The workflow references locally-downloaded LTX 2.3 models / VAE / Gemma
// CLIP weights. Even if the user's .env has COMFY_MODE=cloud, this probe
// must hit the local server (which in this repo is the zrok-tunneled
// machine at COMFYUI_BASE_URL). Set BEFORE constructing the client so
// `getComfyConfig()` reads the local branch.
process.env['COMFY_MODE'] = 'local';

const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')));
const [projectArg, sceneArg, startShotArg, nsegArg] = positional;
const useEqualSegments = flags.has('--equal');
if (!projectArg || !sceneArg) {
  console.error('Usage: pnpm tsx scripts/probe-ltx-promptrelay.ts <project> <scene> [startShot=1] [Nseg=4] [--equal]');
  console.error('  Nseg can be any integer 1..20 — the workflow is expanded in-memory.');
  console.error('  --equal: ignore per-shot durations and use LTX-aligned equal segments.');
  process.exit(1);
}
const scene = parseInt(sceneArg, 10);
const startShot = parseInt(startShotArg ?? '1', 10);
const SEGMENT_COUNT = parseInt(nsegArg ?? '4', 10);
if (!Number.isFinite(scene) || !Number.isFinite(startShot) || !Number.isFinite(SEGMENT_COUNT)) {
  console.error('scene, startShot, and Nseg must be integers');
  process.exit(1);
}
if (SEGMENT_COUNT < 1 || SEGMENT_COUNT > 20) {
  console.error(`Nseg must be between 1 and 20 (got ${SEGMENT_COUNT}); kijai LTXVAddGuideMulti caps at 20.`);
  process.exit(1);
}

const shotNumbers = Array.from({ length: SEGMENT_COUNT }, (_, i) => startShot + i);

// ── Resolve project ──────────────────────────────────────────────────
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`,
);
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

// ── Load 4-seg base workflow + expand to N segments ──────────────────
// The 4-seg JSON is the structural reference (loaders, samplers, NAG,
// video-combine wiring). expandPromptRelayWorkflow stamps out an
// N-segment variant in memory and returns matching parameter mappings.
const workflowBase = 'ltx23_promptrelay_4seg_local';
const baseWorkflowPath = resolve(process.cwd(), `workflows/built-in/${workflowBase}.json`);
const baseTemplate = JSON.parse(readFileSync(baseWorkflowPath, 'utf-8'));

// Sanity-check the patched node is the right class (not the broken
// "UNKNOWN" export). If someone re-copies the raw download over it, fail
// loudly here rather than waiting for ComfyUI to reject the prompt.
const relayNode = baseTemplate['948'];
if (relayNode?.class_type !== 'PromptRelayEncode') {
  console.error(`FAIL: workflow node 948 must be class_type='PromptRelayEncode' (found '${relayNode?.class_type}')`);
  console.error('      Re-apply the patch — the raw downloaded JSON has the class stripped.');
  process.exit(1);
}

const { workflow: template, parameterMappings } = expandPromptRelayWorkflow(baseTemplate, SEGMENT_COUNT);
const manifest = { parameterMappings };

// ── Pick first-frame image for each shot ────────────────────────────
// Source of truth: assets/manifest.json. The manifest lists *every*
// generated image per shot (regenerations don't bump `version`, they
// add a new entry with a fresh `createdAt`). The "current" first-frame
// for a shot is the manifest entry with the largest `createdAt` whose
// path matches `s{N}shot{M}_first_frame_*.png`. Filesystem glob is
// unreliable here because lex-sort on the random nanoid suffix
// happens to pick the older version about half the time.
const imagesDir = join(projectRoot, 'assets/images');
type ManifestAsset = { type?: string; path: string; createdAt?: number };
const projectManifestPath = join(projectRoot, 'assets/manifest.json');
const projectManifest = existsSync(projectManifestPath)
  ? (JSON.parse(readFileSync(projectManifestPath, 'utf-8')) as { assets?: ManifestAsset[] })
  : { assets: [] as ManifestAsset[] };
function pickFirstFrame(s: number, shot: number): string {
  const re = new RegExp(`/s${s}shot${shot}_first_frame_[^/]+\\.png$`);
  const matches = (projectManifest.assets ?? [])
    .filter((a: ManifestAsset) => a.type === 'scene_image' && re.test(a.path))
    .sort((a: ManifestAsset, b: ManifestAsset) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (matches.length > 0) {
    const winner = matches[0];
    return join(projectRoot, winner.path);
  }
  // Backstop: no manifest entry. Take the most-recently-modified file
  // matching the shot pattern. mtime is more reliable than lex-sort.
  const hits = readdirSync(imagesDir)
    .filter(f => new RegExp(`^s${s}shot${shot}_first_frame_`).test(f) && f.endsWith('.png'))
    .map(f => ({ f, mtime: statSync(join(imagesDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (hits.length === 0) {
    console.error(`No first_frame image for scene ${s} shot ${shot} in ${imagesDir}`);
    process.exit(1);
  }
  return join(imagesDir, hits[0].f);
}

// ── Read motion directive for each shot ──────────────────────────────
function readMotion(s: number, shot: number): string {
  const p = join(projectRoot, `prompts/motion/scene_${s}_shot_${shot}.json`);
  if (!existsSync(p)) {
    console.error(`Motion directive not found: ${p}`);
    process.exit(1);
  }
  const motion = JSON.parse(readFileSync(p, 'utf-8'));
  const text = typeof motion.motionDirective === 'string' ? motion.motionDirective.trim() : '';
  if (!text) {
    console.error(`scene_${s}_shot_${shot}.json has no 'motionDirective' field`);
    process.exit(1);
  }
  return text;
}

// ── Build the global prompt as a VISUAL/STYLE anchor, not a story ────
// Past-tense story summaries ("Elara adamantly refuses...") read like
// voice-over copy to LTX-2.3 and trigger narration in the generated
// audio track. The relay's job is to keep the *character + style*
// stable across segments, so we feed it identity + style tokens and
// nothing narrative.
// Read prompts/scene_summaries.json["scene_<N>"] if available.
function readSceneSummary(s: number): string {
  const p = join(projectRoot, 'prompts/scene_summaries.json');
  if (!existsSync(p)) return '';
  try {
    const d = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, string>;
    return d[`scene_${s}`] ?? '';
  } catch { return ''; }
}

const firstFrames = shotNumbers.map(n => pickFirstFrame(scene, n));
const rawLocalPrompts = shotNumbers.map(n => readMotion(scene, n));
// Strip speech-verb clauses from each local_prompt so LTX 2.3's audio
// head doesn't fire on words like "speaking"/"calls out"/"whispers".
// `--keep-speech` env flag bypasses for A/B comparison.
const stripSpeech = !process.env['KEEP_SPEECH'];
const localPrompts = stripSpeech ? rawLocalPrompts.map(p => stripSpeechVerbs(p)) : rawLocalPrompts;
if (stripSpeech) {
  console.log('Speech-verb strip: ENABLED (set KEEP_SPEECH=1 to disable for A/B)');
  for (let i = 0; i < shotNumbers.length; i++) {
    if (rawLocalPrompts[i] !== localPrompts[i]) {
      console.log(`  s${scene}shot${shotNumbers[i]} BEFORE: ${rawLocalPrompts[i].slice(0, 120)}...`);
      console.log(`  s${scene}shot${shotNumbers[i]} AFTER:  ${localPrompts[i].slice(0, 120)}...`);
    }
  }
}

// Read the project's declared style (e.g. "anime") for the visual prefix.
const projectStyle = (() => {
  try {
    const pj = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8')) as { style?: string };
    return pj.style ?? 'cinematic';
  } catch { return 'cinematic'; }
})();

// Global prompt = style + scene summary only. Character descriptions
// are intentionally excluded — they didn't help in earlier probes and
// added Gemma token pressure without changing identity stability.
const sceneSummary = readSceneSummary(scene);
const globalPrompt = buildPromptRelayGlobalPrompt({
  style: projectStyle,
  characters: [],
  sceneDescription: sceneSummary,
});

// Override the workflow's baked-in negative prompt with one that also
// suppresses generated speech/narration. LTX-2.3 produces audio along
// with video; without explicit suppression the model often invents a
// narrator voicing whatever character is on screen.
const negativePrompt = [
  // existing visual negatives (kept verbatim from node 818)
  'blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, compression artifacts, jpeg artifacts, glitches, watermark, text, logo, signature, copyright, subtitles',
  // audio negatives — both the original and new anti-speech tokens
  'distorted sound, saturated sound, loud',
  'narration, voice over, voiceover, monologue, speech, dialogue, talking, singing, vocals, lip sync, mouth movement',
].join(', ');

// ── Frame counts: derive from each shot's declared duration in
// prompts/videos/scenes/scene_<N>.json so the assembled video matches
// the storyboard's timing. LTX-2.3 needs total frames to fit
// (8*M + 1) and each segment ideally a multiple of 8 — round each
// duration*fps to the nearest 8, then add +1 to the first segment so
// the total clears the modular check. Fall back to fixed defaults if
// durations aren't available, or when --equal is passed.
const FPS = 24;
const FIXED_DEFAULT: Record<number, number[]> = {
  4: [121, 120, 120, 120],          // 481 frames ≈ 20s
  9: [81, ...Array(8).fill(80)],    // 721 frames ≈ 30s
};
function alignToLTX(rawFrames: number[]): number[] {
  // Round each to nearest multiple of 8, floor at 8 frames per
  // segment. Then add +1 to the first segment so total = 8*M + 1.
  const rounded = rawFrames.map(f => Math.max(8, Math.round(f / 8) * 8));
  rounded[0] = rounded[0] + 1;
  return rounded;
}
function readSegmentFramesFromProject(): number[] | null {
  if (useEqualSegments) return null;
  const p = join(projectRoot, `prompts/videos/scenes/scene_${scene}.json`);
  if (!existsSync(p)) return null;
  try {
    const sj = JSON.parse(readFileSync(p, 'utf-8')) as { shots?: Array<{ shotNumber?: number; duration?: number }> };
    const byShot = new Map<number, number>();
    for (const sh of sj.shots ?? []) {
      if (typeof sh.shotNumber === 'number' && typeof sh.duration === 'number') {
        byShot.set(sh.shotNumber, sh.duration);
      }
    }
    const durations = shotNumbers.map(n => byShot.get(n));
    if (durations.some(d => d === undefined)) return null;
    return alignToLTX(durations.map(d => (d as number) * FPS));
  } catch { return null; }
}
const projectFrames = readSegmentFramesFromProject();
const segmentFrames = projectFrames ?? FIXED_DEFAULT[SEGMENT_COUNT];
const segmentSource = projectFrames ? 'project shot durations' : (useEqualSegments ? 'fixed (--equal)' : 'fixed (no project durations)');
const totalFrames = segmentFrames.reduce((a, b) => a + b, 0);
const segmentLengthsCsv = segmentFrames.join(', ');

// ── Build seeds ──────────────────────────────────────────────────────
const seedPass1 = Math.floor(Math.random() * 0x7FFFFFFF);
const seedPass2 = Math.floor(Math.random() * 0x7FFFFFFF);

// ── Output dir ───────────────────────────────────────────────────────
const outputDir = join(projectRoot, 'assets/videos/promptrelay_probe');
mkdirSync(outputDir, { recursive: true });

// ── Set up client ────────────────────────────────────────────────────
const client = new ComfyUIClient({ outputDir });

console.log(`Project:       ${projectRoot}`);
console.log(`Scene:         ${scene}`);
console.log(`Shots:         ${shotNumbers.join(', ')}`);
console.log(`Frames:        ${segmentLengthsCsv}  (total ${totalFrames}, ${(totalFrames / FPS).toFixed(2)}s @ ${FPS}fps, source: ${segmentSource})`);
console.log(`Pass1 seed:    ${seedPass1}`);
console.log(`Pass2 seed:    ${seedPass2}`);
console.log(`Global prompt: ${globalPrompt.slice(0, 200)}${globalPrompt.length > 200 ? '...' : ''}`);
for (let i = 0; i < shotNumbers.length; i++) {
  console.log(`  s${scene}shot${shotNumbers[i]}: ${localPrompts[i].slice(0, 120)}${localPrompts[i].length > 120 ? '...' : ''}`);
}

// ── Upload first frames ──────────────────────────────────────────────
console.log('\nUploading first-frame images to ComfyUI...');
const uploadedNames: string[] = [];
for (let i = 0; i < firstFrames.length; i++) {
  const u = await client.uploadImage(firstFrames[i], 'input', true);
  console.log(`  segment ${i + 1}: ${firstFrames[i].split('/').pop()} → ${u.name}`);
  uploadedNames.push(u.name);
}

// ── Parameterize ─────────────────────────────────────────────────────
const filenamePrefix = `promptrelay/s${scene}shots${shotNumbers[0]}-${shotNumbers.at(-1)}`;
const segmentParams: Record<string, unknown> = {};
for (let i = 0; i < SEGMENT_COUNT; i++) {
  segmentParams[`segment_${i + 1}_image`] = uploadedNames[i];
  segmentParams[`segment_${i + 1}_frames`] = segmentFrames[i];
}
const workflow = parameterizeGeneric(template, manifest, {
  global_prompt: globalPrompt,
  local_prompts: localPrompts.join(' | '),
  negative_prompt: negativePrompt,
  segment_lengths: segmentLengthsCsv,
  total_frames: totalFrames,
  ...segmentParams,
  seed_pass1: seedPass1,
  seed_pass2: seedPass2,
  filenamePrefix,
}) as Record<string, unknown>;

// ── Submit + wait ────────────────────────────────────────────────────
console.log('\nSubmitting to LOCAL ComfyUI...');
const start = Date.now();
const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, (p) => {
  if (p.percentage !== undefined && p.message) {
    console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
  }
});
console.log(`  complete in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

// ── Collect + download ───────────────────────────────────────────────
const histImages = await client.getOutputImages(promptId);
const seen = new Set<string>();
const allOutputs = [...wsOutputs, ...histImages]
  .filter(i => /\.(mp4|webm|mov)$/i.test(i.filename))
  .filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));

if (allOutputs.length === 0) {
  console.error('No video output found.');
  console.error('  ws outputs:    ', wsOutputs.map(i => i.filename).join(','));
  console.error('  history outputs:', histImages.map(i => i.filename).join(','));
  process.exit(1);
}

const targetName = `s${scene}shots${shotNumbers[0]}-${shotNumbers.at(-1)}_promptrelay_${SEGMENT_COUNT}seg.mp4`;
const item = allOutputs[0];
const dl = await client.downloadImage(
  item.filename,
  item.subfolder ?? '',
  item.type ?? 'output',
  targetName,
);

// ── Save metadata sidecar ────────────────────────────────────────────
const metaPath = join(outputDir, targetName.replace(/\.mp4$/, '.meta.json'));
writeFileSync(metaPath, JSON.stringify({
  project: projectArg,
  scene,
  shotNumbers,
  workflow: workflowBase,
  globalPrompt,
  localPrompts,
  negativePrompt,
  segmentFrames,
  segmentSource,
  totalFrames,
  fps: FPS,
  seedPass1,
  seedPass2,
  promptId,
  firstFrames: firstFrames.map(p => p.replace(projectRoot + '/', '')),
  uploadedNames,
  comfyMode: 'local',
  comfyBaseUrl: process.env['COMFYUI_BASE_URL'] ?? 'http://localhost:8188',
}, null, 2));

console.log(`\nVideo:    ${dl}`);
console.log(`Metadata: ${metaPath}`);
