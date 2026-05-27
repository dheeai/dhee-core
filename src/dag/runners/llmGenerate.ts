/**
 * `llm.generate` runner — the universal LLM-call runner for bundle
 * pipelines. Replaces the executor's per-typeId LLM handlers
 * (`generatePlot`, `generateStory`, `generateCharacter`, …) with one
 * runner driven entirely by config + prompt-template files.
 *
 * Responsibilities:
 *   - Load prompt template from `<bundleDir>/<config.promptTemplate>`.
 *   - Substitute `{{var_name}}` against `ctx.inputs` — surface missing
 *     vars at substitution time (cheap, deterministic) rather than
 *     letting the LLM call burn tokens on a broken prompt.
 *   - Call an LLM via the tier (heavy/medium/light) the bundle declares.
 *   - Validate output: optionally JSON-parse + schema-validate.
 *   - Write the result to `<projectDir>/<config.outputPath>` atomically.
 *
 * Skip-if-output-exists: if `<projectDir>/<outputPath>` exists AND has
 * non-zero size, return that path without calling the LLM (cache hit).
 * `forceRerun: true` overrides this. Zero-byte files count as missing
 * (probably a crashed prior run).
 *
 * Retry: on transient failure (network, timeout, transient LLM error),
 * retry up to `maxRetries` times with exponential backoff. AbortSignal
 * cancellation skips remaining retries.
 *
 * Testability: the LLM client is injected via `clientFactory` so unit
 * tests stub it. The default factory uses the project's `LLMRouter`
 * with a tier→purpose mapping (because the router's public API takes
 * purposes, not raw tiers).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
// ajv / ajv-formats ESM<>CJS interop: verbatimModuleSyntax preserves
// the default import shape, but ajv's CJS exports the constructor
// directly. The `* as` form lets us reach `.default` defensively.
import * as ajvNs from 'ajv';
import * as ajvFormatsNs from 'ajv-formats';
import type { Runner, RunnerContext, RunnerResult, RunnerDescription } from '../schema.js';
import type { LLMPurpose, LLMTier } from '../../core/llm/purposes.js';
import { LLMRouter } from '../../core/llm/router.js';

// Pull the actual constructor from whichever export shape ajv ships.
type AjvInstance = { compile: (schema: unknown) => (data: unknown) => boolean; errors?: Array<{ instancePath?: string; message?: string }> | null };
type AjvCtor = new (opts?: Record<string, unknown>) => AjvInstance;
type AddFormatsFn = (ajv: AjvInstance) => void;
const Ajv: AjvCtor = ((ajvNs as unknown as { default?: AjvCtor }).default ?? (ajvNs as unknown as AjvCtor));
const addFormats: AddFormatsFn = ((ajvFormatsNs as unknown as { default?: AddFormatsFn }).default ?? (ajvFormatsNs as unknown as AddFormatsFn));

// ── Config shape (validated at runtime) ────────────────────────────────

const VALID_TIERS: readonly LLMTier[] = ['heavy', 'medium', 'light'] as const;

export interface LlmGenerateConfig {
  /** Path to the prompt template, relative to the bundle directory. */
  promptTemplate: string;
  /** Path to write the result, relative to the project directory. */
  outputPath: string;
  /** LLM tier (heavy/medium/light). One of `tier` or `purpose` is required. */
  tier?: LLMTier;
  /**
   * Explicit purpose for fine-grained routing. Wins over `tier` when
   * both supplied. Mainly useful for power-users who want per-call
   * overrides via .env (LLM__PURPOSE__... vars).
   */
  purpose?: LLMPurpose;
  /** 'markdown' (default) — raw text; 'json' — parse + optionally validate. */
  outputFormat?: 'markdown' | 'json';
  /** Path to a JSON Schema (relative to bundle dir) for json output. */
  outputSchema?: string;
  /** Max retry attempts on transient failure. Default 2 (i.e. 3 total attempts). */
  maxRetries?: number;
  /** Re-render even if outputPath exists. Default false. */
  forceRerun?: boolean;
  /** Override the LLM's max tokens. Optional; default is the model's. */
  maxTokens?: number;
  /** Sampling temperature. Default 0.7. */
  temperature?: number;
}

// ── DI: client factory ─────────────────────────────────────────────────

/** Minimal client interface the runner needs. Allows stubbing in tests. */
export interface LlmGenerateClient {
  generate(opts: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    signal?: AbortSignal;
    responseFormat?: { type: 'json_object' };
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content?: string }>;
  getModel(): string;
}

export type LlmClientFactory = (tier: LLMTier, purpose?: LLMPurpose) => LlmGenerateClient;

/**
 * Default client factory: route via LLMRouter using a representative
 * purpose for each tier. Bundles that want fine-grained routing can
 * declare `purpose:` explicitly instead of `tier:`.
 */
const TIER_REPRESENTATIVE_PURPOSE: Record<LLMTier, LLMPurpose> = {
  heavy: 'content.story',
  medium: 'structured.scene_breakdown',
  light: 'utility.image_review',
};

