/**
 * `comfy.image` runner — drives a Klein (or compatible) ComfyUI image
 * workflow for first frame / last frame / character ref / setting ref
 * generation. Replaces the executor's per-typeId image handlers
 * (shot_image, character_image, setting_image, …) with one runner
 * parameterized by workflow + parameter mappings.
 *
 * Responsibilities:
 *   - Resolve the named endpoint to a URL via ENDPOINT_<name> env.
 *   - Load the workflow JSON from <bundleDir>/<workflowPath>.
 *   - Apply parameterMappings (input name → nodeId.field) so config
 *     fields land at the right Comfy node inputs.
 *   - Upload base image + reference images (cap 4 refs, Klein constraint).
 *   - Queue the workflow; await completion; download the produced image
 *     to <projectDir>/<outputPath>.
 *
 * Skip-if-output-exists: same semantics as llm.generate. forceRerun
 * overrides.
 *
 * Testability: ComfyImageClient is injected via createComfyImageRunner(
 * { clientFactory }). Tests stub upload/queue/download.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import { retryTransient } from './transientRetry.js';
import { ComfyUIClient } from '../../services/comfyui/ComfyUIClient.js';
import { openGenerationCache } from '../cas/GenerationCache.js';
import type { InputsHashKey } from '../cas/inputsHash.js';

// ── Public types ──────────────────────────────────────────────────────

export interface ComfyImageParameterMapping {
  /** Logical input name (e.g. 'prompt', 'base_image', 'reference_image_1'). */
  input: string;
  /** Target ComfyUI node id (workflow JSON key). */
  nodeId: string;
  /** Target ComfyUI node input field name. */
  field: string;
}

export interface ComfyImageConfig {
  /** Workflow JSON path, relative to bundle dir. */
  workflowPath: string;
  /** Parameter mappings (inline). Either this OR manifestPath is required. */
  parameterMappings?: ComfyImageParameterMapping[];
  /**
   * Path to a workflow manifest file with parameterMappings (and
   * potentially other metadata). Relative to bundle dir.
   */
  manifestPath?: string;
  /** Named endpoint (e.g. 'self.local'). Resolved via ENDPOINT_<name>. */
  endpoint?: string;
  /** The prompt text (resolved by walker from upstream LLM nodes). */
  prompt?: string;
  /** Absolute path to the base image (when the workflow needs one). */
  baseImage?: string;
  /** Absolute paths to up-to-4 reference images. Klein hard cap. */
  referenceImages?: string[];
  /** Where to write the result, relative to projectDir. */
  outputPath: string;
  /** Sampler seed. Random when omitted. */
  seed?: number;
  /** Output dimensions. */
  width?: number;
  height?: number;
  /** Re-render even if outputPath exists. */
  forceRerun?: boolean;
  /** Allow additional fields the bundle author maps via parameterMappings. */
  [k: string]: unknown;
}

/** Minimal Comfy interface the runner needs. Allows unit-test stubbing. */
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

const KLEIN_MAX_REFS = 4;

// ── Endpoint resolution ────────────────────────────────────────────────

import { resolveEndpointUrl } from './endpointResolver.js';
import { extractShotReferences } from './extractShotReferences.js';

// ── Default client factory (uses ComfyUIClient) ────────────────────────

