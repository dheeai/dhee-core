/**
 * ConversationManager - Manages agent sessions and orchestrates conversations.
 * Each WebSocket connection can have one active conversation session.
 * Agent is created lazily when a project is selected via configureSessionForProject().
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { atomicWriteFileSync } from '../utils/atomicWrite.js';
import { v4 as uuidv4 } from 'uuid';
import { defaultBasePath } from '../tasks/video/workflow/projectFileIO.js';
import {
  resolveProjectDir,
  ProjectDirNotFoundError,
} from '../agent/pi/tools/resolveProjectDir.js';
import type { GenericAgentResult } from '../core/agent/index.js';
import type { LLMClientConfig } from '../core/llm/index.js';
import type { TypedEventEmitter } from '../events/EventEmitter.js';
import { PiSessionAgent } from '../agent/pi/PiSessionAgent.js';
import {
  AMBIENT_PROJECT_SLUG,
  findSession as findStoredSession,
  setSessionProject,
} from '../agent/pi/sessionStore.js';
import { getBackgroundTaskRunner } from './runners/backgroundTaskRunnerSingleton.js';
import { decideCancelActions } from './cancelDecision.js';
import type { BackgroundTaskRunnerEvents } from './runners/BackgroundTaskRunner.js';
import { applyProjectAnnouncement } from './projectAnnouncement.js';
import {
  getOversight,
  setPiOversight as setGlobalPiOversight,
  setVLMJudge as setGlobalVLMJudge,
} from './oversightState.js';
import {
  buildSupervisorTask,
  emptySupervisorState,
  recordSupervisorInvocation,
  shouldFireSupervisor,
  type SupervisorEvent,
  type SupervisorEventInfo,
  type SupervisorState,
} from './conversation/supervisor.js';
import { describeImageWithVLM } from '../core/llm/describeImageWithVLM.js';
import { backfillSceneTreeIfStale } from '../core/project/backfillSceneTreeIfStale.js';
import { getProviderRegistry } from '../services/providers/index.js';
import type { SessionState } from './types.js';
import type { ExpandableTodoItem } from '../core/todo/index.js';
import {
  type SessionContext,
  type IFileSystem,
  runInSession,
  runInSessionAsync,
  createLocalSession,
  createRemoteSession,
  requireSession,
} from '../core/fs/index.js';
import {
  startTimer,
  stopTimer,
  checkpointTimer,
  updateProjectAutonomousMode,
  updateProjectConfiguration,
  getElapsedMs,
  loadProject,
} from '../tasks/video/workflow/ProjectManager.js';
import { applyInvalidation } from '../core/planner/applyInvalidation.js';
import {
  captureSessionEnded,
  captureSessionStarted,
  captureToolCallCompleted,
  captureToolCallStarted,
  captureWorkflowCompleted,
  captureWorkflowFailed,
  captureWorkflowStarted,
} from './posthog.js';
import type { DesktopSessionCapabilities } from '../core/remote/DesktopAssemblyBroker.js';

const TIMER_CHECKPOINT_INTERVAL_MS = 60_000; // Flush elapsed time to disk every 60s

/**
 * Detect "silent" agent.run() resolutions — runs that completed
 * without surfacing anything visible to the user. Two cases qualify:
 *   - status === 'interrupted' (cancelled mid-stream, partial or no
 *     output; the user has no way to tell whether anything happened)
 *   - status === 'completed' but the output is empty / whitespace
 *     (the LLM returned no text and no further tool calls).
 *
 * runTask uses this to push a system notification into the chat when
 * pi-agent ends without saying anything. Without it, the user just
 * sees the chat go quiet after the last tool card and assumes the
 * agent is broken — the bug from 2026-05-22 where two reads were
 * followed by silence with no diagnostic.
 *
 * Does NOT flag:
 *   - waiting_for_user (the agent is alive and asking a question —
 *     the question itself is the visible signal)
 *   - error (runTask throws → IPC bridge already renders a visible
 *     "Couldn't reach the agent" row; double-surfacing would clutter)
 */
export function isSilentAgentResult(r: { status: string; output?: string }): boolean {
  if (r.status === 'interrupted') return true;
  if (r.status === 'completed') {
    const o = r.output;
    if (!o || o.trim().length === 0) return true;
  }
  return false;
}

export interface ConversationManagerConfig {
  llmConfig: LLMClientConfig;
  sessionTimeoutMs?: number;  // Default: 30 minutes
  maxIterations?: number;     // Default: 50
}

export interface ConversationEvents {
  onProgress?: (sessionId: string, percentage: number, message: string) => void;
  onToolCall?: (
    sessionId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    agentName?: string,
  ) => void;
  onToolResult?: (
    sessionId: string,
    toolCallId: string,
    toolName: string,
    result: unknown,
    isError?: boolean,
    agentName?: string,
  ) => void;
  onTodoUpdate?: (sessionId: string, todos: ExpandableTodoItem[]) => void;
  onAgentText?: (sessionId: string, text: string, isFinal: boolean) => void;
  onQuestion?: (sessionId: string, question: string, isConfirmation: boolean, options?: Array<{ label: string; description?: string }>, autoApproveTimeoutMs?: number) => void;
  onAgentStatus?: (sessionId: string, status: string, agentName?: string) => void;
  /** Streaming text from agent's LLM output */
  onStreamingText?: (sessionId: string, chunk: string, done: boolean) => void;
  /** Tool streaming for sub-agent content generation */
  onToolStreaming?: (sessionId: string, toolCallId: string, chunk: string, done: boolean, agentName?: string, toolName?: string, reset?: boolean) => void;
  /** Context window usage stats */
  onContextUsage?: (sessionId: string, data: { promptTokens: number; maxTokens: number; percentage: number; wasCompressed: boolean; iteration: number }) => void;
  /** Workflow phase transition */
  onPhaseTransition?: (sessionId: string, data: { fromPhase: string; toPhase: string; displayName?: string; description?: string }) => void;
  /** Full timeline state update */
  onTimelineUpdate?: (sessionId: string, data: { timeline: unknown }) => void;
  /** User-facing notification */
  onNotification?: (sessionId: string, data: { level: 'info' | 'warning' | 'error'; message: string }) => void;
  /** Agent (or user) focused a project — frontend should treat it as the active project. */
  onProjectFocused?: (sessionId: string, data: { projectName: string; templateId: string; style: string; duration: number; tools: string[] }) => void;
  /** A long-running tool produced an asset (image / video) — surface it as a standalone chat event. */
  onMediaGenerated?: (sessionId: string, data: { kind: 'image' | 'video'; project: string; path: string; source: string }) => void;
  /**
   * Session lifecycle transitions — emitted on every change of
   * `session.state.status` (idle / running / awaiting_input / completed
   * / error). `turnKind` distinguishes user-driven turns from
   * server-initiated supervisor turns so the renderer can show
   * appropriate UI ("Supervisor reviewing…" vs "Pi is thinking…").
   * Skipped when the status hasn't actually changed (no spurious
   * duplicate emits).
   */
  onSessionStatus?: (
    sessionId: string,
    data: { status: string; turnKind?: 'user' | 'supervisor' },
  ) => void;
}

/**
 * Common interface for agents that can be used in sessions.
 * Both GenericAgent and ExecutorAgent satisfy this.
 */
interface SessionAgent extends TypedEventEmitter {
  initialize(): Promise<void>;
  run(task: string, userResponse?: string): Promise<GenericAgentResult>;
  stop(): void;
  isRunning(): boolean;
  getToolNames(): string[];
  setAutonomousMode(enabled: boolean): void;
  injectInput?(input: string): void;
}

/**
 * Session role. `'interactive'` (default) is the user's chat
 * session — long-running pipeline tools are stripped so a chat
 * message can't block on a multi-hour run. `'background'` is the
 * dedicated long-run session (created by the desktop when the user
 * clicks Resume); it gets the full toolkit. See
 * `src/agent/pi/selectToolsForRole.ts`.
 */
export type ConversationSessionRole = 'interactive' | 'background';

interface ActiveSession {
  state: SessionState;
  agent?: SessionAgent;
  abortController?: AbortController;
  initialized?: boolean;
  /** Per-session context for file system and project isolation */
  sessionContext?: SessionContext;
  /** The mode this session operates in */
  mode: 'local' | 'remote';
  /** Long-run policy. See ConversationSessionRole. Default 'interactive'. */
  role: ConversationSessionRole;
  /** Remote client filesystem (set in remote mode) */
  remoteFs?: IFileSystem;
  /** Capabilities reported by the connected desktop client */
  desktopCapabilities?: DesktopSessionCapabilities;
  /** Periodic timer checkpoint interval (flushes elapsedMs to disk) */
  timerCheckpointInterval?: ReturnType<typeof setInterval>;
  /** Events callbacks for the currently-running task (cleared after runTask). */
  activeEvents?: ConversationEvents;
  /**
   * Long-lived event bridge for THIS session. Set once by the IPC
   * bridge (or WS layer) over a stable callback (e.g.
   * `webContents.send`), and reused across every runTask invocation —
   * including server-initiated turns the user never directly triggered
   * (most notably the post-completion supervisor pi-agent that
   * auto-engages on runner `completed` events).
   *
   * Solves the "supervisor invisibility" bug from 2026-05-22: the IPC
   * bridge passed a fresh `eventCb` per runTask, so when `runTask` was
   * called WITHOUT an eventCb (the supervisor's `runTask(sid, msg)`
   * with no third arg), nothing reached the renderer. With this pinned
   * bridge as fallback, supervisor tool calls and streaming text now
   * stream to the chat the same way user-initiated turns do.
   *
   * Distinct from `activeEvents` (per-task, cleared in runTask's
   * finally) and `backgroundEvents` (per-runner-task, cleared on
   * runner completed/failed). Lifetime is session lifetime.
   */
  persistentEvents?: ConversationEvents;
  /**
   * Tag on the in-flight turn so event consumers (and the renderer)
   * can distinguish a supervisor turn from a user-initiated one.
   * Cleared when the turn ends. Read by `onSessionStatus` emission
   * so the UI can render a "Supervisor reviewing…" pill instead of
   * the generic "running" state.
   */
  currentTurnKind?: 'user' | 'supervisor';
  /**
   * Set by `cancelTask` when called with `opts.userInitiated=true`
   * (the IPC bridge path — the user clicked Stop in the chat header).
   * Consumed (read + cleared) once by runTask's silent-agent
   * notification so we don't surface a redundant "Agent didn't
   * respond — interrupted" warning when the user is the one who
   * triggered the interruption. Server-initiated auto-cancels (the
   * runTask back-to-back path) leave this flag unset so the warning
   * still fires for them.
   */
  userInitiatedCancel?: boolean;
  /**
   * Events callbacks pinned for the lifetime of an in-flight background
   * task on this session. Captured from `activeEvents` when the runner
   * emits 'started' and cleared on 'completed' / 'failed' / 'cancelled'.
   * Lives independently of `activeEvents` because the agent's turn
   * (and `activeEvents`) ends as soon as the dispatch tool returns,
   * while the background task keeps emitting progress events for
   * minutes-to-hours afterward.
   */
  backgroundEvents?: ConversationEvents;
  /** Currently-focused project name (no .dhee suffix), set by dhee_focus_project. */
  focusedProject?: string;
  /**
   * Path to a pi-coding-agent JSONL session to reopen on first agent
   * construction. Set when the WebSocket layer reconstructs a stale
   * sessionId from the kshana sessionStore. Cleared after the agent
   * is built (one-shot).
   */
  resumeSessionFile?: string;
  /** Whether this ActiveSession was reconstructed from disk. */
  resumedFromDisk?: boolean;
  /** Last focused project we announced to the agent (for change detection in runTask). */
  announcedProject?: string;
  /**
   * Per-task supervisor counters (circuit breaker for the runtime
   * oversight loop). When a fresh task.id is seen the counters
   * reset; within a task the failed/completed and asset caps
   * keep `[SYSTEM EVENT]` invocations bounded.
   */
  supervisorState?: SupervisorState;
}