function defaultClientFactory(tier: LLMTier, purpose?: LLMPurpose): LlmGenerateClient {
  // LLMRouter requires routing config; pass {} for env-driven defaults.
  const router = new LLMRouter({});
  const eff = purpose ?? TIER_REPRESENTATIVE_PURPOSE[tier];
  const client = router.getClient(eff);
  return {
    async generate(opts) {
      // LLMClient supports responseFormat: { type: 'json_object' } but
      // not { type: 'text' } — for text format we just omit it.
      const passResponseFormat =
        opts.responseFormat && opts.responseFormat.type === 'json_object'
          ? { responseFormat: { type: 'json_object' as const } }
          : {};
      const resp = await client.generate({
        messages: opts.messages,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...passResponseFormat,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
      // LLMResponse.content is string | null; normalize to string | undefined.
      return { content: resp.content ?? undefined };
    },
    getModel: () => client.getModel(),
  };
}

// ── Config validation ──────────────────────────────────────────────────

function validateConfig(raw: unknown): { ok: true; cfg: LlmGenerateConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'llm.generate: config must be an object' };
  }
  const cfg = raw as Partial<LlmGenerateConfig>;
  if (!cfg.promptTemplate || typeof cfg.promptTemplate !== 'string') {
    return { ok: false, error: "llm.generate: missing required config field 'promptTemplate'" };
  }
  if (!cfg.outputPath || typeof cfg.outputPath !== 'string') {
    return { ok: false, error: "llm.generate: missing required config field 'outputPath'" };
  }
  if (!cfg.tier && !cfg.purpose) {
    return { ok: false, error: "llm.generate: one of 'tier' or 'purpose' must be supplied" };
  }
  if (cfg.tier && !(VALID_TIERS as readonly string[]).includes(cfg.tier)) {
    return {
      ok: false,
      error: `llm.generate: tier '${cfg.tier}' is not valid. Expected one of: ${VALID_TIERS.join(', ')}.`,
    };
  }
  const fmt = cfg.outputFormat ?? 'markdown';
  if (fmt !== 'markdown' && fmt !== 'json') {
    return { ok: false, error: `llm.generate: outputFormat '${fmt}' is not valid (expected 'markdown' or 'json').` };
  }
  return { ok: true, cfg: cfg as LlmGenerateConfig };
}

// ── Template substitution ──────────────────────────────────────────────

const TEMPLATE_VAR_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

/**
 * Substitute `{{var_name}}` placeholders in `template` against `vars`.
 * Fails fast when a placeholder references a key not in `vars` — better
 * to surface "missing variable: audience" at the bundle/walker layer
 * than send an incomplete prompt to the LLM.
 */
