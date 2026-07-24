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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { openGenerationCache } from '../cas/GenerationCache.js';
import type { InputsHashKey } from '../cas/inputsHash.js';
import { getProjectCacheScope } from '../projectIdentity.js';
// ajv / ajv-formats ESM<>CJS interop: verbatimModuleSyntax preserves
// the default import shape, but ajv's CJS exports the constructor
// directly. The `* as` form lets us reach `.default` defensively.
import * as ajvNs from 'ajv';
import * as ajvFormatsNs from 'ajv-formats';
import type { Runner, RunnerContext, RunnerResult, RunnerDescription } from '../schema.js';
import type { LLMPurpose, LLMTier } from '../../core/llm/purposes.js';
import { LLMRouter, loadRoutingFromEnv, isRoutingEnabledFromEnv } from '../../core/llm/router.js';
import { getLLMConfig } from '../../core/llm/config.js';
import { recordLlmUsage } from '../../core/llm/usageTelemetry.js';
import {
  buildShotMotionContext,
  type MotionContextDependency,
  type MotionContextShotPlanShot,
} from './shotMotionContext.js';

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
  /**
   * Derived template variables built by the runner from project artifacts.
   * Keeps bundle prompts declarative without teaching the walker about a
   * specific prompt's context shape.
   */
  derivedInputs?: LlmGenerateDerivedInput[];
  /**
   * When true, deterministically (re)assign scene + shot ids on the
   * parsed JSON output BEFORE schema validation. Use on scene/shot
   * breakdown nodes whose schema requires `scene_N_shot_M` shot ids:
   * the id is a pure function of (scene number, shot order within the
   * scene), so the LLM should not be the source of truth for it — weak
   * models drift on the exact string (global counters, sub-shot letters
   * like "shot_15a") and then fail validation in a retry loop forever.
   * We reconstruct the canonical ids here so the contract is satisfied
   * by construction. No-op for output with no top-level `shots` array.
   */
  normalizeShotIds?: boolean;
  /**
   * When true, coerce common near-miss shapes on `beats[].startState` and
   * `beats[].carryToNext` BEFORE schema validation. Motivated by a real
   * failure: deepseek-v4-flash reliably emits `startState` as a single
   * object (or an object with string values) instead of an array of
   * `{ actor: ... }` refs, and `carryToNext` items as objects (e.g.
   * `{ text: "..." }`) instead of plain strings — failing strict schema
   * validation on all retries even after the prompt shows the correct
   * shape. This is a narrow, field-scoped backstop (not a schema
   * weakening): it only reshapes data that is unambiguously the same
   * near-miss pattern, it never invents content, and a beat with no
   * recoverable actor/string is left as-is so the schema still rejects
   * genuine garbage. No-op unless `value` has a top-level `beats` array.
   */
  normalizeVisualScreenplayBeats?: boolean;
  /**
   * How to request structured JSON output from the provider.
   *  - 'object' (default): always send `{type:'json_object'}` — the
   *    legacy behavior, regardless of whether outputSchema is set. ajv
   *    post-validation + the retry-with-feedback loop still run either
   *    way. A node must explicitly opt in (below) to get json_schema.
   *  - 'schema' (opt-in): when `outputSchema` is set, send it as
   *    `response_format:{type:'json_schema', json_schema:{...}}` so
   *    providers that support grammar-constrained decoding (llama.cpp
   *    GBNF, OpenAI structured outputs) can guarantee schema-conforming
   *    output. Falls back to `json_object` when the provider 4xxs on
   *    json_schema (see the module-level fallback cache below).
   *  - 'auto' (opt-in, alias of 'schema'): same behavior — schema sent
   *    whenever outputSchema is set — spelled out for bundle authors
   *    who want to name the semantics rather than the mechanism.
   */
  structuredMode?: 'schema' | 'object' | 'auto';
  /**
   * OpenAI-style `strict` flag on the json_schema response_format.
   * Default `false`: our schemas commonly have OPTIONAL (non-required)
   * fields, and `strict:true` formally requires every property to be
   * `required` + `additionalProperties:false` — providers that actually
   * enforce that (e.g. OpenRouter/deepseek) would reject an optional-
   * field schema on every call. llama.cpp's GBNF grammar constraint was
   * empirically permissive either way (probed against g4-meromero-192k),
   * so `false` is the safe default across both kinds of backend.
   */
  structuredStrict?: boolean;
}

/**
 * Per-client (baseUrl|model) memory of "this provider 4xx'd on
 * response_format:json_schema" — set after the first rejection, read
 * before every subsequent call so we don't keep paying for a doomed
 * json_schema attempt against a provider that has already told us it
 * doesn't support structured outputs.
 */
const structuredOutputUnsupportedCache = new Map<string, boolean>();

/** Test-only: clear the module-level structured-output fallback cache. */
export function __resetStructuredOutputFallbackCacheForTesting(): void {
  structuredOutputUnsupportedCache.clear();
}