export class ConversationManager {
  private sessions = new Map<string, ActiveSession>();
  private llmConfig: LLMClientConfig;
  private sessionTimeoutMs: number;
  private maxIterations: number;
  private cleanupInterval?: ReturnType<typeof setInterval>;

  private getWorkflowName(session: ActiveSession): string {
    const maybeName = (session.agent as unknown as { name?: unknown } | undefined)?.name;
    return typeof maybeName === 'string' && maybeName.trim().length > 0
      ? maybeName
      : 'unknown';
  }

  constructor(config: ConversationManagerConfig) {
    this.llmConfig = config.llmConfig;
    this.sessionTimeoutMs = config.sessionTimeoutMs ?? 30 * 60 * 1000; // 30 minutes
    this.maxIterations = config.maxIterations ?? 50;

    // Start cleanup interval
    this.cleanupInterval = setInterval(() => this.cleanupStaleSessions(), 60 * 1000);

    // Forward background-task-runner events back to the originating
    // session's chat. The runner emits events tagged with the
    // sessionId that dispatched the task; we read each session's
    // activeEvents and route the runner's payload through the
    // same channels the agent's own tool calls use, so the chat
    // panel sees background progress as if it were inline tool output.
    this.subscribeToBackgroundTaskRunner();
  }

  private subscribeToBackgroundTaskRunner(): void {
    const runner = getBackgroundTaskRunner();
    const fakeToolCallIdForTask = (taskId: string): string =>
      `task:${taskId}`;
    // Pick the events sink that's still alive. Prefer the background
    // pin (set on 'started' and held for the task's lifetime) and
    // fall back to activeEvents for the rare case where the agent's
    // turn is still running when an event fires.
    const sinkFor = (session: ActiveSession | undefined): ConversationEvents | undefined =>
      session?.backgroundEvents ?? session?.activeEvents;

    /**
     * Session-keepalive: bump `state.lastActivity` whenever a runner
     * event fires for this session. Without this, `cleanupStaleSessions`
     * reaps the session after `sessionTimeoutMs` (default 30 min) of
     * "no manual chat activity" — even when the BackgroundTaskRunner
     * is steadily streaming progress for an in-flight pipeline. Once
     * reaped, every subsequent runner event has nowhere to forward
     * to (the `sessions.get(sessionId)` lookup returns undefined),
     * the chat panel stops receiving updates, and the user sees the
     * progress count freeze even though the pipeline is still running
     * on disk. Touching lastActivity here keeps the session alive
     * for the duration of the run.
     */
    const touchSessionActivity = (sessionId: string): ActiveSession | undefined => {
      const session = this.sessions.get(sessionId);
      if (session) session.state.lastActivity = Date.now();
      return session;
    };

    runner.on('started', ({ task }: BackgroundTaskRunnerEvents['started']) => {
      const session = touchSessionActivity(task.spec.sessionId);
      captureToolCallStarted({
        sessionId: task.spec.sessionId,
        toolCallId: fakeToolCallIdForTask(task.id),
        toolName: `dhee_${task.spec.kind}`,
        agentName: session ? this.getWorkflowName(session) : 'background-task',
        args: task.spec.params,
        startedAt: new Date(task.startedAt).toISOString(),
        projectDir: task.spec.projectName,
        workflowName: 'background_task',
      });
      captureWorkflowStarted({
        sessionId: task.spec.sessionId,
        workflowName: 'background_task',
        taskKind: task.spec.kind,
        taskId: task.id,
      });
      if (!session) return;
      // Pin the events sink for the task's lifetime — the agent's
      // tool call returns immediately after dispatch, which clears
      // activeEvents, but the runner keeps emitting progress events
      // long after that. Without this pin, every tool/result/asset
      // event would be dropped.
      if (session.activeEvents) {
        session.backgroundEvents = session.activeEvents;
      }
      const events = sinkFor(session);
      if (!events) return;
      // Synthesize a tool_call event so the chat shows a tool card
      // for the task.
      events.onToolCall?.(
        task.spec.sessionId,
        fakeToolCallIdForTask(task.id),
        `dhee_${task.spec.kind}`,
        task.spec.params,
        this.getWorkflowName(session),
      );
    });
    runner.on('tool', ({ task, toolName, nodeId }: BackgroundTaskRunnerEvents['tool']) => {
      const session = touchSessionActivity(task.spec.sessionId);
      const events = sinkFor(session);
      if (!session || !events) return;
      const line = nodeId ? `  [${toolName}] ${nodeId}` : `  [${toolName}]`;
      events.onToolStreaming?.(
        task.spec.sessionId,
        fakeToolCallIdForTask(task.id),
        line + '\n',
        false,
        this.getWorkflowName(session),
        toolName,
      );
    });
    runner.on('result', ({ task, toolName, filePath, status, error }: BackgroundTaskRunnerEvents['result']) => {
      const session = touchSessionActivity(task.spec.sessionId);
      const events = sinkFor(session);
      if (!session || !events) return;
      // Surface the error reason inline so both the agent (when it
      // reads the chat transcript on its next turn) and the user see
      // WHY a tool errored — not just "→ error". Without this the
      // ComfyUI rejection text was being dropped at the runner layer.
      const line = filePath
        ? `    → ${filePath}`
        : status === 'error' && error
          ? `    → error: ${error}`
          : status
            ? `    → ${status}`
            : '';
      if (!line) return;
      events.onToolStreaming?.(
        task.spec.sessionId,
        fakeToolCallIdForTask(task.id),
        line + '\n',
        false,
        this.getWorkflowName(session),
        toolName,
      );
    });
    runner.on('notification', ({ task, level, message }: BackgroundTaskRunnerEvents['notification']) => {
      const session = touchSessionActivity(task.spec.sessionId);
      const events = sinkFor(session);
      if (!session || !events) return;
      events.onToolStreaming?.(
        task.spec.sessionId,
        fakeToolCallIdForTask(task.id),
        `  [${level}] ${message}\n`,
        false,
        this.getWorkflowName(session),
        'dhee_run_to',
      );
    });
    runner.on('asset', ({ task, kind, filePath }: BackgroundTaskRunnerEvents['asset']) => {
      const session = touchSessionActivity(task.spec.sessionId);
      const events = sinkFor(session);
      if (!session || !events) return;
      events.onMediaGenerated?.(task.spec.sessionId, {
        kind,
        path: filePath,
        project: task.spec.projectName,
        source: 'dhee_run_to',
      });
    });
    runner.on('completed', ({ task }: BackgroundTaskRunnerEvents['completed']) => {
      const session = touchSessionActivity(task.spec.sessionId);
      const events = sinkFor(session);
      const completedAt = new Date(task.completedAt ?? Date.now()).toISOString();
      const durationMs = Math.max(0, (task.completedAt ?? Date.now()) - task.startedAt);
      captureToolCallCompleted({
        sessionId: task.spec.sessionId,
        toolCallId: fakeToolCallIdForTask(task.id),
        toolName: `dhee_${task.spec.kind}`,
        agentName: session ? this.getWorkflowName(session) : 'background-task',
        isError: false,
        durationMs,
        startedAt: new Date(task.startedAt).toISOString(),
        completedAt,
        projectDir: task.spec.projectName,
        workflowName: 'background_task',
      });
      captureWorkflowCompleted({
        sessionId: task.spec.sessionId,
        workflowName: 'background_task',
        taskKind: task.spec.kind,
        taskId: task.id,
        durationMs,
      });
      if (session && events) {
        events.onToolResult?.(
          task.spec.sessionId,
          fakeToolCallIdForTask(task.id),
          `dhee_${task.spec.kind}`,
          { status: 'completed' },
          false,
          this.getWorkflowName(session),
        );
      }
      if (session) session.backgroundEvents = undefined;
    });
    runner.on('failed', ({ task, error }: BackgroundTaskRunnerEvents['failed']) => {
      const session = touchSessionActivity(task.spec.sessionId);
      const events = sinkFor(session);
      const completedAt = new Date(task.completedAt ?? Date.now()).toISOString();
      const durationMs = Math.max(0, (task.completedAt ?? Date.now()) - task.startedAt);
      captureToolCallCompleted({
        sessionId: task.spec.sessionId,
        toolCallId: fakeToolCallIdForTask(task.id),
        toolName: `dhee_${task.spec.kind}`,
        agentName: session ? this.getWorkflowName(session) : 'background-task',
        isError: true,
        durationMs,
        errorMessage: error,
        startedAt: new Date(task.startedAt).toISOString(),
        completedAt,
        projectDir: task.spec.projectName,
        workflowName: 'background_task',
      });
      captureWorkflowFailed({
        sessionId: task.spec.sessionId,
        workflowName: 'background_task',
        taskKind: task.spec.kind,
        taskId: task.id,
        errorType: 'background_task_failed',
        durationMs,
      });
      if (session && events) {
        events.onToolResult?.(
          task.spec.sessionId,
          fakeToolCallIdForTask(task.id),
          `dhee_${task.spec.kind}`,
          { error },
          true,
          this.getWorkflowName(session),
        );
      }
      if (session) session.backgroundEvents = undefined;
    });
    runner.on('cancelled', ({ task }: BackgroundTaskRunnerEvents['cancelled']) => {
      const session = touchSessionActivity(task.spec.sessionId);
      const events = sinkFor(session);
      const completedAt = new Date(task.completedAt ?? Date.now()).toISOString();
      const durationMs = Math.max(0, (task.completedAt ?? Date.now()) - task.startedAt);
      captureToolCallCompleted({
        sessionId: task.spec.sessionId,
        toolCallId: fakeToolCallIdForTask(task.id),
        toolName: `dhee_${task.spec.kind}`,
        agentName: session ? this.getWorkflowName(session) : 'background-task',
        isError: false,
        durationMs,
        startedAt: new Date(task.startedAt).toISOString(),
        completedAt,
        projectDir: task.spec.projectName,
        workflowName: 'background_task',
      });
      if (session && events) {
        events.onToolResult?.(
          task.spec.sessionId,
          fakeToolCallIdForTask(task.id),
          `dhee_${task.spec.kind}`,
          { status: 'cancelled' },
          false,
          this.getWorkflowName(session),
        );
      }
      if (session) session.backgroundEvents = undefined;
    });

    // ── Supervisor (oversight) re-engagement ─────────────────────
    // Layered ON TOP of the chat-streaming handlers above. When
    // oversight is on, these auto-invoke pi-agent via runTask with a
    // [SYSTEM EVENT] message so it can judge the runner outcome.
    //
    // The handlers MUST defer (setImmediate) before calling runTask:
    // - Runner events fire synchronously from inside the executor's
    //   call stack, which sits inside an active runTask. Calling
    //   runTask synchronously would hit the "session already
    //   running" guard.
    // - After deferral, the original turn's finally block has run;
    //   session.state.status is in a terminal state and runTask
    //   accepts.
    // - Re-check oversight + status inside the deferred callback so
    //   we honor a toggle flip that landed during the defer window
    //   and don't talk over a user message that arrived first.
    runner.on('failed', ({ task, error }: BackgroundTaskRunnerEvents['failed']) => {
      this.scheduleSupervisorInvocation('failed', task, { reason: error });
    });
    runner.on('completed', ({ task }: BackgroundTaskRunnerEvents['completed']) => {
      this.scheduleSupervisorInvocation('completed', task, {});
    });
    runner.on('asset', (payload: BackgroundTaskRunnerEvents['asset']) => {
      this.scheduleSupervisorInvocation('asset', payload.task, {
        kind: payload.kind,
        filePath: payload.filePath,
      });
    });
  }