function substituteTemplate(
  template: string,
  vars: Record<string, unknown>,
): { ok: true; rendered: string } | { ok: false; error: string } {
  const missing = new Set<string>();
  const rendered = template.replace(TEMPLATE_VAR_RE, (_, name: string) => {
    if (!(name in vars)) {
      missing.add(name);
      return ''; // placeholder; we'll reject below
    }
    const v = vars[name];
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
  if (missing.size > 0) {
    return {
      ok: false,
      error:
        `llm.generate: prompt template references variable(s) that were not provided: ` +
        `${[...missing].join(', ')}. ` +
        `Make sure the bundle's node.inputs[] declare every variable the template uses.`,
    };
  }
  return { ok: true, rendered };
}

// ── JSON parsing & validation ──────────────────────────────────────────

function tryParseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  // Light repair: trim, strip code fences, strip trailing commas.
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (err) {
    return {
      ok: false,
      error: `LLM returned malformed JSON. Parse error: ${(err as Error).message}. Raw output: ${raw}`,
    };
  }
}

function validateAgainstSchema(value: unknown, schemaPath: string): { ok: true } | { ok: false; error: string } {
  let schema: unknown;
  try {
    schema = JSON.parse(readFileSync(schemaPath, 'utf-8'));
  } catch (err) {
    return { ok: false, error: `Failed to load JSON schema at ${schemaPath}: ${(err as Error).message}` };
  }
  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  const validate = ajv.compile(schema as Record<string, unknown>) as ((data: unknown) => boolean) & {
    errors?: Array<{ instancePath?: string; message?: string }> | null;
  };
  if (validate(value)) return { ok: true };
  const errs = (validate.errors ?? ajv.errors ?? [])
    .map((e: { instancePath?: string; message?: string }) =>
      `${e.instancePath || '<root>'} ${e.message ?? 'invalid'}`,
    )
    .join('; ');
  return { ok: false, error: `Schema validation failed: ${errs}` };
}

// ── The runner factory ─────────────────────────────────────────────────

export function createLlmGenerateRunner(opts?: {
  clientFactory?: LlmClientFactory;
}): Runner {
  const clientFactory = opts?.clientFactory ?? defaultClientFactory;

  const describe = (): RunnerDescription => ({
    id: 'llm.generate',
    displayName: 'LLM Generate',
    description: 'Universal LLM runner. Renders a prompt template against ctx.inputs, calls the routed LLM, optionally JSON-parses and schema-validates, and writes the result.',
    capabilities: ['text-generation', 'json-generation', 'schema-validated-json'],
    modalities: { input: ['text'], output: ['text'] },
    configSchema: {
      type: 'object',
      required: ['promptTemplate', 'outputPath'],
      properties: {
        promptTemplate: { type: 'string' },
        outputPath:     { type: 'string' },
        tier:           { type: 'string', enum: ['heavy', 'medium', 'light'] },
        purpose:        { type: 'string' },
        outputFormat:   { type: 'string', enum: ['markdown', 'json'] },
        outputSchema:   { type: 'string' },
        maxRetries:     { type: 'integer', minimum: 0 },
        forceRerun:     { type: 'boolean' },
        maxTokens:      { type: 'integer', minimum: 1 },
        temperature:    { type: 'number' },
      },
    },
  });

  async function run(ctx: RunnerContext): Promise<RunnerResult> {
    // 1. Validate config.
    const v = validateConfig(ctx.node.runner.config);
    if (!v.ok) return { ok: false, error: v.error };
    const cfg = v.cfg;

    if (!ctx.bundleDir) {
      return {
        ok: false,
        error: 'llm.generate requires ctx.bundleDir to resolve promptTemplate path. ' +
          'The walker must populate ctx.bundleDir.',
      };
    }

    // 2. Skip-if-output-exists (cache hit).
    const outAbs = resolve(ctx.projectDir, cfg.outputPath);
    if (!cfg.forceRerun && existsSync(outAbs)) {
      try {
        const st = statSync(outAbs);
        if (st.isFile() && st.size > 0) {
          ctx.log(`llm.generate: cached → ${cfg.outputPath}`);
          return { ok: true, outputPath: cfg.outputPath, metadata: { cached: true } };
        }
      } catch {
        // Fall through to re-render.
      }
    }

    // 3. Load + render prompt template.
    const tmplAbs = resolve(ctx.bundleDir, cfg.promptTemplate);
    if (!existsSync(tmplAbs)) {
      return {
        ok: false,
        error: `llm.generate: prompt template not found at ${tmplAbs} (declared as '${cfg.promptTemplate}' in node config).`,
      };
    }
    const template = readFileSync(tmplAbs, 'utf-8');
    const sub = substituteTemplate(template, ctx.inputs);
    if (!sub.ok) return { ok: false, error: sub.error };

    // 4. Call LLM (with retries + abort).
    const tier: LLMTier = cfg.tier ?? 'medium';
    let client: LlmGenerateClient;
    try {
      client = clientFactory(tier, cfg.purpose);
    } catch (err) {
      return { ok: false, error: `llm.generate: failed to construct LLM client: ${(err as Error).message}` };
    }

    const maxRetries = cfg.maxRetries ?? 2;
    const isJson = (cfg.outputFormat ?? 'markdown') === 'json';
    let lastErr: string | undefined;
    let content: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (ctx.signal?.aborted) {
        return { ok: false, error: 'llm.generate: aborted before LLM call' };
      }
      try {
        const resp = await client.generate({
          messages: [{ role: 'user', content: sub.rendered }],
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(isJson ? { responseFormat: { type: 'json_object' as const } } : {}),
          ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
          ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
        });
        const got = resp.content ?? '';
        if (!got || got.trim() === '') {
          lastErr = 'LLM returned empty response (no content).';
          // Empty response is not retried — the model returning empty is
          // a content/prompt issue, not a transient network failure.
          break;
        }
        content = got;
        break;
      } catch (err) {
        lastErr = (err as Error).message;
        if (ctx.signal?.aborted) {
          return { ok: false, error: `llm.generate: aborted (${lastErr})` };
        }
        if (attempt < maxRetries) {
          const backoffMs = 250 * Math.pow(2, attempt);
          ctx.log(`llm.generate: attempt ${attempt + 1} failed (${lastErr}); retrying in ${backoffMs}ms`);
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }

    if (content === undefined) {
      return {
        ok: false,
        error: `llm.generate: all ${maxRetries + 1} attempts failed. Last error: ${lastErr}`,
      };
    }

    // 5. Format-specific handling.
    let toWrite = content;
    let parsedJson: unknown = undefined;
    if (isJson) {
      const parsed = tryParseJson(content);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      parsedJson = parsed.value;
      if (cfg.outputSchema) {
        const schemaAbs = resolve(ctx.bundleDir, cfg.outputSchema);
        if (!existsSync(schemaAbs)) {
          return { ok: false, error: `llm.generate: outputSchema not found at ${schemaAbs}` };
        }
        const v = validateAgainstSchema(parsedJson, schemaAbs);
        if (!v.ok) return { ok: false, error: v.error };
      }
      toWrite = JSON.stringify(parsedJson, null, 2);
    }

    // 6. Write atomically (mkdir first, then write).
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, toWrite, 'utf-8');
    ctx.log(`llm.generate: wrote ${cfg.outputPath} (${toWrite.length} bytes)`);

    return {
      ok: true,
      outputPath: cfg.outputPath,
      metadata: { model: client.getModel(), bytes: toWrite.length },
    };
  }

  return { describe, run };
}

/** Default singleton — what the registry registers. */
export const llmGenerateRunner = createLlmGenerateRunner();
