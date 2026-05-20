/**
 * In-process runner for ExecutorAgent.
 *
 * Shared core used by:
 *   - HTTP runner (executorRunner.ts) — wraps the result for JobManager
 *   - pi-agent runTo tool — translates events to AgentToolUpdate stream
 *   - (future) scripts/run-to.ts CLI
 *
 * Why this exists:
 *   `pi-agent/tools/runScript.ts` shells out to `pnpm exec tsx scripts/*.ts`,
 *   which only works in the dev/repo context. The packaged desktop build
 *   has no pnpm, no tsx, and no scripts/ directory. The same wiring needs
 *   to live inside src/ so the desktop binary can drive the executor
 *   directly. Tracked previously in todos/wrap-executor-with-pi-agent.md.
 *
 * The runner constructs ExecutorAgent + LLM once, wires the caller's
 * event handlers (progress text, generated assets, notifications),
 * runs the agent, and normalizes the result. Cancellation is via
 * AbortSignal — when aborted, the runner calls agent.stop(); the
 * executor's stop sentinel + per-tick check pick it up.
 */
import { LLMClient } from '../../core/llm/index.js';
import { getLLMConfig } from '../../core/llm/config.js';
import { ExecutorAgent } from '../../core/planner/ExecutorAgent.js';
import { getVideoTemplate } from '../../tasks/video/index.js';
import { setActiveProjectDir } from '../../tasks/video/workflow/activeProject.js';
import { resolveProjectDuration } from '../../core/project/projectTypes.js';
import type { GenericProjectFile } from '../../core/templates/types.js';
import { classifyExecutorAsset } from './classifyExecutorAsset.js';
import { mapExecutorStatus } from './mapExecutorStatus.js';
import { linkAbortSignalToAgent } from './linkAbortSignalToAgent.js';

/**
 * Minimal interface runExecutor requires from an agent. ExecutorAgent
 * satisfies this; tests can supply a stub matching just this surface.
 */
export interface RunExecutorAgent {
  on(event: 'tool_call' | 'tool_result' | 'notification', handler: (event: unknown) => void): unknown;
  run(task: string): Promise<{ status: string; error?: string | undefined }>;
  stop(): void;
  getStopReason(): string | null;
}

export type RunExecutorAgentFactory = (
  llm: LLMClient,
  opts: ConstructorParameters<typeof ExecutorAgent>[1],
) => RunExecutorAgent;

const defaultAgentFactory: RunExecutorAgentFactory = (llm, opts) =>
  new ExecutorAgent(llm, opts);

export interface RunExecutorTarget {
  /** Stop after every node of this typeId has reached terminal state. */
  stage?: string;
  /** Stop after this specific node id. Mutually exclusive with stage. */
  nodeId?: string;
  /** Skip ComfyUI image/video generation; only run LLM prompt stages. */
  skipMedia?: boolean;
  /**
   * Whitelist for isolated-redo mode. When supplied, the executor's
   * loop runs ONLY these node ids (filtered against `getNextReady`)
   * and exits when all are terminal. Other pending work in the graph
   * is left alone — the explicit "run only what was just invalidated"
   * mode used by `dhee_run_to scope='last_invalidated'`.
   */
  runOnly?: string[];
}

export interface RunExecutorAssetEvent {
  kind: 'image' | 'video';
  /** The path the executor reported. May be relative to projectDir. */
  filePath: string;
  /** Tool that produced it (from the tool_result event). */
  toolName?: string | undefined;
  /** Node id the tool was operating on, if known (from tool_call event arguments). */
  nodeId?: string | undefined;
}

export interface RunExecutorOpts {
  project: GenericProjectFile;
  projectDir: string;
  target: RunExecutorTarget;
  signal?: AbortSignal | undefined;

  /** Called for every tool_call event. Lightweight progress (one line). */
  onTool?: ((info: { toolName: string; nodeId?: string | undefined }) => void) | undefined;
  /** Called for every tool_result event with a usable file_path. */
  onResult?: ((info: { toolName: string; filePath?: string; status?: string; error?: string }) => void) | undefined;
  /** Called for notifications (info / warning / error). */
  onNotification?: ((info: { level: string; message: string }) => void) | undefined;
  /** Called when a generated asset (image / video) is observed. */
  onAsset?: ((event: RunExecutorAssetEvent) => void) | undefined;

  /** Custom name shown in executor logs. Default: 'in-process'. */
  name?: string | undefined;

  /**
   * Override agent construction. Production callers should leave this
   * undefined (uses `new ExecutorAgent(llm, opts)`); tests inject a
   * stub matching `RunExecutorAgent` to exercise the bridge wiring
   * without booting the real planner.
   */
  agentFactory?: RunExecutorAgentFactory | undefined;
}

export interface RunExecutorResult {
  status: 'completed' | 'cancelled' | 'failed';
  stopReason: string | null;
  error?: string | undefined;
  /** ExecutorAgent's raw result.status — useful for diagnostics. */
  rawResultStatus: string;
}

