/**
 * buildPiSession — single source of truth for assembling a
 * dhee-flavoured pi-coding-agent session.
 *
 * Two callers:
 *   - drive.ts (Claude-Code-driven CLI test harness)
 *   - the desktop's in-process agent loader (future, BUG-016 proper fix)
 *
 * Splits into two halves:
 *   - `buildPiSessionConfig(opts)` — pure config assembly. Loads the
 *     dhee skill from the package's own skill dir, sets the
 *     read-only built-in tool allowlist, leaves model selection to
 *     pi-coding-agent's defaults (which read from ~/.pi/agent/settings).
 *     Pure enough to unit-test without an LLM.
 *   - `buildPiSession(opts)` — wires the config through
 *     `createAgentSession` and returns the live session.
 *
 * Skill loading: we use `skillsOverride` on DefaultResourceLoader to
 * explicitly inject the package-shipped skill. We deliberately do NOT
 * rely on the standard `.pi/skills/` discovery from cwd, because cwd
 * varies (the desktop's cwd is the user's project dir, not the
 * dhee-core package dir).
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  loadSkillsFromDir,
  SessionManager,
  type CreateAgentSessionOptions,
  type CreateAgentSessionResult,
} from '@mariozechner/pi-coding-agent';
import { getModel, type Model } from '@mariozechner/pi-ai';
import { DHEE_TOOL_NAMES, registerDheeTools } from './tools/index.js';
import { registerContextTrim } from './contextTrim.js';
import { registerUsageTelemetry } from './usageTelemetryExtension.js';

/** The skill name (from the YAML frontmatter `name:` field) we inject. */
export const DHEE_SKILL_NAME = 'dhee';
export const DHEE_CLOUD_PI_MODEL_PROVIDER = 'cloud';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = resolve(__dirname, 'skill');

/**
 * Pi's read-only built-in tools used to be in this allowlist:
 *   ['read', 'ls', 'grep', 'find']
 * Removed because pi's defaults accept ANY absolute path, which let the
 * agent wander into /Users/ganaraj/Projects/kshana-core/src/... to
 * debug engine internals instead of helping the user with their video.
 * The dhee_read / dhee_ls / dhee_grep / dhee_find tools (path-scoped
 * to the user's projectDir) replace them in DHEE_TOOL_NAMES.
 */
const READONLY_BUILTINS: readonly string[] = [];

export interface BuildPiSessionOptions {
  /**
   * Pi SessionManager. Caller decides in-memory vs file-backed.
   *
   * Optional in Phase 6.5 — when omitted, we default to
   * `SessionManager.inMemory(cwd)`. The opt-in default lets the
   * desktop's chat layer build an ephemeral session without taking
   * a transitive dependency on `@mariozechner/pi-coding-agent`'s
   * exports.
   */
  sessionManager?: ReturnType<typeof SessionManager.inMemory>;
  /** Working directory for the agent. Defaults to process.cwd(). */
  cwd?: string;
  /**
   * Additional custom tool names to include in the allowlist. The
   * tools themselves must be registered via an extensionFactory
   * (passed in `extensionFactories`) and ALSO appear here, because
   * pi's `tools` option is a strict allowlist by name (the well-known
   * "Landmine 1": tools missing from the allowlist are silently
   * blocked even if registered).
   */
  customToolNames?: string[];
  /**
   * Extension factories — used to register custom dhee tools. The
   * built-in dhee tool registry runs first by default; pass extras
   * here to layer additional tools / event handlers on top.
   */
  extensionFactories?: ConstructorParameters<typeof DefaultResourceLoader>[0]['extensionFactories'];
  /**
   * Set false to skip registering the v1 dhee tool family. Useful
   * for tests that want to inspect the config shape without pulling
   * in the live tools. Defaults to true.
   */
  includeDefaultTools?: boolean;
  /**
   * Phase 6.5c.d: when set + no explicit `sessionManager`, use
   * `SessionManager.continueRecent(cwd, sessionsDir)` so chat
   * history persists across desktop restarts. Pass the per-project
   * sessions dir (e.g. `~/.dhee/pi-sessions/<projectSlug>/`) — pi
   * picks the most recent JSONL or mints a fresh one.
   */
  sessionsDir?: string;
  /**
   * Phase 6.5b: explicit model + API key pair. When provided, pi-ai's
   * auto-discovery is bypassed:
   *   - AuthStorage gets `apiKey` set as a runtime credential for
   *     `modelProvider` (no on-disk auth.json mutation).
   *   - `getModel(modelProvider, modelId)` resolves the typed Model
   *     that createAgentSession uses for every turn. When
   *     `modelBaseUrl` is supplied, that Model is cloned with the
   *     caller's endpoint so desktop-owned proxies (Dhee Cloud,
   *     LM Studio, etc.) do not fall back to pi-ai's public defaults.
   *   - Dhee Cloud is the exception: desktop passes provider
   *     `cloud`, apiKey, and modelBaseUrl without a modelId.
   *     Core creates a private OpenAI-compatible model with a blank
   *     protocol model id so the cloud proxy owns real model selection.
   *
   * Without this, pi-coding-agent falls back to whatever the user's
   * ~/.pi/agent/settings.json names — which is usually empty on
   * desktops that haven't run `pi /login` — and `session.prompt()`
   * silently returns no text. Explicit is the only reliable path
   * when the desktop's settings (not pi's) own the credentials.
   */
  modelProvider?: string;
  modelId?: string;
  apiKey?: string;
  modelBaseUrl?: string;
}

