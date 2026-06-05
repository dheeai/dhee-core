/**
 * bundleRequirements — read a bundle's declared model/custom-node
 * requirements, auto-derive a stub from its workflows, and enrich a
 * live checkBundle() result with the curated download/install hints.
 *
 *   - loadBundleRequirements(dir)        — read bundle.json.requirements
 *   - deriveBundleRequirements(dir, opts) — stub from workflows/*.json
 *   - enrichBundleFit(fit, requirements)  — annotate gaps with hints
 *
 * Detection (checkBundle) is endpoint-specific and needs no manifest.
 * The manifest is curation metadata — URLs, sizes, pack names, install
 * hints — that the workflow JSON can't carry. This module connects the
 * two: a detected gap ("foo.safetensors missing") + a manifest entry
 * ("FLUX dev, 24 GB, ↗hf.co/…") = an actionable Configurator row.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BundleRequirements,
  RequiredCustomNode,
  RequiredModel,
} from './schema.js';
import {
  extractModelRefs,
  extractNodeClasses,
  type ComfyWorkflow,
  type WorkflowModelRef,
  type MissingNodeClass,
} from './workflowVerify.js';
import { listBundleWorkflows, type BundleFit, type BundleWorkflowFit } from './checkBundle.js';

export type { BundleRequirements, RequiredCustomNode, RequiredModel } from './schema.js';

/**
 * Common vanilla-ComfyUI node classes. deriveBundleRequirements
 * excludes these from the custom-node stub by default so authors
 * aren't handed KSampler/CLIPTextEncode as "requirements". Heuristic,
 * not exhaustive — anything not listed stays in the stub for review.
 */
export const CORE_COMFY_CLASSES: ReadonlySet<string> = new Set([
  'KSampler', 'KSamplerAdvanced', 'KSamplerSelect', 'SamplerCustom', 'SamplerCustomAdvanced',
  'CLIPTextEncode', 'CLIPSetLastLayer', 'CLIPTextEncodeSDXL',
  'VAEDecode', 'VAEEncode', 'VAEEncodeForInpaint', 'VAEDecodeTiled',
  'EmptyLatentImage', 'EmptySD3LatentImage', 'EmptyLatentVideo',
  'LatentUpscale', 'LatentUpscaleBy', 'LatentFromBatch', 'RepeatLatentBatch',
  'SaveImage', 'PreviewImage', 'LoadImage', 'LoadImageMask', 'SaveAnimatedWEBP',
  'ImageScale', 'ImageScaleBy', 'ImageUpscaleWithModel', 'ImageBatch',
  'CheckpointLoaderSimple', 'CheckpointLoader', 'UNETLoader', 'VAELoader',
  'CLIPLoader', 'DualCLIPLoader', 'TripleCLIPLoader', 'UpscaleModelLoader',
  'ControlNetLoader', 'ControlNetApply', 'ControlNetApplyAdvanced',
  'LoraLoader', 'LoraLoaderModelOnly',
  'ConditioningCombine', 'ConditioningConcat', 'ConditioningSetArea',
  'ConditioningZeroOut', 'ConditioningSetTimestepRange',
  'ModelSamplingFlux', 'ModelSamplingSD3', 'ModelSamplingDiscrete',
  'BasicGuider', 'BasicScheduler', 'RandomNoise', 'CFGGuider', 'FluxGuidance',
  'Note', 'PrimitiveNode', 'Reroute',
]);

const TYPE_BY_FIELD: Record<string, string> = {
  unet_name: 'unet',
  vae_name: 'vae',
  clip_name: 'clip',
  clip_name1: 'clip',
  clip_name2: 'clip',
  lora_name: 'lora',
  ckpt_name: 'checkpoint',
  control_net_name: 'controlnet',
  style_model_name: 'style_model',
  upscale_model_name: 'upscale_model',
};

function modelType(field: string): string {
  return TYPE_BY_FIELD[field] ?? 'model';
}

