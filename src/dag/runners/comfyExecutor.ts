/**
 * comfyExecutor — the workflow-AGNOSTIC plumbing shared by every bound
 * ComfyUI image/video runner (comfy.klein, comfy.tti, comfy.fl2v, …).
 *
 * Each bound runner is responsible for the workflow-SPECIFIC parts:
 *   - resolving its named inputs (prompt, base_image, reference_image_N,
 *     first_frame, …) from ctx.inputs / config,
 *   - declaring how to PRUNE its graph when an optional input is absent.
 *
 * Everything below here is the same for any workflow and lives once:
 *   - content-addressed cache get/put + skip-if-output-exists,
 *   - endpoint resolution (ENDPOINT_<name>),
 *   - per-endpoint model aliases,
 *   - image upload (with transient retry),
 *   - required-input enforcement (driven by the manifest's
 *     inputRequirements[].required — NOT by any per-workflow heuristic),
 *   - prune-absent hook, parameter-mapping application, queue + download.
 *
 * The split is deliberate: a runner named after its workflow is allowed
 * to know that workflow's shape (cf. comfy.ltx_director). A generic name
 * would not be — that mismatch is what this module removes.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import type { RunnerContext, RunnerResult } from '../schema.js';
import { retryTransient } from './transientRetry.js';
import { ComfyUIClient } from '../../services/comfyui/ComfyUIClient.js';
import { openGenerationCache } from '../cas/GenerationCache.js';
import type { InputsHashKey } from '../cas/inputsHash.js';
import { resolveEndpointUrl } from './endpointResolver.js';
import { unloadLocalLlmForComfy } from './gpuCoordinator.js';
import { getProjectCacheScope } from '../projectIdentity.js';

// ── Shared types ───────────────────────────────────────────────────────

export interface ComfyImageParameterMapping {
  /** Logical input name (e.g. 'prompt', 'base_image', 'reference_image_1'). */
  input: string;
  /** Target ComfyUI node id (workflow JSON key). */
  nodeId: string;
  /** Target ComfyUI node input field name. */
  field: string;
}