/**
 * Sanitize a string down to the character set OpenAI-style
 * `json_schema.name` fields require (`^[a-zA-Z0-9_-]+$`-ish): safe
 * for llama.cpp/OpenRouter too since it's a strict subset.
 */
function slugify(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

/** Derive the json_schema `name` from the node id, falling back to outputPath. */
function deriveSchemaName(nodeId: string, outputPath: string): string {
  return slugify(nodeId) || slugify(outputPath) || 'output_schema';
}

type LlmResponseFormat =
  | { type: 'json_object' }
  | { type: 'json_schema'; json_schema: { name: string; strict?: boolean; schema: Record<string, unknown> } };

/**
 * Extract an HTTP status code from a thrown error, however deeply it's
 * wrapped (LLMClient's formatOperationError wraps the original error in
 * `.cause`; the OpenAI SDK's APIError exposes `.status`/`.statusCode`
 * directly on whichever layer threw).
 */
function extractHttpStatus(err: unknown, depth = 0): number | undefined {
  if (!err || typeof err !== 'object' || depth > 5) return undefined;
  const anyErr = err as { status?: unknown; statusCode?: unknown; cause?: unknown };
  if (typeof anyErr.status === 'number') return anyErr.status;
  if (typeof anyErr.statusCode === 'number') return anyErr.statusCode;
  if (anyErr.cause) return extractHttpStatus(anyErr.cause, depth + 1);
  return undefined;
}

/**
 * Is `err` a provider rejection of `response_format:json_schema`
 * specifically (as opposed to an unrelated 4xx like a bad API key or
 * rate limit)? Requires BOTH a 4xx status AND the message naming
 * response_format/json_schema/structured output — either signal alone
 * is too weak (a 4xx auth error shouldn't trigger a silent format
 * downgrade; a message mentioning "schema" in an unrelated validation
 * error shouldn't either).
 */
function isStructuredOutputUnsupportedError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  const mentionsStructuredOutput = /response_format|json_schema|structured\s*output/i.test(message);
  if (!mentionsStructuredOutput) return false;
  const status = extractHttpStatus(err);
  if (status !== undefined) return status >= 400 && status < 500;
  // No explicit status field (e.g. a plain Error from a test stub or a
  // minimal client) — fall back to sniffing a 4xx code in the message.
  return /\b4\d\d\b/.test(message);
}

export interface LlmGenerateDerivedInput {
  id: string;
  kind: 'shot_motion_context';
  /** ctx.inputs key containing { shots: [...] }. Default: scenes_plan. */
  shotsInput?: string;
  /** Project-relative pattern for per-shot image prompt JSON. */
  imagePromptPattern?: string;
  /** Project-relative pattern for per-shot motion directive JSON. */
  motionDirectivePattern?: string;
}

// ── DI: client factory ─────────────────────────────────────────────────

/** Usage as the runner records it for telemetry (issue #102 fix #0). */
export interface LlmGenerateUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost?: number;
  cachedPromptTokens?: number;
  cacheDiscount?: number;
}

