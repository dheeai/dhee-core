import { TypedEventEmitter } from '../../events/EventEmitter.js';
import {
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
  type AgentSession,
  type AgentSessionEvent,
  type ToolDefinition,
} from '@mariozechner/pi-coding-agent';
import { existsSync } from 'node:fs';
import { recordSession, sessionFilePathFor, touchSession } from './sessionStore.js';
import { getModel } from '@mariozechner/pi-ai';
import type { Model } from '@mariozechner/pi-ai';
import type { GenericAgentResult } from '../../core/agent/AgentResult.js';
import { dheeTools } from './tools/index.js';
import { createFocusProjectTool, type FocusProjectCallback } from './tools/focusProject.js';
import { createRunToTool, type MediaCallback } from './tools/runTo.js';
import { createShowShotTool } from './tools/showShot.js';
import {
  createShowFirstFrameTool,
  createShowLastFrameTool,
  createShowShotVideoTool,
  createShowFinalVideoTool,
} from './tools/showAsset.js';
import { createDispatchRunToTool } from './tools/dispatchRunTo.js';
import { loadOrchestratorPrompt } from './prompt.js';
import { selectToolsForRole, type SessionRole } from './selectToolsForRole.js';
import { ensureDir, getdheeConfigDir, getProjectsDir, REPO_ROOT } from './paths.js';
import { ensureOpenRouterApiKeyFromEnv } from './ensureOpenRouterKey.js';

const REPO_ROOT_PROMPTS = join(REPO_ROOT, 'prompts');
import { translatePiEvent, type TranslationContext } from './translateEvent.js';
import { join } from 'node:path';

function envTrim(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value || undefined;
}

