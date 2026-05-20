/**
 * Scene-bundle rendering for prompt-relay mode.
 *
 * In prompt_relay mode, an entire scene is rendered as one mp4 via
 * LTX 2.3 + kijai/ComfyUI-PromptRelay. This module owns:
 *
 *   1. Gathering per-shot data for a scene (first_frame paths,
 *      motion prompts, durations).
 *   2. Building the global prompt (style + characters + brief scene
 *      beat).
 *   3. Frame alignment (LTX latent space requires (total - 1) % 8 = 0).
 *   4. Expanding the parametric workflow to N segments.
 *   5. Uploading first frames + submitting + waiting + downloading.
 *   6. Returning the bundle path. The caller is responsible for
 *      registering the asset (so registration stays alongside the
 *      executor's other addAsset calls).
 *
 * Per-shot frame counts and total are derived from each shot's
 * `duration` in `prompts/videos/scenes/scene_<N>.json`. Pulled from
 * the same source the existing per-shot path reads.
 */

import 'dotenv/config';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ComfyUIClient } from '../../services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../../services/comfyui/WorkflowLoader.js';
import { expandPromptRelayWorkflow } from '../../services/providers/promptRelayWorkflowExpander.js';
import { buildPromptRelayGlobalPrompt, type CharacterId } from '../../services/providers/promptRelayGlobalPrompt.js';
import { alignDurationsToLTX } from '../../services/providers/promptRelayFrameAlignment.js';

const FPS_DEFAULT = 24;
const NEGATIVE_PROMPT = [
  // visual negatives (kept verbatim from workflow node 818)
  'blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, compression artifacts, jpeg artifacts, glitches, watermark, text, logo, signature, copyright, subtitles',
  // audio negatives — original + anti-narration
  'distorted sound, saturated sound, loud',
  'narration, voice over, voiceover, monologue, speech, dialogue, talking, singing, vocals, lip sync, mouth movement',
].join(', ');

export interface SceneBundleShot {
  shotNumber: number;
  firstFramePath: string;          // absolute path to local png
  motionPrompt: string;
  duration: number;                // seconds, from scene_video_prompt
}

export interface SceneBundleRequest {
  sceneNumber: number;
  shots: SceneBundleShot[];        // ordered by shot number
  characters: CharacterId[];
  sceneDescription: string;
  style: string;
  projectDir: string;              // absolute
  width: number;
  height: number;
  fps?: number;
  /** Optional progress callback (percentage, message). */
  onProgress?: (pct: number, msg: string) => void;
  /** Optional log sink for executor logs. */
  log?: (msg: string) => void;
  /** Multi-chunk scenes: 0-based chunk index. When set, the output
   *  filename includes `_chunk${chunkIndex}` so chunks for the same
   *  scene don't collide. */
  chunkIndex?: number;
}

export interface SceneBundleResult {
  /** Path to the bundle mp4, relative to projectDir. */
  bundleRelativePath: string;
  promptId: string;
  totalFrames: number;
  segmentFrames: number[];
  globalPrompt: string;
  localPrompts: string[];
  uploadedNames: string[];
}

/**
 * Render a scene as a single prompt-relay bundle mp4.
 * Forces COMFY_MODE=local for this submission — the workflow uses
 * locally-downloaded LTX 2.3 weights that aren't on cloud.
 */