/** Minimal Comfy interface the executor needs. Allows unit-test stubbing. */
export interface ComfyImageClient {
  uploadImage(filePath: string): Promise<{ name: string }>;
  queueAndWait(
    workflow: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{
    outputs: Array<{ filename: string; subfolder?: string; nodeId?: string }>;
  }>;
  downloadOutput(
    filename: string,
    subfolder: string | undefined,
    destPath: string,
  ): Promise<void>;
}

export type ComfyWorkflow = Record<string, { inputs: Record<string, unknown>; class_type?: string }>;

/** A single manifest input declaration (subset the executor reads). */
interface InputRequirement {
  id: string;
  type?: string;
  source?: string;
  required?: boolean;
}

export interface ExecuteComfyOptions {
  ctx: RunnerContext;
  /** Tool id, for logs / errors / CAS key (e.g. 'comfy.klein'). */
  tool: string;
  /** Workflow JSON path, relative to bundleDir. */
  workflowPath: string;
  /** Manifest with parameterMappings + inputRequirements, relative to bundleDir. */
  manifestPath?: string;
  /** Inline mappings (either this or manifestPath). */
  parameterMappings?: ComfyImageParameterMapping[];
  /** Named endpoint (ENDPOINT_<name>). */
  endpoint?: string;
  /** Output path, relative to projectDir. */
  outputPath: string;
  /** Prompt text (for the node + CAS key). */
  prompt?: string;
  /** Resolved, PRESENT image inputs: { inputName → absolute path }. */
  imageInputs: Record<string, string>;
  /** Resolved scalar/text inputs (seed, width, height, durationSeconds, …). */
  scalars?: Record<string, unknown>;
  /** Re-render even if outputPath exists / CAS hit. */
  forceRerun?: boolean;
  /** Width/height for the CAS key (optional; also passed via scalars). */
  width?: number;
  height?: number;
  durationSeconds?: number;
  /**
   * Prune hook — called with the loaded workflow + the set of image-input
   * names that ARE present. The runner deletes the nodes for absent
   * optional inputs and rewires the graph. Must return the set of deleted
   * node ids so the executor can skip their (now-dangling) mappings.
   */
  pruneAbsent?: (workflow: ComfyWorkflow, presentImageInputs: Set<string>) => Set<string>;
  /** Dependency list to stamp onto metadata (precise upstream refs). */
  dependencies?: unknown;
  /** Injected Comfy client factory (tests stub this). */
  clientFactory: (opts: { baseUrl?: string; outputDir: string; workflowId?: string }) => ComfyImageClient;
}

const KLEIN_FALLBACK_FILENAME = 'dag';

/**
 * Fallback map from the workflow FILE to the billing workflowId used by the
 * dhee website (COMFY_GPU_RUNTIME_RATE_PROFILES). A bundle node SHOULD declare
 * `workflowId` explicitly in its runner config; this is the safety net so that
 * bundles which don't still bill correctly.
 *
 * Why it's needed: zimage_tti workflows have GENERIC node class_types
 * (KSampler, UNETLoader, …) — the billing classifier can't recognize "zimage"
 * from class_types alone, so the job would fall into `unknown_partner` and
 * fail to price. klein/ltx/fl2v/qwen workflows DO carry recognizable
 * class_types (Flux2Scheduler/LTXDirector/FluxKontext) so they classify via
 * classType already, but we map them too for explicitness.
 */
const BILLING_WORKFLOW_ID_BY_PATH: ReadonlyArray<{ test: RegExp; workflowId: string }> = [
  { test: /zimage/i, workflowId: 'zimage_cloud' },
  { test: /klein/i, workflowId: 'flux2_klein_edit_cloud' },
  { test: /fl2v/i, workflowId: 'ltx23_fl2v_cloud' },
];

function deriveBillingWorkflowId(workflowPath: string | undefined): string | undefined {
  if (!workflowPath) return undefined;
  for (const { test, workflowId } of BILLING_WORKFLOW_ID_BY_PATH) {
    if (test.test(workflowPath)) return workflowId;
  }
  return undefined;
}

// ── Default client factory (uses ComfyUIClient) ────────────────────────

export function defaultComfyClientFactory(opts: { baseUrl?: string; outputDir: string; workflowId?: string }): ComfyImageClient {
  // Cloud when the URL is cloud.comfy.org OR env says cloud mode (the
  // dhee Cloud proxy isn't a cloud.comfy.org URL but forwards to it,
  // so COMFY_MODE=cloud is the reliable signal there). The constructor
  // re-derives isCloud the same way; this just keeps the factory's own
  // decision consistent so it also passes the api key explicitly.
  const isCloud =
    (opts.baseUrl?.includes('cloud.comfy.org') ?? false) ||
    process.env['COMFY_MODE'] === 'cloud';
  const cloudKey = isCloud ? process.env['COMFY_CLOUD_API_KEY'] : undefined;
  const workflowId = opts.workflowId;
  const client = new ComfyUIClient({
    outputDir: opts.outputDir,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
    ...(cloudKey ? { apiKey: cloudKey } : {}),
  });
  return {
    async uploadImage(filePath) {
      const r = await client.uploadImage(filePath, 'input', true);
      return { name: r.name };
    },
    async queueAndWait(workflow, signal) {
      const { outputs, promptId } = await client.queueAndWaitWS(
        workflow,
        undefined,
        { ...(workflowId ? { workflowId } : {}), ...(signal ? { signal } : {}) },
      );
      let resolved = outputs;
      if (resolved.length === 0 && promptId) {
        try {
          resolved = await client.getOutputImages(promptId);
        } catch {
          // keep empty; executor surfaces "no outputs"
        }
      }
      return {
        outputs: resolved.map((o) => ({ filename: o.filename, subfolder: o.subfolder })),
      };
    },
    async downloadOutput(filename, subfolder, destPath) {
      mkdirSync(dirname(destPath), { recursive: true });
      const dl = await client.downloadOutput(filename, subfolder ?? '', 'output');
      writeFileSync(destPath, dl.buffer);
    },
  };
}

// ── Manifest loading ───────────────────────────────────────────────────

function loadManifest(
  manifestAbs: string,
): { ok: true; mappings: ComfyImageParameterMapping[]; requirements: InputRequirement[] } | { ok: false; error: string } {
  if (!existsSync(manifestAbs)) {
    return { ok: false, error: `workflow manifest not found at ${manifestAbs}` };
  }
  try {
    const m = JSON.parse(readFileSync(manifestAbs, 'utf-8')) as {
      parameterMappings?: ComfyImageParameterMapping[];
      inputRequirements?: InputRequirement[];
    };
    if (!m.parameterMappings || !Array.isArray(m.parameterMappings)) {
      return { ok: false, error: `manifest at ${manifestAbs} has no parameterMappings array` };
    }
    return { ok: true, mappings: m.parameterMappings, requirements: m.inputRequirements ?? [] };
  } catch (err) {
    return { ok: false, error: `failed to parse manifest at ${manifestAbs}: ${(err as Error).message}` };
  }
}

function applyMapping(
  workflow: ComfyWorkflow,
  mapping: ComfyImageParameterMapping,
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  const node = workflow[mapping.nodeId];
  if (!node) {
    return {
      ok: false,
      error: `parameterMapping refers to nodeId '${mapping.nodeId}' (input '${mapping.input}') but that node is not in the workflow.`,
    };
  }
  node.inputs[mapping.field] = value;
  return { ok: true };
}

// ── Generic graph prune + redirect ─────────────────────────────────────

/**
 * Delete `deleteNodes` from the workflow and repoint any surviving link
 * that referenced a deleted node's output to a surviving node, following
 * `redirects` transitively.
 *
 * `redirects` is a list of { from, to } where a consumer of `from`'s
 * output should instead consume `to`'s output. Transitive: if `to` is
 * itself redirected (e.g. it's also being deleted in the same pass), the
 * closure resolves to the first surviving target. This makes pruning a
 * chain (drop refs 3 AND 4 → consumers fall back to ref 2) order-
 * independent and hole-tolerant.
 *
 * The ALGORITHM is workflow-agnostic; callers supply the node-id TABLE
 * (which IS workflow-specific, and lives in the bound runner).
 */
export function pruneAndRedirect(
  workflow: ComfyWorkflow,
  spec: { deleteNodes: string[]; redirects: Array<{ from: string; to: string }> },
): Set<string> {
  const direct = new Map<string, string>();
  for (const r of spec.redirects) direct.set(r.from, r.to);
  const resolveFinal = (id: string): string => {
    const seen = new Set<string>();
    let cur = id;
    while (direct.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = direct.get(cur)!;
    }
    return cur;
  };
  const del = new Set(spec.deleteNodes);
  for (const [nid, node] of Object.entries(workflow)) {
    if (del.has(nid)) continue;
    for (const [field, val] of Object.entries(node.inputs)) {
      // ComfyUI links are [nodeId, slotIndex] tuples.
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
        const finalTarget = resolveFinal(val[0]);
        if (finalTarget !== val[0]) node.inputs[field] = [finalTarget, val[1]];
      }
    }
  }
  for (const nid of del) delete workflow[nid];
  return del;
}

