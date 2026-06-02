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

interface PriorShot { shotNumber: number; itemId?: string; outputAbs: string }
interface ShotPromptJSON {
  chosenBaseShotNumber?: number;
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
  const promptJSON = ctx.inputs['shot_image_prompt'] as ShotPromptJSON | undefined;
  if (!promptJSON || typeof promptJSON !== 'object') {
    return { ok: false, error: 'comfy.qwen_edit_chain: missing shot_image_prompt upstream' };
  }
  const priors = (ctx.inputs['shot_image'] as PriorShot[] | undefined) ?? [];
  const charMap = (ctx.inputs['character_image'] as Record<string, string> | undefined) ?? {};
  const setMap = (ctx.inputs['setting_image'] as Record<string, string> | undefined) ?? {};

  // ── Pick the chain base ──
  let baseImagePath: string | null = null;
  let baseSource = '';
  if (promptJSON.chosenBaseShotNumber !== undefined && priors.length > 0) {
    const picked = priors.find((p) => p.shotNumber === promptJSON.chosenBaseShotNumber);
    if (picked) {
      baseImagePath = picked.outputAbs;
      baseSource = `prior shot ${picked.shotNumber}`;
    }
  }
  if (!baseImagePath && priors.length > 0) {
    // No explicit choice or chosen number not found → take most recent (priors[0] is DESC).
    baseImagePath = priors[0]!.outputAbs;
    baseSource = `prior shot ${priors[0]!.shotNumber} (fallback: LLM choice ${promptJSON.chosenBaseShotNumber ?? '<unset>'} not in priors)`;
  }
  if (!baseImagePath) {
    // Fall back to first setting image, then first character.
    const settings = Object.values(setMap);
    const chars = Object.values(charMap);
    if (settings.length > 0) { baseImagePath = settings[0]!; baseSource = 'setting (no prior shot)'; }
    else if (chars.length > 0) { baseImagePath = chars[0]!; baseSource = 'character (no prior shot)'; }
  }
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
  try {
    const { readAliases, applyAliases } = await import('../workflowAliases.js');
    const aliasesDir = process.env['DHEE_WORKFLOW_ALIASES_DIR']
      || resolve(process.env['HOME'] ?? '', '.dhee', 'workflow-aliases');
    const aliases = readAliases(aliasesDir, baseUrl ?? 'unknown');
    if ((aliases.name_aliases && Object.keys(aliases.name_aliases).length > 0)
        || (aliases.class_swaps && Object.keys(aliases.class_swaps).length > 0)) {
      workflow = applyAliases(workflow as never, {
        workflowKey: cfg.workflowPath,
        aliases,
      }) as never;
      ctx.log(`comfy.qwen_edit_chain: applied aliases for endpoint=${baseUrl} workflow=${cfg.workflowPath}`);
    }
  } catch (e) {
    // Non-fatal — aliases are an optional optimization. If the store
    // is malformed or unreadable, fall through to the canonical
    // workflow + let Comfy report the model-not-found.
    ctx.log(`comfy.qwen_edit_chain: alias load skipped (${(e as Error).message})`);
  }

  // ── Upload base + character refs (up to 2 extras for TextEncodeQwenImageEditPlus image2/image3) ──
  mkdirSync(dirname(outputAbs), { recursive: true });
  const client = new ComfyUIClient({ outputDir: dirname(outputAbs), ...(baseUrl ? { baseUrl } : {}) });

  ctx.log(`comfy.qwen_edit_chain: uploading base + refs...`);
  const upBase = await client.uploadImage(baseImagePath, 'input', true);
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
    const u = await client.uploadImage(refPath, 'input', true);
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
  const { promptId, outputs } = await client.queueAndWaitWS(workflow, (p) => {
    if (p.percentage !== undefined && p.message) {
      ctx.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
    }
  });
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