export async function renderSceneBundle(req: SceneBundleRequest): Promise<SceneBundleResult> {
  const fps = req.fps ?? FPS_DEFAULT;
  const log = req.log ?? (() => {});

  if (req.shots.length === 0) {
    throw new Error(`renderSceneBundle: scene ${req.sceneNumber} has no shots`);
  }
  if (req.shots.length > 20) {
    throw new Error(`renderSceneBundle: scene ${req.sceneNumber} has ${req.shots.length} shots — kijai LTXVAddGuideMulti caps at 20`);
  }

  // ── 1. Frame alignment from project shot durations ────────────────
  const segmentFrames = alignDurationsToLTX(req.shots.map(s => s.duration), fps);
  const totalFrames = segmentFrames.reduce((a, b) => a + b, 0);
  log(`scene ${req.sceneNumber} prompt-relay: ${segmentFrames.length} segments, frames=${segmentFrames.join(',')}, total=${totalFrames} (${(totalFrames / fps).toFixed(2)}s @ ${fps}fps)`);

  // ── 2. Global prompt + local prompts ──────────────────────────────
  const globalPrompt = buildPromptRelayGlobalPrompt({
    style: req.style,
    characters: req.characters,
    sceneDescription: req.sceneDescription,
  });
  const localPrompts = req.shots.map(s => s.motionPrompt);

  // ── 3. Load + expand workflow ─────────────────────────────────────
  const baseWorkflowPath = resolveBaseWorkflowPath();
  const baseWorkflow = JSON.parse(readFileSync(baseWorkflowPath, 'utf-8'));
  const { workflow, parameterMappings } = expandPromptRelayWorkflow(baseWorkflow, req.shots.length);

  // ── 4. ComfyUI client (forced local mode) ─────────────────────────
  const prevMode = process.env['COMFY_MODE'];
  process.env['COMFY_MODE'] = 'local';
  try {
    const outputDir = join(req.projectDir, 'assets/videos/scenes');
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });
    const client = new ComfyUIClient({ outputDir });

    // ── 5. Upload first frames ──────────────────────────────────────
    const uploadedNames: string[] = [];
    for (let i = 0; i < req.shots.length; i++) {
      const fp = req.shots[i]!.firstFramePath;
      const u = await client.uploadImage(fp, 'input', true);
      uploadedNames.push(u.name);
    }
    log(`uploaded ${uploadedNames.length} first frames`);

    // ── 6. Parameterize ─────────────────────────────────────────────
    const seedPass1 = Math.floor(Math.random() * 0x7FFFFFFF);
    const seedPass2 = Math.floor(Math.random() * 0x7FFFFFFF);
    const chunkSuffix = req.chunkIndex !== undefined ? `_chunk${req.chunkIndex}` : '';
    const filenamePrefix = `scene_${req.sceneNumber}${chunkSuffix}_promptrelay`;
    const segmentParams: Record<string, unknown> = {};
    for (let i = 0; i < req.shots.length; i++) {
      segmentParams[`segment_${i + 1}_image`] = uploadedNames[i];
      segmentParams[`segment_${i + 1}_frames`] = segmentFrames[i];
    }
    const params: Record<string, unknown> = {
      global_prompt: globalPrompt,
      local_prompts: localPrompts.join(' | '),
      negative_prompt: NEGATIVE_PROMPT,
      segment_lengths: segmentFrames.join(', '),
      total_frames: totalFrames,
      ...segmentParams,
      seed_pass1: seedPass1,
      seed_pass2: seedPass2,
      width: req.width,
      height: req.height,
      fps,
      filenamePrefix,
    };
    // Reuse parameterizeGeneric for consistency with the rest of the
    // codebase. The expander already returned the parameterMappings.
    const submission = parameterizeGeneric(workflow, { parameterMappings }, params);

    // ── 7. Submit + wait ────────────────────────────────────────────
    const startMs = Date.now();
    const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(submission, (p) => {
      if (p.percentage !== undefined && p.message && req.onProgress) {
        req.onProgress(p.percentage, p.message);
      }
    });
    log(`scene ${req.sceneNumber}: complete in ${Math.floor((Date.now() - startMs) / 1000)}s (prompt_id=${promptId})`);

    // ── 8. Collect + download ───────────────────────────────────────
    const histImages = await client.getOutputImages(promptId);
    const seen = new Set<string>();
    const allOutputs = [...wsOutputs, ...histImages]
      .filter(i => /\.(mp4|webm|mov)$/i.test(i.filename))
      .filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));

    if (allOutputs.length === 0) {
      throw new Error(`scene ${req.sceneNumber}: no video output from ComfyUI (prompt_id=${promptId})`);
    }
    const item = allOutputs[0]!;
    const targetName = `scene_${req.sceneNumber}${chunkSuffix}_promptrelay_${promptId.slice(0, 8)}.mp4`;
    const absDownloaded = await client.downloadImage(
      item.filename,
      item.subfolder ?? '',
      item.type ?? 'output',
      targetName,
    );

    // Convert absolute → project-relative
    let bundleRelativePath: string;
    if (absDownloaded.startsWith(req.projectDir)) {
      bundleRelativePath = absDownloaded.slice(req.projectDir.length).replace(/^\/+/, '');
    } else {
      bundleRelativePath = absDownloaded;
    }

    return {
      bundleRelativePath,
      promptId,
      totalFrames,
      segmentFrames,
      globalPrompt,
      localPrompts,
      uploadedNames,
    };
  } finally {
    if (prevMode === undefined) delete process.env['COMFY_MODE'];
    else process.env['COMFY_MODE'] = prevMode;
  }
}

/**
 * Resolve the canonical 4-segment base workflow path.
 *
 * The expander reads its segment count from the request, but the base
 * file is always the 4-seg JSON — that's the structural reference for
 * loaders, samplers, NAG, video-combine, etc.
 */
function resolveBaseWorkflowPath(): string {
  // Same lookup pattern as WorkflowLoader.getWorkflowsDir, but inlined
  // here to avoid importing the loader's heavy machinery.
  const candidates = [
    process.env['dhee_WORKFLOWS_DIR'],
    join(process.cwd(), 'workflows'),
  ].filter((x): x is string => typeof x === 'string' && x.length > 0);
  for (const dir of candidates) {
    const p = join(dir, 'built-in/ltx23_promptrelay_4seg_local.json');
    if (existsSync(p)) return p;
  }
  throw new Error('renderSceneBundle: cannot find ltx23_promptrelay_4seg_local.json — set dhee_WORKFLOWS_DIR');
}