function defaultClientFactory(opts: { baseUrl?: string; outputDir: string }): ComfyImageClient {
  // Auto-detect: when the resolved endpoint URL points at Comfy Cloud,
  // thread the COMFY_CLOUD_API_KEY env var through to ComfyUIClient as
  // the X-API-Key header. Otherwise the local-Comfy path doesn't need
  // auth.
  const isCloud = opts.baseUrl?.includes('cloud.comfy.org') ?? false;
  const cloudKey = isCloud ? process.env['COMFY_CLOUD_API_KEY'] : undefined;
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
        signal ? { signal } : {},
      );
      // When the run completes via HTTP-polling fallback (cloud
      // cold-start, WS-quiet), `outputs` is empty because nothing
      // arrived over the WS channel. Fall back to the history API
      // to recover the actual output filenames.
      let resolved = outputs;
      if (resolved.length === 0 && promptId) {
        try {
          const hist = await client.getOutputImages(promptId);
          resolved = hist;
        } catch {
          // keep empty; runner will surface "no outputs"
        }
      }
      return {
        outputs: resolved.map((o) => ({
          filename: o.filename,
          subfolder: o.subfolder,
        })),
      };
    },
    async downloadOutput(filename, subfolder, destPath) {
      mkdirSync(dirname(destPath), { recursive: true });
      const dl = await client.downloadOutput(filename, subfolder ?? '', 'output');
      writeFileSync(destPath, dl.buffer);
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

function validateConfig(raw: unknown): { ok: true; cfg: ComfyImageConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'comfy.image: config must be an object' };
  const cfg = raw as Partial<ComfyImageConfig>;
  if (!cfg.workflowPath || typeof cfg.workflowPath !== 'string') {
    return { ok: false, error: "comfy.image: missing required config field 'workflowPath'" };
  }
  if (!cfg.outputPath || typeof cfg.outputPath !== 'string') {
    return { ok: false, error: "comfy.image: missing required config field 'outputPath'" };
  }
  if (!cfg.parameterMappings && !cfg.manifestPath) {
    return { ok: false, error: "comfy.image: one of 'parameterMappings' or 'manifestPath' must be supplied" };
  }
  if (cfg.referenceImages && cfg.referenceImages.length > KLEIN_MAX_REFS) {
    return {
      ok: false,
      error: `comfy.image: ${cfg.referenceImages.length} reference images supplied; Klein hard cap is ${KLEIN_MAX_REFS}.`,
    };
  }
  return { ok: true, cfg: cfg as ComfyImageConfig };
}

function loadParameterMappings(
  cfg: ComfyImageConfig,
  bundleDir: string,
): { ok: true; mappings: ComfyImageParameterMapping[] } | { ok: false; error: string } {
  if (cfg.parameterMappings) return { ok: true, mappings: cfg.parameterMappings };
  if (!cfg.manifestPath) return { ok: false, error: 'comfy.image: no parameterMappings and no manifestPath' };
  const manifestAbs = resolve(bundleDir, cfg.manifestPath);
  if (!existsSync(manifestAbs)) {
    return { ok: false, error: `comfy.image: workflow manifest not found at ${manifestAbs}` };
  }
  try {
    const m = JSON.parse(readFileSync(manifestAbs, 'utf-8')) as { parameterMappings?: ComfyImageParameterMapping[] };
    if (!m.parameterMappings || !Array.isArray(m.parameterMappings)) {
      return { ok: false, error: `comfy.image: manifest at ${manifestAbs} has no parameterMappings array` };
    }
    return { ok: true, mappings: m.parameterMappings };
  } catch (err) {
    return { ok: false, error: `comfy.image: failed to parse manifest at ${manifestAbs}: ${(err as Error).message}` };
  }
}

function applyMapping(
  workflow: Record<string, { inputs: Record<string, unknown>; class_type?: string }>,
  mapping: ComfyImageParameterMapping,
  value: unknown,
): { ok: true } | { ok: false; error: string } {
  const node = workflow[mapping.nodeId];
  if (!node) {
    return {
      ok: false,
      error: `comfy.image: parameterMapping refers to nodeId '${mapping.nodeId}' (input '${mapping.input}') but that node is not in the workflow.`,
    };
  }
  node.inputs[mapping.field] = value;
  return { ok: true };
}

// ── The runner factory ─────────────────────────────────────────────────

