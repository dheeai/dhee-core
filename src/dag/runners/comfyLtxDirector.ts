/**
 * `comfy.ltx_director` runner — renders a contiguous range of shots as
 * one continuous mp4 via the LTX 2.3 Director ComfyUI workflow.
 *
 * Ports the working logic from scripts/probe-ltx-director.ts into the
 * bundle architecture. The probe stays as a CLI sandbox; this runner
 * is what bundle nodes target.
 *
 * Inputs the runner expects (from node config + ctx.inputs):
 *   - workflowPath: absolute path to ltx23_director_local.json (or compatible)
 *   - shots: array of { shotNumber, duration, description, cameraWork?, audio? }
 *   - firstFrames: array of absolute paths to first-frame images (1:1 with shots)
 *   - globalPrompt: string
 *   - fps: number (default 24)
 *   - outputPath: where to write the final mp4 (relative to projectDir)
 *
 * Constraints:
 *   - Total frames (sum of shot durations × fps, LTX-aligned) must be ≤ 1000.
 *     The runner errors if exceeded; chunking belongs in the upstream
 *     scene_clip node or as a future chunking pass.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, basename, resolve, extname } from 'node:path';
import { ComfyUIClient } from '../../services/comfyui/ComfyUIClient.js';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import { ffmpegBin, ffprobeBin } from './ffmpegBin.js';
import { retryTransient } from './transientRetry.js';
import { resolveRelayInputs } from '../projectResolvers.js';
import { REPO_ROOT } from '../../agent/pi/paths.js';
import { canonicalShotId, extractMotionDirective, readJsonFile } from './shotMotionContext.js';

export interface ShotInput {
  shotNumber: number;
  duration: number;
  description?: string;
  cameraWork?: string;
  audio?: string;
  dialogue?: string | null;
  speaker?: string | null;
  purpose?: string;
  transition?: string;
}

export interface LtxDirectorConfig {
  workflowPath: string;
  /**
   * Cloud variant of {@link workflowPath}, used when the resolved endpoint is
   * Comfy Cloud (the local graph references model files absent from cloud,
   * e.g. the gemma_3_12B heretic encoder). Resolved bundle-relative then
   * REPO_ROOT; falls back to {@link workflowPath} when unset or the file
   * doesn't resolve. Local runs are unaffected (the endpoint URL isn't cloud).
   */
  workflowPathCloud?: string;
  workflowId?: string;
  shots?: ShotInput[];
  firstFrames?: string[];
  globalPrompt?: string;
  fps?: number;
  outputPath: string;
  width?: number;
  height?: number;
  sceneNumber?: number;
  shotRange?: [number, number];
  chunkIndex?: number;
  chunkCount?: number;
  /**
   * Named endpoint this runner targets. Resolved against the user's
   * endpoint registry — `ENDPOINT_<name_with_dots_replaced_by_underscores>`
   * env var, mirrored from desktop Settings → ComfyUI Endpoints. The
   * NAME is part of the bundle (portable across users); the URL lives
   * in user config (per-user, never travels with the bundle). See the
   * architecture doc on named endpoints + future P2P routing.
   *
   * Conventional names:
   *   - 'self.local'   — user's own local ComfyUI box
   *   - 'self.cloud'   — user's own private cloud / paid subscription
   *   - 'public.cloud' — the public Comfy Cloud service
   *   - (future) 'peer.<id>' — P2P peers, auto-registered on discovery
   *
   * If omitted, falls back to legacy COMFYUI_BASE_URL env for
   * backwards-compatibility with bundles authored before this field.
   */
  endpoint?: string;
  /**
   * OPT-IN audio-driven mode. Name of the resolved input (e.g. 'segment_audio')
   * holding the per-item audio file path. When set AND a matching audio path is
   * present in ctx.inputs, the runner:
   *   - uploads the audio to Comfy's input dir,
   *   - builds a timeline_data.audioSegments entry + sets use_custom_audio=true,
   *   - repoints CreateVideo.audio to the LTXDirector combined_audio output (slot 6).
   * Absent → unchanged legacy behavior (generated audio, use_custom_audio=false).
   */
  audioInput?: string;
  /**
   * OPT-IN model-chain lora override. Rebuilds the lora chain
   * (base model → lora1 → … → loraN → LTXDirector.model) from this list.
   * Absent → the workflow's baked-in loras are left untouched.
   * Independent of audio: set per node (e.g. character-dialogue nodes use
   * talking-head + dual-character + id loras; narration nodes may set none).
   */
  loras?: Array<{ name: string; strength?: number }>;
  /**
   * OPT-IN lip-sync prompt augmentation. When true, appends explicit
   * facial-synchronization phrasing to each segment's prompt (and mirrors it
   * into timeline_data segments[].prompt). Pairs with audioInput + the
   * talking-head lora. Absent → prompts unchanged.
   */
  lipSync?: boolean;
  /**
   * OPT-IN single-still mode. Name of the resolved input (e.g. 'segment_image')
   * holding THIS item's still-image path. When set AND no scenes_plan is
   * available, the runner animates that one still into a single clip — sized to
   * the narration audio (audioInput) when present, else `duration` (default 5s).
   * For non-narrative bundles (infographics, slideshows) with no scenes_plan.
   * The motion prompt comes from `globalPrompt`.
   */
  imageInput?: string;
  /** Fallback clip length (seconds) for single-still mode when no audio sizes it. Default 5. */
  duration?: number;
  /** Single-still mode: name of an upstream input holding a PER-ITEM motion
   *  directive (string). When set, it becomes the segment's motion prompt
   *  (with `globalPrompt` appended as a shared style suffix), so each scene
   *  animates differently. Absent → `globalPrompt` alone. */
  promptInput?: string;
  /** LTX guide_strength (0..1). Lower = looser adherence to the still = MORE
   *  motion; higher (1.0) = clings to the still = minimal motion. Default 1.0.
   *  For lively cartoon motion, ~0.5–0.7. */
  guideStrength?: number;
}

/**
 * Resolve a named endpoint to its URL from the user's environment.
 * Returns null when the named endpoint isn't configured — caller surfaces
 * the actionable error.
 *
 * Naming convention: dots in the endpoint name become underscores in
 * the env key (env names can't contain dots). So `self.local` reads
 * `ENDPOINT_self_local`.
 */
import { resolveEndpointUrl } from './endpointResolver.js';
import { isCloudEndpoint, resolveWorkflowPath } from '../workflowPathResolver.js';

// ── Prompt-shaping helpers (ported verbatim from probe-ltx-director.ts) ──

export function stripDialogueParaphrase(description: string): string {
  const dialogueVerbs =
    /\b(asks?|says?|tells?|told|explains?|dismisses?|deflects?|whispers?|shouts?|speaks?|spoke|states?|declares?|replies|responds?|answers?|emphasi[sz]es?|insists?|argues?|mutters?|comments?|notes?|remarks?|adds?|continues?|sneers?|smirks?|grunts?)\b/i;
  const pronounSubject = /^\s*(?:He|She|They|It|Him|Her|His|Their)\b/i;
  return description
    .split(/(?<=[.!?])\s+/)
    .filter((s) => {
      if (!dialogueVerbs.test(s)) return true;
      if (pronounSubject.test(s)) return false;
      return true;
    })
    .join(' ')
    .trim();
}

