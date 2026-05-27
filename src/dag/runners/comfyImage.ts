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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import { ComfyUIClient } from '../../services/comfyui/ComfyUIClient.js';

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

function resolveEndpointUrl(endpointName: string): string | null {
  const envKey = `ENDPOINT_${endpointName.replace(/\./g, '_')}`;
  const url = process.env[envKey];
  return url && url.trim().length > 0 ? url.trim() : null;
}

// ── Default client factory (uses ComfyUIClient) ────────────────────────

function defaultClientFactory(opts: { baseUrl?: string; outputDir: string }): ComfyImageClient {
  const client = new ComfyUIClient({
    outputDir: opts.outputDir,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });
  return {
    async uploadImage(filePath) {
      const r = await client.uploadImage(filePath, 'input', true);
      return { name: r.name };
    },
    async queueAndWait(workflow, signal) {
      const { outputs } = await client.queueAndWaitWS(
        workflow,
        undefined,
        signal ? { signal } : {},
      );
      return {
        outputs: outputs.map((o) => ({
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

    const v = validateConfig(ctx.node.runner.config);
    if (!v.ok) return { ok: false, error: v.error };
    const cfg = v.cfg;

    // ── Cache hit? ──
    const outAbs = resolve(ctx.projectDir, cfg.outputPath);
    if (!cfg.forceRerun && existsSync(outAbs)) {
      try {
        if (statSync(outAbs).size > 0) {
          ctx.log(`comfy.image: cached → ${cfg.outputPath}`);
          return { ok: true, outputPath: cfg.outputPath, metadata: { cached: true } };
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
    const workflow = JSON.parse(readFileSync(workflowAbs, 'utf-8')) as Record<
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

    let baseUploaded: { name: string } | undefined;
    if (cfg.baseImage) {
      try {
        baseUploaded = await client.uploadImage(cfg.baseImage);
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
          refUploaded.push(await client.uploadImage(r));
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
      queueResult = await client.queueAndWait(workflow, ctx.signal);
    } catch (err) {
      return { ok: false, error: `comfy.image: ${(err as Error).message}` };
    }
    if (!queueResult.outputs || queueResult.outputs.length === 0) {
      return { ok: false, error: 'comfy.image: Comfy returned no outputs (workflow may have failed silently).' };
    }

    // ── Download first image output ──
    const imageOut = queueResult.outputs.find((o) => /\.(png|jpg|jpeg|webp)$/i.test(o.filename))
      ?? queueResult.outputs[0]!;
    try {
      await client.downloadOutput(imageOut.filename, imageOut.subfolder, outAbs);
    } catch (err) {
      return { ok: false, error: `comfy.image: download failed: ${(err as Error).message}` };
    }
    if (!existsSync(outAbs)) {
      return { ok: false, error: `comfy.image: download reported success but ${outAbs} does not exist on disk` };
    }

    ctx.log(`comfy.image: wrote ${cfg.outputPath}`);
    return {
      ok: true,
      outputPath: cfg.outputPath,
      metadata: { comfyOutput: imageOut.filename },
    };
  }

  return { describe, run };
}

/** Default singleton — what the registry registers. */
export const comfyImageRunner = createComfyImageRunner();