/** Minimal client interface the runner needs. Allows stubbing in tests. */
export interface LlmGenerateClient {
  generate(opts: {
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
    signal?: AbortSignal;
    responseFormat?: LlmResponseFormat;
    temperature?: number;
    maxTokens?: number;
  }): Promise<{ content?: string; usage?: LlmGenerateUsage }>;
  getModel(): string;
  /**
   * Optional: the endpoint this client talks to. Used (with getModel())
   * to key the structured-output-unsupported fallback cache so the
   * decision is per (baseUrl, model), not global. Clients that omit it
   * (legacy test stubs) just key on model alone.
   */
  getBaseUrl?(): string;
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
  // Read env-based default LLM config (LLM_PROVIDER + per-provider vars).
  // Without this, the router uses hardcoded LM Studio defaults which
  // require a local server running.
  const envDefault = getLLMConfig();
  // Honor LLM_ROUTING_ENABLED + LLM_TIER_*_MODEL env so bundles using
  // `tier: 'heavy'` actually route to LLM_TIER_HEAVY_MODEL rather than
  // falling back to OPENAI_MODEL. Without this, OPENAI_MODEL leaks
  // through (e.g. a deprecated model) and overrides per-tier choices.
  const routing = loadRoutingFromEnv();
  const enabled = isRoutingEnabledFromEnv();
  const router = new LLMRouter(envDefault, routing, enabled);
  const eff = purpose ?? TIER_REPRESENTATIVE_PURPOSE[tier];
  const client = router.getClient(eff);
  return {
    async generate(opts) {
      // LLMClient supports both responseFormat shapes (json_object AND
      // json_schema — see GenerateOptions in core/llm/types.ts) but not
      // { type: 'text' } — for text format we just omit it.
      const passResponseFormat = opts.responseFormat
        ? { responseFormat: opts.responseFormat }
        : {};
      const resp = await client.generate({
        messages: opts.messages,
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...passResponseFormat,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
      });
      // LLMResponse.content is string | null; normalize to string | undefined.
      // Pass usage through so the runner can record per-call telemetry.
      return { content: resp.content ?? undefined, usage: resp.usage };
    },
    getModel: () => client.getModel(),
    getBaseUrl: () => client.getConnectionInfo().baseUrl,
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

/**
 * Cache-breakpoint marker. When a prompt template contains this token,
 * the runner splits the RENDERED prompt into a stable `system` prefix
 * (everything BEFORE the marker) and a per-item `user` suffix (everything
 * AFTER it). The marker itself is stripped from what's sent to the model.
 *
 * Why: collection nodes (shot_image_prompt, shot_motion_directive,
 * character_image, setting_image, scene_video_prompt, …) fan out into
 * many successive LLM calls that share a large INVARIANT context — the
 * full scenes_plan / characters_plan / settings_plan, the world style,
 * the instructions and output schema — and differ only by a tiny per-item
 * selector (`{{item_id}}`). By making that invariant block the leading
 * `system` message, byte-identical across every item, the provider's
 * automatic prefix caching (DeepSeek / OpenRouter) reuses it across items
 * in a run, across runs, and across users hitting the same upstream. The
 * per-item delta is the only part that changes the request. See issue #102.
 *
 * Authoring rule: put ALL invariant content BEFORE the marker and ONLY
 * the per-item delta AFTER it. Templates without the marker are sent
 * unchanged as a single user message (fully backward compatible).
 */
export const CACHE_BREAKPOINT_MARKER = '<<<DHEE_CACHE_BREAKPOINT>>>';

/**
 * Split a rendered prompt at the cache breakpoint. Returns null (→ send
 * as a single user message) when the marker is absent or either side is
 * empty — a split only helps when there's real content on both sides.
 */
export function splitOnCacheBreakpoint(
  rendered: string,
): { prefix: string; suffix: string } | null {
  const idx = rendered.indexOf(CACHE_BREAKPOINT_MARKER);
  if (idx === -1) return null;
  const prefix = rendered.slice(0, idx).trimEnd();
  const suffix = rendered.slice(idx + CACHE_BREAKPOINT_MARKER.length).trimStart();
  if (!prefix || !suffix) return null;
  return { prefix, suffix };
}

function recordFromUnknown(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function applyDerivedInputs(
  ctx: RunnerContext,
  cfg: LlmGenerateConfig,
  vars: Record<string, unknown>,
): { ok: true; additionalDependencies: MotionContextDependency[] } | { ok: false; error: string } {
  const derivedInputs = cfg.derivedInputs ?? [];
  const additionalDependencies: MotionContextDependency[] = [];
  for (const derived of derivedInputs) {
    if (!derived.id || typeof derived.id !== 'string') {
      return { ok: false, error: 'llm.generate: derivedInputs entries require a string id' };
    }
    if (derived.kind !== 'shot_motion_context') {
      return { ok: false, error: `llm.generate: unsupported derived input kind '${String(derived.kind)}'` };
    }

    const shotsInput = derived.shotsInput ?? 'scenes_plan';
    const plan = recordFromUnknown(vars[shotsInput]);
    const rawShots = plan?.['shots'];
    const shots = Array.isArray(rawShots)
      ? (rawShots as MotionContextShotPlanShot[])
      : [];
    const built = buildShotMotionContext({
      projectDir: ctx.projectDir,
      ...(ctx.itemId !== undefined ? { itemId: ctx.itemId } : {}),
      shots,
      imagePromptPattern: derived.imagePromptPattern ?? 'prompts/shot_image/{{item_id}}.json',
      motionDirectivePattern: derived.motionDirectivePattern ?? 'prompts/motion/{{item_id}}.json',
    });
    vars[derived.id] = built.context;
    additionalDependencies.push(...built.additionalDependencies);
  }
  return { ok: true, additionalDependencies };
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
    // Tolerate trailing junk after an otherwise-complete value: some models repeat
    // their object, or leak a role token (e.g. "response") between duplicate copies.
    // JSON.parse reports the offset where the extra non-whitespace begins — re-parse
    // just the valid prefix so one clean object still succeeds.
    const m = /position (\d+)/.exec((err as Error).message);
    if (m) {
      try {
        return { ok: true, value: JSON.parse(s.slice(0, Number(m[1]))) };
      } catch {
        /* fall through to the error below */
      }
    }
    return {
      ok: false,
      error: `LLM returned malformed JSON. Parse error: ${(err as Error).message}. Raw output: ${raw}`,
    };
  }
}

/**
 * Validate `value` against an already-parsed JSON Schema object. Takes
 * the parsed schema (not a path) so the caller can load it ONCE and
 * reuse the same object both for ajv compilation here AND for the
 * `response_format.json_schema.schema` sent to the provider — the two
 * were previously divergent reads of the same file (ajv re-read it on
 * every retry attempt).
 */
function validateAgainstSchema(value: unknown, schema: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
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

/**
 * Deterministically (re)assign scene + shot ids for scene/shot
 * breakdown output, in place. The canonical shot id is
 * `scene_<sceneNum>_shot_<shotNumberWithinScene>` — a pure function of
 * data we already control — so the LLM is relieved of formatting it and
 * can no longer fail the id schema (weak models drift: global shot
 * counters, "shot_15a" sub-shot letters). Idempotent. No-op unless
 * `value` is an object with a top-level `shots` array.
 *
 * Scene membership per shot is read from the integer `scene` field (the
 * signal weak models DO get right), falling back to the `scene_N_`
 * prefix of any id the model emitted, then to carry-forward of the
 * previous shot's scene. `shotNumber` is (re)assigned purely by order
 * within each scene, so a mangled model value can't leak into the id.
 * Scene ids are renumbered `scene_1..N` by array order to match.
 */
export function normalizeSceneShotIds(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const obj = value as { scenes?: unknown; shots?: unknown };
  if (!Array.isArray(obj.shots)) return;

  // Scenes: canonical ids by array order (scene_1, scene_2, …).
  if (Array.isArray(obj.scenes)) {
    obj.scenes.forEach((sc, i) => {
      if (sc && typeof sc === 'object') {
        (sc as { id?: string }).id = `scene_${i + 1}`;
      }
    });
  }

  // Shots: per-scene order counter → shotNumber → id.
  const perScene = new Map<number, number>();
  let lastScene = 1;
  for (const raw of obj.shots) {
    if (!raw || typeof raw !== 'object') continue;
    const shot = raw as { id?: string; scene?: number; shotNumber?: number };
    let sceneNum: number;
    if (typeof shot.scene === 'number' && Number.isInteger(shot.scene) && shot.scene > 0) {
      sceneNum = shot.scene;
    } else {
      const m = String(shot.id ?? '').match(/^scene_(\d+)_shot_/);
      sceneNum = m ? parseInt(m[1]!, 10) : lastScene;
    }
    lastScene = sceneNum;
    const next = (perScene.get(sceneNum) ?? 0) + 1;
    perScene.set(sceneNum, next);
    shot.scene = sceneNum;
    shot.shotNumber = next;
    shot.id = `scene_${sceneNum}_shot_${next}`;
  }
}

/**
 * Coerce a single `startState`/`enters`/etc.-style actor ref into
 * `{ actor: string, ... }`. Handles the shapes deepseek-v4-flash actually
 * emits for a near-miss: a bare string (the actor id itself), or an
 * object missing `actor` but carrying an alias (`id`, `name`, `subject`).
 * Returns undefined when nothing recoverable is present (caller drops it,
 * leaving the array short rather than injecting a fabricated actor).
 */
function coerceActorRef(item: unknown): Record<string, unknown> | undefined {
  if (typeof item === 'string') {
    const s = item.trim();
    return s ? { actor: s } : undefined;
  }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const obj = item as Record<string, unknown>;
  if (typeof obj['actor'] === 'string' && obj['actor'].trim()) return obj;
  const alias = obj['id'] ?? obj['name'] ?? obj['subject'];
  if (typeof alias === 'string' && alias.trim()) return { ...obj, actor: alias };
  return undefined;
}

/** Coerce a single `carryToNext` entry down to a plain string. */
function coerceCarryString(item: unknown): string | undefined {
  if (typeof item === 'string') {
    const s = item.trim();
    return s || undefined;
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    const candidate = obj['text'] ?? obj['detail'] ?? obj['note'] ?? obj['carry'] ?? obj['description'];
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
  }
  return undefined;
}

/**
 * Reshape `beats[].startState` and `beats[].carryToNext` to the arrays the
 * schema requires, in place, BEFORE validation. See
 * `LlmGenerateConfig.normalizeVisualScreenplayBeats` for motivation.
 * No-op unless `value` is an object with a top-level `beats` array.
 */
export function normalizeVisualScreenplayBeats(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  const obj = value as { beats?: unknown };
  if (!Array.isArray(obj.beats)) return;

  for (const raw of obj.beats) {
    if (!raw || typeof raw !== 'object') continue;
    const beat = raw as { startState?: unknown; carryToNext?: unknown };

    if ('startState' in beat && !Array.isArray(beat.startState)) {
      const ss = beat.startState;
      const asArray = ss && typeof ss === 'object' && !Array.isArray(ss) ? Object.values(ss as Record<string, unknown>) : [ss];
      beat.startState = asArray.map(coerceActorRef).filter((v): v is Record<string, unknown> => v !== undefined);
    } else if (Array.isArray(beat.startState)) {
      beat.startState = beat.startState.map(coerceActorRef).filter((v): v is Record<string, unknown> => v !== undefined);
    }

    if ('carryToNext' in beat && !Array.isArray(beat.carryToNext)) {
      const ct = beat.carryToNext;
      const asArray = ct && typeof ct === 'object' && !Array.isArray(ct) ? Object.values(ct as Record<string, unknown>) : [ct];
      beat.carryToNext = asArray.map(coerceCarryString).filter((v): v is string => v !== undefined);
    } else if (Array.isArray(beat.carryToNext)) {
      beat.carryToNext = beat.carryToNext.map(coerceCarryString).filter((v): v is string => v !== undefined);
    }
  }
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
        derivedInputs:  { type: 'array' },
        normalizeShotIds: { type: 'boolean' },
        normalizeVisualScreenplayBeats: { type: 'boolean' },
        structuredMode:  { type: 'string', enum: ['schema', 'object', 'auto'] },
        structuredStrict: { type: 'boolean' },
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

    // Per-instance template vars: itemId is exposed as {{item_id}}.
    // Walker doesn't populate this in ctx.inputs but the runner has it
    // via ctx.itemId. Inject so prompts can address the specific
    // instance.
    const inputsWithItemId: Record<string, unknown> = { ...ctx.inputs };
    if (ctx.itemId !== undefined && inputsWithItemId['item_id'] === undefined) {
      inputsWithItemId['item_id'] = ctx.itemId;
    }
    const derived = applyDerivedInputs(ctx, cfg, inputsWithItemId);
    if (!derived.ok) return { ok: false, error: derived.error };
    const additionalDependencies = derived.additionalDependencies;

    // 2. Skip-if-output-exists (cache hit) — but only when no pending
    //    critique exists for this (node, item). When a critique is
    //    pending, the user explicitly wants a re-fire, so we must
    //    bypass the cache. Critique check is deferred to step 3b but
    //    we need its key here to gate cache reads.
    const outAbs = resolve(ctx.projectDir, cfg.outputPath);
    const critiqueKeyForCache = ctx.itemId
      ? `${ctx.node.id}:${ctx.itemId}`
      : ctx.node.id;
    const hasPendingCritique = (() => {
      try {
        const p = resolve(ctx.projectDir, 'project.json');
        if (!existsSync(p)) return false;
        const projJson = JSON.parse(readFileSync(p, 'utf-8')) as {
          pendingCritiques?: Record<string, string>;
        };
        return Boolean(projJson.pendingCritiques?.[critiqueKeyForCache]);
      } catch {
        return false;
      }
    })();
    // Path-based skip — ONLY trustworthy when CAS is disabled. With
    // CAS on, a file at outputPath may have been produced by a
    // different branch / project with different inputs; let the CAS
    // check below decide. The runtime gate is the same env var the
    // CAS lookup reads later in this function.
    const casDisabledForPathSkip = process.env['DHEE_DISABLE_CAS'] === '1';
    if (casDisabledForPathSkip && !cfg.forceRerun && !hasPendingCritique && existsSync(outAbs)) {
      try {
        const st = statSync(outAbs);
        if (st.isFile() && st.size > 0) {
          ctx.log(`llm.generate: cached → ${cfg.outputPath}`);
          return {
            ok: true,
            outputPath: cfg.outputPath,
            metadata: {
              cached: true,
              ...(additionalDependencies.length > 0 ? { additionalDependencies } : {}),
            },
          };
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
    const sub = substituteTemplate(template, inputsWithItemId);
    if (!sub.ok) return { ok: false, error: sub.error };

    const tier: LLMTier = cfg.tier ?? 'medium';
    let client: LlmGenerateClient;
    try {
      client = clientFactory(tier, cfg.purpose);
    } catch (err) {
      return { ok: false, error: `llm.generate: failed to construct LLM client: ${(err as Error).message}` };
    }
    const resolvedModel = client.getModel();

    // 3a. CAS lookup — cross-project replay. The key is content-based:
    //     - prompt template FILE CONTENTS (so template edits bust)
    //     - rendered prompt (which folds in all upstream inputs)
    //     - resolved model + config (tier, temperature, schema path, etc.)
    //     - schema FILE CONTENTS when applicable
    // Hit → link cached file to outputPath, return cached:true with
    // inputsHash on the metadata so the walker stamps it on
    // node.completed. Miss → fall through to the live LLM call.
    const cacheKey: InputsHashKey = {
      tool: 'llm.generate',
      toolVersion: '0.1.0',
      inputs: {
        renderedPrompt: sub.rendered,
        promptTemplateFile: { kind: 'file' as const, path: tmplAbs },
        ...(cfg.outputSchema
          ? { schemaFile: { kind: 'file' as const, path: resolve(ctx.bundleDir, cfg.outputSchema) } }
          : {}),
      },
      config: {
        projectScope: getProjectCacheScope(ctx.projectDir),
        model: resolvedModel,
        tier: cfg.tier ?? 'medium',
        ...(cfg.purpose ? { purpose: cfg.purpose } : {}),
        ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
        ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
        outputFormat: cfg.outputFormat ?? 'markdown',
      },
    };
    // CAS kill-switch for tests + opt-out scenarios. Production calls
    // through this path; vitest sets DHEE_DISABLE_CAS=1 to keep unit
    // tests isolated from the shared ~/.kshana/cache.
    const casDisabled = process.env['DHEE_DISABLE_CAS'] === '1';
    if (!casDisabled && !cfg.forceRerun && !hasPendingCritique) {
      const cache = openGenerationCache(
        process.env['DHEE_CACHE_ROOT']
          ? { cacheRoot: process.env['DHEE_CACHE_ROOT'] }
          : undefined,
      );
      const hit = cache.get(cacheKey);
      if (hit) {
        mkdirSync(dirname(outAbs), { recursive: true });
        copyFileSync(hit.storePath, outAbs);
        ctx.log(`llm.generate: CAS hit ${hit.hash.slice(0, 8)} → ${cfg.outputPath}`);
        const inputsHashCS = hit.hash;
        return {
          ok: true,
          outputPath: cfg.outputPath,
          metadata: {
            cached: true,
            inputsHash: inputsHashCS,
            casHit: true,
            ...(hit.metadata ?? {}),
            ...(additionalDependencies.length > 0 ? { additionalDependencies } : {}),
          },
        };
      }
    }

    // 3b. Check for a pending critique under
    //     `pendingCritiques[nodeId(:itemId)]` in project.json. When
    //     present, prepend a system message conveying the critique so
    //     the LLM corrects the prior output on this re-fire. Cleared
    //     on success below. Allows the dhee_critique_node tool to
    //     "set fix-it instructions, then invalidate" without needing
    //     a separate runner.
    const critiqueKey = ctx.itemId
      ? `${ctx.node.id}:${ctx.itemId}`
      : ctx.node.id;
    let pendingCritique: string | undefined;
    let critiquesPath: string | undefined;
    try {
      critiquesPath = resolve(ctx.projectDir, 'project.json');
      if (existsSync(critiquesPath)) {
        const projJson = JSON.parse(readFileSync(critiquesPath, 'utf-8')) as {
          pendingCritiques?: Record<string, string>;
        };
        if (projJson.pendingCritiques && projJson.pendingCritiques[critiqueKey]) {
          pendingCritique = projJson.pendingCritiques[critiqueKey];
        }
      }
    } catch {
      // Best-effort — a malformed project.json shouldn't block the regen.
      pendingCritique = undefined;
    }

    // 4. Call LLM (with retries + abort).
    const maxRetries = cfg.maxRetries ?? 2;
    const isJson = (cfg.outputFormat ?? 'markdown') === 'json';
    let lastErr: string | undefined;
    let content: string | undefined;
    let parsedJson: unknown = undefined;
    // Accumulated USD cost across all attempts of this node (a failed
    // retry still cost tokens). Propagated onto the result metadata so
    // the walker stamps node.completed.generation.costUsd — the field
    // computeCostLedger sums and the budget backstop (features.budgetCapUsd)
    // enforces. Without this the ledger sees $0 for every LLM node and
    // the cap never trips. Stays undefined when the provider reports no
    // cost (e.g. a local / non-cost-reporting OpenAI-compatible endpoint).
    let costUsd: number | undefined;

    // Resolve + parse the schema ONCE if applicable. The parsed object is
    // reused both for ajv validation below AND (Layer 1) for the
    // `response_format.json_schema.schema` sent to the provider.
    let schemaAbs: string | undefined;
    let parsedSchema: Record<string, unknown> | undefined;
    if (isJson && cfg.outputSchema) {
      schemaAbs = resolve(ctx.bundleDir, cfg.outputSchema);
      if (!existsSync(schemaAbs)) {
        return { ok: false, error: `llm.generate: outputSchema not found at ${schemaAbs}` };
      }
      try {
        parsedSchema = JSON.parse(readFileSync(schemaAbs, 'utf-8')) as Record<string, unknown>;
      } catch (err) {
        return { ok: false, error: `Failed to load JSON schema at ${schemaAbs}: ${(err as Error).message}` };
      }
    }

    // Layer 1 — structured (json_schema) response_format. 'auto'/'schema'
    // (explicit opt-in) send the schema whenever one is declared;
    // 'object' — the default when a node doesn't set structuredMode —
    // keeps the legacy json_object-only behavior. A provider that has
    // already 4xx'd on json_schema for this exact client (baseUrl|model)
    // — see the fallback-catch below — skips straight to json_object.
    const structuredMode = cfg.structuredMode ?? 'object';
    const clientKey = `${client.getBaseUrl?.() ?? ''}|${client.getModel()}`;
    const wantsStructuredSchema =
      isJson && parsedSchema !== undefined && structuredMode !== 'object';
    let currentResponseFormat: LlmResponseFormat | undefined = !isJson
      ? undefined
      : wantsStructuredSchema && structuredOutputUnsupportedCache.get(clientKey) !== true
        ? {
            type: 'json_schema',
            json_schema: {
              name: deriveSchemaName(ctx.node.id, cfg.outputPath),
              strict: cfg.structuredStrict ?? false,
              schema: parsedSchema!,
            },
          }
        : { type: 'json_object' };

    // Retry loop covers BOTH transient network failures AND schema
    // validation failures. On a schema error we feed the error message
    // back to the LLM as a corrective hint so it can self-correct on
    // the next attempt (common with enum drift — model emits "medium
    // close-up" instead of the strict "close-up" enum value).
    //
    // When a pending critique is present for this (node, item), prepend
    // it as a leading user message that frames the regen as a "fix the
    // previous output" task. Keeps the prompt template untouched.
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    const critiqueMessage = pendingCritique
      ? `CRITIQUE OF PREVIOUS OUTPUT:\n${pendingCritique}\n\n` +
        `The previous attempt at this artifact had the issues described above. ` +
        `Address them directly in your new response. Otherwise follow the task below as written.`
      : undefined;

    // Cache-aware split: when the template declares a cache breakpoint,
    // send the invariant prefix as a leading `system` message (byte-
    // identical across every item in a collection → provider prefix-cache
    // hit) and the per-item delta as the trailing `user` message. The
    // `system` message always goes first so the cacheable prefix is
    // stable even when a per-regen critique is interleaved. Templates with
    // no marker fall back to a single user message (unchanged behavior).
    const cacheSplit = splitOnCacheBreakpoint(sub.rendered);
    if (cacheSplit) {
      messages.push({ role: 'system', content: cacheSplit.prefix });
      if (critiqueMessage) messages.push({ role: 'user', content: critiqueMessage });
      messages.push({ role: 'user', content: cacheSplit.suffix });
    } else {
      if (critiqueMessage) messages.push({ role: 'user', content: critiqueMessage });
      messages.push({ role: 'user', content: sub.rendered });
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (ctx.signal?.aborted) {
        return { ok: false, error: 'llm.generate: aborted before LLM call' };
      }
      try {
        const resp = await client.generate({
          messages,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          ...(currentResponseFormat ? { responseFormat: currentResponseFormat } : {}),
          ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
          ...(cfg.maxTokens !== undefined ? { maxTokens: cfg.maxTokens } : {}),
        });
        // Per-call usage telemetry (issue #102 fix #0). Recorded for EVERY
        // real call — including parse/schema-retry attempts, which re-send
        // the full prompt and cost real tokens. Tagged lane='walker' +
        // the originating node/item so the chat-vs-walker spend split and
        // the prefix-cache hit ratio are verifiable from the log.
        if (resp.usage) {
          if (resp.usage.cost !== undefined) {
            // Sum across attempts — every real call cost tokens, and the
            // budget cap should account for the retries it took too.
            costUsd = (costUsd ?? 0) + resp.usage.cost;
          }
          recordLlmUsage({
            lane: 'walker',
            model: client.getModel(),
            nodeId: ctx.node.id,
            ...(ctx.itemId !== undefined ? { itemId: ctx.itemId } : {}),
            promptTokens: resp.usage.promptTokens,
            cachedTokens: resp.usage.cachedPromptTokens ?? 0,
            completionTokens: resp.usage.completionTokens,
            totalTokens: resp.usage.totalTokens,
            ...(resp.usage.cost !== undefined ? { costUsd: resp.usage.cost } : {}),
          });
        }
        const got = resp.content ?? '';
        if (!got || got.trim() === '') {
          // An empty response is a transient model hiccup (rate-limit
          // blip, content-filter no-op, gateway truncation), NOT a
          // structural problem — so retry it like a network error
          // instead of bailing on the first occurrence. Only give up
          // once the attempts are exhausted.
          lastErr = 'LLM returned empty response (no content).';
          if (attempt < maxRetries) {
            const backoffMs = 250 * Math.pow(2, attempt);
            ctx.log(`llm.generate: attempt ${attempt + 1} returned empty; retrying in ${backoffMs}ms`);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          break;
        }

        // For JSON output: parse + schema-validate INSIDE the retry
        // loop. On failure, feed the error back to the LLM.
        if (isJson) {
          const parsed = tryParseJson(got);
          if (!parsed.ok) {
            lastErr = parsed.error;
            if (attempt < maxRetries) {
              messages.push({ role: 'assistant', content: got });
              messages.push({ role: 'user', content: `Your previous response did not parse as JSON. Error: ${parsed.error}. Return the JSON object ONLY, no preamble or markdown fences.` });
              ctx.log(`llm.generate: attempt ${attempt + 1} JSON parse failed (${parsed.error.slice(0, 120)}); retrying with feedback`);
              continue;
            }
            break;
          }
          // Construct canonical scene/shot ids BEFORE validating, so the
          // schema's id contract is satisfied by construction rather than
          // by the model getting the string right. The strict schema then
          // doubles as a post-condition check on our own normalization.
          if (cfg.normalizeShotIds) normalizeSceneShotIds(parsed.value);
          if (cfg.normalizeVisualScreenplayBeats) normalizeVisualScreenplayBeats(parsed.value);
          if (parsedSchema) {
            const v = validateAgainstSchema(parsed.value, parsedSchema);
            if (!v.ok) {
              lastErr = v.error;
              if (attempt < maxRetries) {
                messages.push({ role: 'assistant', content: got });
                messages.push({ role: 'user', content: `Your previous response failed schema validation: ${v.error}. Please re-emit the JSON object using ONLY values from the declared enums. Return the JSON object only, no preamble.` });
                ctx.log(`llm.generate: attempt ${attempt + 1} schema validation failed (${v.error.slice(0, 160)}); retrying with feedback`);
                continue;
              }
              break;
            }
          }
          parsedJson = parsed.value;
        }
        content = got;
        break;
      } catch (err) {
        // Layer 1 graceful fallback: this specific provider (client key
        // = baseUrl|model) just told us it doesn't support
        // response_format:json_schema. Downgrade to json_object for
        // THIS call — retried immediately, not counted against
        // maxRetries (the `attempt--` below cancels the for-loop's
        // increment) — and cache the decision so every subsequent call
        // to the same client skips straight to json_object. Never
        // touches the node's model/tier/purpose, only response_format.
        if (currentResponseFormat?.type === 'json_schema' && isStructuredOutputUnsupportedError(err)) {
          structuredOutputUnsupportedCache.set(clientKey, true);
          currentResponseFormat = { type: 'json_object' };
          ctx.log(
            `llm.generate: provider rejected response_format:json_schema (${(err as Error).message.slice(0, 160)}); ` +
              `falling back to json_object for this and future calls to '${clientKey}'`,
          );
          attempt--;
          continue;
        }
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

    let toWrite = content;
    if (isJson) {
      toWrite = JSON.stringify(parsedJson, null, 2);
    }

    // 6. Write atomically (mkdir first, then write).
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, toWrite, 'utf-8');
    ctx.log(`llm.generate: wrote ${cfg.outputPath} (${toWrite.length} bytes)`);

    // 6a. Put into CAS for cross-project replay. Best-effort: a CAS
    //     write failure must NOT kill the run — the artifact already
    //     wrote to outputPath. Skipped when the LLM emitted a critique
    //     fix (different effective prompt than the cached key) OR
    //     when CAS is disabled (tests / opt-out).
    let inputsHashForEvent: string | undefined;
    if (!pendingCritique && !casDisabled) {
      try {
        const cache = openGenerationCache(
          process.env['DHEE_CACHE_ROOT']
            ? { cacheRoot: process.env['DHEE_CACHE_ROOT'] }
            : undefined,
        );
        const ext = (extname(cfg.outputPath).slice(1) || 'txt');
        const put = cache.put({
          key: cacheKey,
          sourcePath: outAbs,
          ext,
          metadata: { model: client.getModel(), bytes: toWrite.length },
        });
        inputsHashForEvent = put.hash;
      } catch {
        // Best-effort — never fail the run on CAS write errors.
      }
    }

    // 6b. Clear consumed pending critique. Done AFTER the artifact
    //     write succeeds — if the call failed, the critique survives
    //     for the next attempt (defense-in-depth against a partial
    //     run leaving a stale fix-it note behind).
    if (pendingCritique && critiquesPath) {
      try {
        const projJson = JSON.parse(readFileSync(critiquesPath, 'utf-8')) as {
          pendingCritiques?: Record<string, string>;
          [k: string]: unknown;
        };
        if (projJson.pendingCritiques) {
          delete projJson.pendingCritiques[critiqueKey];
          // Drop the field entirely when empty so project.json stays clean.
          if (Object.keys(projJson.pendingCritiques).length === 0) {
            delete projJson.pendingCritiques;
          }
          writeFileSync(critiquesPath, JSON.stringify(projJson, null, 2), 'utf-8');
        }
      } catch {
        // Non-fatal — the artifact was already written.
      }
    }

    return {
      ok: true,
      outputPath: cfg.outputPath,
      metadata: {
        model: client.getModel(),
        bytes: toWrite.length,
        cached: false,
        ...(inputsHashForEvent ? { inputsHash: inputsHashForEvent } : {}),
        ...(costUsd !== undefined ? { costUsd } : {}),
        ...(pendingCritique ? { critiqueApplied: true } : {}),
        ...(additionalDependencies.length > 0 ? { additionalDependencies } : {}),
      },
    };
  }

  return { describe, run };
}

/** Default singleton — what the registry registers. */
export const llmGenerateRunner = createLlmGenerateRunner();