/**
 * Run the executor in-process to completion or to the configured stop
 * point. Streams events to the caller's handlers; honors the supplied
 * AbortSignal by calling agent.stop().
 *
 * Caveat (same as executorRunner.ts): the pipeline reads
 * `setActiveProjectDir` globally. Concurrent runs across DIFFERENT
 * projects will clobber each other's activeProjectDir. JobManager
 * already serializes per-project; cross-project serialization is the
 * caller's responsibility.
 */
export async function runExecutor(opts: RunExecutorOpts): Promise<RunExecutorResult> {
  setActiveProjectDir(opts.projectDir);

  const project = opts.project;
  const template = getVideoTemplate(project.templateId || 'narrative');
  const llm = new LLMClient(getLLMConfig());

  const stopAtStage = opts.target.stage;
  const stopAfterNode = opts.target.nodeId;
  const skipMedia = opts.target.skipMedia === true;

  const description = stopAtStage
    ? `Run pipeline up to stage ${stopAtStage}`
    : stopAfterNode
      ? `Run pipeline up to node ${stopAfterNode}`
      : 'Run pipeline to completion';

  const agent = (opts.agentFactory ?? defaultAgentFactory)(llm, {
    template,
    project,
    projectDir: opts.projectDir,
    goal: {
      targetArtifacts: ['final_video'],
      preferences: {
        style: project.style || 'cinematic_realism',
        duration: resolveProjectDuration(project),
      },
      description,
    },
    name: opts.name ?? 'in-process',
    ...(stopAtStage ? { stopAtStage } : {}),
    ...(stopAfterNode ? { stopAfterNode } : {}),
    ...(skipMedia ? { skipMediaGeneration: true } : {}),
  });

  // Pin the isolated-redo whitelist BEFORE run() so the loop's
  // first tick already filters readyNodes against it. Falsy / empty
  // arrays don't pin (full graph drain semantics — the
  // "continue from here" mode).
  const runOnly = opts.target.runOnly;
  if (runOnly && runOnly.length > 0) {
    const ag = agent as unknown as {
      setRedoOnlyNodes?: (ids: string[] | null) => void;
    };
    ag.setRedoOnlyNodes?.(runOnly);
  }

  // Track the latest node-id we saw in a tool_call so onAsset events
  // can be tagged with what they belong to. Not perfect (interleaved
  // tools could overlap), but a useful default for the chat UI.
  let lastSeenNodeId: string | undefined;

  // ── Wire events ─────────────────────────────────────────────────
  if (opts.onTool || opts.onAsset) {
    agent.on('tool_call', (event) => {
      const args = (event as { arguments?: Record<string, unknown> }).arguments;
      const nodeId =
        (args?.['shot'] as string | undefined) ??
        (args?.['node'] as string | undefined) ??
        (args?.['itemId'] as string | undefined);
      if (typeof nodeId === 'string') lastSeenNodeId = nodeId;
      opts.onTool?.({
        toolName: (event as { toolName: string }).toolName,
        nodeId,
      });
    });
  }

  agent.on('tool_result', (event) => {
    const r = (event as { result?: { file_path?: string; status?: string; error?: string } }).result;
    const toolName = (event as { toolName: string }).toolName;
    if (opts.onResult) {
      opts.onResult({
        toolName,
        ...(r?.file_path ? { filePath: r.file_path } : {}),
        ...(r?.status ? { status: r.status } : {}),
        ...(r?.error ? { error: r.error } : {}),
      });
    }
    if (opts.onAsset) {
      const kind = classifyExecutorAsset(r?.file_path);
      if (kind && r?.file_path) {
        opts.onAsset({
          kind,
          filePath: r.file_path,
          toolName,
          nodeId: lastSeenNodeId,
        });
      }
    }
  });

  if (opts.onNotification) {
    agent.on('notification', (event) => {
      opts.onNotification?.({
        level: (event as { level: string }).level,
        message: (event as { message: string }).message,
      });
    });
  }

  // ── Cancellation: AbortSignal → agent.stop() ────────────────────
  // ExecutorAgent.stop() sets the stopped flag (checked each tick),
  // sets stopReason='cancelled', and fires a ComfyUI interrupt to kill
  // any in-flight image/video generation immediately.
  const cleanupAbort = linkAbortSignalToAgent(opts.signal, () => agent.stop());

  try {
    const result = await agent.run(description);
    const stopReason = agent.getStopReason();
    return {
      status: mapExecutorStatus(result.status, stopReason),
      stopReason,
      ...(result.error ? { error: result.error } : {}),
      rawResultStatus: result.status,
    };
  } catch (err) {
    // If we threw while the signal was already aborted, report as
    // cancelled rather than failed — the caller asked for cancellation
    // and the throw is the side effect, not a real failure.
    if (opts.signal?.aborted) {
      return {
        status: 'cancelled',
        stopReason: 'cancelled',
        rawResultStatus: 'thrown',
      };
    }
    return {
      status: 'failed',
      stopReason: null,
      error: err instanceof Error ? err.message : String(err),
      rawResultStatus: 'thrown',
    };
  } finally {
    cleanupAbort();
  }
}
