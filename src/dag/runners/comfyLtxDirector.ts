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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { ComfyUIClient } from '../../services/comfyui/ComfyUIClient.js';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';

interface ShotInput {
  shotNumber: number;
  duration: number;
  description?: string;
  cameraWork?: string;
  audio?: string;
  purpose?: string;
}

interface LtxDirectorConfig {
  workflowPath: string;
  shots: ShotInput[];
  firstFrames: string[];
  globalPrompt: string;
  fps?: number;
  outputPath: string;
  width?: number;
  height?: number;
}

// ── Prompt-shaping helpers (ported verbatim from probe-ltx-director.ts) ──

function stripDialogueParaphrase(description: string): string {
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

function reformatDialogue(audio: string): string {
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

function buildLocalPrompt(s: ShotInput): string {
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

/** LTX latent alignment: each segment multiple of 8 frames; first segment +1
 *  so (total - 1) % 8 === 0. */
function alignToLTX(rawFrames: number[]): number[] {
  const rounded = rawFrames.map((f) => Math.max(8, Math.round(f / 8) * 8));
  rounded[0] = rounded[0]! + 1;
  return rounded;
}

// ── Runner implementation ─────────────────────────────────────────────

async function runComfyLtxDirector(ctx: RunnerContext): Promise<RunnerResult> {
  const cfg = ctx.node.runner.config as unknown as LtxDirectorConfig;

  if (!cfg.workflowPath || !cfg.shots || !cfg.firstFrames || !cfg.globalPrompt) {
    return { ok: false, error: 'comfy.ltx_director: missing required config (workflowPath/shots/firstFrames/globalPrompt)' };
  }

  // Resume short-circuit: if the chunk's output mp4 already exists on
  // disk, skip the (expensive) Comfy call and return success with the
  // existing path. This lets a re-run after a Comfy crash pick up from
  // where it left off without re-rendering completed chunks. Not a
  // content-addressed cache (no upstream-change detection) — just an
  // "output exists → trust it" pragmatic skip. Override by deleting the
  // mp4 file or by setting DAG_BUNDLE_FORCE_RERENDER=1.
  const outputAbs = join(ctx.projectDir, cfg.outputPath);
  if (existsSync(outputAbs) && !process.env['DAG_BUNDLE_FORCE_RERENDER']) {
    ctx.log(`comfy.ltx_director: ${cfg.outputPath} already exists — skipping render (set DAG_BUNDLE_FORCE_RERENDER=1 to force)`);
    return { ok: true, outputPath: cfg.outputPath, metadata: { skipped: true, reason: 'output_exists' } };
  }
  if (cfg.shots.length !== cfg.firstFrames.length) {
    return { ok: false, error: `comfy.ltx_director: shots (${cfg.shots.length}) must equal firstFrames (${cfg.firstFrames.length})` };
  }
  if (cfg.shots.length === 0) {
    return { ok: false, error: 'comfy.ltx_director: empty shots array' };
  }

  const fps = cfg.fps ?? 24;
  const width = cfg.width ?? 854;
  const height = cfg.height ?? 480;

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

  const client = new ComfyUIClient({ outputDir });

  ctx.log(`comfy.ltx_director: uploading ${cfg.firstFrames.length} first-frame images...`);
  const uploadedNames: string[] = [];
  for (let i = 0; i < cfg.firstFrames.length; i++) {
    const u = await client.uploadImage(cfg.firstFrames[i]!, 'input', true);
    ctx.log(`  shot ${cfg.shots[i]!.shotNumber}: ${basename(cfg.firstFrames[i]!)} → ${u.name}`);
    uploadedNames.push(u.name);
  }

  const timelineData = {
    segments: cfg.shots.map((_, i) => ({
      type: 'image',
      imageFile: uploadedNames[i]!,
      start: segmentStarts[i]!,
    })),
    audioSegments: [] as unknown[],
  };

  const baseWorkflow = JSON.parse(readFileSync(cfg.workflowPath, 'utf-8')) as Record<
    string,
    { inputs: Record<string, unknown>; class_type: string }
  >;
  const workflow: Record<
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
  director.inputs['local_prompts'] = localPrompts.join(' | ');
  director.inputs['segment_lengths'] = segmentFrames.join(', ');
  director.inputs['frame_rate'] = fps;
  director.inputs['epsilon'] = 0.001;
  director.inputs['guide_strength'] = cfg.shots.map(() => '1.0').join(', ');
  director.inputs['use_custom_audio'] = false;
  director.inputs['custom_width'] = width;
  director.inputs['custom_height'] = height;
  director.inputs['divisible_by'] = 32;
  director.inputs['img_compression'] = 18;

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
  const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, (p) => {
    if (p.percentage !== undefined && p.message) {
      ctx.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
    }
  });
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

  // Write meta sidecar next to the video.
  const metaPath = outputAbs.replace(/\.[^.]+$/, '.meta.json');
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        runner: 'comfy.ltx_director',
        workflow: cfg.workflowPath,
        globalPrompt: cfg.globalPrompt,
        localPrompts,
        segmentFrames,
        segmentStarts,
        totalFrames,
        fps,
        seed,
        promptId,
        timelineData,
        uploadedFrames: uploadedNames,
        shots: cfg.shots.map((s) => ({ shotNumber: s.shotNumber, duration: s.duration })),
      },
      null,
      2,
    ),
  );

  return {
    ok: true,
    outputPath: cfg.outputPath,
    metadata: { absolutePath: downloaded, promptId, seed, totalFrames, fps },
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
      required: ['workflowPath', 'shots', 'firstFrames', 'globalPrompt', 'outputPath'],
      properties: {
        workflowPath: { type: 'string', description: 'Absolute path to LTX Director Comfy workflow JSON' },
        shots: { type: 'array', items: { type: 'object' } },
        firstFrames: { type: 'array', items: { type: 'string' } },
        globalPrompt: { type: 'string' },
        fps: { type: 'number', default: 24 },
        width: { type: 'number', default: 854 },
        height: { type: 'number', default: 480 },
        outputPath: { type: 'string', description: 'Output video path relative to project dir' },
      },
    },
    costHint: 'local_gpu',
  };
}

export const comfyLtxDirectorRunner: Runner = { describe, run: runComfyLtxDirector };