function readBundleJson(bundleDir: string): Record<string, unknown> | null {
  const file = join(bundleDir, 'bundle.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The bundle's declared requirements, or null if it declares none. */
export function loadBundleRequirements(bundleDir: string): BundleRequirements | null {
  const bundle = readBundleJson(bundleDir);
  const req = bundle?.['requirements'];
  return req && typeof req === 'object' ? (req as BundleRequirements) : null;
}

export interface DerivedRequirements extends BundleRequirements {
  /** Every distinct node class referenced (informational — author prunes). */
  allNodeClasses: string[];
}

export interface DeriveOpts {
  /**
   * Node classes to treat as core/built-in (excluded from the
   * customNodes stub). Defaults to CORE_COMFY_CLASSES. Pass a vanilla
   * ComfyUI's /object_info key set for a sharper cut.
   */
  coreClasses?: ReadonlySet<string>;
}

/**
 * Auto-stub a bundle's requirements from its workflow JSONs. Models
 * come out fully (filenames + loader field + inferred type); custom
 * nodes are the referenced classes minus the core set, with curation
 * fields left blank for the author. Pure given the bundleDir contents.
 */
export function deriveBundleRequirements(
  bundleDir: string,
  opts: DeriveOpts = {},
): DerivedRequirements {
  const core = opts.coreClasses ?? CORE_COMFY_CLASSES;
  const modelByFilename = new Map<string, RequiredModel>();
  const allClasses = new Set<string>();

  for (const key of listBundleWorkflows(bundleDir)) {
    let wf: ComfyWorkflow;
    try {
      wf = JSON.parse(readFileSync(join(bundleDir, key), 'utf8')) as ComfyWorkflow;
    } catch {
      continue;
    }
    for (const ref of extractModelRefs(wf)) {
      if (!modelByFilename.has(ref.current_value)) {
        modelByFilename.set(ref.current_value, {
          classField: `${ref.nodeType}.${ref.inputField}`,
          canonicalFilename: ref.current_value,
          type: modelType(ref.inputField),
          downloadUrl: '',
          sizeGb: 0,
          optional: false,
        });
      }
    }
    for (const { class_type } of extractNodeClasses(wf)) allClasses.add(class_type);
  }

  const customNodes: RequiredCustomNode[] = [...allClasses]
    .filter((c) => !core.has(c))
    .sort()
    .map((classType) => ({ classType, pack: '', installVia: 'manager', gitUrl: '', note: '' }));

  return {
    models: [...modelByFilename.values()].sort((a, b) =>
      a.canonicalFilename.localeCompare(b.canonicalFilename),
    ),
    customNodes,
    allNodeClasses: [...allClasses].sort(),
  };
}

export interface EnrichedModelGap extends WorkflowModelRef {
  requirement?: RequiredModel;
}
export interface EnrichedNodeGap extends MissingNodeClass {
  requirement?: RequiredCustomNode;
}
export interface EnrichedWorkflowFit extends Omit<BundleWorkflowFit, 'missing_refs' | 'missing_node_classes'> {
  missing_refs: EnrichedModelGap[];
  missing_node_classes: EnrichedNodeGap[];
}
export interface EnrichedBundleFit extends Omit<BundleFit, 'workflows'> {
  workflows: EnrichedWorkflowFit[];
}

/**
 * Attach the bundle's curated requirement entry to each detected gap
 * (model by canonical filename; node by class_type). Gaps with no
 * manifest entry pass through with `requirement` undefined — the UI
 * shows the bare filename/class and a generic action.
 */
export function enrichBundleFit(
  fit: BundleFit,
  requirements: BundleRequirements | null,
): EnrichedBundleFit {
  const modelByName = new Map<string, RequiredModel>();
  for (const m of requirements?.models ?? []) modelByName.set(m.canonicalFilename, m);
  const nodeByClass = new Map<string, RequiredCustomNode>();
  for (const n of requirements?.customNodes ?? []) nodeByClass.set(n.classType, n);

  return {
    ...fit,
    workflows: fit.workflows.map((w) => ({
      ...w,
      missing_refs: w.missing_refs.map((r) => {
        const requirement = modelByName.get(r.current_value);
        return requirement ? { ...r, requirement } : { ...r };
      }),
      missing_node_classes: w.missing_node_classes.map((n) => {
        const requirement = nodeByClass.get(n.class_type);
        return requirement ? { ...n, requirement } : { ...n };
      }),
    })),
  };
}