  /**
   * Build a SupervisorEventInfo and fire pi-agent on the next tick
   * if the circuit-breaker, oversight gate, and (for asset events)
   * VLM gate all permit. Defers via setImmediate to escape the
   * synchronous event-emit stack and re-check state with the
   * original turn's finally block already run.
   */
  private scheduleSupervisorInvocation(
    event: SupervisorEvent,
    task: BackgroundTaskRunnerEvents['failed']['task'],
    extra: {
      reason?: string;
      kind?: 'image' | 'video';
      filePath?: string;
      /** Node ids the user invalidated (user_invalidate event). */
      seeds?: string[];
      /** Free-form origin tag for user_invalidate events. */
      source?: string;
    },
  ): void {
    setImmediate(() => {
      void this.runSupervisorInvocation(event, task, extra);
    });
  }

  private async runSupervisorInvocation(
    event: SupervisorEvent,
    task: BackgroundTaskRunnerEvents['failed']['task'],
    extra: {
      reason?: string;
      kind?: 'image' | 'video';
      filePath?: string;
      seeds?: string[];
      source?: string;
    },
  ): Promise<void> {
    const sessionId = task.spec.sessionId;
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Gate 1: oversight off → never fire.
    const oversight = getOversight();
    if (!oversight.piOversight) return;

    // Gate 2: per-asset events also require VLM on.
    if (event === 'asset' && !oversight.vlmJudge) return;

    // Gate 3: per-asset events only meaningful for images. Videos
    // don't go through the describer (out of scope for v1).
    if (event === 'asset' && extra.kind !== 'image') return;

    // Gate 4: circuit breaker.
    const supState = session.supervisorState ?? emptySupervisorState();
    if (!shouldFireSupervisor(supState, event, task.id)) return;

    // Gate 5: don't talk over an active user turn. session.state.status
    // is set to 'running' for the duration of runTask. If a user
    // message arrived during the defer window, skip — they win.
    if (session.state.status === 'running') return;

    // For asset events: ask the VLM to describe the image. Returns
    // null when VLM_* env config is missing (one-time warning is
    // logged from inside describeImageWithVLM); we still fire the
    // supervisor turn but with no description so pi-agent decides
    // text-only.
    let vlmDescription: string | undefined;
    if (event === 'asset' && extra.filePath) {
      // Resolve to absolute. The runner reports paths relative to
      // projectDir; describeImageWithVLM (and the underlying
      // chatWithImage) need an on-disk path it can read.
      // Best-effort: if path is already absolute, use as-is;
      // otherwise prepend the resolved project dir.
      const absPath = extra.filePath;
      const desc = await describeImageWithVLM(
        absPath,
        // The asset's originating prompt isn't on the runner event —
        // for now we send a generic framing. Future: thread the
        // shot's imagePrompt through onAsset.
        'asset generated by the dhee pipeline',
      );
      if (desc) vlmDescription = desc;
    }

    const info: SupervisorEventInfo = (() => {
      if (event === 'failed') {
        return {
          event: 'failed',
          taskId: task.id,
          taskKind: task.spec.kind,
          projectName: task.spec.projectName,
          reason: extra.reason ?? 'unknown',
        };
      }
      if (event === 'completed') {
        return {
          event: 'completed',
          taskId: task.id,
          taskKind: task.spec.kind,
          projectName: task.spec.projectName,
        };
      }
      if (event === 'user_invalidate') {
        return {
          event: 'user_invalidate',
          taskId: task.id,
          taskKind: task.spec.kind,
          projectName: task.spec.projectName,
          seeds: extra.seeds ?? [],
          ...(extra.source ? { source: extra.source } : {}),
        };
      }
      return {
        event: 'asset',
        taskId: task.id,
        taskKind: task.spec.kind,
        projectName: task.spec.projectName,
        assetPath: extra.filePath ?? '(unknown)',
        assetPrompt: 'asset generated by the dhee pipeline',
        ...(vlmDescription ? { vlmDescription } : {}),
      };
    })();
    const taskMessage = buildSupervisorTask(info);

    // Record the invocation BEFORE awaiting runTask so re-entrant
    // events that fire during the supervisor turn see the bumped
    // counter.
    session.supervisorState = recordSupervisorInvocation(supState, event, task.id);

    // Tag the upcoming turn as supervisor so onSessionStatus emission
    // carries turnKind='supervisor' (the renderer can render a
    // "Supervisor reviewing…" pill instead of the generic running
    // indicator). Pre-fire a notification so the chat shows a visible
    // marker even on UIs that haven't subscribed to onSessionStatus
    // yet — this is the main accessibility fix for the "supervisor is
    // running invisibly" bug from 2026-05-22.
    session.currentTurnKind = 'supervisor';
    const supervisorBanner = (() => {
      switch (event) {
        case 'completed': return '🔍 Reviewing the run…';
        case 'failed': return '🔍 Investigating the failure…';
        case 'asset': return '🔍 Reviewing generated asset…';
        case 'user_invalidate': return '🔍 Reviewing user invalidation…';
        default: return '🔍 Supervisor turn started';
      }
    })();
    const sink = this.resolveTaskEvents(sessionId, session.activeEvents);
    try {
      sink?.onNotification?.(sessionId, {
        level: 'info',
        message: supervisorBanner,
      });
    } catch {
      // notification sink failures are non-fatal
    }

    try {
      await this.runTask(sessionId, taskMessage);
    } catch {
      // Supervisor failures shouldn't crash the runner subscription.
      // The user will see whatever pi-agent's reply ended up as
      // (or, on a thrown runTask, no reply); the runner keeps
      // emitting events for the rest of the run.
    } finally {
      // Clear the turn kind so a subsequent user-initiated runTask
      // gets the right (undefined / 'user') tag.
      const s = this.sessions.get(sessionId);
      if (s) delete s.currentTurnKind;
    }
  }

  /**
   * Create a new conversation session (bare — no agent until project is configured).
   *
   * If `existingSessionId` is provided and the kshana sessionStore knows about
   * it, the SessionState is reconstructed under that id and tagged
   * `resumedFromDisk` so subsequent agent construction reopens the
   * pi-coding-agent JSONL transcript instead of creating a fresh in-memory
   * session.
   */
  createSession(
    mode: 'local' | 'remote' = 'local',
    remoteFs?: IFileSystem,
    role: ConversationSessionRole = 'interactive',
    existingSessionId?: string,
  ): SessionState {
    const stored = existingSessionId ? findStoredSession(existingSessionId) : null;
    const sessionId = stored?.sessionId ?? uuidv4();
    const now = Date.now();

    const state: SessionState = {
      id: sessionId,
      createdAt: stored?.createdAt ?? now,
      lastActivity: now,
      status: 'idle',
      taskHistory: [],
    };

    this.sessions.set(sessionId, {
      state,
      mode,
      role,
      remoteFs,
      ...(stored
        ? {
            resumeSessionFile: stored.sessionFile,
            resumedFromDisk: true,
            ...(stored.projectSlug !== AMBIENT_PROJECT_SLUG ? { focusedProject: stored.projectSlug } : {}),
          }
        : {}),
    });

    // Resume restore: when the stored session has a known project,
    // populate `sessionContext` synchronously so IPC calls that need
    // a working dir (invalidateNodes, run_to, focusSessionProject's
    // later content reads, etc.) succeed on the first request after
    // resume. Without this, every IPC call would fail with "Session
    // project not configured" until the renderer happened to fire a
    // focusProject IPC — a race that left buttons broken after a
    // desktop process restart even though everything else looked
    // healthy.
    //
    // The richer `focusSessionProject` path (which also reads
    // project.json, fires a broadcast, etc.) still runs when the
    // renderer eventually calls focusProject; this just makes sure
    // sessionContext is non-null in the interim.
    if (stored && stored.projectSlug !== AMBIENT_PROJECT_SLUG) {
      const resumed = this.sessions.get(sessionId);
      if (resumed) {
        try {
          // The project folder may have been deleted out from under
          // the persisted session id. Skip restore in that case so
          // the next legitimate focusProject call surfaces the
          // missing-project error instead of us silently swallowing it.
          const projectDirAbs = resolveProjectDir({
            name: stored.projectSlug,
            basePath: defaultBasePath(),
          });
          const projectDirName = nodePath.basename(projectDirAbs);
          resumed.sessionContext = mode === 'remote' && remoteFs
            ? createRemoteSession(sessionId, projectDirName, remoteFs)
            : createLocalSession(sessionId, projectDirName);
        } catch {
          // Don't fail createSession — the renderer can still re-focus
          // explicitly if the project comes back.
        }
      }
    }

    captureSessionStarted(sessionId, new Date(state.createdAt).toISOString());

    return state;
  }

