/**
 * `comfy.qwen_edit_chain` runner — Qwen Image Edit 2511 + Multi-Angle LoRA
 * + Lightning 4-step LoRA, with iterative shot chaining.
 *
 * Each invocation generates ONE shot's first-frame image by editing a
 * PRIOR shot's image (chosen by the LLM at shot_image_prompt time)
 * with the multi-angle LoRA's camera-rotation guidance.
 *
 * Wiring (resolved by the walker into ctx.inputs):
 *   - shot_image_prompt: parsed JSON with {chosenBaseShotNumber,
 *     view, elevation, distance, deltaText} from the camera-enum
 *     structured-output LLM call
 *   - shot_image (scope: 'previousN'): array of
 *     {shotNumber, itemId, outputAbs} for the prior shots (DESC by shotNumber)
 *   - character_image (scope: 'all'): {[characterId]: absolutePath}
 *   - setting_image (scope: 'all'): {[settingId]: absolutePath}
 *
 * Fallback for shot 1 (no prior shots in previousN): use the scene's
 * setting image as the chain base. If no setting either, the first
 * available character image.
 *
 * Lets us run Qwen Edit on either local OR cloud Comfy by switching
 * `endpoint` in the bundle.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import { ComfyUIClient } from '../../services/comfyui/ComfyUIClient.js';
import { retryTransient } from './transientRetry.js';

interface PriorShot { shotNumber: number; itemId?: string; outputAbs: string }
interface ShotPromptJSON {
  chosenBaseShotNumber?: number;
  /**
   * Optional EXPLICIT base-image selector. When set, the runner resolves
   * it against the setting map (then character map) and uses it as the
   * edit base — overriding the "first setting" fallback. This lets a
   * non-chain caller (e.g. per-setting plate generation) target THE
   * correct base in a multi-setting project: the plate prompt emits
   * baseId = its settingId. Ignored when a prior shot is chosen.
   */
  baseId?: string;
  view: string;
  elevation: string;
  distance: string;
  deltaText: string;
  /**
   * Character IDs (from characters_plan) visually present in this shot,
   * primary subject first. Max 2 (Qwen Edit Multi-Angle constraint).
   * The LLM emits this as part of the structured output (see
   * shot_image_prompt.schema.json). The runner uses this list directly
   * for Qwen's reference slots — no inference from prose.
   */
  characters: string[];
}

interface ChainConfig {
  workflowPath: string;
  endpoint?: string;
  outputPath: string;
  /** Multi-Angle LoRA strength. */
  multiAngleStrength?: number;
  /** Render size (Qwen Edit usually 1024×1024). */
  width?: number;
  height?: number;
  forceRerun?: boolean;
}

import { resolveEndpointUrl } from './endpointResolver.js';

/** A value has the Qwen camera-token prompt shape if it carries the
 * azimuth `view` + the change `deltaText` (the two fields the runner
 * needs to build `<sks> {view} … , {deltaText}`). */
function isQwenPrompt(v: unknown): v is ShotPromptJSON {
  return !!v && typeof v === 'object'
    && typeof (v as Record<string, unknown>)['view'] === 'string'
    && typeof (v as Record<string, unknown>)['deltaText'] === 'string';
}

/** Locate the upstream prompt JSON by shape. Prefers the conventional
 * 'shot_image_prompt' input; otherwise returns the first shape-matching
 * input value (so plate_prompt / any node emitting the camera-token shape
 * drives this runner without a hardcoded key). */
function findQwenPrompt(inputs: Record<string, unknown>): ShotPromptJSON | null {
  if (isQwenPrompt(inputs['shot_image_prompt'])) return inputs['shot_image_prompt'];
  for (const v of Object.values(inputs)) if (isQwenPrompt(v)) return v;
  return null;
}

/**
 * Pure base-image selection (no fs): priors (LLM-chosen, then most-recent)
 * → explicit baseId (setting then character) → first setting → first
 * character. Returns the chosen path (or null) + a human source label.
 * Exported for unit testing — the runner does the existsSync check.
 */