/**
 * Build a generic OpenAI-compatible Model for an endpoint that pi-ai's
 * curated MODELS table doesn't know — niche OpenRouter slugs
 * (`inclusionai/ring-2.6-1t`), local servers, custom proxies. Without
 * this, `getModel()` returns undefined for such ids and the caller would
 * leave `config.model` unset, which makes pi-coding-agent silently fall
 * back to its built-in default model (gpt-5.x on api.openai.com). Paired
 * with a non-OpenAI key (an OpenRouter `sk-or-…` key) that 401s on every
 * turn and silently kills the agent — the "Resume does nothing" bug.
 */
function buildOpenAICompatModel(opts: {
  id: string;
  name: string;
  provider: string;
  baseUrl: string;
}): Model<'openai-completions'> {
  return {
    id: opts.id,
    name: opts.name,
    api: 'openai-completions',
    provider: opts.provider,
    baseUrl: opts.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128000,
    maxTokens: 8192,
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: 'max_completion_tokens',
      thinkingFormat: 'openai',
    },
  };
}

function buildDheeCloudModel(baseUrl: string): Model<'openai-completions'> {
  // Blank protocol model id so the Dhee Cloud proxy owns real model selection.
  return buildOpenAICompatModel({
    id: '',
    name: 'Dhee Cloud',
    provider: DHEE_CLOUD_PI_MODEL_PROVIDER,
    baseUrl,
  });
}

/**
 * Build the full pi-coding-agent config without booting the session.
 * Splitting this out makes the factory unit-testable.
 */
