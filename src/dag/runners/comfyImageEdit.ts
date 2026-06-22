/**
 * `comfy.image_edit` — GENERIC, model-agnostic image-edit runner.
 *
 * Exposes ANY ComfyUI edit workflow (Qwen-Image-Edit, FLUX 2 Klein, Boogu,
 * future models) behind ONE uniform interface — like the Nano Banana / Gemini
 * edit endpoints:
 *
 *     images[]  +  prompt  +  additionalArgs(loras, steps, cfg, seed, w, h, neg)
 *
 * NOTHING about any specific model is baked into this code. All workflow-shape
 * knowledge (which node is the prompt, which are the image slots, where the
 * LoRA chain attaches, how absent reference slots are pruned, which scalar maps
 * to which sampler field) lives in the workflow's MANIFEST under `editConfig`
 * (data, not code). That is what lets a generic NAME hold honestly generic CODE
 * (cf. the runner-authoring rule): binding lives in the per-workflow manifest.
 *
 * To support a new edit model: drop its workflow .json + a manifest with an
 * `editConfig` block. No code change.
 *
 * All endpoint / upload / queue / download / alias / CAS plumbing is reused
 * from comfyExecutor (workflow-agnostic).
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import {
  executeComfyWorkflow,
  defaultComfyClientFactory,
  pruneAndRedirect,
  type ComfyImageClient,
  type ComfyWorkflow,
} from './comfyExecutor.js';

type Lora = { name: string; strength?: number };

/** Declared by each edit workflow's manifest (`editConfig`). Pure data. */
interface EditConfig {
  /** Ordered logical image-slot names, e.g. ['base_image','reference_image_1',…].
   *  The Nth provided image is bound to the Nth slot. */
  imageSlots: string[];
  /** Where to (re)attach the LoRA chain: a model-consuming node + field.
   *  Absent → loras are ignored (model has no LoRA seam). */
  loraTarget?: { nodeId: string; field: string };
  /** Logical-scalar → present (declared in parameterMappings) name passthrough.
   *  Keys are the additionalArgs we accept; values are the manifest input name. */
  scalarMap?: Partial<Record<'steps' | 'cfg' | 'seed' | 'width' | 'height' | 'negativePrompt', string>>;
  /** Per optional image slot: nodes to delete + chain redirects when the slot
   *  is absent (consumed by the generic pruneAndRedirect graph op). */
  pruneBranches?: Record<string, { deleteNodes: string[]; redirects: Array<{ from: string; to: string }> }>;
}

/** Rebuild the LoraLoaderModelOnly chain feeding `target` from `loras`.
 *  Mirrors the proven chain-rebuild in comfyLtxDirector — generic graph op. */
function rebuildLoraChain(wf: ComfyWorkflow, target: { nodeId: string; field: string }, loras: Lora[]): void {
  const consumer = wf[target.nodeId];
  if (!consumer || !consumer.inputs) return;
  let ref = consumer.inputs[target.field] as [string, number] | undefined;
  const oldIds: string[] = [];
  while (Array.isArray(ref) && wf[ref[0]] && wf[ref[0]]!.class_type === 'LoraLoaderModelOnly') {
    oldIds.push(ref[0]);
    ref = wf[ref[0]]!.inputs['model'] as [string, number] | undefined;
  }
  if (!Array.isArray(ref)) return;
  for (const id of oldIds) delete wf[id];
  let prev: [string, number] = ref;
  loras.forEach((l, i) => {
    const id = `editlora_${i}`;
    wf[id] = {
      class_type: 'LoraLoaderModelOnly',
      inputs: { lora_name: l.name, strength_model: l.strength ?? 1.0, model: prev },
    } as ComfyWorkflow[string];
    prev = [id, 0];
  });
  consumer.inputs[target.field] = prev;
}

function readEditConfig(bundleDir: string, manifestPath: string): EditConfig | { error: string } {
  const abs = resolve(bundleDir, manifestPath);
  if (!existsSync(abs)) return { error: `manifest not found at ${abs}` };
  let m: { editConfig?: EditConfig };
  try {
    m = JSON.parse(readFileSync(abs, 'utf-8')) as { editConfig?: EditConfig };
  } catch (e) {
    return { error: `manifest at ${abs} is not valid JSON: ${(e as Error).message}` };
  }
  if (!m.editConfig || !Array.isArray(m.editConfig.imageSlots) || m.editConfig.imageSlots.length === 0) {
    return { error: `manifest at ${abs} has no editConfig.imageSlots[]` };
  }
  return m.editConfig;
}

/** Resolve a prompt from cfg.prompt (literal) or an upstream input (string or {imagePrompt}). */
function resolvePrompt(ctx: RunnerContext, cfg: Record<string, unknown>): string {
  if (typeof cfg['prompt'] === 'string' && cfg['prompt']) return cfg['prompt'];
  const key = cfg['promptInput'];
  if (typeof key === 'string') {
    const v = ctx.inputs[key];
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof (v as { imagePrompt?: unknown }).imagePrompt === 'string') {
      return (v as { imagePrompt: string }).imagePrompt;
    }
  }
  return '';
}

