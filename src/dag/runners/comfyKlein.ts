/**
 * `comfy.klein` — Flux 2 Klein reference-edit image runner.
 *
 * Bound to the Klein edit workflow (klein.json): a base reference image
 * plus up to three additional references, each threaded through a
 * ReferenceLatent chain into the sampler's conditioning. The runner is
 * NAMED after the workflow it drives (cf. comfy.ltx_director), so it is
 * allowed to know that workflow's shape — that's the honest alternative
 * to a generic name hiding workflow-specific code.
 *
 * Responsibilities (the workflow-SPECIFIC parts):
 *   - resolve the shot prompt's references[] against the character_image
 *     / setting_image collections into base_image + reference_image_1..3,
 *   - declare the per-reference ReferenceLatent BRANCH so an absent
 *     optional reference is PRUNED (nodes deleted + chain rewired) rather
 *     than left pointing at a placeholder filename Comfy would reject.
 *
 * All endpoint / upload / queue / download / alias / CAS plumbing lives
 * in comfyExecutor (workflow-agnostic).
 */
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import { extractShotReferences } from './extractShotReferences.js';
import {
  executeComfyWorkflow,
  defaultComfyClientFactory,
  pruneAndRedirect,
  type ComfyImageClient,
  type ComfyWorkflow,
} from './comfyExecutor.js';

/** Base + 3 references = 4 LoadImage slots in klein.json. */
const KLEIN_MAX_REFERENCES = 3;

/**
 * klein.json ReferenceLatent chain topology, per OPTIONAL reference input.
 * base_image (LoadImage 76, ReferenceLatent 92:79:77/76) is REQUIRED and
 * never pruned. Each optional reference owns one branch:
 *   LoadImage → ImageScaleToTotalPixels → VAEEncode → ReferenceLatent(pos)
 *                                                    → ReferenceLatent(neg)
 * When absent we delete the branch and redirect consumers of this branch's
 * ReferenceLatent outputs to the PREVIOUS branch's outputs, so the
 * positive/negative chain (…→ 92:84 → 92:88 → 92:89 → CFGGuider 92:63)
 * stays connected at whatever the last present reference is.
 */
const KLEIN_REFERENCE_BRANCHES: Record<
  string,
  { deleteNodes: string[]; redirects: Array<{ from: string; to: string }> }
> = {
  reference_image_1: {
    deleteNodes: ['81', '92:85', '92:84:78', '92:84:77', '92:84:76'],
    redirects: [
      { from: '92:84:77', to: '92:79:77' },
      { from: '92:84:76', to: '92:79:76' },
    ],
  },
  reference_image_2: {
    deleteNodes: ['82', '92:87', '92:88:78', '92:88:77', '92:88:76'],
    redirects: [
      { from: '92:88:77', to: '92:84:77' },
      { from: '92:88:76', to: '92:84:76' },
    ],
  },
  reference_image_3: {
    deleteNodes: ['83', '92:89', '92:89:78', '92:89:77', '92:89:76'],
    redirects: [
      { from: '92:89:77', to: '92:88:77' },
      { from: '92:89:76', to: '92:88:76' },
    ],
  },
};

/** Prune the branches for any optional reference input that's absent. */
export function pruneKleinReferences(workflow: ComfyWorkflow, present: Set<string>): Set<string> {
  const deleteNodes: string[] = [];
  const redirects: Array<{ from: string; to: string }> = [];
  for (const [input, branch] of Object.entries(KLEIN_REFERENCE_BRANCHES)) {
    if (present.has(input)) continue;
    deleteNodes.push(...branch.deleteNodes);
    redirects.push(...branch.redirects);
  }
  if (deleteNodes.length === 0) return new Set();
  return pruneAndRedirect(workflow, { deleteNodes, redirects });
}

interface ShotPrompt {
  imagePrompt?: string;
  references?: Array<{ id: string; type: string }>;
  aspectRatio?: string;
}

/**
 * Resolve the shot prompt + its references into ordered image paths.
 * First resolved reference → base_image; the rest → reference_image_1..N.
 * References resolve against the character_image / setting_image scope='all'
 * maps the walker exposes ({ itemId → absolutePath }).
 */