export async function buildPiSessionConfig(
  opts: BuildPiSessionOptions,
): Promise<CreateAgentSessionOptions> {
  const cwd = opts.cwd ?? process.cwd();
  // Default to the v1 dhee toolset; callers can override (e.g. to []
  // for the unit-test "config shape" suite). Production callers
  // shouldn't override — every dhee tool name must be in the allowlist
  // or pi silently blocks it (Landmine 1).
  const customToolNames = opts.customToolNames ?? [...DHEE_TOOL_NAMES];
  const baseExtensionFactories = opts.extensionFactories ?? [];
  // `registerContextTrim` bounds re-sent chat history each turn (issue
  // #102 — unbounded prompt growth). It's part of the production default
  // stack alongside the dhee tools; the `includeDefaultTools: false`
  // escape hatch (config-shape tests) skips both.
  const extensionFactories = opts.includeDefaultTools === false
    ? baseExtensionFactories
    : [registerDheeTools, registerContextTrim, registerUsageTelemetry, ...baseExtensionFactories];

  // Load our packaged skill once and inject it via skillsOverride.
  // We disable default discovery (which would also scan cwd/.pi/skills
  // and ~/.pi/agent/skills) by hijacking `current` and replacing with
  // exactly our skill set. Callers who want extra skills can layer
  // them on a subsequent override.
  const packagedSkills = loadSkillsFromDir({
    dir: SKILL_DIR,
    source: 'dhee-core/src/agent/pi/skill',
  });

  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    skillsOverride: () => packagedSkills,
    extensionFactories,
  });
  await resourceLoader.reload();

  // Phase 6.5c.d session-manager selection:
  // 1. Explicit `opts.sessionManager` always wins.
  // 2. Else if `opts.sessionsDir` is set, continueRecent the most
  //    recent JSONL in that dir (creates a new one if none exists)
  //    so chat history persists across desktop restarts.
  // 3. Otherwise in-memory (no persistence; CLI default).
  const sessionManager =
    opts.sessionManager ??
    (opts.sessionsDir
      ? SessionManager.continueRecent(cwd, opts.sessionsDir)
      : SessionManager.inMemory(cwd));

  const config: CreateAgentSessionOptions = {
    cwd,
    resourceLoader,
    tools: [...READONLY_BUILTINS, ...customToolNames],
    sessionManager,
  };

  // Phase 6.5b: when the caller supplies an explicit model target, wire
  // a fresh in-memory AuthStorage with the runtime key set + resolve
  // the typed Model via pi-ai's getModel. This bypasses pi-coding-
  // agent's `findInitialModel` heuristic (which reads ~/.pi/agent/
  // settings.json + auth.json + env vars, and returns null silently
  // when none align) — the desktop owns its own credentials.
  //
  // Local OpenAI-compatible servers often do not require an API key, but
  // pi-ai's OpenAI transport still expects a runtime credential slot.
  // Use a harmless placeholder in that no-key local/proxy case so the
  // explicit model path still activates instead of falling back to pi's
  // default OpenAI model.
  if (opts.modelProvider && (opts.apiKey !== undefined || opts.modelBaseUrl)) {
    if (opts.modelProvider === DHEE_CLOUD_PI_MODEL_PROVIDER && !opts.apiKey) {
      return config;
    }
    const authStorage = AuthStorage.inMemory();
    authStorage.setRuntimeApiKey(opts.modelProvider, opts.apiKey?.trim() || 'local');
    config.authStorage = authStorage;
    const modelBaseUrl = opts.modelBaseUrl?.trim();
    if (opts.modelProvider === DHEE_CLOUD_PI_MODEL_PROVIDER && modelBaseUrl) {
      config.model = buildDheeCloudModel(modelBaseUrl);
      return config;
    }
    if (!opts.modelId) return config;

    // getModel is strongly typed against MODELS table; cast to any so
    // the desktop can pass user-string provider/model ids without
    // dragging pi-ai's type union through every consumer.
    const model = getModel(opts.modelProvider as never, opts.modelId as never);
    if (model) {
      config.model = modelBaseUrl ? { ...model, baseUrl: modelBaseUrl } : model;
    } else if (modelBaseUrl) {
      // pi-ai's curated table doesn't know this model id (a niche
      // OpenRouter slug, a local-server model, etc.). DON'T leave
      // config.model unset — pi-coding-agent would then fall back to its
      // built-in default model (gpt-5.x / api.openai.com), and the
      // caller's non-OpenAI key 401s on every turn, silently killing the
      // agent (the desktop "Resume does nothing" bug). The caller gave us
      // an explicit endpoint, so honor it + the requested id directly.
      config.model = buildOpenAICompatModel({
        id: opts.modelId,
        name: opts.modelId,
        provider: opts.modelProvider,
        baseUrl: modelBaseUrl,
      });
    }
    // else: unknown id AND no endpoint to target — fall through to pi's
    // auto-discovery (config.model stays unset), the prior behavior.
  }

  return config;
}

/** Boot a dhee-flavoured pi-coding-agent session. */
export async function buildPiSession(
  opts: BuildPiSessionOptions,
): Promise<CreateAgentSessionResult> {
  const cfg = await buildPiSessionConfig(opts);
  return createAgentSession(cfg);
}
