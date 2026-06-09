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
import { dirname, join, basename, resolve } from 'node:path';
import { ComfyUIClient } from '../../services/comfyui/ComfyUIClient.js';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
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
  if (s.transition && s.transition.trim().length > 0) {
    parts.push(`Transition: ${s.transition.trim()}`);
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

export interface ResolvedLtxDirectorConfig extends LtxDirectorConfig {
  workflowPath: string;
  shots: ShotInput[];
  firstFrames: string[];
  globalPrompt: string;
  outputPath: string;
  dependencies?: Array<{ nodeId: string; itemId?: string; role?: 'input' | 'context' | 'reference' | 'aggregate' }>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
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

function resolveWorkflowPath(ctx: RunnerContext, workflowPath: string): string {
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
        workflowPath: resolveWorkflowPath(ctx, cfg.workflowPath),
        shots: cfg.shots,
        firstFrames: cfg.firstFrames,
        globalPrompt: cfg.globalPrompt,
        outputPath: cfg.outputPath,
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
        workflowPath: resolveWorkflowPath(ctx, cfg.workflowPath),
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
        workflowPath: resolveWorkflowPath(ctx, cfg.workflowPath),
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
  {
    const { applyEndpointAliases, defaultAliasesDir } = await import('../workflowAliases.js');
    const aliasRes = await applyEndpointAliases({
      workflow: workflow as never,
      workflowKey: cfg.workflowPath.split('/').slice(-2).join('/'),
      aliasesDir: defaultAliasesDir(),
      endpointUrl: endpointBaseUrl,
      log: (m) => ctx.log(`comfy.ltx_director: ${m}`),
    });
    if (aliasRes.error) return { ok: false, error: `comfy.ltx_director: ${aliasRes.error}` };
    workflow = aliasRes.workflow as never;
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
    metadata: {
      absolutePath: downloaded,
      promptId,
      seed,
      totalFrames,
      fps,
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
        outputPath: { type: 'string', description: 'Output video path relative to project dir' },
      },
    },
    costHint: 'local_gpu',
  };
}

export const comfyLtxDirectorRunner: Runner = { describe, run: runComfyLtxDirector };
