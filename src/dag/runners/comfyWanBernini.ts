/**
 * `comfy.wan_bernini` — WAN 2.2 "Bernini" multi-reference-to-video runner.
 *
 * Bound to wan_bernini_r2v.json: three reference images (image0 / image1 /
 * image2) are batched (BatchImagesNode) and fed to BerniniConditioning,
 * which conditions a dual high/low-noise WAN 2.2 sampler. The prompt
 * addresses the references positionally — "the man from image0, the woman
 * from image1, … in image2" — exactly the Flux-Klein-style reference
 * addressing, but driving a video instead of an edit.
 *
 * The runner is NAMED after the workflow it drives (cf. comfy.klein,
 * comfy.ltx_director), so it is allowed to know that workflow's shape.
 *
 * Workflow-SPECIFIC part (here): resolve the scene video-prompt's
 * references[] into the three fixed Bernini slots, against the
 * character_sheet / background_image scope='all' maps the walker exposes.
 * Everything else — upload, parameter mapping, queue, video download, CAS —
 * lives in the shared comfyExecutor (the same path comfy.fl2v uses for
 * video; VHS_VideoCombine outputs come back under the 'gifs' key).
 */
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import {
  executeComfyWorkflow,
  defaultComfyClientFactory,
  type ComfyImageClient,
} from './comfyExecutor.js';

/** The three fixed reference slots BatchImagesNode batches (image0..image2). */
export const WAN_BERNINI_SLOTS = ['image0', 'image1', 'image2'] as const;

export interface WanReference {
  id: string;
  /** 'character' | 'setting' | 'background' (alias of setting). Defaults to character. */
  type?: string;
  /** Explicit Bernini slot. When absent, filled positionally (image0→1→2). */
  slot?: string;
}

export interface WanScenePrompt {
  videoPrompt?: string;
  references?: WanReference[];
}

export interface WanReferenceMaps {
  /** characterId → absolute sheet path (the scope='all' character_sheet map). */
  character: Record<string, string>;
  /** settingId → absolute background path (the scope='all' background_image map). */
  setting: Record<string, string>;
}

export interface WanReferenceResolution {
  prompt?: string;
  /** slot (image0/1/2) → absolute image path, only for resolved references. */
  imageInputs: Record<string, string>;
  /** reference ids that named no image in either map. */
  missing: string[];
}

/**
 * Resolve a scene's references[] into the three Bernini reference slots.
 *
 * Each reference takes its explicit `slot` if given, else the next free
 * slot in order (image0, image1, image2). A reference whose id is absent
 * from its map is reported in `missing` rather than silently consuming a
 * slot. References beyond the available slots are dropped. Pure — no fs,
 * no ctx — so the slot logic is unit-testable in isolation.
 */
export function resolveWanReferences(
  scene: WanScenePrompt | null | undefined,
  maps: WanReferenceMaps,
  opts?: { slots?: readonly string[] },
): WanReferenceResolution {
  const slots = opts?.slots ?? WAN_BERNINI_SLOTS;
  const imageInputs: Record<string, string> = {};
  const missing: string[] = [];
  const prompt =
    typeof scene?.videoPrompt === 'string' && scene.videoPrompt.length > 0 ? scene.videoPrompt : undefined;

  if (!scene || !Array.isArray(scene.references)) {
    return { imageInputs, missing, ...(prompt !== undefined ? { prompt } : {}) };
  }

  const used = new Set<string>();
  let cursor = 0;
  const nextFreeSlot = (): string | undefined => {
    while (cursor < slots.length && used.has(slots[cursor]!)) cursor++;
    return cursor < slots.length ? slots[cursor] : undefined;
  };

  for (const ref of scene.references) {
    if (!ref || typeof ref.id !== 'string') continue;
    const slot = ref.slot ?? nextFreeSlot();
    if (!slot || used.has(slot)) continue; // no free slot, or explicit slot already taken
    const map =
      ref.type === 'setting' || ref.type === 'background'
        ? maps.setting
        : ref.type === 'character' || ref.type === undefined
          ? maps.character
          : undefined;
    const path = map?.[ref.id];
    if (!path) {
      missing.push(ref.id);
      continue;
    }
    imageInputs[slot] = path;
    used.add(slot);
  }

  return { imageInputs, missing, ...(prompt !== undefined ? { prompt } : {}) };
}