// ── The executor ───────────────────────────────────────────────────────

export async function executeComfyWorkflow(opts: ExecuteComfyOptions): Promise<RunnerResult> {
  const { ctx, tool } = opts;
  const tag = (s: string) => `${tool}: ${s}`;

  if (ctx.signal?.aborted) return { ok: false, error: tag('aborted before runner started') };
  if (!ctx.bundleDir) return { ok: false, error: tag('ctx.bundleDir is required; walker must populate it') };
  if (!opts.workflowPath) return { ok: false, error: tag("missing required config field 'workflowPath'") };
  if (!opts.outputPath) return { ok: false, error: tag("missing required config field 'outputPath'") };
  if (!opts.parameterMappings && !opts.manifestPath) {
    return { ok: false, error: tag("one of 'parameterMappings' or 'manifestPath' must be supplied") };
  }

  const outAbs = resolve(ctx.projectDir, opts.outputPath);
  const workflowAbs = resolve(ctx.bundleDir, opts.workflowPath);
  const scalars = opts.scalars ?? {};

  // ── Content-addressed cache key ──
  const casDisabled = process.env['DHEE_DISABLE_CAS'] === '1';
  const imageEntries: Record<string, { kind: 'file'; path: string } | undefined> = {};
  for (const [name, p] of Object.entries(opts.imageInputs)) {
    imageEntries[`img_${name}`] = existsSync(p) ? { kind: 'file' as const, path: p } : undefined;
  }
  const cacheKey: InputsHashKey = {
    tool,
    toolVersion: '0.1.0',
    inputs: {
      workflowFile: existsSync(workflowAbs) ? { kind: 'file' as const, path: workflowAbs } : undefined,
      prompt: opts.prompt ?? '',
      ...imageEntries,
    },
    config: {
      projectScope: getProjectCacheScope(ctx.projectDir),
      width: opts.width,
      height: opts.height,
      durationSeconds: opts.durationSeconds,
    },
  };

  if (!casDisabled && !opts.forceRerun) {
    const cache = openGenerationCache(
      process.env['DHEE_CACHE_ROOT'] ? { cacheRoot: process.env['DHEE_CACHE_ROOT'] } : undefined,
    );
    const hit = cache.get(cacheKey);
    if (hit) {
      mkdirSync(dirname(outAbs), { recursive: true });
      copyFileSync(hit.storePath, outAbs);
      ctx.log(tag(`CAS hit ${hit.hash.slice(0, 8)} → ${opts.outputPath}`));
      return {
        ok: true,
        outputPath: opts.outputPath,
        metadata: {
          cached: true,
          inputsHash: hit.hash,
          casHit: true,
          ...(hit.metadata ?? {}),
          ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
        },
      };
    }
  }

  // Path-based skip — only trustworthy when CAS is disabled.
  if (casDisabled && !opts.forceRerun && existsSync(outAbs)) {
    try {
      if (statSync(outAbs).size > 0) {
        ctx.log(tag(`cached → ${opts.outputPath}`));
        return {
          ok: true,
          outputPath: opts.outputPath,
          metadata: { cached: true, ...(opts.dependencies ? { dependencies: opts.dependencies } : {}) },
        };
      }
    } catch {
      /* fall through */
    }
  }

  // ── Load workflow + mappings + requirements ──
  if (!existsSync(workflowAbs)) return { ok: false, error: tag(`workflow not found at ${workflowAbs}`) };
  let workflow: ComfyWorkflow;
  try {
    workflow = JSON.parse(readFileSync(workflowAbs, 'utf-8')) as ComfyWorkflow;
  } catch (err) {
    return { ok: false, error: tag(`workflow JSON malformed: ${(err as Error).message}`) };
  }

  let mappings: ComfyImageParameterMapping[];
  let requirements: InputRequirement[] = [];
  if (opts.parameterMappings) {
    mappings = opts.parameterMappings;
  } else {
    const m = loadManifest(resolve(ctx.bundleDir, opts.manifestPath!));
    if (!m.ok) return { ok: false, error: tag(m.error) };
    mappings = m.mappings;
    requirements = m.requirements;
  }

  // ── Required-input enforcement (manifest-driven, no per-workflow heuristic) ──
  // Whatever the manifest marks required: true must be resolvable. This is
  // what replaces the old klein-specific "base_image present?" guard — the
  // requirement now travels with the workflow, not the runner.
  const present = new Set<string>([
    ...Object.keys(opts.imageInputs),
    ...Object.keys(scalars).filter((k) => scalars[k] !== undefined),
  ]);
  if (opts.prompt !== undefined && opts.prompt !== '') present.add('prompt');
  for (const req of requirements) {
    if (req.required && !present.has(req.id)) {
      return {
        ok: false,
        error: tag(
          `required input '${req.id}'` +
            (req.source ? ` (source: ${req.source})` : '') +
            ` was not resolved for this item` +
            (ctx.itemId ? ` (${ctx.itemId})` : '') +
            `. The workflow '${opts.workflowPath}' declares it required, so it cannot run without it. ` +
            `Fix the upstream output (e.g. add a reference to the shot prompt) or route this node to a ` +
            `workflow that doesn't require '${req.id}'.`,
        ),
      };
    }
  }

  // ── Resolve endpoint ──
  let baseUrl: string | undefined;
  if (opts.endpoint) {
    const resolved = resolveEndpointUrl(opts.endpoint);
    if (!resolved) {
      return {
        ok: false,
        error: tag(
          `endpoint '${opts.endpoint}' is referenced by the bundle but ` +
            `ENDPOINT_${opts.endpoint.replace(/\./g, '_')} is not set in the environment. ` +
            `Configure it in Settings → ComfyUI Endpoints (or your .env in dev mode).`,
        ),
      };
    }
    baseUrl = resolved;
    ctx.log(tag(`routing to endpoint '${opts.endpoint}' → ${resolved}`));
  }

  // ── Per-endpoint workflow aliases (model rename / class swap) ──
  // Logs each class_swap applied and validates each swap target against the
  // endpoint's node signatures — an invalid swap (e.g. one that needs an
  // input the node lacks) fails fast here instead of a cryptic Comfy 400.
  {
    const { applyEndpointAliases, defaultAliasesDir } = await import('../workflowAliases.js');
    const aliasRes = await applyEndpointAliases({
      workflow: workflow as never,
      workflowKey: opts.workflowPath.split('/').slice(-2).join('/'),
      aliasesDir: defaultAliasesDir(),
      endpointUrl: baseUrl ?? process.env['COMFYUI_BASE_URL'],
      log: (m) => ctx.log(tag(m)),
    });
    if (aliasRes.error) return { ok: false, error: tag(aliasRes.error) };
    workflow = aliasRes.workflow as never;
  }

  // ── Build client ──
  const outDir = dirname(outAbs);
  mkdirSync(outDir, { recursive: true });
  // workflowId travels in extra_data.dhee_workflow_id so the dhee website
  // proxy can bill the job (classifyComfyWorkflow keys GPU-runtime rates by
  // it, e.g. 'zimage_cloud'). Declared per-node in the bundle config, with a
  // workflowPath-derived fallback so bundles that omit it still bill.
  const configRecord = ctx.node.runner.config as Record<string, unknown> | undefined;
  const explicitWorkflowId =
    configRecord && typeof configRecord['workflowId'] === 'string'
      ? String(configRecord['workflowId'])
      : undefined;
  const workflowId = explicitWorkflowId ?? deriveBillingWorkflowId(opts.workflowPath);
  const client = opts.clientFactory({
    ...(baseUrl ? { baseUrl } : {}),
    outputDir: outDir,
    ...(workflowId ? { workflowId } : {}),
  });

  // ── Upload present images ──
  const uploadedNames: Record<string, string> = {};
  const uploadWithRetry = (path: string) =>
    retryTransient(() => client.uploadImage(path), {
      signal: ctx.signal,
      log: ctx.log,
      label: `${tool} upload ${basename(path)}`,
    });
  for (const [name, path] of Object.entries(opts.imageInputs)) {
    if (ctx.signal?.aborted) return { ok: false, error: tag('aborted during upload') };
    if (!existsSync(path)) return { ok: false, error: tag(`input image '${name}' not found on disk: ${path}`) };
    try {
      const u = await uploadWithRetry(path);
      uploadedNames[name] = u.name;
    } catch (err) {
      return { ok: false, error: tag(`upload failed for ${path} (input '${name}'): ${(err as Error).message}`) };
    }
  }

  // ── Prune absent optional branches (workflow-specific, runner-supplied) ──
  // Done BEFORE mapping so orphaned LoadImage nodes (pointing at placeholder
  // filenames) are removed and never reach Comfy's validator.
  let prunedNodeIds = new Set<string>();
  if (opts.pruneAbsent) {
    try {
      prunedNodeIds = opts.pruneAbsent(workflow, new Set(Object.keys(opts.imageInputs)));
    } catch (e) {
      return { ok: false, error: tag(`prune-absent failed: ${(e as Error).message}`) };
    }
  }

  // ── Apply parameter mappings ──
  const valueMap: Record<string, unknown> = {
    ...scalars,
    ...(opts.prompt !== undefined ? { prompt: opts.prompt } : {}),
    seed: (scalars['seed'] as number | undefined) ?? Math.floor(Math.random() * 0x7fffffff),
    filenamePrefix: `${KLEIN_FALLBACK_FILENAME}/${ctx.node.id}_${Date.now()}`,
    ...uploadedNames,
  };
  for (const m of mappings) {
    if (prunedNodeIds.has(m.nodeId)) continue; // node was pruned for an absent input
    if (!(m.input in valueMap)) continue; // optional input not provided
    const ap = applyMapping(workflow, m, valueMap[m.input]);
    if (!ap.ok) return { ok: false, error: tag(ap.error) };
  }

  // ── Queue + await ──
  if (ctx.signal?.aborted) return { ok: false, error: tag('aborted before queue') };
  // Single-GPU swap: unload the local LLM/VLM off the shared GPU before this
  // render (no-op unless DHEE_SINGLE_GPU=1). Best-effort; never blocks the render.
  await unloadLocalLlmForComfy(undefined, ctx.log);
  let queueResult: { outputs: Array<{ filename: string; subfolder?: string }> };
  try {
    queueResult = await retryTransient(() => client.queueAndWait(workflow, ctx.signal), {
      signal: ctx.signal,
      log: ctx.log,
      label: `${tool} queue`,
    });
  } catch (err) {
    return { ok: false, error: tag((err as Error).message) };
  }
  if (!queueResult.outputs || queueResult.outputs.length === 0) {
    return { ok: false, error: tag('Comfy returned no outputs (workflow may have failed silently).') };
  }

  // ── Download first media output ──
  // Audio extensions (wav/mp3/flac/ogg/m4a) let audio-producing workflows
  // (TTS, music) round-trip through this shared executor too.
  const imageOut =
    queueResult.outputs.find((o) =>
      /\.(png|jpg|jpeg|webp|mp4|webm|mov|wav|mp3|flac|ogg|m4a)$/i.test(o.filename),
    ) ?? queueResult.outputs[0]!;
  try {
    await retryTransient(() => client.downloadOutput(imageOut.filename, imageOut.subfolder, outAbs), {
      signal: ctx.signal,
      log: ctx.log,
      label: `${tool} download ${imageOut.filename}`,
    });
  } catch (err) {
    return { ok: false, error: tag(`download failed: ${(err as Error).message}`) };
  }
  if (!existsSync(outAbs)) {
    return { ok: false, error: tag(`download reported success but ${outAbs} does not exist on disk`) };
  }
  ctx.log(tag(`wrote ${opts.outputPath}`));

  // ── CAS put (best-effort) ──
  let inputsHashForEvent: string | undefined;
  if (!casDisabled) {
    try {
      const cache = openGenerationCache(
        process.env['DHEE_CACHE_ROOT'] ? { cacheRoot: process.env['DHEE_CACHE_ROOT'] } : undefined,
      );
      const ext = extname(opts.outputPath).slice(1) || 'png';
      const put = cache.put({
        key: cacheKey,
        sourcePath: outAbs,
        ext,
        metadata: { comfyOutput: imageOut.filename, bytes: statSync(outAbs).size },
      });
      inputsHashForEvent = put.hash;
    } catch {
      /* best-effort */
    }
  }

  return {
    ok: true,
    outputPath: opts.outputPath,
    metadata: {
      comfyOutput: imageOut.filename,
      cached: false,
      ...(inputsHashForEvent ? { inputsHash: inputsHashForEvent } : {}),
      ...(opts.dependencies ? { dependencies: opts.dependencies } : {}),
    },
  };
}