export function createComfyImageEditRunner(opts?: {
  clientFactory?: (opts: { baseUrl?: string; outputDir: string }) => ComfyImageClient;
}): Runner {
  const clientFactory = opts?.clientFactory ?? defaultComfyClientFactory;

  const describe = (): RunnerDescription => ({
    id: 'comfy.image_edit',
    displayName: 'Comfy Image Edit (generic)',
    description:
      'Model-agnostic image-edit API over any ComfyUI edit workflow (Qwen-Image-Edit, FLUX Klein, Boogu, …). ' +
      'Interface: images[] + prompt + additionalArgs(loras, steps, cfg, seed, width, height, negativePrompt). ' +
      'Per-workflow node mapping lives in the manifest editConfig — no model is baked into the code.',
    capabilities: ['comfyui', 'image', 'image-edit', 'reference-edit', 'model-agnostic'],
    modalities: { input: ['image', 'text'], output: ['image'] },
    configSchema: {
      workflowPath: 'string (edit workflow json, rel bundleDir)',
      manifestPath: 'string (manifest with parameterMappings + editConfig)',
      endpoint: 'string (ENDPOINT_<name>)',
      outputPath: 'string (rel projectDir)',
      images: 'string[] (ordered input ids → image slots)',
      prompt: 'string (literal) OR promptInput: string (upstream input id)',
      additionalArgs: '{ loras?: {name,strength}[], steps?, cfg?, seed?, width?, height?, negativePrompt? }',
    },
    costHint: 'local_gpu',
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const tag = (s: string) => `comfy.image_edit: ${s}`;
    if (!ctx.bundleDir) return { ok: false, error: tag('ctx.bundleDir is required') };
    const cfg = ctx.node.runner.config as Record<string, unknown>;
    const workflowPath = cfg['workflowPath'] as string | undefined;
    const manifestPath = cfg['manifestPath'] as string | undefined;
    const outputPath = cfg['outputPath'] as string | undefined;
    if (!workflowPath || !manifestPath || !outputPath) {
      return { ok: false, error: tag("missing required config: 'workflowPath', 'manifestPath', 'outputPath'") };
    }

    const editCfg = readEditConfig(ctx.bundleDir, manifestPath);
    if ('error' in editCfg) return { ok: false, error: tag(editCfg.error) };

    // ── Resolve ordered images → logical slots ──
    const imageIds = Array.isArray(cfg['images']) ? (cfg['images'] as string[]) : [];
    if (imageIds.length === 0) return { ok: false, error: tag("config 'images' must list at least one input id") };
    if (imageIds.length > editCfg.imageSlots.length) {
      return { ok: false, error: tag(`${imageIds.length} images but workflow has ${editCfg.imageSlots.length} slots`) };
    }
    const imageInputs: Record<string, string> = {};
    const presentSlots = new Set<string>();
    imageIds.forEach((id, i) => {
      const v = ctx.inputs[id];
      const path = typeof v === 'string' ? v : undefined;
      if (path && existsSync(path)) {
        const slot = editCfg.imageSlots[i]!;
        imageInputs[slot] = path;
        presentSlots.add(slot);
      }
    });
    if (Object.keys(imageInputs).length === 0) {
      return { ok: false, error: tag(`no image inputs resolved from ${JSON.stringify(imageIds)}`) };
    }

    const prompt = resolvePrompt(ctx, cfg);

    // ── Scalars from additionalArgs, keyed by the manifest's logical names ──
    const add = (cfg['additionalArgs'] as Record<string, unknown> | undefined) ?? {};
    const scalars: Record<string, unknown> = {};
    const sm = editCfg.scalarMap ?? {};
    const setScalar = (argKey: keyof NonNullable<EditConfig['scalarMap']>, val: unknown) => {
      const logical = sm[argKey];
      if (logical && val !== undefined) scalars[logical] = val;
    };
    setScalar('steps', add['steps']);
    setScalar('cfg', add['cfg']);
    setScalar('seed', add['seed']);
    setScalar('width', add['width']);
    setScalar('height', add['height']);
    setScalar('negativePrompt', add['negativePrompt']);

    const width = typeof add['width'] === 'number' ? (add['width'] as number) : undefined;
    const height = typeof add['height'] === 'number' ? (add['height'] as number) : undefined;
    // `loras` PRESENT (even []) → rebuild the chain (so [] removes the workflow's
    // default distill LoRA for full quality). ABSENT → leave the workflow's loras.
    const lorasProvided = Array.isArray(add['loras']);
    const loras = lorasProvided ? (add['loras'] as Lora[]) : [];

    // ── Mutation hook: prune absent optional slots + inject LoRAs ──
    const pruneAbsent = (workflow: ComfyWorkflow, present: Set<string>): Set<string> => {
      const deleted = new Set<string>();
      if (editCfg.pruneBranches) {
        for (const [slot, branch] of Object.entries(editCfg.pruneBranches)) {
          if (!present.has(slot)) {
            const removed = pruneAndRedirect(workflow, branch);
            for (const id of removed) deleted.add(id);
          }
        }
      }
      if (lorasProvided && editCfg.loraTarget) {
        rebuildLoraChain(workflow, editCfg.loraTarget, loras);
      }
      return deleted;
    };

    return executeComfyWorkflow({
      ctx,
      tool: 'comfy.image_edit',
      workflowPath,
      manifestPath,
      ...(cfg['endpoint'] ? { endpoint: cfg['endpoint'] as string } : {}),
      outputPath,
      prompt,
      imageInputs,
      scalars,
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      pruneAbsent,
      clientFactory,
    });
  }

  return { describe, run };
}

export const comfyImageEditRunner = createComfyImageEditRunner();