/** Find the upstream {videoPrompt, references} JSON among the declared inputs. */
function pickScenePrompt(ctx: RunnerContext): WanScenePrompt | null {
  const cfg = ctx.node.runner.config;
  if (typeof cfg['videoPrompt'] === 'string' || Array.isArray(cfg['references'])) {
    return {
      ...(typeof cfg['videoPrompt'] === 'string' ? { videoPrompt: cfg['videoPrompt'] } : {}),
      ...(Array.isArray(cfg['references']) ? { references: cfg['references'] as WanReference[] } : {}),
    };
  }
  const declared = (ctx.node.inputs ?? [])
    .filter((i) => i.usage === undefined || i.usage === 'input')
    .map((i) => i.from);
  const keys = declared.length > 0 ? declared : Object.keys(ctx.inputs);
  for (const k of keys) {
    const v = ctx.inputs[k];
    if (v && typeof v === 'object' && typeof (v as WanScenePrompt).videoPrompt === 'string') {
      return v as WanScenePrompt;
    }
  }
  return null;
}

export function createComfyWanBerniniRunner(opts?: {
  clientFactory?: (o: { baseUrl?: string; outputDir: string }) => ComfyImageClient;
}): Runner {
  const clientFactory = opts?.clientFactory ?? defaultComfyClientFactory;

  const describe = (): RunnerDescription => ({
    id: 'comfy.wan_bernini',
    displayName: 'Comfy WAN 2.2 Bernini (multi-reference to video)',
    description:
      'Drives the WAN 2.2 Bernini reference-to-video workflow: three reference images (image0/image1/image2 — e.g. two characters + a background) batched into BerniniConditioning, addressed positionally by the prompt. No dialogue. Reuses the shared executor for upload/queue/video download.',
    capabilities: ['video-generation', 'reference-image-conditioning'],
    modalities: { input: ['text', 'image'], output: ['video'] },
    configSchema: {
      type: 'object',
      required: ['workflowPath', 'outputPath'],
      properties: {
        workflowPath: { type: 'string' },
        manifestPath: { type: 'string' },
        parameterMappings: { type: 'array' },
        endpoint: { type: 'string' },
        outputPath: { type: 'string' },
        videoPrompt: { type: 'string' },
        references: { type: 'array' },
        seed: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        length: { type: 'integer' },
        forceRerun: { type: 'boolean' },
      },
    },
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const cfg = ctx.node.runner.config;

    const scene = pickScenePrompt(ctx);
    const character = (ctx.inputs['character_sheet'] as Record<string, string> | undefined) ?? {};
    const setting = (ctx.inputs['background_image'] as Record<string, string> | undefined) ?? {};
    const { prompt, imageInputs, missing } = resolveWanReferences(scene, { character, setting });
    if (missing.length > 0) {
      ctx.log(`comfy.wan_bernini: ${missing.length} reference(s) did not resolve and were skipped: ${missing.join(', ')}`);
    }

    const scalars: Record<string, unknown> = {};
    for (const k of ['width', 'height', 'length', 'seed'] as const) {
      if (typeof cfg[k] === 'number') scalars[k] = cfg[k];
    }

    return executeComfyWorkflow({
      ctx,
      tool: 'comfy.wan_bernini',
      workflowPath: cfg['workflowPath'] as string,
      ...(typeof cfg['manifestPath'] === 'string' ? { manifestPath: cfg['manifestPath'] } : {}),
      ...(Array.isArray(cfg['parameterMappings']) ? { parameterMappings: cfg['parameterMappings'] as never } : {}),
      ...(typeof cfg['endpoint'] === 'string' ? { endpoint: cfg['endpoint'] } : {}),
      outputPath: cfg['outputPath'] as string,
      ...(prompt !== undefined ? { prompt } : {}),
      imageInputs,
      scalars,
      ...(cfg['forceRerun'] === true ? { forceRerun: true } : {}),
      ...(typeof cfg['width'] === 'number' ? { width: cfg['width'] } : {}),
      ...(typeof cfg['height'] === 'number' ? { height: cfg['height'] } : {}),
      clientFactory,
    });
  }

  return { describe, run };
}

export const comfyWanBerniniRunner = createComfyWanBerniniRunner();