export function reformatDialogue(audio: string): string {
  const speakerRe = /\b([A-Z][A-Z0-9_ ]{1,30}):\s*([^.!?]*[.!?])/g;
  const replacements: { full: string; speaker: string; line: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = speakerRe.exec(audio)) !== null) {
    replacements.push({ full: m[0], speaker: m[1]!, line: m[2]! });
  }
  if (replacements.length === 0) return audio;
  let out = audio;
  for (const r of replacements) {
    const name = r.speaker.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
    out = out.replace(r.full, `${name} says: "${r.line.trim()}".`);
  }
  return out;
}

/** Appended to a segment prompt when cfg.lipSync is set — the phrasing
 *  (from the working LTX Director example) that actually drives mouth motion. */
export const LIP_SYNC_SUFFIX =
  ' Their lips, jaws, cheeks, and subtle facial muscles move naturally in perfect synchronization with the spoken audio dialogue; they blink realistically with subtle head movements and gentle micro-expressions.';

type LtxWfNodes = Record<string, { inputs: Record<string, unknown>; class_type: string }>;

/**
 * Rebuild the model→lora chain from a lora list. Walks back from
 * LTXDirector(46).model through any LoraLoaderModelOnly nodes to the base
 * (non-lora) model source, removes those lora nodes, then re-creates one
 * LoraLoaderModelOnly per configured lora: base → lora0 → … → loraN →
 * 46.model. An empty list points 46.model straight at the base (no loras).
 * Exported for testing.
 */
export function rebuildLoraChain(wf: LtxWfNodes, loras: Array<{ name: string; strength?: number }>): void {
  const director = wf['46'];
  if (!director) return;
  let ref = director.inputs['model'] as [string, number] | undefined;
  const oldLoraIds: string[] = [];
  while (Array.isArray(ref) && wf[ref[0]] && wf[ref[0]]!.class_type === 'LoraLoaderModelOnly') {
    oldLoraIds.push(ref[0]);
    ref = wf[ref[0]]!.inputs['model'] as [string, number] | undefined;
  }
  const baseRef = ref;
  if (!baseRef) return;
  for (const id of oldLoraIds) delete wf[id];
  let prev: [string, number] = baseRef;
  loras.forEach((l, i) => {
    const id = `ltxlora_${i}`;
    wf[id] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { lora_name: l.name, strength_model: l.strength ?? 0.8, model: prev },
    };
    prev = [id, 0];
  });
  director.inputs['model'] = prev;
}

