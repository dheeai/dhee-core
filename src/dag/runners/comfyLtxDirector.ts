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
import { retryTransient } from './transientRetry.js';

interface ShotInput {
  shotNumber: number;
  duration: number;
  description?: string;
  cameraWork?: string;
  audio?: string;
  dialogue?: string | null;
  speaker?: string | null;
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

  const client = new ComfyUIClient({
    outputDir,
    ...(endpointBaseUrl ? { baseUrl: endpointBaseUrl } : {}),
  });

  ctx.log(`comfy.ltx_director: uploading ${cfg.firstFrames.length} first-frame images...`);
  const uploadedNames: string[] = [];
  for (let i = 0; i < cfg.firstFrames.length; i++) {
    const u = await retryTransient(
      () => client.uploadImage(cfg.firstFrames[i]!, 'input', true),
      { signal: ctx.signal, log: ctx.log, label: `comfy.ltx_director upload shot_${cfg.shots[i]!.shotNumber}` },
    );
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
  let workflow: Record<
    string,
    { inputs: Record<string, unknown>; class_type: string }
  > = JSON.parse(JSON.stringify(baseWorkflow));

  // Apply per-endpoint workflow aliases (model-file rename +
  // class_type swap for GGUF / quant variants). Same mechanism as
  // comfy.qwen_edit_chain — bundle's canonical workflow stays
  // untouched on disk; the user's local Comfy may have differently-
  // named LoRAs / UNETs (e.g. VBVR vs transition base LoRA), and the
  // agent's dhee_apply_workflow_aliases tool persists the chosen map.
  try {
    const { readAliases, applyAliases, defaultAliasesDir } = await import('../workflowAliases.js');
    const aliasesDir = defaultAliasesDir();
    const aliases = readAliases(aliasesDir, endpointBaseUrl ?? 'unknown');
    if (
      (aliases.name_aliases && Object.keys(aliases.name_aliases).length > 0) ||
      (aliases.class_swaps && Object.keys(aliases.class_swaps).length > 0)
    ) {
      const workflowKey = cfg.workflowPath.split('/').slice(-2).join('/');
      workflow = applyAliases(workflow as never, {
        workflowKey,
        aliases,
      }) as never;
      ctx.log(
        `comfy.ltx_director: applied aliases for endpoint=${endpointBaseUrl} workflow=${workflowKey}`,
      );
    }
  } catch (e) {
    ctx.log(`comfy.ltx_director: alias load skipped (${(e as Error).message})`);
  }

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
  const { promptId, outputs: wsOutputs } = await retryTransient(
    () =>
      client.queueAndWaitWS(workflow, (p) => {
        if (p.percentage !== undefined && p.message) {
          ctx.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
        }
      }),
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