function envNumber(name: string, fallback: number): number {
  const value = Number(envTrim(name));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build an `openai-completions` Model with explicit baseUrl/apiKey/model from
 * the given env-var prefix. Used for both the legacy `OPENAI_*` route and the
 * new `LLM_TIER_HEAVY_*` route. Returns undefined when baseUrl is missing —
 * pi-ai's `getModel()` cannot route to a custom URL on its own, so without
 * baseUrl we have to fall back to the named-provider path.
 */
function openAiCompatibleProxyModelFromPrefix(
  prefix: 'OPENAI' | 'LLM_TIER_HEAVY',
): Model<'openai-completions'> | undefined {
  const baseUrl = envTrim(`${prefix}_BASE_URL`);
  const apiKey = envTrim(`${prefix}_API_KEY`);
  if (!baseUrl || !apiKey) return undefined;

  const modelId = envTrim(`${prefix}_MODEL`) ?? 'deepseek/deepseek-v4-flash';
  const lowerModel = modelId.toLowerCase();
  const reasoning =
    lowerModel.includes('deepseek') ||
    lowerModel.includes('qwen') ||
    lowerModel.includes('gpt-5') ||
    lowerModel.includes('reason');

  return {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: 'openai',
    baseUrl,
    reasoning,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: envNumber('LLM_CONTEXT_TOKENS', 160000),
    maxTokens: envNumber('LLM_MAX_TOKENS', 64000),
  };
}

export function resolvePiSessionModel(): Model<string> {
  const model = resolvePiSessionModelInner();
  if (!model) {
    // pi-ai's getModel(provider, modelId) returns undefined for unknown
    // model ids — e.g. a custom proxy model like "Qwen3.6-35B-A3B" is
    // NOT in pi-ai's static registry. The undefined silently propagates
    // until pi-coding-agent reads `model.api` and dies with the
    // unhelpful "Cannot read properties of undefined (reading 'api')".
    // Fail fast with a message that points at the cause.
    const llmProvider = envTrim('LLM_PROVIDER') ?? '(unset)';
    const baseUrl = envTrim('OPENAI_BASE_URL') ?? '(unset)';
    const modelId = envTrim('OPENAI_MODEL') ?? '(unset)';
    const hasKey = !!envTrim('OPENAI_API_KEY');
    throw new Error(
      `resolvePiSessionModel returned no model. ` +
        `LLM_PROVIDER=${llmProvider} OPENAI_BASE_URL=${baseUrl} ` +
        `OPENAI_MODEL=${modelId} hasOpenAIKey=${hasKey}. ` +
        `For openai-compatible proxies (LM Studio, custom hosts), set ` +
        `OPENAI_BASE_URL + OPENAI_API_KEY (any non-empty key) so the ` +
        `proxy-model path fires; pi-ai's static registry will not have ` +
        `your custom model id.`,
    );
  }
  // Pi-agent uses @mariozechner/pi-coding-agent's internal HTTP stack,
  // which bypasses LLMLogger — without this log line there is NO
  // observable signal of which baseUrl/model pi-agent is hitting.
  // Print to stdout so it lands in the desktop's electron-log capture.
   
  console.log(
    `[resolvePiSessionModel] api=${model.api} provider=${model.provider} ` +
      `id=${model.id} baseUrl=${(model as { baseUrl?: string }).baseUrl ?? '(default)'}`,
  );
  return model;
}

function resolvePiSessionModelInner(): Model<string> {
  ensureOpenRouterApiKeyFromEnv();

  const tierProvider = envTrim('LLM_TIER_HEAVY_PROVIDER');
  const tierModel = envTrim('LLM_TIER_HEAVY_MODEL');
  if (tierProvider) {
    // When the user has supplied an explicit base URL for the heavy
    // tier (e.g. self-hosted proxy, LM Studio, Kshana Cloud), build an
    // openai-completions Model so pi-ai routes to that URL. Without
    // this, getModel() sends to the named provider's default endpoint
    // and silently bypasses the user's proxy.
    const tierProxy = openAiCompatibleProxyModelFromPrefix('LLM_TIER_HEAVY');
    if (tierProxy) return tierProxy;
    return getModel(
      tierProvider as Parameters<typeof getModel>[0],
      (tierModel ?? 'deepseek/deepseek-v4-flash') as never
    ) as Model<string>;
  }

  const llmProvider = envTrim('LLM_PROVIDER')?.toLowerCase();
  if (llmProvider === 'openai') {
    const proxyModel = openAiCompatibleProxyModelFromPrefix('OPENAI');
    if (proxyModel) return proxyModel;
    return getModel('openai', (envTrim('OPENAI_MODEL') ?? 'gpt-4o') as never) as Model<string>;
  }
  if (llmProvider === 'openrouter') {
    return getModel(
      'openrouter',
      (envTrim('OPENROUTER_MODEL') ?? 'deepseek/deepseek-v4-flash') as never
    ) as Model<string>;
  }

  return getModel('openrouter', 'deepseek/deepseek-v4-flash') as Model<string>;
}

/**
 * PiSessionAgent — wraps pi-coding-agent's AgentSession to satisfy the
 * SessionAgent contract that ConversationManager expects.
 */
export class PiSessionAgent extends TypedEventEmitter {
  public readonly name = 'dhee-pi';

  private session?: AgentSession;
  private streaming = false;
  private currentResolve?: (result: GenericAgentResult) => void;
  private currentReject?: (err: Error) => void;
  private translationContext: TranslationContext = {
    agentName: 'dhee-pi',
    finalAssistantText: '',
  };
  private unsubscribe?: () => void;

  private readonly tools: ToolDefinition[];
  private readonly systemPrompt: string;
  private readonly sessionId?: string;
  private readonly projectSlug?: string;
  private readonly resumeSessionFile?: string;

  constructor(opts?: {
    tools?: ToolDefinition[];
    systemPrompt?: string;
    /**
     * Session role. `'interactive'` strips long-running pipeline tools
     * (dhee_run_to, dhee_render_scene_bundle, dhee_audit_fidelity)
     * so a chat session can't be hijacked by a 1–4h blocking task.
     * `'background'` is the dedicated long-run session; it sees the
     * full toolkit. Defaults to `'interactive'` — the safer choice
     * for any caller that hasn't thought about it.
     */
    role?: SessionRole;
    /** Callback that lets the agent focus a project as the session's active project. */
    focusProject?: FocusProjectCallback;
    /** Called whenever a long-running tool surfaces a newly-generated asset. */
    onMedia?: MediaCallback;
    /**
     * Session id to embed in `dhee_dispatch_*` tools so the
     * background task runner tags emitted events with this id, and
     * the host can route them back to the right chat.
     *
     * Also used as the on-disk filename for the persisted pi-coding-agent
     * session JSONL (`<projectSlug>/<sessionId>.jsonl`). Without it, the
     * session falls back to in-memory only.
     */
    sessionId?: string;
    /**
     * Project slug (no `.kshana` suffix) the session is scoped to.
     * Determines the directory the JSONL transcript is written into.
     * Without it, the session falls back to in-memory only — pi-agent
     * still works, but the chat is lost on restart.
     */
    projectSlug?: string;
    /**
     * Path to an existing pi-coding-agent JSONL session to resume from.
     * When set, takes precedence over a fresh-create with `projectSlug`.
     */
    resumeSessionFile?: string;
  }) {
    super();
    const role: SessionRole = opts?.role ?? 'interactive';
    let baseTools = opts?.tools ?? dheeTools;
    // Tools that need to surface inline media in chat are factory-built when
    // an onMedia callback is wired. Without onMedia, dhee_show_shot still
    // returns a text summary but won't render image/video cards in the UI.
    if (opts?.onMedia) {
      const mediaRunTo = createRunToTool({
        onMedia: opts.onMedia,
        ...(opts?.sessionId ? { sessionId: opts.sessionId } : {}),
      });
      // The four per-asset show tools (firstFrame, lastFrame,
      // shotVideo, finalVideo) used to be plain exports without
      // any onMedia plumbing — pi-agent calls succeeded but no
      // image/video bubble rendered in chat. Replacing them here
      // with media-wired factory variants closes that gap.
      const showShot = createShowShotTool({ onMedia: opts.onMedia });
      const showFirstFrame = createShowFirstFrameTool({ onMedia: opts.onMedia });
      const showLastFrame = createShowLastFrameTool({ onMedia: opts.onMedia });
      const showShotVideo = createShowShotVideoTool({ onMedia: opts.onMedia });
      const showFinalVideo = createShowFinalVideoTool({ onMedia: opts.onMedia });
      baseTools = baseTools.map(t => {
        if (t.name === 'dhee_run_to') return mediaRunTo;
        if (t.name === 'dhee_show_first_frame') return showFirstFrame;
        if (t.name === 'dhee_show_last_frame') return showLastFrame;
        if (t.name === 'dhee_show_shot_video') return showShotVideo;
        if (t.name === 'dhee_show_final_video') return showFinalVideo;
        return t;
      });
      baseTools = [...baseTools, showShot];
    } else if (opts?.sessionId) {
      // No onMedia callback (rare in production) but we still want
      // to dispatch instead of block when we have a session id.
      const sessionRunTo = createRunToTool({ sessionId: opts.sessionId });
      baseTools = baseTools.map(t => (t.name === 'dhee_run_to' ? sessionRunTo : t));
      baseTools = [...baseTools, createShowShotTool({})];
    } else {
      baseTools = [...baseTools, createShowShotTool({})];
    }
    // Currently a no-op pass-through (see selectToolsForRole notes).
    // Reserved for future dispatch-based tool gating.
    baseTools = selectToolsForRole(baseTools, role);

    // Add the per-session dispatch tools when we have a sessionId.
    // Without sessionId (legacy callers), they're omitted — the
    // legacy synchronous dhee_run_to remains in the tool list as
    // a fallback, so behavior degrades gracefully.
    if (opts?.sessionId) {
      const dispatchRunTo = createDispatchRunToTool({ sessionId: opts.sessionId });
      baseTools = [...baseTools, dispatchRunTo];
    }

    this.tools = opts?.focusProject
      ? [...baseTools, createFocusProjectTool(opts.focusProject)]
      : baseTools;
    this.systemPrompt = opts?.systemPrompt ?? loadOrchestratorPrompt();
    this.sessionId = opts?.sessionId;
    this.projectSlug = opts?.projectSlug;
    this.resumeSessionFile = opts?.resumeSessionFile;
  }

  async initialize(): Promise<void> {
    if (this.session) return;

    const model = resolvePiSessionModel();

    const cwd = ensureDir(getProjectsDir());
    const agentDir = ensureDir(join(getdheeConfigDir(), 'pi-agent'));

    const authStorage = AuthStorage.create(join(agentDir, 'auth.json'));
    const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, 'models.json'));
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const skillsDir = join(REPO_ROOT_PROMPTS, 'skills');
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      systemPromptOverride: () => this.systemPrompt,
      additionalSkillPaths: [skillsDir],
    });
    await resourceLoader.reload();

    const result = await createAgentSession({
      cwd,
      agentDir,
      authStorage,
      modelRegistry,
      model,
      customTools: this.tools,
      resourceLoader,
      sessionManager: this.buildSessionManager(cwd),
      settingsManager,
    });
    this.session = result.session;
    this.unsubscribe = this.session.subscribe(event => this.handleEvent(event));
  }

  /**
   * Pick the right SessionManager based on resume / persist / fallback rules.
   *
   * - resumeSessionFile present and the JSONL exists → reopen it.
   * - sessionId + projectSlug → fresh persistent session at a deterministic
   *   path so the kshana-side index can find it later.
   * - Otherwise → in-memory only (legacy callers without an id).
   *
   * Also records / touches the kshana sessionStore so resumes can locate
   * the file by sessionId without scanning the disk.
   */
  private buildSessionManager(cwd: string): SessionManager {
    if (this.resumeSessionFile && existsSync(this.resumeSessionFile)) {
      if (this.sessionId) touchSession(this.sessionId);
      return SessionManager.open(this.resumeSessionFile);
    }
    if (this.sessionId && this.projectSlug) {
      const sessionFile = sessionFilePathFor(this.sessionId, this.projectSlug);
      const sessionDir = join(sessionFile, '..');
      // SessionManager.create() writes a new JSONL using its own id format.
      // To pin the file to <sessionId>.jsonl so the kshana index stays in
      // sync, we create then redirect via setSessionFile.
      const mgr = SessionManager.create(cwd, sessionDir);
      mgr.setSessionFile(sessionFile);
      recordSession(this.sessionId, this.projectSlug, sessionFile);
      return mgr;
    }
    return SessionManager.inMemory();
  }

  /**
   * Read every persisted session entry (messages, tool calls, compaction
   * markers, etc.) for this session. Used by the WebSocket resume path
   * to replay history into a fresh frontend on reconnect.
   *
   * Returns an empty array for in-memory sessions or before initialize().
   */
  getSessionEntries(): ReturnType<SessionManager['getEntries']> {
    if (!this.session) return [];
    const mgr = this.session.sessionManager;
    if (!mgr.isPersisted()) return [];
    return mgr.getEntries();
  }

  /** Whether this session is backed by a persistent JSONL file. */
  isPersisted(): boolean {
    return this.session?.sessionManager.isPersisted() ?? false;
  }

  /** Path to the JSONL transcript file, or undefined for in-memory sessions. */
  getSessionFile(): string | undefined {
    return this.session?.sessionManager.getSessionFile();
  }

  async run(task: string, userResponse?: string): Promise<GenericAgentResult> {
    if (!this.session) {
      throw new Error('PiSessionAgent.run() called before initialize()');
    }
    const text = userResponse ? `${task}\n\n${userResponse}`.trim() : task;
    if (!text) {
      return { status: 'completed', output: '', todos: [] };
    }

    // Mid-stream user message → steer. pi-coding-agent throws
    // "Agent is already processing. Specify streamingBehavior" if
    // prompt() is called while a previous turn is still streaming.
    // For chat UX, treat the second message as an interrupt + redirect
    // ('steer'): the in-flight turn picks up the new instruction and
    // emits ONE agent_end that resolves the original run() promise.
    // This run() resolves immediately so the renderer doesn't hang
    // awaiting a separate result that will never come.
    if (this.session.isStreaming) {
      try {
        await this.session.prompt(text, { streamingBehavior: 'steer' });
        return { status: 'completed', output: '', todos: [] };
      } catch (err) {
        return {
          status: 'error',
          output: '',
          todos: [],
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }

    this.streaming = true;
    this.translationContext = { agentName: this.name, finalAssistantText: '' };

    return await new Promise<GenericAgentResult>((resolve, reject) => {
      this.currentResolve = resolve;
      this.currentReject = reject;
      this.session!.prompt(text).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        if (this.currentReject) {
          const r = this.currentReject;
          this.cleanupRun();
          r(new Error(message));
        }
      });
    });
  }

  stop(): void {
    if (this.session && this.streaming) {
      void this.session.abort();
    }
  }

  isRunning(): boolean {
    return this.streaming;
  }

  getToolNames(): string[] {
    return this.tools.map(t => t.name);
  }

  setAutonomousMode(_enabled: boolean): void {
    // Pi has no direct equivalent of ExecutorAgent's autonomous toggle;
    // session-level confirmation behavior is governed by pi's own settings.
  }

  destroy(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.removeAllListeners();
  }

  private handleEvent(event: AgentSessionEvent): void {
    const r = translatePiEvent(event, this.translationContext);
    this.translationContext = r.context;
    for (const e of r.events) {
      // TypedEventEmitter is generic — emit accepts any AgentEvent variant.
      this.emit(e as never);
    }
    if (r.agentEndOutput !== undefined) {
      this.streaming = false;
      const resolve = this.currentResolve;
      this.cleanupRun();
      resolve?.({ status: 'completed', output: r.agentEndOutput, todos: [] });
    }
  }

  private cleanupRun(): void {
    this.streaming = false;
    this.currentResolve = undefined;
    this.currentReject = undefined;
  }
}