function resolveReferences(
  ctx: RunnerContext,
): { prompt?: string; shotPrompt: ShotPrompt | null; imageInputs: Record<string, string> } {
  const imageInputs: Record<string, string> = {};
  const cfg = ctx.node.runner.config as Record<string, unknown>;

  // Explicit config wins (direct paths, e.g. from a non-narrative caller).
  let prompt = typeof cfg['prompt'] === 'string' ? (cfg['prompt'] as string) : undefined;
  if (typeof cfg['baseImage'] === 'string') imageInputs['base_image'] = cfg['baseImage'] as string;
  if (Array.isArray(cfg['referenceImages'])) {
    (cfg['referenceImages'] as string[]).slice(0, KLEIN_MAX_REFERENCES).forEach((p, i) => {
      imageInputs[`reference_image_${i + 1}`] = p;
    });
  }

  // Else resolve from the upstream shot prompt JSON.
  let shotPrompt: ShotPrompt | null = null;
  if (!prompt || !imageInputs['base_image']) {
    for (const v of Object.values(ctx.inputs)) {
      if (v && typeof v === 'object' && 'imagePrompt' in (v as Record<string, unknown>)) {
        const p = v as ShotPrompt;
        if (typeof p.imagePrompt !== 'string') continue;
        shotPrompt = p;
        if (!prompt) prompt = p.imagePrompt;
        if (!imageInputs['base_image'] && Array.isArray(p.references) && p.references.length > 0) {
          const charMap = (ctx.inputs['character_image'] as Record<string, string> | undefined) ?? {};
          const setMap = (ctx.inputs['setting_image'] as Record<string, string> | undefined) ?? {};
          const refPaths: string[] = [];
          for (const ref of p.references) {
            const path =
              ref.type === 'character' ? charMap[ref.id] : ref.type === 'setting' ? setMap[ref.id] : undefined;
            if (path) refPaths.push(path);
          }
          if (refPaths.length > 0) {
            imageInputs['base_image'] = refPaths[0]!;
            refPaths.slice(1, 1 + KLEIN_MAX_REFERENCES).forEach((p2, i) => {
              imageInputs[`reference_image_${i + 1}`] = p2;
            });
          }
        }
        break;
      }
    }
  }
  return { prompt, shotPrompt, imageInputs };
}

export function createComfyKleinRunner(opts?: {
  clientFactory?: (o: { baseUrl?: string; outputDir: string }) => ComfyImageClient;
}): Runner {
  const clientFactory = opts?.clientFactory ?? defaultComfyClientFactory;

  const describe = (): RunnerDescription => ({
    id: 'comfy.klein',
    displayName: 'Comfy Klein (Flux 2 reference edit)',
    description:
      'Drives the Flux 2 Klein edit workflow: a base reference image plus up to 3 optional references threaded through a ReferenceLatent chain. Absent optional references are pruned from the graph.',
    capabilities: ['image-generation', 'image-edit', 'reference-image-conditioning'],
    modalities: { input: ['text', 'image'], output: ['image'] },
    configSchema: {
      type: 'object',
      required: ['workflowPath', 'outputPath'],
      properties: {
        workflowPath: { type: 'string' },
        manifestPath: { type: 'string' },
        parameterMappings: { type: 'array' },
        endpoint: { type: 'string' },
        prompt: { type: 'string' },
        baseImage: { type: 'string' },
        referenceImages: { type: 'array', items: { type: 'string' }, maxItems: KLEIN_MAX_REFERENCES },
        outputPath: { type: 'string' },
        seed: { type: 'integer' },
        width: { type: 'integer' },
        height: { type: 'integer' },
        forceRerun: { type: 'boolean' },
      },
    },
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    const cfg = ctx.node.runner.config as Record<string, unknown>;

    if (Array.isArray(cfg['referenceImages']) && (cfg['referenceImages'] as unknown[]).length > KLEIN_MAX_REFERENCES) {
      return {
        ok: false,
        error: `comfy.klein: ${(cfg['referenceImages'] as unknown[]).length} reference images supplied; klein supports at most ${KLEIN_MAX_REFERENCES} (plus the required base image).`,
      };
    }

    const { prompt, shotPrompt, imageInputs } = resolveReferences(ctx);

    const dependencies = shotPrompt
      ? extractShotReferences({ promptItemId: ctx.itemId ?? '', prompt: shotPrompt })
      : undefined;

    const scalars: Record<string, unknown> = {};
    if (typeof cfg['width'] === 'number') scalars['width'] = cfg['width'];
    if (typeof cfg['height'] === 'number') scalars['height'] = cfg['height'];
    if (typeof cfg['seed'] === 'number') scalars['seed'] = cfg['seed'];

    return executeComfyWorkflow({
      ctx,
      tool: 'comfy.klein',
      workflowPath: cfg['workflowPath'] as string,
      ...(typeof cfg['manifestPath'] === 'string' ? { manifestPath: cfg['manifestPath'] as string } : {}),
      ...(Array.isArray(cfg['parameterMappings'])
        ? { parameterMappings: cfg['parameterMappings'] as never }
        : {}),
      ...(typeof cfg['endpoint'] === 'string' ? { endpoint: cfg['endpoint'] as string } : {}),
      outputPath: cfg['outputPath'] as string,
      ...(prompt !== undefined ? { prompt } : {}),
      imageInputs,
      scalars,
      ...(cfg['forceRerun'] === true ? { forceRerun: true } : {}),
      ...(typeof cfg['width'] === 'number' ? { width: cfg['width'] as number } : {}),
      ...(typeof cfg['height'] === 'number' ? { height: cfg['height'] as number } : {}),
      pruneAbsent: pruneKleinReferences,
      ...(dependencies ? { dependencies } : {}),
      clientFactory,
    });
  }

  return { describe, run };
}

export const comfyKleinRunner = createComfyKleinRunner();