export function selectQwenBase(
  promptJSON: Pick<ShotPromptJSON, 'chosenBaseShotNumber' | 'baseId'>,
  priors: PriorShot[],
  setMap: Record<string, string>,
  charMap: Record<string, string>,
): { path: string | null; source: string } {
  if (promptJSON.chosenBaseShotNumber !== undefined && priors.length > 0) {
    const picked = priors.find((p) => p.shotNumber === promptJSON.chosenBaseShotNumber);
    if (picked) return { path: picked.outputAbs, source: `prior shot ${picked.shotNumber}` };
  }
  if (priors.length > 0) {
    return {
      path: priors[0]!.outputAbs,
      source: `prior shot ${priors[0]!.shotNumber} (fallback: LLM choice ${promptJSON.chosenBaseShotNumber ?? '<unset>'} not in priors)`,
    };
  }
  if (promptJSON.baseId) {
    if (setMap[promptJSON.baseId]) return { path: setMap[promptJSON.baseId]!, source: `setting '${promptJSON.baseId}' (explicit baseId)` };
    if (charMap[promptJSON.baseId]) return { path: charMap[promptJSON.baseId]!, source: `character '${promptJSON.baseId}' (explicit baseId)` };
  }
  const settings = Object.values(setMap);
  const chars = Object.values(charMap);
  if (settings.length > 0) return { path: settings[0]!, source: 'setting (no prior shot)' };
  if (chars.length > 0) return { path: chars[0]!, source: 'character (no prior shot)' };
  return { path: null, source: '' };
}