  /**
   * Configure a session's agent for a specific project.
   * Uses the shared createAgentForProject() — same tools, prompt, and params as CLI.
   * Creates a per-session SessionContext so each session has its own project dir and filesystem.
   */
  configureSessionForProject(
    sessionId: string,
    templateId: string,
    style: string,
    duration: number,
    projectDirName?: string,
    providerConfig?: { imageGeneration?: string; imageEditing?: string; videoGeneration?: string },
    autonomousMode?: boolean,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Create per-session context with the appropriate filesystem
    const projectDir = projectDirName ?? 'default.dhee';
    if (session.mode === 'remote' && session.remoteFs) {
      session.sessionContext = createRemoteSession(sessionId, projectDir, session.remoteFs);
    } else {
      session.sessionContext = createLocalSession(sessionId, projectDir);
    }

    // Store autonomous mode on session state
    if (autonomousMode) {
      session.state.autonomousMode = true;
    }

    // Apply provider config if provided
    if (providerConfig) {
      getProviderRegistry().setConfig(providerConfig);
    }

    // Create the pi-coding-agent session inside the session context so tools see
    // the right project dir. The legacy ExecutorAgent is no longer used at this
    // layer — it's driven by the dhee_* tools.
    //
    // Idempotent on the agent: pi sessions hold the user's chat history, so
    // we MUST NOT recreate the agent when the user selects a different
    // project mid-conversation. Only the SessionContext (filesystem scope)
    // and the focusedProject marker change. The agent picks up the new
    // project via runTask's prepended "Active project" announcement.
    runInSession(session.sessionContext, () => {
      if (!session.agent) {
        const slug = projectDirName
          ? projectDirName.replace(/\.dhee$/, '')
          : (session.focusedProject ?? AMBIENT_PROJECT_SLUG);
        session.agent = new PiSessionAgent({
          role: session.role,
          sessionId,
          projectSlug: slug,
          ...(session.resumeSessionFile ? { resumeSessionFile: session.resumeSessionFile } : {}),
          focusProject: (name) => this.focusSessionProject(sessionId, name),
          onMedia: (event) => {
            const s = this.sessions.get(sessionId);
            s?.activeEvents?.onMediaGenerated?.(sessionId, event);
          },
        });
        session.initialized = false;
        // One-shot: clear so a later configure call (e.g. user switching
        // projects mid-conversation) doesn't try to reopen the same file.
        session.resumeSessionFile = undefined;
      }
    });

    if (projectDirName) {
      session.focusedProject = projectDirName.replace(/\.dhee$/, '');
      // Keep the sessionStore record's projectSlug current so per-project
      // resume queries see the latest focus. Best-effort — failure here
      // shouldn't break the configure call.
      try {
        setSessionProject(sessionId, session.focusedProject);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Ensure the session has a SessionContext + PiSessionAgent so the user can
   * chat before selecting a project. Uses default.dhee as the ambient
   * working directory; tool calls take an explicit `project` parameter so the
   * ambient context only matters for filesystem helpers that scope to a
   * project dir.
   */
  private ensureAmbientSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (!session.sessionContext) {
      const projectDir = 'default.dhee';
      session.sessionContext =
        session.mode === 'remote' && session.remoteFs
          ? createRemoteSession(sessionId, projectDir, session.remoteFs)
          : createLocalSession(sessionId, projectDir);
    }

    if (!session.agent) {
      runInSession(session.sessionContext, () => {
        const slug = session.focusedProject ?? AMBIENT_PROJECT_SLUG;
        session.agent = new PiSessionAgent({
          role: session.role,
          sessionId,
          projectSlug: slug,
          ...(session.resumeSessionFile ? { resumeSessionFile: session.resumeSessionFile } : {}),
          focusProject: (name) => this.focusSessionProject(sessionId, name),
          onMedia: (event) => {
            const s = this.sessions.get(sessionId);
            s?.activeEvents?.onMediaGenerated?.(sessionId, event);
          },
        });
        session.initialized = false;
        session.resumeSessionFile = undefined;
      });
    }
  }

  /**
   * Get an existing session.
   */
  getSession(sessionId: string): SessionState | undefined {
    const session = this.sessions.get(sessionId);
    return session?.state;
  }

  /**
   * Cross-project concurrency check. Returns the focusedProject slug of
   * any OTHER session that is currently `running` AND bound to a
   * different project than `currentFocusedProject`. Returns `null` when
   * it's safe to start a new run in the caller's session.
   *
   * Why this matters: the pipeline's `setActiveProjectDir` is a
   * process-global. Two sessions on different projects firing tasks at
   * once would race on that global and silently corrupt each other's
   * project.json. The JobManager serializes within a project; this
   * guard adds the cross-project layer.
   *
   * Ambient sessions (no focusedProject) don't trigger the guard either
   * direction — the agent can chat about projects without locking out
   * generation work.
   */
  private findCrossProjectConflict(
    currentSessionId: string,
    currentFocusedProject: string | undefined,
  ): string | null {
    for (const [otherSessionId, other] of this.sessions.entries()) {
      if (otherSessionId === currentSessionId) continue;
      if (other.state.status !== 'running') continue;
      if (!other.focusedProject) continue;
      if (other.focusedProject === currentFocusedProject) continue;
      return other.focusedProject;
    }
    return null;
  }

  getSessionTimerState(sessionId: string): {
    elapsedMs: number;
    running: boolean;
    completed: boolean;
  } | null {
    const session = this.sessions.get(sessionId);
    if (!session?.sessionContext) {
      return null;
    }

    try {
      return runInSession(session.sessionContext, () => {
        const project = loadProject();
        return {
          elapsedMs: getElapsedMs(),
          running: session.state.status === 'running',
          completed:
            session.state.status !== 'running' && !!project?.productionCompletedAt,
        };
      });
    } catch {
      return null;
    }
  }

  /**
   * Check if a session exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Bind a long-lived event bridge to a session. Survives across every
   * runTask invocation on this session — including server-initiated
   * turns (supervisor) that don't pass an eventCb directly.
   *
   * The IPC bridge (and any future WS layer) should call this once
   * per renderer connection, passing a stable callback over the
   * transport (e.g. `webContents.send`). Calling again with new
   * events replaces the binding (renderer-reload scenario).
   *
   * Silent no-op when the session doesn't exist yet — the bridge
   * may call this during a resume race window before the session
   * has been fully materialized.
   */
  bindSessionEventBridge(sessionId: string, events: ConversationEvents): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.persistentEvents = events;
  }

  /**
   * Clear the persistent event bridge for a session (renderer
   * disconnect). The session itself is left intact — only the bridge
   * is dropped.
   */
  unbindSessionEventBridge(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    delete session.persistentEvents;
  }

  /**
   * Pick the events sink to use for a given task. Passed-in events
   * win (caller-supplied bridge for one specific task); otherwise
   * fall back to the session's pinned `persistentEvents`. Returns
   * undefined when neither is set (legacy CLI / smoke paths).
   */
  private resolveTaskEvents(
    sessionId: string,
    passedEvents?: ConversationEvents,
  ): ConversationEvents | undefined {
    if (passedEvents) return passedEvents;
    const session = this.sessions.get(sessionId);
    return session?.persistentEvents;
  }

  /**
   * Single source of truth for status transitions. Writes the new
   * status to the session and emits `onSessionStatus` through the
   * effective event bridge so the renderer can react. Skips the emit
   * when the status is unchanged (avoids spurious duplicate events
   * during multi-step internal writes).
   */
  private setSessionStatus(
    sessionId: string,
    status: SessionState['status'],
    turnKind?: 'user' | 'supervisor',
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.state.status === status) return;
    session.state.status = status;
    const events = this.resolveTaskEvents(sessionId, session.activeEvents);
    try {
      events?.onSessionStatus?.(sessionId, {
        status,
        ...(turnKind ? { turnKind } : {}),
      });
    } catch {
      // Event sink failures shouldn't poison status writes.
    }
  }

  /**
   * Wait until the session's status changes away from `fromStatus`,
   * with a hard timeout. Used by runTask's auto-cancel path: after
   * cancelling the in-flight turn, we want to give it a beat to flip
   * to 'error' / 'completed' before we mark the session 'running'
   * again for the new task. If the previous turn refuses to die
   * within the timeout, we proceed anyway — the new turn will
   * overwrite status. Better than blocking the chat forever.
   */
  private async waitForStatusChange(
    sessionId: string,
    fromStatus: SessionState['status'],
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const session = this.sessions.get(sessionId);
      if (!session) return;
      if (session.state.status !== fromStatus) return;
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Refresh a session's activity timestamp to keep it eligible for resume.
   */
  touchSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    session.state.lastActivity = Date.now();
    return true;
  }

  /**
   * Check if a session has a configured agent.
   */
  isSessionConfigured(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return session?.agent != null;
  }

  /**
   * Get the tool names for a configured session's agent.
   */
  getSessionToolNames(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session?.agent?.getToolNames() ?? [];
  }