export function createComfyImageRunner(opts?: {
  clientFactory?: (opts: { baseUrl?: string; outputDir: string }) => ComfyImageClient;
}): Runner {
  const clientFactory = opts?.clientFactory ?? defaultClientFactory;

  const describe = (): RunnerDescription => ({
    id: 'comfy.image',
    displayName: 'Comfy Image',
    description: 'Generates a single image via a ComfyUI workflow (Klein or compatible). Handles uploads, parameter injection, and output download.',
    capabilities: ['image-generation', 'image-edit', 'reference-image-conditioning'],
    modalities: { input: ['text', 'image'], output: ['image'] },
    configSchema: {
      type: 'object',
      required: ['workflowPath', 'outputPath'],
      properties: {
        workflowPath:      { type: 'string' },
        parameterMappings: { type: 'array' },
        manifestPath:      { type: 'string' },
        endpoint:          { type: 'string' },
        prompt:            { type: 'string' },
        baseImage:         { type: 'string' },
        referenceImages:   { type: 'array', items: { type: 'string' }, maxItems: KLEIN_MAX_REFS },
        outputPath:        { type: 'string' },
        seed:              { type: 'integer' },
        width:             { type: 'integer' },
        height:            { type: 'integer' },
        forceRerun:        { type: 'boolean' },
      },
    },
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    // ── Pre-flight ──
    if (ctx.signal?.aborted) {
      return { ok: false, error: 'comfy.image: aborted before runner started' };
    }
    if (!ctx.bundleDir) {
      return { ok: false, error: 'comfy.image: ctx.bundleDir is required; walker must populate it' };
    }

    // Merge config with upstream-provided prompt/refs. The bundle's
    // shot_image_prompt LLM node (and friends) outputs JSON like
    // {imagePrompt, references: [{id, type}]}. The walker put that
    // parsed JSON on ctx.inputs keyed by the upstream node id. We
    // look across all ctx.inputs for entries that look like
    // image-prompt JSON and adopt them when config doesn't have prompt.
    //
    // Also: when running FL2V-style video workflows, derive prompt
    // from shot_motion_directive's description field, and pull
    // first_frame / last_frame paths from shot_image /
    // shot_image_last_frame upstream output file paths.
    const baseCfg = ctx.node.runner.config as Record<string, unknown>;
    const cfgWithUpstream: Record<string, unknown> = { ...baseCfg };

    // FL2V wiring: shot_motion_directive → prompt (description field).
    // shot_image / shot_image_last_frame → first_frame / last_frame
    // (walker exposes them as absolute paths since they're PNG files).
    const mdInput = ctx.inputs['shot_motion_directive'];
    if (mdInput && typeof mdInput === 'object' && 'description' in (mdInput as Record<string, unknown>)) {
      if (!cfgWithUpstream['prompt']) {
        cfgWithUpstream['prompt'] = (mdInput as { description: string }).description;
      }
    }
    if (typeof ctx.inputs['shot_image'] === 'string' && !cfgWithUpstream['baseImage']) {
      cfgWithUpstream['baseImage'] = ctx.inputs['shot_image'];
    }
    // FL2V workflow expects 'first_frame' and 'last_frame' as named
    // inputs to its parameterMappings (not base_image/reference_image_N
    // like Klein). Stash them under those names so the mapping
    // applies them to the correct LoadImage nodes.
    if (typeof ctx.inputs['shot_image'] === 'string') {
      cfgWithUpstream['_fl2v_first_frame'] = ctx.inputs['shot_image'];
    }
    if (typeof ctx.inputs['shot_image_last_frame'] === 'string') {
      cfgWithUpstream['_fl2v_last_frame'] = ctx.inputs['shot_image_last_frame'];
    }
    // When we resolve the prompt from ctx.inputs below, remember it
    // so we can emit a precise `metadata.dependencies` set on success
    // — only the refs this shot ACTUALLY consumed, not every char +
    // setting the bundle's scope='all' makes available.
    let extractedPrompt: { imagePrompt?: string; references?: Array<{ id?: string; type?: string }> } | null = null;
    if (!cfgWithUpstream['prompt']) {
      for (const v of Object.values(ctx.inputs)) {
        if (v && typeof v === 'object' && 'imagePrompt' in (v as Record<string, unknown>)) {
          const p = v as { imagePrompt?: string; references?: Array<{ id: string; type: string }>; aspectRatio?: string };
          if (typeof p.imagePrompt === 'string') {
            cfgWithUpstream['prompt'] = p.imagePrompt;
            extractedPrompt = p;
            // Resolve references against character_image / setting_image
            // outputs already produced. We look up the upstream node by
            // ref.id and ref.type to find the rendered image path.
            if (Array.isArray(p.references) && p.references.length > 0) {
              // Walker exposes scope='all' collection inputs as
              // { [itemId]: absolutePath } maps. Look up each ref's
              // (id, type) in the appropriate map.
              const charMap = (ctx.inputs['character_image'] as Record<string, string> | undefined) ?? {};
              const setMap = (ctx.inputs['setting_image'] as Record<string, string> | undefined) ?? {};
              const refPaths: string[] = [];
              for (const ref of p.references) {
                const path = ref.type === 'character' ? charMap[ref.id]
                  : ref.type === 'setting' ? setMap[ref.id]
                  : undefined;
                if (path) refPaths.push(path);
              }
              if (refPaths.length > 0) {
                // First ref becomes base_image; rest become reference_image_1..N
                cfgWithUpstream['baseImage'] = refPaths[0];
                if (refPaths.length > 1) {
                  cfgWithUpstream['referenceImages'] = refPaths.slice(1, 4);
                }
              }
            }
            if (p.aspectRatio && !cfgWithUpstream['aspectRatio']) {
              cfgWithUpstream['aspectRatio'] = p.aspectRatio;
            }
            break;
          }
        }
      }
    }
    const v = validateConfig(cfgWithUpstream);
    if (!v.ok) return { ok: false, error: v.error };
    const cfg = v.cfg;

    // ── Cache: build a content-addressed key over (workflow file
    //          content + prompt + reference image bytes + dimensions).
    //          Hit → copy from CAS and return cached:true with the
    //          inputsHash on metadata (the walker stamps it onto
    //          node.completed). Miss → run; CAS-put on the way out.
    const outAbs = resolve(ctx.projectDir, cfg.outputPath);
    const workflowAbsForKey = resolve(ctx.bundleDir, cfg.workflowPath);
    const casDisabled = process.env['DHEE_DISABLE_CAS'] === '1';
    const cacheKey: InputsHashKey = {
      tool: 'comfy.image',
      toolVersion: '0.1.0',
      inputs: {
        workflowFile: existsSync(workflowAbsForKey) ? { kind: 'file' as const, path: workflowAbsForKey } : undefined,
        prompt: cfg.prompt ?? '',
        baseImage: cfg.baseImage && existsSync(cfg.baseImage)
          ? { kind: 'file' as const, path: cfg.baseImage } : undefined,
        referenceImages: cfg.referenceImages?.filter((p) => existsSync(p)).map((p) => ({ kind: 'file' as const, path: p })),
        // FL2V wiring inputs (when present)
        fl2vFirst: (cfgWithUpstream['_fl2v_first_frame'] as string | undefined) && existsSync(cfgWithUpstream['_fl2v_first_frame'] as string)
          ? { kind: 'file' as const, path: cfgWithUpstream['_fl2v_first_frame'] as string } : undefined,
        fl2vLast: (cfgWithUpstream['_fl2v_last_frame'] as string | undefined) && existsSync(cfgWithUpstream['_fl2v_last_frame'] as string)
          ? { kind: 'file' as const, path: cfgWithUpstream['_fl2v_last_frame'] as string } : undefined,
      },
      config: {
        width: cfg.width,
        height: cfg.height,
        durationSeconds: (cfg as { duration?: number }).duration,
      },
    };
    if (!casDisabled && !cfg.forceRerun) {
      const cache = openGenerationCache(
        process.env['DHEE_CACHE_ROOT'] ? { cacheRoot: process.env['DHEE_CACHE_ROOT'] } : undefined,
      );
      const hit = cache.get(cacheKey);
      if (hit) {
        mkdirSync(dirname(outAbs), { recursive: true });
        copyFileSync(hit.storePath, outAbs);
        ctx.log(`comfy.image: CAS hit ${hit.hash.slice(0, 8)} → ${cfg.outputPath}`);
        const cachedDeps = extractedPrompt
          ? extractShotReferences({ promptItemId: ctx.itemId ?? '', prompt: extractedPrompt })
          : null;
        return {
          ok: true,
          outputPath: cfg.outputPath,
          metadata: {
            cached: true,
            inputsHash: hit.hash,
            casHit: true,
            ...(hit.metadata ?? {}),
            ...(cachedDeps ? { dependencies: cachedDeps } : {}),
          },
        };
      }
    }

    // Path-based skip (intra-project resume) — only trustworthy when
    // CAS is disabled. With CAS enabled, the CAS lookup above is the
    // source of truth; a file at outputPath may have come from a
    // different inputs (e.g. another branch).
    if (casDisabled && !cfg.forceRerun && existsSync(outAbs)) {
      try {
        if (statSync(outAbs).size > 0) {
          ctx.log(`comfy.image: cached → ${cfg.outputPath}`);
          const pathCachedDeps = extractedPrompt
            ? extractShotReferences({ promptItemId: ctx.itemId ?? '', prompt: extractedPrompt })
            : null;
          return {
            ok: true,
            outputPath: cfg.outputPath,
            metadata: {
              cached: true,
              ...(pathCachedDeps ? { dependencies: pathCachedDeps } : {}),
            },
          };
        }
      } catch {
        // fall through
      }
    }

    // ── Resolve workflow + mappings ──
    const workflowAbs = resolve(ctx.bundleDir, cfg.workflowPath);
    if (!existsSync(workflowAbs)) {
      return { ok: false, error: `comfy.image: workflow not found at ${workflowAbs}` };
    }
    let workflow = JSON.parse(readFileSync(workflowAbs, 'utf-8')) as Record<
      string,
      { inputs: Record<string, unknown>; class_type?: string }
    >;
    const mRes = loadParameterMappings(cfg, ctx.bundleDir);
    if (!mRes.ok) return { ok: false, error: mRes.error };
    const mappings = mRes.mappings;

    // ── Resolve endpoint ──
    let baseUrl: string | undefined;
    if (cfg.endpoint) {
      const resolved = resolveEndpointUrl(cfg.endpoint);
      if (!resolved) {
        return {
          ok: false,
          error:
            `comfy.image: endpoint '${cfg.endpoint}' is referenced by the bundle but ` +
            `ENDPOINT_${cfg.endpoint.replace(/\./g, '_')} is not set in the environment. ` +
            `Configure it in Settings → ComfyUI Endpoints (or your .env in dev mode).`,
        };
      }
      baseUrl = resolved;
      ctx.log(`comfy.image: routing to endpoint '${cfg.endpoint}' → ${resolved}`);
    }

    // ── Apply per-endpoint workflow aliases ──
    // The bundle's canonical workflow may reference model files under
    // names the user's local Comfy doesn't have (e.g. a `flux-2-*`
    // checkpoint vs the user's klein-quantized variant). The
    // BundleConfigurator's "use a model I have" picker and the agent's
    // dhee_apply_workflow_aliases tool persist a per-box rename map; we
    // apply it here in-memory so IMAGE nodes honor the user's choice.
    // Without this, image-model substitutions were silently ignored —
    // only the ltx_director / qwen_edit_chain runners applied aliases —
    // so the mismatch reappeared on every render. Bundle JSON on disk
    // stays untouched; the substitution lives in the alias store.
    try {
      const { readAliases, applyAliases } = await import('../workflowAliases.js');
      const { resolve: pathResolve } = await import('node:path');
      const aliasesDir =
        process.env['DHEE_WORKFLOW_ALIASES_DIR'] ??
        pathResolve(process.env['HOME'] ?? '', '.dhee', 'workflow-aliases');
      const aliasEndpoint = baseUrl ?? process.env['COMFYUI_BASE_URL'] ?? 'unknown';
      const aliases = readAliases(aliasesDir, aliasEndpoint);
      if (
        (aliases.name_aliases && Object.keys(aliases.name_aliases).length > 0) ||
        (aliases.class_swaps && Object.keys(aliases.class_swaps).length > 0)
      ) {
        const workflowKey = cfg.workflowPath.split('/').slice(-2).join('/');
        workflow = applyAliases(workflow as never, { workflowKey, aliases }) as never;
        ctx.log(
          `comfy.image: applied aliases for endpoint=${aliasEndpoint} workflow=${workflowKey}`,
        );
      }
    } catch (e) {
      ctx.log(`comfy.image: alias load skipped (${(e as Error).message})`);
    }

    // ── Build the client ──
    const outDir = dirname(outAbs);
    mkdirSync(outDir, { recursive: true });
    const client = clientFactory({
      ...(baseUrl ? { baseUrl } : {}),
      outputDir: outDir,
    });

    // ── Upload base + refs ──
    if (cfg.baseImage && !existsSync(cfg.baseImage)) {
      return { ok: false, error: `comfy.image: baseImage not found on disk: ${cfg.baseImage}` };
    }
    if (cfg.referenceImages) {
      for (const r of cfg.referenceImages) {
        if (!existsSync(r)) {
          return { ok: false, error: `comfy.image: referenceImage not found on disk: ${r}` };
        }
      }
    }

    // FL2V additional uploads: first_frame + last_frame. These are
    // separate from base_image / referenceImages because the FL2V
    // workflow's manifest declares them as named inputs.
    // Tunnel-flakiness-aware upload: 3 retries on 502/504/ECONNRESET
    // etc. before treating as terminal. Permanent errors (4xx, malformed
    // workflow) still bubble immediately.
    const uploadWithRetry = (path: string) =>
      retryTransient(() => client.uploadImage(path), {
        signal: ctx.signal,
        log: ctx.log,
        label: `comfy.image upload ${basename(path)}`,
      });

    let fl2vFirstUploaded: { name: string } | undefined;
    let fl2vLastUploaded: { name: string } | undefined;
    const fl2vFirstPath = (cfgWithUpstream['_fl2v_first_frame'] as string | undefined);
    const fl2vLastPath = (cfgWithUpstream['_fl2v_last_frame'] as string | undefined);
    if (fl2vFirstPath && existsSync(fl2vFirstPath)) {
      try {
        fl2vFirstUploaded = await uploadWithRetry(fl2vFirstPath);
      } catch (err) {
        return { ok: false, error: `comfy.image: FL2V first_frame upload failed for ${fl2vFirstPath}: ${(err as Error).message}` };
      }
    }
    if (fl2vLastPath && existsSync(fl2vLastPath)) {
      try {
        fl2vLastUploaded = await uploadWithRetry(fl2vLastPath);
      } catch (err) {
        return { ok: false, error: `comfy.image: FL2V last_frame upload failed for ${fl2vLastPath}: ${(err as Error).message}` };
      }
    }

    let baseUploaded: { name: string } | undefined;
    if (cfg.baseImage) {
      try {
        baseUploaded = await uploadWithRetry(cfg.baseImage);
      } catch (err) {
        return {
          ok: false,
          error: `comfy.image: upload failed for ${cfg.baseImage}: ${(err as Error).message}`,
        };
      }
    }
    const refUploaded: Array<{ name: string }> = [];
    if (cfg.referenceImages) {
      for (const r of cfg.referenceImages) {
        if (ctx.signal?.aborted) {
          return { ok: false, error: 'comfy.image: aborted during upload' };
        }
        try {
          refUploaded.push(await uploadWithRetry(r));
        } catch (err) {
          return {
            ok: false,
            error: `comfy.image: upload failed for ${r}: ${(err as Error).message}`,
          };
        }
      }
    }

    // ── Apply mappings ──
    // Build the value source from cfg fields + uploaded names + defaults.
    const valueMap: Record<string, unknown> = {
      ...cfg, // pass-through for arbitrary fields the bundle author mapped
      seed: cfg.seed ?? Math.floor(Math.random() * 0x7fffffff),
      filenamePrefix: `dag/${ctx.node.id}_${Date.now()}`,
    };
    if (baseUploaded) valueMap['base_image'] = baseUploaded.name;
    for (let i = 0; i < refUploaded.length; i++) {
      valueMap[`reference_image_${i + 1}`] = refUploaded[i]!.name;
    }
    if (fl2vFirstUploaded) valueMap['first_frame'] = fl2vFirstUploaded.name;
    if (fl2vLastUploaded) valueMap['last_frame'] = fl2vLastUploaded.name;
    // FL2V durationSeconds — derive from motion directive's shot
    // duration if the bundle node's config didn't supply it. Default 3s.
    if (valueMap['durationSeconds'] === undefined) {
      valueMap['durationSeconds'] = (cfg as { duration?: number }).duration ?? 3;
    }
    // Klein workflow has 4 LoadImage nodes (base + 3 refs); every
    // slot must point at a real uploaded file or Comfy rejects with
    // ImageDownloadError before the prompt even queues. When the
    // bundle supplied fewer than 4 images, fill unused slots with the
    // first available image (typically the base). This is a Klein
    // structural requirement, not a creative choice — those slots
    // affect generation per their LoRA weights, but using the base
    // image is the closest to "no extra conditioning" we can do
    // without restructuring the workflow.
    const fallback =
      (valueMap['base_image'] as string | undefined) ??
      (refUploaded[0]?.name);
    if (fallback) {
      for (let i = 1; i <= KLEIN_MAX_REFS - 1; i++) {
        const key = `reference_image_${i}`;
        if (!valueMap[key]) valueMap[key] = fallback;
      }
      if (!valueMap['base_image']) valueMap['base_image'] = fallback;
    }

    for (const m of mappings) {
      if (!(m.input in valueMap)) continue; // optional input not provided → skip
      const ap = applyMapping(workflow, m, valueMap[m.input]);
      if (!ap.ok) return { ok: false, error: ap.error };
    }

    // ── Queue + await ──
    if (ctx.signal?.aborted) {
      return { ok: false, error: 'comfy.image: aborted before queue' };
    }
    let queueResult: { outputs: Array<{ filename: string; subfolder?: string }> };
    try {
      queueResult = await retryTransient(() => client.queueAndWait(workflow, ctx.signal), {
        signal: ctx.signal,
        log: ctx.log,
        label: 'comfy.image queue',
      });
    } catch (err) {
      return { ok: false, error: `comfy.image: ${(err as Error).message}` };
    }
    if (!queueResult.outputs || queueResult.outputs.length === 0) {
      return { ok: false, error: 'comfy.image: Comfy returned no outputs (workflow may have failed silently).' };
    }

    // ── Download first image output ──
    const imageOut = queueResult.outputs.find((o) => /\.(png|jpg|jpeg|webp|mp4|webm|mov)$/i.test(o.filename))
      ?? queueResult.outputs[0]!;
    try {
      await retryTransient(() => client.downloadOutput(imageOut.filename, imageOut.subfolder, outAbs), {
        signal: ctx.signal,
        log: ctx.log,
        label: `comfy.image download ${imageOut.filename}`,
      });
    } catch (err) {
      return { ok: false, error: `comfy.image: download failed: ${(err as Error).message}` };
    }
    if (!existsSync(outAbs)) {
      return { ok: false, error: `comfy.image: download reported success but ${outAbs} does not exist on disk` };
    }

    ctx.log(`comfy.image: wrote ${cfg.outputPath}`);

    // Best-effort: stamp the rendered output into CAS so future runs
    // (cross-project, cross-branch) can replay without re-rendering.
    let inputsHashForEvent: string | undefined;
    if (!casDisabled) {
      try {
        const cache = openGenerationCache(
          process.env['DHEE_CACHE_ROOT'] ? { cacheRoot: process.env['DHEE_CACHE_ROOT'] } : undefined,
        );
        const ext = (extname(cfg.outputPath).slice(1) || 'png');
        const put = cache.put({
          key: cacheKey,
          sourcePath: outAbs,
          ext,
          metadata: { comfyOutput: imageOut.filename, bytes: statSync(outAbs).size },
        });
        inputsHashForEvent = put.hash;
      } catch {
        // best-effort
      }
    }

    // Stamp the precise dep list when the resolved prompt has a
    // `references[]` field — only what we actually consumed gets
    // recorded on node.completed.dependencies. Other char/setting
    // items the walker exposed via scope='all' are NOT in this list,
    // so cascade-invalidation stays surgical.
    const preciseDeps = extractedPrompt
      ? extractShotReferences({ promptItemId: ctx.itemId ?? '', prompt: extractedPrompt })
      : null;

    return {
      ok: true,
      outputPath: cfg.outputPath,
      metadata: {
        comfyOutput: imageOut.filename,
        cached: false,
        ...(inputsHashForEvent ? { inputsHash: inputsHashForEvent } : {}),
        ...(preciseDeps ? { dependencies: preciseDeps } : {}),
      },
    };
  }

  return { describe, run };
}

/** Default singleton — what the registry registers. */
export const comfyImageRunner = createComfyImageRunner();