export function buildLocalPrompt(s: ShotInput): string {
  const parts: string[] = [];
  if (s.description) {
    const cleaned = stripDialogueParaphrase(s.description.trim());
    if (cleaned.length > 0) parts.push(cleaned);
  }
  if (s.cameraWork) parts.push(s.cameraWork.trim());
  // Surface dialogue: prefer explicit dialogue/speaker fields (set by
  // scenes_plan), fall back to legacy audio field.
  if (s.dialogue && s.dialogue.trim().length > 0) {
    const speaker = (s.speaker ?? '').trim();
    const line = s.dialogue.trim().replace(/^["']|["']$/g, '');
    const formatted = speaker
      ? `${speaker.charAt(0).toUpperCase()}${speaker.slice(1).toLowerCase()} says: "${line}".`
      : `"${line}".`;
    parts.push(`Audio: ${formatted}`);
  } else if (s.audio && s.audio.trim().length > 0) {
    parts.push(`Audio: ${reformatDialogue(s.audio.trim())}`);
  }
  if (s.transition && s.transition.trim().length > 0) {
    parts.push(`Transition: ${s.transition.trim()}`);
  }
  return parts.join(' ');
}

/** LTX latent alignment: each segment multiple of 8 frames; first segment +1
 *  so (total - 1) % 8 === 0. */
export function alignToLTX(rawFrames: number[]): number[] {
  const rounded = rawFrames.map((f) => Math.max(8, Math.round(f / 8) * 8));
  rounded[0] = rounded[0]! + 1;
  return rounded;
}

/** Snap n to the nearest multiple of m (never below m). LTX requires pixel
 *  dimensions divisible by 32; the bundles express intent (854×480, 1280×720)
 *  which are NOT divisible by 32, so we align here for deterministic output. */
export function snapToMultiple(n: number, m: number): number {
  return Math.max(m, Math.round(n / m) * m);
}

/**
 * Normalize a first-frame image to exactly targetW×targetH using a "cover"
 * fit: scale up to fully cover the target box, then center-crop the excess.
 * This guarantees every segment anchor shares ONE aspect ratio, which is what
 * stops the LTXDirector node from collapsing mixed-aspect first-frames (e.g.
 * a 1024×1024 zimage still next to an 848×480 klein still) into a square
 * 512×512 output. Idempotent: returns the original path when the image already
 * matches the target. Falls back to the original path on any ffmpeg/ffprobe
 * error so a normalization failure never blocks the render.
 */
export function normalizeFirstFrame(
  srcPath: string,
  targetW: number,
  targetH: number,
  log: (m: string) => void,
): string {
  let curW = 0;
  let curH = 0;
  try {
    const out = execFileSync(
      ffprobeBin(),
      ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', srcPath],
      { encoding: 'utf-8' },
    ).trim();
    const parts = out.split(',');
    curW = parseInt(parts[0] ?? '0', 10);
    curH = parseInt(parts[1] ?? '0', 10);
  } catch {
    return srcPath;
  }
  if (curW === targetW && curH === targetH) return srcPath;
  const dst = join(tmpdir(), `dhee-ltx-norm-${targetW}x${targetH}-${basename(srcPath)}`);
  try {
    execFileSync(
      ffmpegBin(),
      ['-y', '-i', srcPath, '-vf', `scale=${targetW}:${targetH}:force_original_aspect_ratio=increase,crop=${targetW}:${targetH}`, dst],
      { stdio: 'ignore' },
    );
    log(`comfy.ltx_director: normalized ${basename(srcPath)} ${curW}×${curH} → ${targetW}×${targetH}`);
    return dst;
  } catch {
    return srcPath;
  }
}

export interface ResolvedLtxDirectorConfig extends LtxDirectorConfig {
  workflowPath: string;
  shots: ShotInput[];
  firstFrames: string[];
  globalPrompt: string;
  outputPath: string;
  dependencies?: Array<{ nodeId: string; itemId?: string; role?: 'input' | 'context' | 'reference' | 'aggregate' }>;
}

type LtxDependency = NonNullable<ResolvedLtxDirectorConfig['dependencies']>[number];

export interface AudioVolumeProbe {
  meanVolumeDb?: number;
  maxVolumeDb?: number;
  silent: boolean;
  error?: string;
}

export interface FrameSimilarityProbe {
  ssim?: number;
  sampleTimeSeconds?: number;
  samples?: Array<{ timeSeconds: number; ssim?: number; error?: string }>;
  error?: string;
}

export interface MotionOutputValidation {
  ok: boolean;
  errors: string[];
  audio?: AudioVolumeProbe;
  firstFrame?: FrameSimilarityProbe;
}

const SILENT_AUDIO_MAX_DB = -60;
const MIN_ANCHOR_FRAME_SSIM = 0.4;
const ANCHOR_FRAME_SAMPLE_SECONDS = [0, 0.5, 1, 2] as const;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Duration (seconds) of an audio/video file, via ffprobe — content-based, so
 * it works for FLAC/WAV/mp4 regardless of file extension (Qwen3-TTS emits FLAC
 * even when the artifact is named .wav). Returns null if ffprobe is unavailable
 * or the file is unreadable; the caller then falls back to a config duration.
 */
function mediaDurationSeconds(path: string): number | null {
  try {
    const out = execFileSync(
      ffprobeBin(),
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
      { encoding: 'utf-8' },
    ).trim();
    const d = parseFloat(out);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function imageDataUri(path: string): string {
  const ext = extname(path).toLowerCase();
  const mime = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

function collectBeatRecords(plan: Record<string, unknown>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const beats = plan['beats'];
  if (Array.isArray(beats)) {
    for (const beat of beats) {
      const rec = asRecord(beat);
      if (rec) out.push(rec);
    }
  }
  const scenes = plan['scenes'];
  if (Array.isArray(scenes)) {
    for (const scene of scenes) {
      const sceneRec = asRecord(scene);
      const sceneBeats = sceneRec?.['beats'];
      if (!Array.isArray(sceneBeats)) continue;
      for (const beat of sceneBeats) {
        const rec = asRecord(beat);
        if (rec) out.push(rec);
      }
    }
  }
  return out;
}

function readBeatContextFromScenePlan(
  ctx: RunnerContext,
): { prompt?: string; dependency?: LtxDependency } {
  const plan = asRecord(ctx.inputs['scene_plan']);
  if (!plan || !ctx.itemId) return {};
  const beat = collectBeatRecords(plan).find((b) => nonEmptyString(b['id']) === ctx.itemId);
  if (!beat) return {};

  const parts: string[] = [];
  const vo = nonEmptyString(beat['vo']);
  const imageBrief = nonEmptyString(beat['image_brief']);
  const layout = nonEmptyString(beat['layout']);
  if (vo) parts.push(`Narration context: ${vo}`);
  if (imageBrief) parts.push(`Visual brief: ${imageBrief}`);
  if (layout) parts.push(`Composition: ${layout}`);
  if (parts.length === 0) return {};
  return {
    prompt: `${parts.join('. ')}.`,
    dependency: { nodeId: 'scene_plan', itemId: ctx.itemId, role: 'context' },
  };
}

function resolveAudioInputPath(ctx: RunnerContext, cfg: LtxDirectorConfig): string | undefined {
  if (!cfg.audioInput) return undefined;
  const value = ctx.inputs[cfg.audioInput];
  return typeof value === 'string' && existsSync(value) ? value : undefined;
}

export function probeAudioVolume(path: string): AudioVolumeProbe {
  const result = spawnSync(
    ffmpegBin(),
    ['-hide_banner', '-nostats', '-i', path, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
    { encoding: 'utf-8' },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    return { silent: true, error: output.trim().split('\n').slice(-4).join(' ') || 'ffmpeg volume probe failed' };
  }
  const meanMatch = output.match(/mean_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
  const maxMatch = output.match(/max_volume:\s*(-?(?:inf|\d+(?:\.\d+)?))\s*dB/i);
  const parseDb = (value: string | undefined): number | undefined => {
    if (!value || value.toLowerCase() === '-inf') return undefined;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  };
  const meanVolumeDb = parseDb(meanMatch?.[1]);
  const maxVolumeDb = parseDb(maxMatch?.[1]);
  return {
    ...(meanVolumeDb !== undefined ? { meanVolumeDb } : {}),
    ...(maxVolumeDb !== undefined ? { maxVolumeDb } : {}),
    silent: maxVolumeDb === undefined || maxVolumeDb <= SILENT_AUDIO_MAX_DB,
  };
}

export function probeFirstFrameSimilarity(opts: {
  sourceImagePath: string;
  videoPath: string;
  width: number;
  height: number;
}): FrameSimilarityProbe {
  return probeFrameSimilarityAtTime({ ...opts, timeSeconds: 0 });
}

function probeFrameSimilarityAtTime(opts: {
  sourceImagePath: string;
  videoPath: string;
  width: number;
  height: number;
  timeSeconds: number;
}): FrameSimilarityProbe {
  const { sourceImagePath, videoPath, width, height, timeSeconds } = opts;
  const filter = [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=gray[ref]`,
    `[1:v]scale=${width}:${height},format=gray[cmp]`,
    '[ref][cmp]ssim',
  ].join(';');
  const videoInputArgs = timeSeconds > 0 ? ['-ss', String(timeSeconds), '-i', videoPath] : ['-i', videoPath];
  const result = spawnSync(
    ffmpegBin(),
    [
      '-hide_banner',
      '-nostats',
      '-i',
      sourceImagePath,
      ...videoInputArgs,
      '-filter_complex',
      filter,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf-8' },
  );
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0) {
    return { error: output.trim().split('\n').slice(-4).join(' ') || 'ffmpeg frame similarity probe failed' };
  }
  const match = output.match(/All:([0-9.]+)/);
  const ssim = match ? Number(match[1]) : NaN;
  return Number.isFinite(ssim) ? { ssim, sampleTimeSeconds: timeSeconds } : { error: 'ffmpeg did not report SSIM' };
}

export function probeAnchorFrameSimilarity(opts: {
  sourceImagePath: string;
  videoPath: string;
  width: number;
  height: number;
}): FrameSimilarityProbe {
  const samples = ANCHOR_FRAME_SAMPLE_SECONDS.map((timeSeconds) => ({
    timeSeconds,
    ...probeFrameSimilarityAtTime({ ...opts, timeSeconds }),
  }));
  let best: { timeSeconds: number; ssim: number } | undefined;
  for (const sample of samples) {
    if (typeof sample.ssim !== 'number') continue;
    if (!best || sample.ssim > best.ssim) best = { timeSeconds: sample.timeSeconds, ssim: sample.ssim };
  }
  if (!best) {
    return {
      samples,
      error: samples.map((sample) => sample.error).filter(Boolean).join('; ') || 'no comparable video frames',
    };
  }
  return { ssim: best.ssim, sampleTimeSeconds: best.timeSeconds, samples };
}

export function muxOriginalAudio(videoPath: string, audioPath: string): { ok: true; volume: AudioVolumeProbe } | { ok: false; error: string } {
  const tmpPath = videoPath.replace(/\.[^.]+$/, `.audiofix-${Date.now()}.mp4`);
  try {
    execFileSync(
      ffmpegBin(),
      [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-i', videoPath,
        '-i', audioPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-shortest',
        '-movflags', '+faststart',
        tmpPath,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const volume = probeAudioVolume(tmpPath);
    if (volume.silent) {
      try { unlinkSync(tmpPath); } catch { /* best effort */ }
      return {
        ok: false,
        error: `remuxed audio is silent${volume.maxVolumeDb !== undefined ? ` (max_volume=${volume.maxVolumeDb} dB)` : ''}`,
      };
    }
    renameSync(tmpPath, videoPath);
    return { ok: true, volume };
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best effort */ }
    const stderr = (err as { stderr?: Buffer | string }).stderr;
    const detail = Buffer.isBuffer(stderr) ? stderr.toString('utf-8') : typeof stderr === 'string' ? stderr : String(err);
    return { ok: false, error: detail.trim().split('\n').slice(-4).join(' ') };
  }
}

function validateMotionOutput(opts: {
  videoPath: string;
  audioPath?: string;
  sourceImagePath?: string;
  width: number;
  height: number;
}): MotionOutputValidation {
  const errors: string[] = [];
  let audio: AudioVolumeProbe | undefined;
  let firstFrame: FrameSimilarityProbe | undefined;
  if (opts.audioPath) {
    audio = probeAudioVolume(opts.videoPath);
    if (audio.silent) {
      errors.push(`audio is silent${audio.maxVolumeDb !== undefined ? ` (max_volume=${audio.maxVolumeDb} dB)` : ''}`);
    }
  }
  if (opts.sourceImagePath) {
    firstFrame = probeAnchorFrameSimilarity({
      sourceImagePath: opts.sourceImagePath,
      videoPath: opts.videoPath,
      width: opts.width,
      height: opts.height,
    });
    if (firstFrame.error) {
      errors.push(`anchor-frame validation failed: ${firstFrame.error}`);
    } else if ((firstFrame.ssim ?? 0) < MIN_ANCHOR_FRAME_SSIM) {
      const samples = firstFrame.samples
        ?.filter((sample) => typeof sample.ssim === 'number')
        .map((sample) => `${sample.timeSeconds}s:${(sample.ssim ?? 0).toFixed(4)}`)
        .join(', ');
      errors.push(
        `anchor frame ignored source image (best_ssim=${(firstFrame.ssim ?? 0).toFixed(4)} at ${firstFrame.sampleTimeSeconds ?? 0}s` +
          `${samples ? `; samples=${samples}` : ''})`,
      );
    }
  }
  return {
    ok: errors.length === 0,
    errors,
    ...(audio ? { audio } : {}),
    ...(firstFrame ? { firstFrame } : {}),
  };
}

export function applyConfiguredLoras(
  workflow: LtxWfNodes,
  cfg: Pick<LtxDirectorConfig, 'loras'>,
  log?: (message: string) => void,
): boolean {
  if (!Array.isArray(cfg.loras)) return false;
  rebuildLoraChain(workflow, cfg.loras);
  log?.(
    cfg.loras.length > 0
      ? `comfy.ltx_director: loras → ${cfg.loras.map((l) => `${l.name}@${l.strength ?? 0.8}`).join(', ')}`
      : 'comfy.ltx_director: loras → none',
  );
  return true;
}

export function buildLtxTimelineData(opts: {
  shots: ShotInput[];
  uploadedNames: string[];
  imageDataUris?: Array<string | undefined>;
  segmentStarts: number[];
  audioSegments?: unknown[];
  localPrompts?: string[];
  guideStrength: number;
  lipSync?: boolean;
}): { segments: Array<Record<string, unknown>>; audioSegments: unknown[] } {
  const audioSegments = opts.audioSegments ?? [];
  return {
    segments: opts.shots.map((_, i) => {
      const dataUri = opts.imageDataUris?.[i];
      return {
        type: 'image',
        imageFile: dataUri ? '' : opts.uploadedNames[i]!,
        ...(dataUri ? { imageB64: dataUri } : {}),
        start: opts.segmentStarts[i]!,
        strength: opts.guideStrength,
        ...(opts.lipSync ? { prompt: `${opts.localPrompts?.[i] ?? ''}${LIP_SYNC_SUFFIX}` } : {}),
      };
    }),
    audioSegments,
  };
}

function redactTimelineData(timelineData: { segments: Array<Record<string, unknown>>; audioSegments: unknown[] }) {
  return {
    ...timelineData,
    segments: timelineData.segments.map((segment) => ({
      ...segment,
      ...(typeof segment['imageB64'] === 'string'
        ? { imageB64: `<embedded:${(segment['imageB64'] as string).length} chars>` }
        : {}),
    })),
  };
}

function asStringMap(value: unknown): Record<string, string> | undefined {
  const obj = asRecord(value);
  if (!obj) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function parseSceneNumberFromItemId(itemId: string | undefined): number | undefined {
  const m = itemId?.match(/^scene_(\d+)/);
  return m ? parseInt(m[1]!, 10) : undefined;
}

export function pickSceneVideoPrompt<T extends { sceneNumber?: number }>(
  svpInsts: T[],
  sceneNumber: number | undefined,
): T | undefined {
  if (sceneNumber !== undefined) {
    const match = svpInsts.find((s) => s.sceneNumber === sceneNumber);
    if (match) return match;
  }
  return svpInsts[0];
}

function deriveSceneShotFields(shots: Array<ShotInput & { id?: string; scene?: number }>): void {
  for (const s of shots) {
    if (s.scene === undefined || s.shotNumber === undefined) {
      const m = s.id?.match(/^scene_(\d+)_shot_(\d+)$/);
      if (m) {
        if (s.scene === undefined) s.scene = parseInt(m[1]!, 10);
        if (s.shotNumber === undefined) s.shotNumber = parseInt(m[2]!, 10);
      }
    }
  }
}

function readPromptFromScenePromptInput(
  ctx: RunnerContext,
  sceneNumber: number | undefined,
): { prompt?: string; dependency?: { nodeId: string; itemId?: string; role: 'context' } } {
  const input = ctx.inputs['scene_video_prompt'];
  if (typeof input === 'string') return { prompt: input, dependency: { nodeId: 'scene_video_prompt', role: 'context' } };
  const pathsById = asStringMap(input);
  if (!pathsById) return {};
  const sceneKey = sceneNumber !== undefined ? `scene_${sceneNumber}` : undefined;
  const promptPath = (sceneKey ? pathsById[sceneKey] : undefined) ?? Object.values(pathsById)[0];
  if (!promptPath || !existsSync(promptPath)) return {};
  try {
    const itemId = Object.entries(pathsById).find(([, p]) => p === promptPath)?.[0];
    return {
      prompt: readFileSync(promptPath, 'utf-8'),
      dependency: { nodeId: 'scene_video_prompt', ...(itemId !== undefined ? { itemId } : {}), role: 'context' },
    };
  } catch {
    return {};
  }
}

/** Resolve the CANONICAL (non-cloud) workflow path: absolute passthrough,
 *  else bundle-relative if it exists, else REPO_ROOT-relative. Cloud-aware
 *  selection happens later in runComfyLtxDirector via resolveWorkflowPath. */
function resolveCanonicalWorkflowPath(ctx: RunnerContext, workflowPath: string): string {
  if (workflowPath.startsWith('/')) return workflowPath;
  const bundleRel = ctx.bundleDir ? resolve(ctx.bundleDir, workflowPath) : undefined;
  return bundleRel && existsSync(bundleRel) ? bundleRel : resolve(REPO_ROOT, workflowPath);
}

export function resolveLtxDirectorConfigFromInputs(
  ctx: RunnerContext,
  cfg: LtxDirectorConfig,
): { ok: true; cfg: ResolvedLtxDirectorConfig } | { ok: false; error: string } {
  if (cfg.shots && cfg.firstFrames && cfg.globalPrompt) {
    return {
      ok: true,
      cfg: {
        ...cfg,
        workflowPath: resolveCanonicalWorkflowPath(ctx, cfg.workflowPath),
        shots: cfg.shots,
        firstFrames: cfg.firstFrames,
        globalPrompt: cfg.globalPrompt,
        outputPath: cfg.outputPath,
      },
    };
  }

  // Single-still mode: one image (+ optional audio) → one clip. For bundles
  // with no scenes_plan (e.g. infographics, slideshows). Sized to the narration
  // audio when audioInput resolves, else cfg.duration (default 5s).
  if (cfg.imageInput) {
    const imgVal = ctx.inputs[cfg.imageInput];
    const imagePath = typeof imgVal === 'string' ? imgVal : undefined;
    if (!imagePath || !existsSync(imagePath)) {
      return {
        ok: false,
        error: `comfy.ltx_director: imageInput '${cfg.imageInput}' resolved no image path (got ${JSON.stringify(imgVal)})`,
      };
    }
    const fps = cfg.fps ?? 24;
    let duration = cfg.duration ?? 5;
    const aPath = resolveAudioInputPath(ctx, cfg);
    if (aPath) {
        const d = mediaDurationSeconds(aPath);
        if (d && d > 0) {
          // Cap so totalFrames stays under the LTX 1000-frame audio-latent ceiling.
          const maxSec = Math.floor((1000 - 16) / fps);
          duration = Math.min(Math.max(d, 2), maxSec);
        }
    }
    // Per-item motion directive (if wired) + globalPrompt as a shared style suffix.
    const motionVal = cfg.promptInput ? ctx.inputs[cfg.promptInput] : undefined;
    const motionPrompt = typeof motionVal === 'string' && motionVal.trim().length > 0 ? motionVal.trim() : undefined;
    const beatContext = motionPrompt ? {} : readBeatContextFromScenePlan(ctx);
    const prompt =
      [motionPrompt ?? beatContext.prompt, cfg.globalPrompt].filter(Boolean).join(' ') ||
      'Subtle, elegant motion: a slow cinematic push-in with gentle parallax and a soft light shimmer; the composition stays crisp and readable.';
    const deps: ResolvedLtxDirectorConfig['dependencies'] = [
      { nodeId: cfg.imageInput, ...(ctx.itemId ? { itemId: ctx.itemId } : {}), role: 'input' },
    ];
    if (aPath && cfg.audioInput) {
      deps.push({ nodeId: cfg.audioInput, ...(ctx.itemId ? { itemId: ctx.itemId } : {}), role: 'input' });
    }
    if (motionPrompt && cfg.promptInput) deps.push({ nodeId: cfg.promptInput, role: 'input' });
    if (beatContext.dependency) deps.push(beatContext.dependency);
    return {
      ok: true,
      cfg: {
        ...cfg,
        workflowPath: resolveCanonicalWorkflowPath(ctx, cfg.workflowPath),
        shots: [{ shotNumber: 1, duration, description: prompt }],
        firstFrames: [imagePath],
        globalPrompt: prompt,
        outputPath: cfg.outputPath,
        dependencies: deps,
      },
    };
  }

  const sceneNumber = cfg.sceneNumber ?? parseSceneNumberFromItemId(ctx.itemId);
  const plan = asRecord(ctx.inputs['scenes_plan']);
  const rawShots = plan?.['shots'];
  if (Array.isArray(rawShots)) {
    if (sceneNumber === undefined) {
      return { ok: false, error: 'comfy.ltx_director: missing sceneNumber for scenes_plan input' };
    }
    const shots = (rawShots as Array<ShotInput & { id?: string; scene?: number }>).map((s) => ({ ...s }));
    deriveSceneShotFields(shots);
    const sceneShots = shots.filter((s) => s.scene === sceneNumber);
    const selected = cfg.shotRange
      ? sceneShots.filter((s) => s.shotNumber >= cfg.shotRange![0] && s.shotNumber <= cfg.shotRange![1])
      : sceneShots;
    if (selected.length === 0) {
      return { ok: false, error: `comfy.ltx_director: scenes_plan has no shots for scene ${sceneNumber}` };
    }

    const firstFrameById = asStringMap(ctx.inputs['shot_image']);
    if (!firstFrameById) {
      return { ok: false, error: "comfy.ltx_director: missing ctx.inputs['shot_image'] path map" };
    }
    const motionById = asStringMap(ctx.inputs['shot_motion_directive']) ?? {};
    const firstFrames: string[] = [];
    const resolvedShots: ShotInput[] = [];
    const dependencies: ResolvedLtxDirectorConfig['dependencies'] = [
      { nodeId: 'scenes_plan', role: 'context' },
    ];
    for (const s of selected) {
      const sid = canonicalShotId(s);
      if (!sid) {
        return { ok: false, error: `comfy.ltx_director: shot ${s.shotNumber} has no canonical id` };
      }
      const firstFrame = firstFrameById[sid];
      if (!firstFrame || !existsSync(firstFrame)) {
        return {
          ok: false,
          error: `comfy.ltx_director: shot_image output missing for ${sid} (looked up: ${firstFrame ?? '<no path>'})`,
        };
      }
      firstFrames.push(firstFrame);
      dependencies.push({ nodeId: 'shot_image', itemId: sid, role: 'input' });

      const motion = motionById[sid]
        ? extractMotionDirective(readJsonFile(motionById[sid]))
        : undefined;
      if (motionById[sid]) dependencies.push({ nodeId: 'shot_motion_directive', itemId: sid, role: 'input' });
      resolvedShots.push({
        shotNumber: s.shotNumber,
        duration: s.duration ?? 3,
        ...(motion?.description ?? s.description ? { description: motion?.description ?? s.description } : {}),
        ...(motion?.cameraWork ?? s.cameraWork ? { cameraWork: motion?.cameraWork ?? s.cameraWork } : {}),
        ...(motion?.audio ? { audio: motion.audio } : {}),
        ...(s.dialogue ? { dialogue: s.dialogue } : {}),
        ...(s.speaker ? { speaker: s.speaker } : {}),
        ...(motion?.purpose ? { purpose: motion.purpose } : {}),
        ...(motion?.transition ? { transition: motion.transition } : {}),
      });
    }
    const scenePrompt = readPromptFromScenePromptInput(ctx, sceneNumber);
    if (scenePrompt.dependency) dependencies.push(scenePrompt.dependency);

    return {
      ok: true,
      cfg: {
        ...cfg,
        workflowPath: resolveCanonicalWorkflowPath(ctx, cfg.workflowPath),
        shots: resolvedShots,
        firstFrames,
        globalPrompt: scenePrompt.prompt ?? `Scene ${sceneNumber}`,
        outputPath: cfg.outputPath,
        dependencies,
      },
    };
  }

  if (sceneNumber === undefined || !cfg.shotRange) {
    return {
      ok: false,
      error: 'comfy.ltx_director: missing scenes_plan input and no legacy sceneNumber/shotRange fallback is available',
    };
  }
  try {
    const resolved = resolveRelayInputs(ctx.projectDir, sceneNumber, cfg.shotRange);
    return {
      ok: true,
      cfg: {
        ...cfg,
        workflowPath: resolveCanonicalWorkflowPath(ctx, cfg.workflowPath),
        shots: resolved.shots,
        firstFrames: resolved.firstFrames,
        globalPrompt: resolved.globalPrompt,
        outputPath: cfg.outputPath,
      },
    };
  } catch (err) {
    return { ok: false, error: `comfy.ltx_director: ${(err as Error).message}` };
  }
}

// ── Runner implementation ─────────────────────────────────────────────

async function runComfyLtxDirector(ctx: RunnerContext): Promise<RunnerResult> {
  const rawCfg = ctx.node.runner.config as unknown as LtxDirectorConfig;

  if (!rawCfg.workflowPath || !rawCfg.outputPath) {
    return { ok: false, error: 'comfy.ltx_director: missing required config (workflowPath/outputPath)' };
  }
  const resolvedCfg = resolveLtxDirectorConfigFromInputs(ctx, rawCfg);
  if (!resolvedCfg.ok) return { ok: false, error: resolvedCfg.error };
  const cfg = resolvedCfg.cfg;
  if (cfg.shots.length !== cfg.firstFrames.length) {
    return { ok: false, error: `comfy.ltx_director: shots (${cfg.shots.length}) must equal firstFrames (${cfg.firstFrames.length})` };
  }
  if (cfg.shots.length === 0) {
    return { ok: false, error: 'comfy.ltx_director: empty shots array' };
  }

  const fps = cfg.fps ?? 24;
  // Snap to multiples of 32 — LTX requires pixel dimensions divisible by 32
  // (divisible_by on the node), and the bundle's configured width/height
  // (854×480, 1280×720) express 16:9 intent but aren't themselves aligned.
  // Aligning here also matches the target we normalize first-frames to below.
  const width = snapToMultiple(cfg.width ?? 854, 32);
  const height = snapToMultiple(cfg.height ?? 480, 32);
  const outputAbs = join(ctx.projectDir, cfg.outputPath);
  const sourceAudioPath = resolveAudioInputPath(ctx, cfg);
  const validationSourceImage = cfg.firstFrames.length > 0 ? cfg.firstFrames[0] : undefined;

  // Resume short-circuit: if the chunk's output mp4 already exists on disk,
  // skip the expensive Comfy call only when the existing artifact passes the
  // same audio/anchor validation we apply to fresh cloud output.
  if (existsSync(outputAbs) && !process.env['DAG_BUNDLE_FORCE_RERENDER']) {
    const existing = validateMotionOutput({
      videoPath: outputAbs,
      ...(sourceAudioPath ? { audioPath: sourceAudioPath } : {}),
      ...(validationSourceImage ? { sourceImagePath: validationSourceImage } : {}),
      width,
      height,
    });
    if (existing.ok) {
      ctx.log(`comfy.ltx_director: ${cfg.outputPath} already exists and passed validation — skipping render (set DAG_BUNDLE_FORCE_RERENDER=1 to force)`);
      return {
        ok: true,
        outputPath: cfg.outputPath,
        metadata: { skipped: true, reason: 'output_exists', validation: existing },
      };
    }
    ctx.log(`comfy.ltx_director: ${cfg.outputPath} exists but failed validation (${existing.errors.join('; ')}) — rerendering`);
  }

  const segmentFrames = alignToLTX(cfg.shots.map((s) => s.duration * fps));
  const totalFrames = segmentFrames.reduce((a, b) => a + b, 0);
  if (totalFrames > 1000) {
    return {
      ok: false,
      error: `comfy.ltx_director: total frames ${totalFrames} exceeds LTX 2.3 audio-latent cap (1000). Chunk into smaller bundles.`,
    };
  }

  const segmentStarts: number[] = [];
  {
    let acc = 0;
    for (const f of segmentFrames) {
      segmentStarts.push(acc);
      acc += f;
    }
  }

  // Verify all first frames exist on disk.
  for (let i = 0; i < cfg.firstFrames.length; i++) {
    if (!existsSync(cfg.firstFrames[i]!)) {
      return { ok: false, error: `comfy.ltx_director: first frame not found: ${cfg.firstFrames[i]}` };
    }
  }

  // Verify workflow exists.
  if (!existsSync(cfg.workflowPath)) {
    return { ok: false, error: `comfy.ltx_director: workflow not found: ${cfg.workflowPath}` };
  }

  const localPrompts = cfg.shots.map(buildLocalPrompt);

  // ── Comfy submission ──
  const outputDir = dirname(outputAbs);
  mkdirSync(outputDir, { recursive: true });

  // Resolve the endpoint. Bundles declare the endpoint by NAME
  // (portable across users). The URL lives in the user's env /
  // desktop settings as `ENDPOINT_<name_with_dots_as_underscores>`.
  // Fail loud with an actionable error when the named endpoint
  // hasn't been configured — much better than a confusing "couldn't
  // reach Comfy" timeout later.
  let endpointBaseUrl: string | undefined;
  if (cfg.endpoint) {
    const resolved = resolveEndpointUrl(cfg.endpoint);
    if (!resolved) {
      return {
        ok: false,
        error:
          `Bundle requires endpoint '${cfg.endpoint}' but ` +
          `ENDPOINT_${cfg.endpoint.replace(/\./g, '_')} is not set. ` +
          `Configure it in Settings → ComfyUI Endpoints (or your .env in dev mode). ` +
          `Conventional names: self.local, self.cloud, public.cloud.`,
      };
    }
    endpointBaseUrl = resolved;
    ctx.log(`comfy.ltx_director: routing to endpoint '${cfg.endpoint}' → ${resolved}`);
  }

  // Backend-aware workflow selection: when the resolved endpoint is Comfy
  // Cloud and a cloud variant is available, use it — the local graph
  // references model files absent from cloud (e.g. the gemma_3_12B heretic
  // text encoder). Falls back to the canonical workflowPath otherwise, so
  // local runs and bundles without a cloud variant are unaffected.
  const workflowPath = resolveWorkflowPath({
    workflowPath: rawCfg.workflowPath,
    bundleDir: ctx.bundleDir,
    endpointUrl: endpointBaseUrl,
    workflowPathCloud: rawCfg.workflowPathCloud,
  });
  if (!existsSync(workflowPath)) {
    return { ok: false, error: `comfy.ltx_director: workflow not found: ${workflowPath}` };
  }
  if (workflowPath !== cfg.workflowPath) {
    ctx.log(`comfy.ltx_director: cloud endpoint → using ${workflowPath}`);
  }
  const workflowId = rawCfg.workflowId;

  const client = new ComfyUIClient({
    outputDir,
    ...(endpointBaseUrl ? { baseUrl: endpointBaseUrl } : {}),
  });
  const embedTimelineImages = endpointBaseUrl ? isCloudEndpoint(endpointBaseUrl) : false;

  ctx.log(`comfy.ltx_director: uploading ${cfg.firstFrames.length} first-frame images...`);
  const uploadedNames: string[] = [];
  const embeddedImageDataUris: Array<string | undefined> = [];
  for (let i = 0; i < cfg.firstFrames.length; i++) {
    // Normalize each anchor to the exact target W×H (cover + center-crop) so
    // all segments share one aspect ratio. Mixed-aspect first-frames (e.g. a
    // square zimage still next to a 16:9 klein still) otherwise collapse the
    // LTXDirector output to a square. See normalizeFirstFrame.
    const uploadPath = normalizeFirstFrame(cfg.firstFrames[i]!, width, height, ctx.log);
    const u = await retryTransient(
      () => client.uploadImage(uploadPath, 'input', true),
      { signal: ctx.signal, log: ctx.log, label: `comfy.ltx_director upload shot_${cfg.shots[i]!.shotNumber}` },
    );
    ctx.log(`  shot ${cfg.shots[i]!.shotNumber}: ${basename(cfg.firstFrames[i]!)} → ${u.name}`);
    uploadedNames.push(u.name);
    embeddedImageDataUris.push(embedTimelineImages ? imageDataUri(uploadPath) : undefined);
  }
  if (embedTimelineImages) {
    ctx.log('comfy.ltx_director: embedding timeline guide images as base64 for Comfy Cloud LTXDirector');
  }

  // ── OPT-IN custom audio (audio-driven / lip-sync). Absent → legacy path. ──
  const audioSegments: unknown[] = [];
  let useCustomAudio = false;
  if (cfg.audioInput) {
    if (sourceAudioPath && cfg.lipSync === true) {
      const ua = await retryTransient(() => client.uploadImage(sourceAudioPath, 'input', true), {
        signal: ctx.signal,
        log: ctx.log,
        label: 'comfy.ltx_director upload audio',
      });
      ctx.log(`comfy.ltx_director: custom audio ${basename(sourceAudioPath)} → ${ua.name} (use_custom_audio=true)`);
      audioSegments.push({
        id: 'seg_audio_0',
        type: 'audio',
        start: 0,
        length: totalFrames,
        trimStart: 0,
        audioDurationFrames: totalFrames,
        audioFile: ua.name,
        fileName: basename(sourceAudioPath),
        waveformPeaks: [],
      });
      useCustomAudio = true;
    } else if (sourceAudioPath) {
      ctx.log(
        `comfy.ltx_director: audioInput '${cfg.audioInput}' will be muxed after render (lipSync=false, use_custom_audio=false)`,
      );
    } else {
      ctx.log(
        `comfy.ltx_director: audioInput '${cfg.audioInput}' set but no audio path resolved — using generated audio`,
      );
    }
  }

  const guideStrength = typeof cfg.guideStrength === 'number' ? cfg.guideStrength : 1.0;
  const timelineData = buildLtxTimelineData({
    shots: cfg.shots,
    uploadedNames,
    ...(embedTimelineImages ? { imageDataUris: embeddedImageDataUris } : {}),
    segmentStarts,
    audioSegments,
    localPrompts,
    guideStrength,
    lipSync: cfg.lipSync,
  });

  const baseWorkflow = JSON.parse(readFileSync(workflowPath, 'utf-8')) as Record<
    string,
    { inputs: Record<string, unknown>; class_type: string }
  >;
  let workflow: Record<
    string,
    { inputs: Record<string, unknown>; class_type: string }
  > = JSON.parse(JSON.stringify(baseWorkflow));

  const director = workflow['46'];
  if (!director || director.class_type !== 'LTXDirector') {
    return { ok: false, error: 'comfy.ltx_director: workflow missing LTXDirector at node 46' };
  }
  director.inputs['global_prompt'] = cfg.globalPrompt;
  director.inputs['duration_frames'] = totalFrames;
  director.inputs['duration_seconds'] = totalFrames / fps;
  director.inputs['timeline_data'] = JSON.stringify(timelineData);
  director.inputs['local_prompts'] = (cfg.lipSync ? localPrompts.map((p) => p + LIP_SYNC_SUFFIX) : localPrompts).join(' | ');
  director.inputs['segment_lengths'] = segmentFrames.join(', ');
  director.inputs['frame_rate'] = fps;
  director.inputs['epsilon'] = 0.001;
  director.inputs['guide_strength'] = cfg.shots.map(() => String(guideStrength)).join(', ');
  director.inputs['use_custom_audio'] = useCustomAudio;
  director.inputs['custom_width'] = width;
  director.inputs['custom_height'] = height;
  director.inputs['resize_method'] = 'crop';
  director.inputs['divisible_by'] = 32;
  director.inputs['img_compression'] = 18;

  // ── OPT-IN lora chain override (independent of audio). Absent → untouched.
  // An explicit empty list means "remove the workflow's baked loras".
  const loraOverrideApplied = applyConfiguredLoras(workflow as LtxWfNodes, cfg, ctx.log);

  // Apply per-endpoint workflow aliases (model-file rename +
  // class_type swap for GGUF / quant variants). Runs AFTER the lora
  // chain rebuild so name_aliases can remap the injected LoRA names
  // (e.g. a talking-head LoRA absent from cloud Comfy → a LoRA that
  // the cloud endpoint has). Same mechanism as comfy.qwen_edit_chain
  // — bundle's canonical workflow stays untouched on disk; the user's
  // local Comfy may have differently-named LoRAs / UNETs, and the
  // agent's dhee_apply_workflow_aliases tool persists the chosen map.
  {
    const { applyEndpointAliases, defaultAliasesDir } = await import('../workflowAliases.js');
    const aliasRes = await applyEndpointAliases({
      workflow: workflow as never,
      workflowKey: workflowPath.split('/').slice(-2).join('/'),
      aliasesDir: defaultAliasesDir(),
      endpointUrl: endpointBaseUrl,
      log: (m) => ctx.log(`comfy.ltx_director: ${m}`),
    });
    if (aliasRes.error) return { ok: false, error: `comfy.ltx_director: ${aliasRes.error}` };
    workflow = aliasRes.workflow as never;
  }

  // ── Custom audio: mux the LTXDirector combined_audio output (slot 6) into
  // the video, replacing the generated-audio decode path. ONLY when custom
  // audio is active — the relay/narrative bundles keep their node-16 wiring. ──
  if (useCustomAudio) {
    const createVideo = workflow['17'];
    if (createVideo && createVideo.class_type === 'CreateVideo') {
      createVideo.inputs['audio'] = ['46', 6];
    }
  }

  const negativeNode = workflow['90'];
  if (negativeNode && negativeNode.class_type === 'CLIPTextEncode') {
    negativeNode.inputs['text'] = [
      'blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, compression artifacts, jpeg artifacts, glitches, watermark, text, logo, signature, copyright, subtitles',
      'distorted sound, saturated sound, loud',
      'narration, voice over, voiceover, monologue, singing, vocals, background music, music score',
      'improvised speech, additional dialogue, extra phrases, extra sentences, rambling, made-up words, freestyle speech, ad-lib, hallucinated speech, speech beyond the quoted line, continued talking, mumbling',
    ].join(', ');
  }

  const seed = Math.floor(Math.random() * 0x7fffffff);
  const noiseNode = workflow['28'];
  if (noiseNode && noiseNode.class_type === 'RandomNoise') {
    noiseNode.inputs['noise_seed'] = seed;
  }

  // Use a filename prefix Comfy can put in its output dir; we'll download
  // and rename to the bundle's outputPath.
  const tsSlug = `dag_relay_${Date.now()}`;
  const saveNode = workflow['30'];
  if (saveNode && saveNode.class_type === 'SaveVideo') {
    saveNode.inputs['filename_prefix'] = `dag_relay/${tsSlug}`;
  }

  ctx.log(`comfy.ltx_director: submitting (${cfg.shots.length} shots, ${totalFrames} frames = ${(totalFrames / fps).toFixed(2)}s @ ${fps}fps)`);
  const startTime = Date.now();
  const { promptId, outputs: wsOutputs } = await retryTransient(
    () =>
      client.queueAndWaitWS(workflow, (p) => {
        if (p.percentage !== undefined && p.message) {
          ctx.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
        }
      }, { ...(workflowId ? { workflowId } : {}), ...(ctx.signal ? { signal: ctx.signal } : {}) }),
    { signal: ctx.signal, log: ctx.log, label: 'comfy.ltx_director queue' },
  );
  ctx.log(`  complete in ${Math.floor((Date.now() - startTime) / 1000)}s (prompt_id=${promptId})`);

  const histImages = await client.getOutputImages(promptId);
  const seen = new Set<string>();
  const allOutputs = [...wsOutputs, ...histImages]
    .filter((i) => /\.(mp4|webm|mov)$/i.test(i.filename))
    .filter((i) => !seen.has(i.filename) && (seen.add(i.filename), true));

  if (allOutputs.length === 0) {
    return { ok: false, error: 'comfy.ltx_director: no video output from Comfy' };
  }

  const item = allOutputs[0]!;
  const downloadTargetName = basename(outputAbs);
  const downloaded = await client.downloadImage(
    item.filename,
    item.subfolder ?? '',
    item.type ?? 'output',
    downloadTargetName,
  );

  let remuxVolume: AudioVolumeProbe | undefined;
  if (sourceAudioPath) {
    const mux = muxOriginalAudio(downloaded, sourceAudioPath);
    if (!mux.ok) {
      return { ok: false, error: `comfy.ltx_director: failed to mux original audio — ${mux.error}` };
    }
    remuxVolume = mux.volume;
    ctx.log(
      `comfy.ltx_director: muxed original audio ${basename(sourceAudioPath)} into ${basename(downloaded)} (max_volume=${remuxVolume.maxVolumeDb ?? 'unknown'} dB)`,
    );
  }

  const outputValidation = validateMotionOutput({
    videoPath: downloaded,
    ...(sourceAudioPath ? { audioPath: sourceAudioPath } : {}),
    ...(validationSourceImage ? { sourceImagePath: validationSourceImage } : {}),
    width,
    height,
  });
  if (!outputValidation.ok) {
    return {
      ok: false,
      error: `comfy.ltx_director: rendered output failed validation — ${outputValidation.errors.join('; ')}`,
    };
  }

  // Write meta sidecar next to the video.
  const metaPath = outputAbs.replace(/\.[^.]+$/, '.meta.json');
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        runner: 'comfy.ltx_director',
        workflow: workflowPath,
        globalPrompt: cfg.globalPrompt,
        localPrompts,
        segmentFrames,
        segmentStarts,
        totalFrames,
        fps,
        seed,
        promptId,
        timelineData: redactTimelineData(timelineData),
        uploadedFrames: uploadedNames,
        sourceFrames: cfg.firstFrames,
        sourceAudio: sourceAudioPath,
        loraOverrideApplied,
        loras: cfg.loras ?? null,
        remux: sourceAudioPath
          ? {
              sourceAudio: sourceAudioPath,
              volume: remuxVolume,
            }
          : null,
        validation: outputValidation,
        shots: cfg.shots.map((s) => ({ shotNumber: s.shotNumber, duration: s.duration })),
      },
      null,
      2,
    ),
  );

  return {
    ok: true,
    outputPath: cfg.outputPath,
    metadata: {
      absolutePath: downloaded,
      promptId,
      seed,
      totalFrames,
      fps,
      validation: outputValidation,
      ...(cfg.dependencies ? { dependencies: cfg.dependencies } : {}),
    },
  };
}

function describe(): RunnerDescription {
  return {
    id: 'comfy.ltx_director',
    displayName: 'LTX 2.3 Director (prompt relay)',
    description: 'Renders a contiguous range of shots as one continuous mp4 via the LTX 2.3 Director ComfyUI workflow.',
    capabilities: ['multi_shot_relay', 'image_anchored_t2v'],
    modalities: { input: ['image', 'text'], output: ['video'] },
    configSchema: {
      type: 'object',
      required: ['workflowPath', 'outputPath'],
      properties: {
        workflowPath: { type: 'string', description: 'Path to LTX Director Comfy workflow JSON' },
        workflowPathCloud: { type: 'string', description: 'Cloud variant workflow (used when endpoint resolves to Comfy Cloud). Omit to use workflowPath everywhere.' },
        workflowId: { type: 'string', description: 'Optional workflow reference forwarded to Comfy extra_data.' },
        shots: { type: 'array', items: { type: 'object' } },
        firstFrames: { type: 'array', items: { type: 'string' } },
        globalPrompt: { type: 'string' },
        fps: { type: 'number', default: 24 },
        width: { type: 'number', default: 854 },
        height: { type: 'number', default: 480 },
        sceneNumber: { type: 'number' },
        shotRange: { type: 'array', items: { type: 'number' } },
        chunkIndex: { type: 'number' },
        chunkCount: { type: 'number' },
        audioInput: { type: 'string', description: 'Input id holding this item\'s audio path (audio-driven mode)' },
        imageInput: { type: 'string', description: 'Input id holding this item\'s still-image path (single-still mode, no scenes_plan)' },
        duration: { type: 'number', description: 'Fallback clip length (s) for single-still mode when no audio sizes it' },
        promptInput: { type: 'string', description: 'Single-still mode: input id holding a per-item motion directive (string); globalPrompt is appended as a style suffix' },
        guideStrength: { type: 'number', description: 'LTX guide_strength 0..1. Lower = more motion (looser to the still). Default 1.0; ~0.5-0.7 for lively motion' },
        outputPath: { type: 'string', description: 'Output video path relative to project dir' },
      },
    },
    costHint: 'local_gpu',
  };
}

export const comfyLtxDirectorRunner: Runner = { describe, run: runComfyLtxDirector };