  /**
   * Update the remote filesystem for a session after websocket connect/reconnect.
   */
  setRemoteFileSystem(sessionId: string, remoteFs: IFileSystem): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    session.remoteFs = remoteFs;
    if (session.mode === 'remote') {
      if (session.sessionContext) {
        (
          session.sessionContext as SessionContext & {
            fs: IFileSystem;
            mode: 'remote';
          }
        ).fs = remoteFs;
      } else {
        session.sessionContext = createRemoteSession(
          sessionId,
          'default.dhee',
          remoteFs,
        );
      }
    }
    session.state.lastActivity = Date.now();
  }

  getSessionMode(sessionId: string): 'local' | 'remote' | null {
    return this.sessions.get(sessionId)?.mode ?? null;
  }

  setDesktopCapabilities(
    sessionId: string,
    capabilities: DesktopSessionCapabilities,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    session.desktopCapabilities = capabilities;
    session.state.lastActivity = Date.now();
  }

  getDesktopCapabilities(
    sessionId: string,
  ): DesktopSessionCapabilities | undefined {
    return this.sessions.get(sessionId)?.desktopCapabilities;
  }

  /**
   * Toggle autonomous mode on a running session.
   */
  setAutonomousMode(sessionId: string, enabled: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state.autonomousMode = enabled;
    session.agent?.setAutonomousMode(enabled);
    if (session.sessionContext) {
      runInSession(session.sessionContext, () => {
        updateProjectAutonomousMode(enabled);
      });
    }
  }

  /**
   * Pi-agent oversight runtime toggle (global). Mutates the
   * process-wide `oversightState` global. The desktop's
   * `dheeCoreManager` invokes this on Settings-panel changes AND on
   * chat-header toggle clicks; both surfaces share the same state.
   *
   * Note on session id: the parameter is preserved for IPC-shape
   * symmetry with `setAutonomousMode`, but oversight is global —
   * the value applies to ALL sessions, not just the caller's.
   * Future-friendly: when we want per-session overrides, this
   * becomes the place to layer them.
   */
  setPiOversight(_sessionId: string, enabled: boolean): void {
    setGlobalPiOversight(enabled);
  }

  /**
   * VLM master switch (global). Same global-state semantics as
   * setPiOversight. The runtime effective value is
   * `piOversight && vlmJudge` — VLM standalone has no consumer;
   * gating is enforced at the runner-singleton's read site, not
   * on writes.
   */
  setVLMJudge(_sessionId: string, enabled: boolean): void {
    setGlobalVLMJudge(enabled);
  }

  /**
   * Ensure project.json is present in the remote project cache so sync
   * helpers like loadProject() can read it. No-op for local sessions.
   */
  async ensureRemoteProjectJsonCached(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.sessionContext || session.sessionContext.mode !== 'remote') {
      return;
    }

    await runInSessionAsync(session.sessionContext, async () => {
      try {
        await requireSession().fs.readFile('project.json');
      } catch {
        // Missing or unreadable; persist may still no-op until a project exists on disk.
      }
    });
  }

  persistProjectConfiguration(
    sessionId: string,
    config: { templateId: string; style: string; duration: number; autonomousMode?: boolean },
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.sessionContext) {
      return false;
    }

    return runInSession(session.sessionContext, () => {
      return updateProjectConfiguration({
        templateId: config.templateId,
        style: config.style,
        duration: config.duration,
        autonomousMode: config.autonomousMode,
      });
    });
  }

  /**
   * Toggle parallel media generation on a running session.
   */
  setParallelMediaGeneration(sessionId: string, enabled: boolean): void {
    const session = this.sessions.get(sessionId);
    if (!session?.agent) return;
    // ExecutorAgent exposes setParallelMediaGeneration
    if ('setParallelMediaGeneration' in session.agent) {
      (session.agent as { setParallelMediaGeneration(e: boolean): void }).setParallelMediaGeneration(enabled);
    }
  }

  /**
   * Run a task in a session.
   * Wraps execution in the session's context so all tool/file operations
   * see the correct project directory and filesystem.
   *
   * `opts.stopAtStage` arms the executor's `/run-to <stage>` gate for
   * THIS invocation only — it's cleared in the finally block so the
   * long-lived agent instance doesn't carry state between tasks.
   */
  async runTask(
    sessionId: string,
    task: string,
    events?: ConversationEvents,
    opts?: { stopAtStage?: string },
  ): Promise<GenericAgentResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Back-to-back UX. Old behavior: throw "Session already has a
    // running task" — which surfaced to the renderer as "Couldn't
    // reach the agent" any time the user typed during pi-agent's
    // turn OR during the auto-engaged supervisor turn. New behavior:
    // user intent wins. Cancel the in-flight turn, wait briefly for
    // cleanup, then proceed with the new task. The chat is now
    // interruptible from anywhere — same effect as the client-side
    // optimistic cancel at ChatPanelEmbedded.tsx:1001, but moved to
    // the server so it's not racey with the renderer's stale
    // session.status view.
    if (session.state.status === 'running') {
      console.log(
        `[runTask] auto-cancel sessionId=${sessionId} prevTurnKind=${session.currentTurnKind ?? 'none'} — incoming task supersedes in-flight turn`,
      );
      this.cancelTask(sessionId);
      await this.waitForStatusChange(sessionId, 'running', 3000);
    }

    // Cross-project concurrency guard. kshana-core's pipeline reads a
    // process-global `activeProjectDir` (see tasks/video/workflow/
    // activeProject.ts); JobManager serializes per-project, but two
    // sessions for DIFFERENT projects would race on the global and
    // silently corrupt each other's project.json. Reject the second
    // dispatch until the first finishes. Idle / same-project sessions
    // pass through unchanged.
    const conflict = this.findCrossProjectConflict(sessionId, session.focusedProject);
    if (conflict) {
      throw new Error(
        `Another project ('${conflict}') has an active task. Cancel it before starting a new generation in this session.`,
      );
    }

    // Pi-orchestrator chat works without a project being selected — the user
    // can ask "what projects are available?" before picking one. If no project
    // is configured yet, set up an ambient context + agent on first message.
    // Run BEFORE the agent guard so a brand-new session (created via
    // createSession() but never configured) can still chat. Without this
    // ordering, the embedded desktop hits "Session agent not configured"
    // because focusSessionProject doesn't create an agent — only
    // configureSessionForProject and ensureAmbientSession do.
    if (!session.sessionContext || !session.agent) {
      this.ensureAmbientSession(sessionId);
    }
    if (!session.sessionContext || !session.agent) {
      throw new Error('Failed to initialize session context');
    }

    // Run the entire agent execution inside the session context
    return runInSession(session.sessionContext, async () => {
      // Initialize agent if not already done (queries model context length)
      if (!session.initialized) {
        await session.agent!.initialize();
        session.initialized = true;
      }

      // Update session state. setSessionStatus emits onSessionStatus
      // through the persistent event bridge so the renderer can show
      // a "thinking…" pill — and so the supervisor turn (turnKind set
      // ahead of the call) is distinguishable from a user turn.
      this.setSessionStatus(sessionId, 'running', session.currentTurnKind);
      session.state.lastActivity = Date.now();
      session.state.taskHistory.push(task);

      // Create abort controller for cancellation
      session.abortController = new AbortController();

      // Resolve effective events: passed-in events win (caller-supplied
      // bridge for one specific task), otherwise fall back to the
      // session's pinned persistentEvents (IPC bridge). This is what
      // makes supervisor turns visible — runSupervisorInvocation calls
      // runTask without events, but persistentEvents (bound by the IPC
      // bridge on connect) catches the fallback.
      const effectiveEvents = this.resolveTaskEvents(sessionId, events);

      // Set up event listeners
      this.setupEventListeners(sessionId, session.agent!, effectiveEvents);
      // Stash events on the session so non-agent-emitter callbacks
      // (e.g. PiSessionAgent's onMedia closure firing onMediaGenerated)
      // can reach the WS bridge while the run is in flight.
      session.activeEvents = effectiveEvents;

      // Start active timer + periodic checkpoint
      try { startTimer(); } catch { /* ignore if no project yet */ }
      session.timerCheckpointInterval = setInterval(() => {
        try { checkpointTimer(); } catch { /* ignore */ }
      }, TIMER_CHECKPOINT_INTERVAL_MS);

      // Arm the `/run-to <stage>` gate for this invocation. Guard with a
      // capability check so non-executor agents (if any) don't break.
      const agent = session.agent!;
      const hasStageGate = typeof (agent as { setStopAtStage?: unknown }).setStopAtStage === 'function';
      if (opts?.stopAtStage && hasStageGate) {
        (agent as unknown as { setStopAtStage(s: string | null): void }).setStopAtStage(opts.stopAtStage);
      }

      const workflowName = this.getWorkflowName(session);
      const workflowStartedAt = Date.now();
      captureWorkflowStarted({
        sessionId,
        workflowName,
      });

      // Announce the focused project on the first turn after it changes — pi
      // remembers it in its conversation context, so we only inject once.
      const announced = applyProjectAnnouncement(task, session.focusedProject, session.announcedProject);
      session.announcedProject = announced.announcedProject;
      const effectiveTask = announced.task;

      // Instrumentation: pi-agent's internal loop is silent today, so
      // when a turn ends without visible output (the 2026-05-22 "agent
      // did two reads then stopped" repro) we have no log to grep for
      // why. Log entry/exit with task preview, turnKind, output length
      // — every chat turn — so the NEXT silent failure leaves a usable
      // breadcrumb trail.
      const turnTag = session.currentTurnKind ?? 'user';
      const taskPreview = effectiveTask.replace(/\s+/g, ' ').slice(0, 80);
      console.log(`[runTask] start sessionId=${sessionId} turnKind=${turnTag} task='${taskPreview}'`);
      const runStartedAt = Date.now();
      try {
        const result = await session.agent!.run(effectiveTask);

        // Stop active timer + checkpoint interval
        if (session.timerCheckpointInterval) { clearInterval(session.timerCheckpointInterval); session.timerCheckpointInterval = undefined; }
        try { stopTimer(); } catch { /* ignore */ }

        // Update session state based on result
        session.state.lastActivity = Date.now();
        if (result.status === 'waiting_for_user') {
          this.setSessionStatus(sessionId, 'awaiting_input', session.currentTurnKind);
        } else if (result.status === 'completed') {
          this.setSessionStatus(sessionId, 'completed', session.currentTurnKind);
        } else if (result.status === 'error' || result.status === 'interrupted') {
          this.setSessionStatus(sessionId, 'error', session.currentTurnKind);
        }

        const outputLen = (result.output ?? '').length;
        const elapsedMs = Date.now() - runStartedAt;
        console.log(
          `[runTask] end   sessionId=${sessionId} turnKind=${turnTag} status=${result.status} outputLen=${outputLen} elapsedMs=${elapsedMs}`,
        );

        // Silent-agent escape hatch: when the agent resolves without
        // anything visible (interrupted OR completed-but-empty), push
        // a notification so the chat shows a system row instead of
        // going quiet. The user knows the turn ended, can decide to
        // retry, and we have a log breadcrumb for the next debug.
        //
        // Suppress when the user themselves clicked Stop — they
        // already know the turn was interrupted, the extra warning
        // is noise. The userInitiatedCancel flag is consumed here
        // so subsequent silent ends still surface normally.
        if (isSilentAgentResult(result)) {
          const userCancelled = !!session.userInitiatedCancel;
          if (session.userInitiatedCancel) {
            session.userInitiatedCancel = false; // consume the flag
          }
          if (userCancelled) {
            console.log(
              `[runTask] SILENT sessionId=${sessionId} suppressed (user-initiated stop)`,
            );
          } else {
            // Be specific about WHAT happened so the user can act on
            // it instead of guessing. The two real-world causes for a
            // status='completed' + outputLen=0 turn are:
            //   1. The LLM API returned an empty completion (no text,
            //      no tool calls). Common with some OpenRouter
            //      providers under load, or with models that
            //      occasionally short-circuit on short prompts.
            //   2. The run was cancelled mid-stream by something
            //      other than the user (the runTask auto-cancel for
            //      back-to-back messages, or pi-agent's internal
            //      stop). User-initiated stops are filtered above.
            const isInterrupt = result.status === 'interrupted';
            const reasonLog = isInterrupt
              ? "the run was interrupted before it finished"
              : "the LLM returned an empty response (no text, no tool calls)";
            console.log(`[runTask] SILENT sessionId=${sessionId} reason="${reasonLog}" elapsedMs=${elapsedMs}`);
            const userMessage = isInterrupt
              ? "⚠️ The run was interrupted before the agent finished. Try sending the message again."
              : `⚠️ The model returned no response — no text and no tool calls (after ${Math.round(elapsedMs / 1000)}s). This is usually a model/provider issue. Try resending; if it keeps happening, switch to a different LLM model in Settings.`;
            try {
              effectiveEvents?.onNotification?.(sessionId, {
                level: 'warning',
                message: userMessage,
              });
            } catch {
              // notification sink failure is non-fatal
            }
          }
        }

        captureWorkflowCompleted({
          sessionId,
          workflowName,
          durationMs: Math.max(0, Date.now() - workflowStartedAt),
        });

        return result;
      } catch (error) {
        // Stop active timer + checkpoint interval on error
        if (session.timerCheckpointInterval) { clearInterval(session.timerCheckpointInterval); session.timerCheckpointInterval = undefined; }
        try { stopTimer(); } catch { /* ignore */ }
        this.setSessionStatus(sessionId, 'error', session.currentTurnKind);
        session.state.lastActivity = Date.now();
        const errName = error instanceof Error ? error.name : 'unknown_error';
        const errMsg = error instanceof Error ? error.message : String(error);
        console.log(
          `[runTask] THROW sessionId=${sessionId} turnKind=${turnTag} err=${errName} msg='${errMsg.slice(0, 200)}'`,
        );
        captureWorkflowFailed({
          sessionId,
          workflowName,
          errorType: errName,
          durationMs: Math.max(0, Date.now() - workflowStartedAt),
        });
        throw error;
      } finally {
        // Always clear the stage gate — per-invocation, never persists across tasks.
        if (hasStageGate) {
          (agent as unknown as { setStopAtStage(s: string | null): void }).setStopAtStage(null);
        }
        // Clean up event listeners
        session.agent!.removeAllListeners();
        session.abortController = undefined;
        session.activeEvents = undefined;
      }
    });
  }

  /**
   * Focus a project as the active project for this session. Called from the
   * dhee_focus_project tool so the agent can pick a project from the chat
   * without the user needing to use the dropdown. Updates the session's
   * filesystem context, persists the project's stored config, and notifies
   * the frontend so panels (storyboard / phase / timeline) can populate.
   */
  async focusSessionProject(sessionId: string, projectName: string): Promise<{
    projectName: string;
    title?: string;
    style?: string;
    phase?: string;
    templateId: string;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    // Resolve the on-disk folder via the shared resolver so both
    // naming conventions work — `<name>.dhee` (canonical) and
    // `<name>` (dhee-desktop's NewProjectDialog default). Earlier
    // this hardcoded `<name>.dhee` and ENOENT'd on desktop projects.
    let projectDirAbs: string;
    try {
      projectDirAbs = resolveProjectDir({
        name: projectName,
        basePath: defaultBasePath(),
      });
    } catch (err) {
      const detail =
        err instanceof ProjectDirNotFoundError ? err.message : String(err);
      throw new Error(
        `Project '${projectName}' not found or unreadable. ${detail}`,
      );
    }
    const projectDirName = nodePath.basename(projectDirAbs);

    // Backfill the denormalized `scenes[]` mirror from on-disk state
    // before reading project.json. Fixes the long-standing gap where
    // executorState.nodes was populated by the executor but scenes[]
    // stayed empty, because the older addAsset path silently bailed
    // on shot frames. The helper is idempotent — it short-circuits
    // when scenes[] is already populated — so safe to invoke on every
    // focus. Without this, UI readers (PromptsView's two-column
    // layout, kshana_show_first_frame, etc.) come up blank on
    // projects that ran end-to-end before the addAsset fix landed.
    try {
      const backfillResult = backfillSceneTreeIfStale(projectDirAbs);
      if (backfillResult.ran) {
        // Log only when something actually happened — otherwise the
        // logs get noisy on every project open.
        // eslint-disable-next-line no-console
        console.log(
          `[focusSessionProject] backfilled scenes[] for ${projectName}: ` +
          `frames=${backfillResult.framesAdded ?? 0} videos=${backfillResult.videosAdded ?? 0} ` +
          `finalVideo=${backfillResult.finalVideoSet ?? false}`,
        );
      }
    } catch (err) {
      // Backfill failure is non-fatal — project might be readable
      // even if the backfill stumbles. Surface for debugging but
      // continue with the focus flow.
      // eslint-disable-next-line no-console
      console.warn(
        `[focusSessionProject] backfillSceneTreeIfStale failed for ${projectName}: ${(err as Error).message}`,
      );
    }

    let project: NonNullable<ReturnType<typeof loadProject>>;
    try {
      const projectJsonPath = nodePath.join(projectDirAbs, 'project.json');
      if (!nodeFs.existsSync(projectJsonPath)) {
        throw new Error(`project.json not found at ${projectJsonPath}`);
      }
      const raw = nodeFs.readFileSync(projectJsonPath, 'utf-8');
      project = JSON.parse(raw) as NonNullable<ReturnType<typeof loadProject>>;
    } catch (err) {
      throw new Error(
        `Project '${projectName}' not found or unreadable. ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const templateId = project.templateId ?? 'narrative';
    const style = project.style ?? 'cinematic_realism';
    const duration = project.targetDuration ?? 60;

    // Refresh the session context to point at the focused project so any
    // file-system helpers that scope to a project (asset registry, etc.) see
    // the right cwd. Preserve the existing agent — we don't want to recreate
    // pi mid-conversation; pi tools already take an explicit project param.
    if (session.mode === 'remote' && session.remoteFs) {
      session.sessionContext = createRemoteSession(sessionId, projectDirName, session.remoteFs);
    } else {
      session.sessionContext = createLocalSession(sessionId, projectDirName);
    }

    session.focusedProject = projectName;
    try {
      setSessionProject(sessionId, projectName);
    } catch {
      // sessionStore not initialized yet (e.g. in-memory session) — ignore
    }
    // Do NOT pre-mark this project as announced. Both the agent's own
    // dhee_focus_project tool AND the desktop's IPC focusProject
    // bridge land here, but only the agent path already sees the
    // focus inside its tool result; the desktop path opens a project
    // BEFORE any agent turn has run. Pre-setting `announcedProject`
    // caused `applyProjectAnnouncement` to silently skip the prefix
    // on the very first user message, leaving pi-agent to guess the
    // active project from `dhee_list_projects` (the BurgerEating-vs-
    // The-Village miss from the field). A redundant announcement when
    // the agent itself just focused is cheap; a missed announcement
    // when the desktop just focused is a wrong-project answer.
    session.announcedProject = undefined;

    // Persist the configuration so a reconnect resumes on this project.
    try {
      this.persistProjectConfiguration(sessionId, { templateId, style, duration });
    } catch {
      /* persisting is best-effort — non-fatal if storage is unavailable */
    }

    const tools = session.agent?.getToolNames() ?? [];
    session.activeEvents?.onProjectFocused?.(sessionId, {
      projectName,
      templateId,
      style,
      duration,
      tools,
    });

    return {
      projectName,
      title: project.title,
      style: project.style,
      phase: project.currentPhase,
      templateId,
    };
  }

  /**
   * Read the agent's last stop reason. Used by WebSocketHandler to
   * distinguish "paused at stage" from "completed" when emitting the
   * final status message.
   */
  getAgentStopReason(sessionId: string): 'complete' | 'paused_at_stage' | 'cancelled' | 'failed' | null {
    const session = this.sessions.get(sessionId);
    const agent = session?.agent;
    if (agent && typeof (agent as { getStopReason?: unknown }).getStopReason === 'function') {
      return (agent as unknown as { getStopReason(): 'complete' | 'paused_at_stage' | 'cancelled' | 'failed' | null }).getStopReason();
    }
    return null;
  }

  /**
   * Send a user response to continue a paused session.
   * Wraps execution in the session's context.
   */
  async sendResponse(
    sessionId: string,
    response: string,
    events?: ConversationEvents
  ): Promise<GenericAgentResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (!session.agent) {
      throw new Error('Session agent not configured. Select a project first.');
    }

    if (session.state.status !== 'awaiting_input') {
      throw new Error('Session is not awaiting input');
    }

    if (!session.sessionContext) {
      throw new Error('Session context not initialized.');
    }

    return runInSession(session.sessionContext, async () => {
      // Update session state via the helper so onSessionStatus emits.
      this.setSessionStatus(sessionId, 'running', session.currentTurnKind);
      session.state.lastActivity = Date.now();

      // Create abort controller for cancellation
      session.abortController = new AbortController();

      // Resolve effective events with persistentEvents fallback.
      const effectiveEvents = this.resolveTaskEvents(sessionId, events);

      // Set up event listeners
      this.setupEventListeners(sessionId, session.agent!, effectiveEvents);
      session.activeEvents = effectiveEvents;

      // Start active timer + periodic checkpoint
      try { startTimer(); } catch { /* ignore */ }
      session.timerCheckpointInterval = setInterval(() => {
        try { checkpointTimer(); } catch { /* ignore */ }
      }, TIMER_CHECKPOINT_INTERVAL_MS);

      try {
        const result = await session.agent!.run('', response);

        // Stop active timer + checkpoint interval
        if (session.timerCheckpointInterval) { clearInterval(session.timerCheckpointInterval); session.timerCheckpointInterval = undefined; }
        try { stopTimer(); } catch { /* ignore */ }

        // Update session state based on result
        session.state.lastActivity = Date.now();
        if (result.status === 'waiting_for_user') {
          this.setSessionStatus(sessionId, 'awaiting_input', session.currentTurnKind);
        } else if (result.status === 'completed') {
          this.setSessionStatus(sessionId, 'completed', session.currentTurnKind);
        } else if (result.status === 'error' || result.status === 'interrupted') {
          this.setSessionStatus(sessionId, 'error', session.currentTurnKind);
        }

        return result;
      } catch (error) {
        // Stop active timer + checkpoint interval on error
        if (session.timerCheckpointInterval) { clearInterval(session.timerCheckpointInterval); session.timerCheckpointInterval = undefined; }
        try { stopTimer(); } catch { /* ignore */ }
        this.setSessionStatus(sessionId, 'error', session.currentTurnKind);
        session.state.lastActivity = Date.now();
        throw error;
      } finally {
        // Clean up event listeners
        session.agent!.removeAllListeners();
        session.abortController = undefined;
        session.activeEvents = undefined;
      }
    });
  }

  /**
   * Set up event listeners for agent events.
   */
  private setupEventListeners(
    sessionId: string,
    agent: SessionAgent,
    events?: ConversationEvents
  ): void {
    const session = this.sessions.get(sessionId);
    const projectDir = session?.sessionContext?.projectDir;
    const workflowName = session ? this.getWorkflowName(session) : 'unknown';

    if (!events) return;

    if (events.onProgress) {
      agent.on('progress', (data) => {
        events.onProgress!(sessionId, data.percentage, data.message);
      });
    }

    if (events.onToolCall) {
      agent.on('tool_call', (data) => {
        captureToolCallStarted({
          sessionId,
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          agentName: data.agentName ?? workflowName,
          args: data.arguments,
          projectDir,
          workflowName,
        });
        events.onToolCall!(
          sessionId,
          data.toolCallId,
          data.toolName,
          data.arguments,
          data.agentName,
        );
      });
    }

    if (events.onToolResult) {
      agent.on('tool_result', (data) => {
        const errorMessage =
          typeof data.result === 'string'
            ? data.result
            : (
              typeof data.result === 'object' &&
              data.result !== null &&
              'error' in data.result &&
              typeof (data.result as { error?: unknown }).error === 'string'
            )
              ? (data.result as { error: string }).error
              : undefined;
        captureToolCallCompleted({
          sessionId,
          toolCallId: data.toolCallId,
          toolName: data.toolName,
          agentName: data.agentName ?? workflowName,
          isError: data.isError === true,
          errorMessage,
          projectDir,
          workflowName,
        });
        events.onToolResult!(
          sessionId,
          data.toolCallId,
          data.toolName,
          data.result,
          data.isError,
          data.agentName,
        );
      });
    }

    if (events.onStreamingText) {
      agent.on('streaming_text', (data) => {
        events.onStreamingText!(sessionId, data.chunk, data.done);
      });
    }

    if (events.onToolStreaming) {
      agent.on('tool_streaming', (data) => {
        events.onToolStreaming!(sessionId, data.toolCallId, data.chunk, data.done, data.agentName, data.toolName, data.reset);
      });
    }

    if (events.onTodoUpdate) {
      agent.on('todo_update', (data) => {
        events.onTodoUpdate!(sessionId, data.todos);
      });
    }

    if (events.onAgentText) {
      agent.on('agent_text', (data) => {
        events.onAgentText!(sessionId, data.text, data.isFinal);
      });
    }

    if (events.onAgentStatus) {
      agent.on('agent_status', (data) => {
        events.onAgentStatus!(sessionId, data.status, data.agentName);
      });
    }

    if (events.onQuestion) {
      agent.on('question', (data) => {
        events.onQuestion!(sessionId, data.question, data.isConfirmation, data.options, data.autoApproveTimeoutMs);
      });
    }

    if (events.onContextUsage) {
      agent.on('context_usage', (data) => {
        events.onContextUsage!(sessionId, data);
      });
    }

    if (events.onPhaseTransition) {
      agent.on('phase_transition', (data) => {
        events.onPhaseTransition!(sessionId, data);
      });
    }

    if (events.onTimelineUpdate) {
      agent.on('timeline_update', (data) => {
        events.onTimelineUpdate!(sessionId, { timeline: data.timeline });
      });
    }

    if (events.onNotification) {
      agent.on('notification', (data) => {
        events.onNotification!(sessionId, data);
      });
    }
  }

  /**
   * Cancel a running task.
   *
   * Two execution paths can be live for one chat:
   *   1. The pi-agent's own loop (`session.agent`) — stopped via
   *      `agent.stop()` + `abortController.abort()`.
   *   2. A `BackgroundTaskRunner` task the pi-agent dispatched
   *      (`dhee_dispatch_run_to`) — runs OUT of the chat's call
   *      stack with its own AbortController.
   *
   * Stop must terminate BOTH. Pre-2026-05-04 only (1) was cancelled,
   * so the desktop's Stop button left the runner ploughing through
   * shots while the chat's "Stopping..." spinner span forever. Only
   * the runner task matching THIS session's id is touched — other
   * chat windows' work is independent.
   */
  cancelTask(
    sessionId: string,
    onProgress?: (step: { lane: 'agent' | 'abort' | 'comfy' | 'runner' | 'summary'; message: string }) => void,
    opts?: { userInitiated?: boolean },
  ): boolean {
    const session = this.sessions.get(sessionId);

    // Mark the cancel source so the silent-agent escape hatch in
    // runTask can suppress its "Agent didn't respond" notification
    // when the user themselves clicked Stop — they obviously know the
    // turn was interrupted, the extra warning row is just noise. The
    // flag is consumed (read + cleared) once by isSilentAgentResult's
    // handler so subsequent silent ends still surface normally.
    if (session && opts?.userInitiated) {
      session.userInitiatedCancel = true;
    }

    // Log the caller — pinning down WHO triggers a cancel is critical
    // for diagnosing "agent stopped silently" reports. The 2026-05-22
    // repro had a cancelTask in the logs with no obvious source.
    // Capture 4 frames of the stack so we can tell user-Stop from
    // server-side auto-cancel from runner cancel paths.
    const callerStack = new Error().stack?.split('\n').slice(2, 6).map(s => s.trim()).join(' << ') ?? '(no stack)';
    const currentStatus = session?.state.status ?? '(no session)';
    const turnKind = session?.currentTurnKind ?? 'none';
    const initBy = opts?.userInitiated ? 'user' : 'server';
    console.log(
      `[cancelTask] CALLED sessionId=${sessionId} status=${currentStatus} turnKind=${turnKind} initiatedBy=${initBy} caller: ${callerStack}`,
    );

    // FM9 + user request 2026-05-19: `onProgress` lets the WebSocket /
    // IPC layer pipe per-lane progress into the chat panel so the user
    // sees WHAT is being cancelled instead of a stuck "Stopping…"
    // spinner. Messages are ephemeral chat bubbles — they MUST NOT
    // flow into the persisted JSONL chat history (the LLM shouldn't
    // see internal cancellation chatter as conversation context). The
    // default route is `session.activeEvents.onNotification`, which is
    // already wired to the renderer's chat panel via the notification
    // event channel; notifications are NOT persisted by the agent's
    // event recorder. Explicit `onProgress` overrides for tests or
    // server-mode callers that want raw lane info.
    const emit = (lane: 'agent' | 'abort' | 'comfy' | 'runner' | 'summary', message: string) => {
      console.log(`[cancelTask] ${lane}: ${message}`);
      try {
        if (onProgress) {
          onProgress({ lane, message });
        } else {
          session?.activeEvents?.onNotification?.(sessionId, {
            level: 'info',
            message: `🛑 ${message}`,
          });
        }
      } catch (err) {
        console.log(`[cancelTask] emit threw: ${(err as Error).message}`);
      }
    };

    // Inspect runner state ONCE up front so the decision helper sees a
    // consistent snapshot. Wrapped in try/catch because the runner is
    // initialized lazily and accessing it during early boot throws.
    let runnerActiveTaskId: string | null = null;
    try {
      const runner = getBackgroundTaskRunner();
      const active = runner.getActive();
      // FM1 fix (2026-05-19): no sessionId match here. Single-session
      // model — if the runner is busy, it's THIS user's work, period.
      // The old gate `active.spec.sessionId === sessionId` silently
      // dropped cancels after a session-rename (clearChatHistory mints
      // a fresh id on new-project create), leaving the runner ploughing
      // through shots while the chat's "Stopping..." spinner ran forever.
      if (active) runnerActiveTaskId = active.id;
    } catch {
      // Runner uninitialized — leave as null.
    }

    const plan = decideCancelActions({
      sessionExists: !!session,
      hasAgent: !!session?.agent,
      hasAbortController: !!session?.abortController,
      runnerActiveTaskId,
    });

    console.log(
      `[cancelTask] sessionId=${sessionId} outcome=${plan.outcome} ` +
        `plan: agent=${plan.signalAgent} abort=${plan.fireAbortController} ` +
        `comfy=${plan.interruptComfy} runnerTask=${plan.cancelRunnerTaskId ?? '-'}`,
    );

    if (!session) {
      emit('summary', `No active session to cancel (sessionId=${sessionId} not found).`);
      // FM8: when the sessionId doesn't match anything we know, return
      // false honestly rather than silently report "false" alongside
      // potentially-fired side-effects.
      return false;
    }

    emit('summary', 'Cancelling — waiting for active operations to wind down…');

    let agentSignaled = false;
    if (plan.signalAgent && session.agent) {
      try {
        session.agent.stop();
        agentSignaled = true;
        emit('agent', 'Stopping chat agent loop (will halt after the current step).');
      } catch (err) {
        emit('agent', `Chat agent stop failed: ${(err as Error).message}`);
      }
    }

    let abortFired = false;
    if (plan.fireAbortController && session.abortController) {
      try {
        session.abortController.abort();
        abortFired = true;
        emit('abort', 'Aborting in-flight LLM streams.');
      } catch (err) {
        emit('abort', `Abort signal failed: ${(err as Error).message}`);
      }
    }

    if (plan.interruptComfy) {
      // Fire-and-forget by design: interrupt is a best-effort GPU
      // release. Emit a chat update when the call resolves so the
      // user sees the count of jobs interrupted.
      emit('comfy', 'Interrupting ComfyUI prompts (releasing GPU)…');
      void import('../services/comfyui/activeJobs.js')
        .catch((err) => {
          emit('comfy', `ComfyUI interrupt failed to load: ${(err as Error).message}`);
          return null;
        })
        .then((mod) => {
          if (
            mod &&
            typeof (mod as { cancelAllActiveJobs?: unknown }).cancelAllActiveJobs ===
              'function'
          ) {
            (mod as { cancelAllActiveJobs: () => Promise<number> })
              .cancelAllActiveJobs()
              .then((n) =>
                emit(
                  'comfy',
                  n > 0
                    ? `ComfyUI interrupt sent for ${n} active job(s).`
                    : 'ComfyUI had no active prompts to interrupt.',
                ),
              )
              .catch((err) =>
                emit('comfy', `ComfyUI interrupt threw: ${(err as Error).message}`),
              );
          }
        });
    }

    let runnerCancelled = false;
    if (plan.cancelRunnerTaskId) {
      try {
        const runner = getBackgroundTaskRunner();
        runnerCancelled = runner.cancel(plan.cancelRunnerTaskId);
        emit(
          'runner',
          runnerCancelled
            ? `Background task ${plan.cancelRunnerTaskId} cancellation requested. In-flight work may take a few seconds to wind down.`
            : `Background task ${plan.cancelRunnerTaskId} was already idle — nothing to cancel.`,
        );
      } catch (err) {
        emit('runner', `Background task cancel threw: ${(err as Error).message}`);
      }
    }

    this.setSessionStatus(sessionId, 'idle');
    session.state.lastActivity = Date.now();

    const anythingHappenedHere =
      agentSignaled || abortFired || runnerCancelled || plan.interruptComfy;
    emit(
      'summary',
      anythingHappenedHere
        ? 'Cancel signals dispatched. The runner will mark the task cancelled once in-flight ops settle.'
        : 'Nothing was running to cancel.',
    );

    // FM8: the legacy `return !!(agent || abortController || backgroundCancelled)`
    // counted the OLD pre-cancel state, not what actually fired. Now we
    // return true only when at least one downstream signal actually
    // dispatched (or got skipped because nothing was running, which the
    // helper's outcome flag captures).
    const anythingHappened = agentSignaled || abortFired || runnerCancelled;
    return anythingHappened || plan.outcome === 'no_active_work';
  }

  /**
   * Turn the session's basename-style projectDir into an absolute path.
   * `focusSessionProject` stores `nodePath.basename(projectDirAbs)` in
   * sessionContext, so any disk-touching code on the session must
   * re-resolve through the project resolver (which knows both the
   * `<name>.dhee` and bare `<name>` conventions).
   */
  private resolveSessionProjectDirAbs(session: { sessionContext?: { projectDir: string } }): string {
    if (!session.sessionContext) {
      throw new Error(
        'Session project not configured. Call configureProject / focusProject first.',
      );
    }
    const name = session.sessionContext.projectDir;
    // If the host stored an absolute path (older code paths), trust it.
    if (nodePath.isAbsolute(name) && nodeFs.existsSync(name)) {
      return name;
    }
    try {
      return resolveProjectDir({ name, basePath: defaultBasePath() });
    } catch (err) {
      const detail =
        err instanceof ProjectDirNotFoundError ? err.message : String(err);
      throw new Error(`Project '${name}' not found or unreadable. ${detail}`);
    }
  }

  /**
   * Mark a set of executor nodes `pending` on disk without resuming
   * execution. Used by the desktop's Prompts-tab edit flow: after the
   * user saves a per-shot prompt change, the dependent image / video
   * node needs to be invalidated so the next pipeline run regenerates
   * from there. The user (not this method) is responsible for kicking
   * off that next run.
   *
   * Loads project.json under the session's projectDir, applies the
   * pure `applyInvalidation` op, and writes back. Mirrors what the
   * agent's `dhee_invalidate` tool does, minus the agent surface.
   */
  async invalidateNodes(
    sessionId: string,
    nodeIds: string[],
    source?: string,
  ): Promise<{ invalidated: string[]; notFound: string[] }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (!session.sessionContext) {
      throw new Error(
        'Session project not configured. Call configureProject / focusProject first.',
      );
    }
    if (session.state.status === 'running') {
      throw new Error(
        'Session has a running task — cannot invalidate while executing',
      );
    }

    // sessionContext.projectDir is a basename (e.g. "Baker and the Bee" or
    // "demo.dhee") — see focusSessionProject. Resolve to absolute before
    // touching disk; otherwise nodePath.join produces a CWD-relative path
    // and ENOENTs.
    const projectDirAbs = this.resolveSessionProjectDirAbs(session);
    const projectJsonPath = nodePath.join(projectDirAbs, 'project.json');
    if (!nodeFs.existsSync(projectJsonPath)) {
      throw new Error(`project.json not found at ${projectJsonPath}`);
    }
    const raw = nodeFs.readFileSync(projectJsonPath, 'utf-8');
    const project = JSON.parse(raw) as {
      executorState?: { nodes?: Record<string, unknown> };
    };
    if (!project.executorState || !project.executorState.nodes) {
      throw new Error(
        'Cannot invalidate — project has no executorState (run a stage first).',
      );
    }

    const result = applyInvalidation(
      project as Parameters<typeof applyInvalidation>[0],
      nodeIds,
    );
    atomicWriteFileSync(
      projectJsonPath,
      JSON.stringify(project, null, 2),
      'utf-8',
    );

    // Tell pi-agent that the project state just changed under it.
    // Without this, the next "resume" / "what's left?" question
    // would be answered from pi-agent's stale in-context view — it
    // would confidently say "everything is done" because its last
    // mental snapshot predates the user's UI mutation.
    //
    // Routed through the same supervisor scheduling as runner asset
    // events: deferred via setImmediate so the synthetic task runs
    // when the current event-loop tick clears, and gated by the same
    // `session.state.status === 'running'` check (we don't talk over
    // an active turn — the prompt-side "always re-check on resume"
    // rule covers the case where this event was dropped).
    //
    // SKIP entirely when source === 'redo_from_menu': the desktop's
    // "Redo from…" UI is about to send a runTask immediately as the
    // user's resume command. If we also emit the user_invalidate
    // event, pi-agent receives TWO instructions in the same turn —
    // (1) "DO NOT auto-dispatch from this event" and (2) the user
    // task "Continue running the pipeline". Pi-agent resolves the
    // conflict by acking the system rule and ignoring the user task
    // (observed 2026-05-19 on Soft Seinen: 138 nodes invalidated,
    // pi-agent replied "I'm paused and ready", runner never
    // started). The runTask alone is the unambiguous user intent;
    // no supervisor narration needed.
    const skipSupervisor = source === 'redo_from_menu';
    if (result.seeds.length > 0 && !skipSupervisor) {
      this.scheduleSupervisorInvocation(
        'user_invalidate',
        {
          // Synthesize a TaskRecord-shaped placeholder so the
          // supervisor's task-id-based circuit breaker treats this as
          // a fresh non-runner event.
          id: `user_invalidate_${Date.now()}`,
          spec: {
            sessionId,
            kind: 'user_invalidate',
            projectName: session.focusedProject ?? '(ambient)',
          },
        } as never,
        { seeds: result.seeds, ...(source ? { source } : {}) },
      );
    }

    return result;
  }

  /**
   * Redo a specific node: invalidate it + dependents, then resume execution.
   */
  async redoNode(
    sessionId: string,
    nodeId: string,
    events?: ConversationEvents,
    editedPrompt?: Record<string, unknown>,
    frame?: string,
    scope?: 'prompt',
  ): Promise<GenericAgentResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    if (session.state.status === 'running') {
      throw new Error('Session already has a running task — cannot redo while executing');
    }
    const conflict = this.findCrossProjectConflict(sessionId, session.focusedProject);
    if (conflict) {
      throw new Error(
        `Another project ('${conflict}') has an active task. Cancel it before starting a new regeneration here.`,
      );
    }
    // We need sessionContext to know where the project lives, but we do
    // NOT need session.agent — redoNode now runs the executor in-process
    // (see runExecutor below). The agent gate was a relic of the legacy
    // ExecutorAgent path that was never created in production.
    if (!session.sessionContext) {
      throw new Error(
        'Session project not configured. Call configureProject / focusProject first.',
      );
    }

    // If user edited the prompt, save it to disk BEFORE invalidation.
    const hasEdits = !!(editedPrompt && Object.keys(editedPrompt).length > 0);
    if (hasEdits) {
      const { saveEditedPrompt } = await import('./editAndRedo.js');
      const projectDirAbs = this.resolveSessionProjectDirAbs(session);
      await saveEditedPrompt(projectDirAbs, nodeId, editedPrompt);
    }

    // Edit-prompt special case: keep the user's edited prompt, regen
    // only the dependent shot_image. Frame preserved so just that frame
    // regenerates.
    let redoTargetNodeId = nodeId;
    let redoOpts: { frame?: string; scope?: 'prompt' | 'image_only' } = { frame, scope };
    if (hasEdits && nodeId.startsWith('shot_image_prompt:')) {
      redoTargetNodeId = nodeId.replace('shot_image_prompt:', 'shot_image:');
      redoOpts = { scope: 'image_only', frame };
    }

    return await this.runRegenInProcess(
      sessionId,
      redoTargetNodeId,
      redoOpts,
      events,
    );
  }

  /**
   * In-process surgical regen.
   *
   * Replaces the previous subprocess path (which shelled out to
   * `tsx scripts/regen-node.ts`). That path was dev-only — packaged
   * kshana-desktop builds ship no `tsx`, no `scripts/` directory, and
   * no `pnpm`. The canonical packaged-runtime path is
   * `src/server/runners/runExecutor.ts`, whose own header docs name
   * this exact trap.
   *
   * Flow:
   *   1. Read project.json from disk
   *   2. Map (frame, scope) → applyInvalidation options, mirroring
   *      ExecutorAgent.redoNode's dispatch (src/core/planner/
   *      ExecutorAgent.ts:1041) so behavior matches the legacy in-process
   *      redo.
   *   3. Persist the invalidated state.
   *   4. Run the executor in-process scoped to `lastInvalidatedIds`
   *      via `target.runOnly`.
   *   5. Bridge runExecutor's events (tool / result / notification /
   *      asset) onto the supplied ConversationEvents so the chat panel
   *      sees streaming progress just like a normal `runTask`.
   */
  private async runRegenInProcess(
    sessionId: string,
    nodeId: string,
    opts: { frame?: string; scope?: 'prompt' | 'image_only' },
    events?: ConversationEvents,
  ): Promise<GenericAgentResult> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.sessionContext) {
      throw new Error(`Session not found or not configured: ${sessionId}`);
    }

    const { applyInvalidation } = await import(
      '../core/planner/applyInvalidation.js'
    );
    const { runExecutor } = await import('./runners/runExecutor.js');

    const projectDirAbs = this.resolveSessionProjectDirAbs(session);
    const projectJsonPath = nodePath.join(projectDirAbs, 'project.json');
    if (!nodeFs.existsSync(projectJsonPath)) {
      throw new Error(`project.json not found at ${projectJsonPath}`);
    }

    const projectRaw = nodeFs.readFileSync(projectJsonPath, 'utf-8');
    const project = JSON.parse(projectRaw) as {
      executorState?: { nodes?: Record<string, unknown>; lastInvalidatedIds?: string[] };
    };
    if (!project.executorState || !project.executorState.nodes) {
      throw new Error(
        'Cannot regenerate — project has no executorState. Run the pipeline first.',
      );
    }

    // ── Map (frame, scope) → applyInvalidation calls. Same matrix as
    // ExecutorAgent.redoNode and scripts/regen-node.ts.
    const { frame, scope } = opts;
    const projectLike = project as Parameters<typeof applyInvalidation>[0];
    if (scope === 'prompt') {
      const shotImageNodeId = nodeId.startsWith('shot_image_prompt:')
        ? nodeId.replace('shot_image_prompt:', 'shot_image:')
        : nodeId.startsWith('shot_image:')
          ? nodeId
          : null;
      if (!shotImageNodeId) {
        throw new Error(
          `scope='prompt' requires a shot_image_prompt:* or shot_image:* node (got "${nodeId}")`,
        );
      }
      const promptNodeId = shotImageNodeId.replace(
        'shot_image:',
        'shot_image_prompt:',
      );
      // Two seeds: invalidate the prompt by itself (no cascade), then
      // the image with cascadeOnlyCompleted so the downstream video
      // already on disk flips to pending.
      applyInvalidation(projectLike, [promptNodeId], { cascade: false });
      applyInvalidation(projectLike, [shotImageNodeId], {
        cascade: true,
        cascadeOnlyCompleted: true,
      });
    } else if (scope === 'image_only' || frame) {
      const preserveOthers = frame === 'last_frame' || frame === 'mid_frame';
      applyInvalidation(projectLike, [nodeId], {
        cascade: true,
        cascadeOnlyCompleted: true,
        ...(preserveOthers
          ? { preserveFramesOther: true, singleFrame: frame }
          : {}),
      });
    } else {
      applyInvalidation(projectLike, [nodeId], { cascade: true });
    }

    atomicWriteFileSync(
      projectJsonPath,
      JSON.stringify(project, null, 2),
      'utf-8',
    );

    const runOnly =
      (project.executorState as { lastInvalidatedIds?: string[] })
        .lastInvalidatedIds ?? [];
    if (runOnly.length === 0) {
      throw new Error(
        `No nodes were invalidated for ${nodeId}. Either it does not exist or its on-disk record is malformed.`,
      );
    }

    // ── Stream-events bridge. Mirror the previous subprocess wiring so
    // the chat panel's tool-card / media-generated handlers light up.
    const toolCallId = `regen_${Date.now()}`;
    this.setSessionStatus(sessionId, 'running');
    session.state.lastActivity = Date.now();
    const effectiveEvents = this.resolveTaskEvents(sessionId, events);
    session.activeEvents = effectiveEvents;

    effectiveEvents?.onToolCall?.(
      sessionId,
      toolCallId,
      'kshana_regen',
      {
        node: nodeId,
        run_only: runOnly,
        ...(frame ? { frame } : {}),
        ...(scope ? { scope } : {}),
      },
      'kshana',
    );

    try {
      const result = await runExecutor({
        project: project as Parameters<typeof runExecutor>[0]['project'],
        projectDir: projectDirAbs,
        target: { runOnly },
        name: 'dhee-regen-in-process',
        onTool: (info) => {
          const hint = info.nodeId ? ` ${info.nodeId}` : '';
          effectiveEvents?.onToolStreaming?.(
            sessionId,
            toolCallId,
            `[${info.toolName}]${hint}\n`,
            false,
            'dhee',
            'dhee_regen',
            false,
          );
        },
        onResult: (info) => {
          if (info.filePath) {
            effectiveEvents?.onToolStreaming?.(
              sessionId,
              toolCallId,
              `  → ${info.filePath}\n`,
              false,
              'dhee',
              'dhee_regen',
              false,
            );
          } else if (info.status) {
            effectiveEvents?.onToolStreaming?.(
              sessionId,
              toolCallId,
              `  → ${info.status}\n`,
              false,
              'dhee',
              'dhee_regen',
              false,
            );
          }
          if (info.error) {
            effectiveEvents?.onToolStreaming?.(
              sessionId,
              toolCallId,
              `  ! ${info.error}\n`,
              false,
              'dhee',
              'dhee_regen',
              false,
            );
          }
        },
        onNotification: (info) => {
          effectiveEvents?.onToolStreaming?.(
            sessionId,
            toolCallId,
            `[${info.level}] ${info.message}\n`,
            false,
            'dhee',
            'dhee_regen',
            false,
          );
        },
        onAsset: (event) => {
          effectiveEvents?.onMediaGenerated?.(sessionId, {
            kind: event.kind,
            project: session.focusedProject ?? '',
            path: event.filePath,
            source: 'dhee_regen',
          });
        },
      });

      const ok = result.status === 'completed';
      effectiveEvents?.onToolResult?.(
        sessionId,
        toolCallId,
        'dhee_regen',
        {
          status: result.status,
          stopReason: result.stopReason ?? null,
          ...(result.error ? { error: result.error } : {}),
        },
        !ok,
        'dhee',
      );

      this.setSessionStatus(sessionId, ok ? 'completed' : 'error');
      session.activeEvents = undefined;

      return {
        status: ok ? 'completed' : 'error',
        output: ok
          ? `Regenerated ${nodeId} (${runOnly.length} node(s))`
          : `Regen failed: ${result.error ?? result.stopReason ?? 'unknown'}`,
        todos: [],
        ...(ok ? {} : { error: result.error ?? `regen status=${result.status}` }),
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      effectiveEvents?.onToolResult?.(
        sessionId,
        toolCallId,
        'dhee_regen',
        { error: msg },
        true,
        'dhee',
      );
      this.setSessionStatus(sessionId, 'error');
      session.activeEvents = undefined;
      throw err;
    }
  }

  /**
   * Delete a session.
   */
  deleteSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      const sessionDurationMs = Math.max(0, Date.now() - session.state.createdAt);
      captureSessionEnded(
        sessionId,
        sessionDurationMs,
        new Date(session.state.createdAt).toISOString(),
        session.state.taskHistory.length
      );

      // Cancel any running task. Pass 'shutdown' as the abort reason so
      // ExecutorAgent.stop() (wired up via linkAbortSignalToAgent in
      // runExecutor) can tag the resulting failed nodes with the
      // shutdown origin. resetAbortedNodes() then auto-recovers them on
      // the next run instead of leaving them in failed state requiring
      // manual invalidation. (Bug 17.)
      if (session.abortController) {
        session.abortController.abort('shutdown');
      }
      // Clear timer checkpoint interval
      if (session.timerCheckpointInterval) {
        clearInterval(session.timerCheckpointInterval);
        session.timerCheckpointInterval = undefined;
      }
      // Remotion infographic rendering is hosted by the desktop wrapper
      // (kshana-desktop/src/main/remotionManager.ts) — no kshana-core
      // cleanup needed. The previous in-kshana-core RemotionRenderer was
      // removed because its `npx remotion bundle` subprocess only ran in
      // dev (no npx in packaged builds).
      this.sessions.delete(sessionId);
      return true;
    }
    return false;
  }

  /**
   * Clean up stale sessions.
   */
  private cleanupStaleSessions(): void {
    const now = Date.now();
    // Sessions awaiting user input get a longer timeout (2 hours)
    // to survive long generation jobs + user think time
    const awaitingInputTimeout = Math.max(this.sessionTimeoutMs, 2 * 60 * 60 * 1000);
    for (const [sessionId, session] of this.sessions) {
      const timeout = session.state.status === 'awaiting_input'
        ? awaitingInputTimeout
        : this.sessionTimeoutMs;
      if (now - session.state.lastActivity > timeout) {
        this.deleteSession(sessionId);
      }
    }
  }

  /**
   * Get all active sessions.
   */
  getActiveSessions(): SessionState[] {
    return Array.from(this.sessions.values()).map((s) => s.state);
  }

  /**
   * Shutdown the manager.
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    // Cancel all running tasks and clear sessions
    for (const sessionId of this.sessions.keys()) {
      this.deleteSession(sessionId);
    }
  }
}