async function runQwenEditChain(ctx: RunnerContext): Promise<RunnerResult> {
  const cfg = ctx.node.runner.config as unknown as ChainConfig;
  if (!cfg.workflowPath || !cfg.outputPath) {
    return { ok: false, error: 'comfy.qwen_edit_chain: missing workflowPath or outputPath' };
  }
  if (!ctx.bundleDir) {
    return { ok: false, error: 'comfy.qwen_edit_chain: ctx.bundleDir required' };
  }

  // ── Resume short-circuit ──
  const outputAbs = resolve(ctx.projectDir, cfg.outputPath);
  if (!cfg.forceRerun && existsSync(outputAbs)) {
    ctx.log(`comfy.qwen_edit_chain: ${cfg.outputPath} already exists — skipping`);
    return { ok: true, outputPath: cfg.outputPath, metadata: { skipped: true } };
  }

  // ── Read upstream inputs ──
  // Resolve the prompt JSON by SHAPE, not by a hardcoded input key, so this
  // runner drives any node whose upstream emits the Qwen camera-token shape
  // ({view, distance, deltaText, …}) — e.g. shot_image_prompt for shots OR
  // plate_prompt for per-setting plates. Prefer the conventional
  // 'shot_image_prompt' key, else the first shape-matching input.
  const promptJSON = findQwenPrompt(ctx.inputs);
  if (!promptJSON) {
    return { ok: false, error: 'comfy.qwen_edit_chain: no upstream prompt with Qwen camera-token shape ({view, distance, deltaText, …})' };
  }
  const priors = (ctx.inputs['shot_image'] as PriorShot[] | undefined) ?? [];
  const charMap = (ctx.inputs['character_image'] as Record<string, string> | undefined) ?? {};
  const setMap = (ctx.inputs['setting_image'] as Record<string, string> | undefined) ?? {};

  // ── Pick the chain base ──
  const { path: baseImagePath, source: baseSource } = selectQwenBase(promptJSON, priors, setMap, charMap);
  if (!baseImagePath || !existsSync(baseImagePath)) {
    return { ok: false, error: `comfy.qwen_edit_chain: no usable base image (priors=${priors.length}, settings=${Object.keys(setMap).length}, chars=${Object.keys(charMap).length})` };
  }

  // ── Build full prompt with <sks> prefix ──
  const fullPrompt = `<sks> ${promptJSON.view} ${promptJSON.elevation} ${promptJSON.distance}, ${promptJSON.deltaText}`;
  ctx.log(`comfy.qwen_edit_chain: base=${baseSource}, prompt="${fullPrompt.slice(0, 140)}${fullPrompt.length > 140 ? '…' : ''}"`);

  // ── Resolve endpoint ──
  let baseUrl: string | undefined;
  if (cfg.endpoint) {
    const url = resolveEndpointUrl(cfg.endpoint);
    if (!url) return { ok: false, error: `Bundle requires endpoint '${cfg.endpoint}' but ENDPOINT_${cfg.endpoint.replace(/\./g, '_')} is not set.` };
    baseUrl = url;
  }

  // ── Load workflow ──
  const wfPath = resolve(ctx.bundleDir, cfg.workflowPath);
  if (!existsSync(wfPath)) return { ok: false, error: `comfy.qwen_edit_chain: workflow not found at ${wfPath}` };
  let workflow = JSON.parse(readFileSync(wfPath, 'utf-8')) as Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;

  // ── Apply per-endpoint workflow aliases (model-file rename +
  //    class_type swap for GGUF/quant variants). The user's local
  //    Comfy may not have the exact filenames the bundle's workflow
  //    expects; the agent's dhee_apply_workflow_aliases tool writes
  //    a per-endpoint mapping. Reading + applying here keeps the
  //    bundle's canonical workflow untouched.
  {
    const { applyEndpointAliases, defaultAliasesDir } = await import('../workflowAliases.js');
    const aliasRes = await applyEndpointAliases({
      workflow: workflow as never,
      workflowKey: cfg.workflowPath,
      aliasesDir: defaultAliasesDir(),
      endpointUrl: baseUrl,
      log: (m) => ctx.log(`comfy.qwen_edit_chain: ${m}`),
    });
    if (aliasRes.error) return { ok: false, error: `comfy.qwen_edit_chain: ${aliasRes.error}` };
    workflow = aliasRes.workflow as never;
  }

  // ── Upload base + character refs (up to 2 extras for TextEncodeQwenImageEditPlus image2/image3) ──
  mkdirSync(dirname(outputAbs), { recursive: true });
  const client = new ComfyUIClient({ outputDir: dirname(outputAbs), ...(baseUrl ? { baseUrl } : {}) });

  ctx.log(`comfy.qwen_edit_chain: uploading base + refs...`);
  const upBase = await retryTransient(
    () => client.uploadImage(baseImagePath, 'input', true),
    { signal: ctx.signal, log: ctx.log, label: 'comfy.qwen_edit_chain upload base' },
  );
  ctx.log(`  base → ${upBase.name}`);

  // Character refs come straight from the LLM's structured output —
  // see shot_image_prompt.schema.json `characters` field. No
  // string-matching, no inference: the LLM declared who is in this
  // shot, the runner just uploads those refs in declared order
  // (primary subject = slot 1).
  const declaredChars = Array.isArray(promptJSON.characters) ? promptJSON.characters : null;
  if (declaredChars === null) {
    return {
      ok: false,
      error: `comfy.qwen_edit_chain: prompt JSON missing 'characters' field. Re-run shot_image_prompt with the current schema (characters: array of character ids).`,
    };
  }
  const upRefs: string[] = [];
  for (const cid of declaredChars.slice(0, 2)) {
    const refPath = charMap[cid];
    if (!refPath) {
      return {
        ok: false,
        error: `comfy.qwen_edit_chain: prompt declared character '${cid}' but no reference image is available (charMap keys: ${Object.keys(charMap).join(', ')}). Verify characters_plan and the LLM's emitted character id.`,
      };
    }
    const u = await retryTransient(
      () => client.uploadImage(refPath, 'input', true),
      { signal: ctx.signal, log: ctx.log, label: `comfy.qwen_edit_chain upload ref ${cid}` },
    );
    upRefs.push(u.name);
    ctx.log(`  ref ${cid} → ${u.name}`);
  }
  if (upRefs.length === 0) {
    ctx.log(`  (no character refs declared — insert/object shot; base shot provides framing only)`);
  }

  // ── Patch workflow ──
  // Workflow is the qwen_edit_multi topology I proved earlier:
  //   - UNETLoader (e.g. node "UNET") → MultiAngleLoRA → LightningLoRA → MSAF → CFGNorm → KSampler
  //   - LoadImage 'LI' = base image
  //   - TextEncodeQwenImageEditPlus 'POS' with image1=SCALE, image2=REF_1, image3=REF_2
  //   - FluxKontextMultiReferenceLatentMethod, KSampler at 4 steps/cfg 1
  if (!workflow['LI'] || !workflow['POS']) {
    return { ok: false, error: 'comfy.qwen_edit_chain: workflow missing required nodes LI / POS' };
  }
  workflow['LI']!.inputs['image'] = upBase.name;
  workflow['POS']!.inputs['prompt'] = fullPrompt;
  // All 4 LoadImage slots must point at a real uploaded file (cloud Comfy
  // validates LoadImage filenames before execution). Cascade fallbacks:
  // missing ref slot → use the previous filled ref → use the base image.
  // Effect: the model sees up to 2 distinct refs but can never error
  // on a missing placeholder filename.
  const fallback1 = upRefs[0] ?? upBase.name;
  const fallback2 = upRefs[1] ?? fallback1;
  if (workflow['REF_1']) workflow['REF_1']!.inputs['image'] = fallback1;
  if (workflow['REF_2']) workflow['REF_2']!.inputs['image'] = fallback2;

  // LoRA strength override (Multi-Angles default 0.9).
  if (workflow['LORA_MA'] && typeof cfg.multiAngleStrength === 'number') {
    workflow['LORA_MA']!.inputs['strength_model'] = cfg.multiAngleStrength;
  }

  const seed = Math.floor(Math.random() * 0x7fffffff);
  if (workflow['KS']) workflow['KS']!.inputs['seed'] = seed;
  if (workflow['SAVE']) workflow['SAVE']!.inputs['filename_prefix'] = `qwen_chain/${Date.now()}`;

  ctx.log(`comfy.qwen_edit_chain: submitting (seed=${seed})...`);
  const start = Date.now();
  const { promptId, outputs } = await retryTransient(
    () =>
      client.queueAndWaitWS(workflow, (p) => {
        if (p.percentage !== undefined && p.message) {
          ctx.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
        }
      }),
    { signal: ctx.signal, log: ctx.log, label: 'comfy.qwen_edit_chain queue' },
  );
  ctx.log(`  completed in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

  // ── Download ──
  const hist = await client.getOutputImages(promptId);
  const seen = new Set<string>();
  const all = [...outputs, ...hist].filter((o) => /\.(png|jpg|webp)$/i.test(o.filename)).filter((o) => !seen.has(o.filename) && (seen.add(o.filename), true));
  if (all.length === 0) return { ok: false, error: 'comfy.qwen_edit_chain: no image output from Comfy' };
  const item = all[0]!;
  const targetName = outputAbs.split('/').pop()!;
  const downloaded = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', targetName);

  // Sidecar meta.
  writeFileSync(outputAbs.replace(/\.[^.]+$/, '.meta.json'), JSON.stringify({
    runner: 'comfy.qwen_edit_chain', fullPrompt, baseImage: baseImagePath, baseSource,
    priors: priors.map((p) => ({ shotNumber: p.shotNumber, itemId: p.itemId })),
    chosenBaseShotNumber: promptJSON.chosenBaseShotNumber, charRefs: upRefs, seed, promptId,
  }, null, 2));

  return { ok: true, outputPath: cfg.outputPath, metadata: { absolutePath: downloaded, promptId, seed, baseSource } };
}

function describe(): RunnerDescription {
  return {
    id: 'comfy.qwen_edit_chain',
    displayName: 'Qwen Edit chain (Multi-Angle + Lightning)',
    description: 'Generates one shot first-frame image by editing a prior shot via Qwen Image Edit 2511 + Multi-Angles + Lightning LoRA. LLM picks which prior shot to use as the base via shot_image_prompt.chosenBaseShotNumber.',
    capabilities: ['image-edit', 'multi-angle-rotation', 'shot-chain'],
    modalities: { input: ['image', 'text'], output: ['image'] },
    configSchema: {
      type: 'object',
      required: ['workflowPath', 'outputPath'],
      properties: {
        workflowPath:        { type: 'string' },
        endpoint:            { type: 'string' },
        outputPath:          { type: 'string' },
        multiAngleStrength:  { type: 'number', default: 0.9 },
        width:               { type: 'integer', default: 1024 },
        height:              { type: 'integer', default: 1024 },
        forceRerun:          { type: 'boolean' },
      },
    },
    costHint: 'cloud_gpu',
  };
}

export const comfyQwenEditChainRunner: Runner = { describe, run: runQwenEditChain };
