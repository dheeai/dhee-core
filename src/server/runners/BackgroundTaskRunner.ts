/**
 * Single-slot background task runner.
 *
 * Long-ish dhee operations (dhee_run_to, dhee_regen,
 * dhee_audit_fidelity) take anywhere from seconds to hours. If the agent dispatches them as ordinary
 * blocking tool calls, the chat session is starved while the work
 * runs. This runner detaches them: dispatch returns instantly with
 * a task id, the actual execution happens off the agent's tool-call
 * loop, and progress streams back to the originating session via
 * the host's event bus.
 *
 * State semantics
 * ───────────────
 * Exactly ONE task is active at a time. A second `dispatch` while
 * one is running returns `{ status: 'rejected' }` with the active
 * task's id so the agent can decide:
 *   - call `cancel()` and re-dispatch
 *   - tell the user to wait
 *   - (future) `replace()` shorthand for cancel-then-dispatch
 *
 * The runner is intentionally not a queue today — single-slot is
 * easier to reason about and matches the user's model. Adding a
 * queue is a small extension when we need it.
 *
 * Pure state machine
 * ──────────────────
 * `BackgroundTaskRunner` itself only manages state and delegates
 * execution to a `TaskExecutor` injected at construction. This
 * keeps the runner unit-testable without booting any LLM, executor,
 * or IPC machinery — every test in
 * `tests/unit/BackgroundTaskRunner.test.ts` exercises the state
 * machine end-to-end via a stub executor.
 */

import { EventEmitter } from 'node:events';

export type TaskKind = 'run_to' | 'regen' | 'audit_fidelity';

export type TaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/** What the agent / desktop dispatches into the runner. */
export interface TaskSpec {
  kind: TaskKind;
  /** Project name (for display + identifying which project the task is on). */
  projectName: string;
  /** Free-form params interpreted by the executor for this kind. */
  params: Record<string, unknown>;
  /**
   * Source session id — events emitted while the task runs are
   * tagged with this so the renderer routes them to the right chat.
   */
  sessionId: string;
}

export interface TaskRecord {
  id: string;
  spec: TaskSpec;
  status: TaskStatus;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export type DispatchResult =
  | {
      status: 'started';
      taskId: string;
    }
  | {
      status: 'rejected';
      reason: 'task_already_running';
      activeTaskId: string;
      activeTaskKind: TaskKind;
      activeProjectName: string;
    };

/**
 * Hooks the executor calls so the runner can forward progress to
 * subscribers (dheeCoreManager → IPC → chat). They mirror the
 * shape of the existing runExecutor callbacks so wrapping tools is
 * trivial.
 */
export interface TaskExecutionHooks {
  onTool: (info: { toolName: string; nodeId?: string }) => void;
  onResult: (info: {
    toolName: string;
    filePath?: string;
    status?: string;
    /** Error message when status==='error'. Surfaces ComfyUI / LLM
     *  rejection reasons up to the chat session so the agent and the
     *  UI see WHY a tool errored, not just THAT it did. */
    error?: string;
  }) => void;
  onNotification: (info: { level: string; message: string }) => void;
  onAsset?: (info: {
    kind: 'image' | 'video';
    filePath: string;
    toolName?: string;
    nodeId?: string;
  }) => void;
}

export interface TaskExecutionContext {
  spec: TaskSpec;
  signal: AbortSignal;
  hooks: TaskExecutionHooks;
}

/**
 * Sentinel an executor can return to signal "the underlying job
 * cancelled itself" — used when cancellation came from a path the
 * AbortController never saw (e.g. `.executor.stop` sentinel,
 * cooperative shutdown on timeout). The runner classifies the task
 * as `cancelled` rather than `completed` in that case, so the chat
 * session sees the right terminal event.
 */
export interface ExecutorCancelled {
  cancelled: true;
}

/**
 * Executor: actually runs the task. Production wires this to
 * `runExecutor` (for run_to) / `redoNode` (for regen) / etc.;
 * tests inject a stub.
 *
 * Must:
 *   - Honor `signal` (return promptly when aborted)
 *   - Resolve `void` on success
 *   - Resolve `{ cancelled: true }` when the underlying job
 *     cancelled itself out-of-band (stop file, soft shutdown)
 *   - Reject (or throw) on error — the runner records it
 */
export type TaskExecutor = (ctx: TaskExecutionContext) => Promise<void | ExecutorCancelled>;

export interface BackgroundTaskRunnerEvents {
  started: { task: TaskRecord };
  tool: { task: TaskRecord; toolName: string; nodeId?: string };
  result: { task: TaskRecord; toolName: string; filePath?: string; status?: string; error?: string };
  notification: { task: TaskRecord; level: string; message: string };
  asset: {
    task: TaskRecord;
    kind: 'image' | 'video';
    filePath: string;
    toolName?: string;
    nodeId?: string;
  };
  completed: { task: TaskRecord };
  failed: { task: TaskRecord; error: string };
  cancelled: { task: TaskRecord };
}

let nextTaskCounter = 0;
function makeTaskId(): string {
  nextTaskCounter += 1;
  return `task-${Date.now().toString(36)}-${nextTaskCounter}`;
}

type RunnerEventName = keyof BackgroundTaskRunnerEvents;

export class BackgroundTaskRunner {
  private active: { record: TaskRecord; controller: AbortController } | null = null;
  /**
   * Set to `true` the moment `cancel()` is called and `abort()` is
   * dispatched on the AbortController. Cleared in `runActive()`'s
   * finally block alongside `this.active = null`. Surfaced via
   * `getActive()` and IPC status so the desktop's Stop/Resume button
   * can show "Stopping…" even when the cancel originated from a
   * non-UI path (e.g. pi-agent's `kshana_task_cancel` tool, an
   * automation calling the cancel IPC directly, or programmatic
   * replace()). Without this, only `handleCancel()` on the desktop
   * could flip the local pendingCancel — agent-initiated cancels
   * left the button stuck on "Stop" until runnerActive flipped,
   * mid-stream, with no "Stopping…" intermediate state to explain
   * the lag.
   */
  private cancelRequested = false;
  private readonly executor: TaskExecutor;
  private readonly emitter = new EventEmitter();

  constructor(executor: TaskExecutor) {
    this.executor = executor;
  }

  on<E extends RunnerEventName>(
    event: E,
    handler: (payload: BackgroundTaskRunnerEvents[E]) => void,
  ): () => void {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return () => {
      this.emitter.off(event, handler as (...args: unknown[]) => void);
    };
  }

  private emit<E extends RunnerEventName>(
    event: E,
    payload: BackgroundTaskRunnerEvents[E],
  ): void {
    this.emitter.emit(event, payload);
  }

  /** Returns the active task record (if any) — read-only snapshot. */
  getActive(): TaskRecord | null {
    if (!this.active) return null;
    return { ...this.active.record };
  }

  isBusy(): boolean {
    return this.active !== null;
  }

  /**
   * Queue a task. If nothing is running, kicks off execution and
   * returns `{ status: 'started', taskId }`. If something is
   * already running, rejects with the active task's metadata so the
   * caller can react.
   */
  dispatch(spec: TaskSpec): DispatchResult {
    if (this.active) {
      return {
        status: 'rejected',
        reason: 'task_already_running',
        activeTaskId: this.active.record.id,
        activeTaskKind: this.active.record.spec.kind,
        activeProjectName: this.active.record.spec.projectName,
      };
    }

    const record: TaskRecord = {
      id: makeTaskId(),
      spec,
      status: 'running',
      startedAt: Date.now(),
    };
    const controller = new AbortController();
    this.active = { record, controller };
    this.emit('started', { task: { ...record } });

    void this.runActive();

    return { status: 'started', taskId: record.id };
  }

  /**
   * Cancel the active task. Returns `false` when nothing is running
   * or when `taskId` is provided but doesn't match.
   *
   * In addition to aborting the local controller (which propagates to
   * the executor + LLM streams), this also fires POST /interrupt on
   * every in-flight ComfyUI prompt the executor submitted. Without
   * that step the local pipeline stops but the GPU job keeps running
   * to completion, burning paid Cloud credits the user thinks they
   * just reclaimed. See src/services/comfyui/activeJobs.ts.
   */
  cancel(taskId?: string): boolean {
    if (!this.active) return false;
    if (taskId && this.active.record.id !== taskId) return false;
    this.cancelRequested = true;
    this.active.controller.abort();
    // Fire-and-forget: interrupt does not need to complete before
    // cancel() returns. Errors are swallowed inside cancelAllActiveJobs.
    void import('../../services/comfyui/activeJobs.js').then(
      ({ cancelAllActiveJobs }) => cancelAllActiveJobs(),
    );
    return true;
  }

  /**
   * Cancel the current task (if any) and dispatch the new one.
   * Use this for the "replace what's running" UX shortcut.
   *
   * Note: the cancel signal can take a moment to propagate before
   * the active task actually terminates; until then the new
   * dispatch will still be rejected. Callers that need atomic
   * replace semantics should `cancel()` then await an idle event
   * before dispatching.
   */
  replace(spec: TaskSpec): DispatchResult {
    this.cancel();
    return this.dispatch(spec);
  }

  private async runActive(): Promise<void> {
    const slot = this.active;
    if (!slot) return;
    const { record, controller } = slot;
    const hooks: TaskExecutionHooks = {
      onTool: (info) =>
        this.emit('tool', {
          task: { ...record },
          toolName: info.toolName,
          ...(info.nodeId !== undefined ? { nodeId: info.nodeId } : {}),
        }),
      onResult: (info) =>
        this.emit('result', {
          task: { ...record },
          toolName: info.toolName,
          ...(info.filePath !== undefined ? { filePath: info.filePath } : {}),
          ...(info.status !== undefined ? { status: info.status } : {}),
          ...(info.error !== undefined ? { error: info.error } : {}),
        }),
      onNotification: (info) =>
        this.emit('notification', {
          task: { ...record },
          level: info.level,
          message: info.message,
        }),
      onAsset: (info) =>
        this.emit('asset', {
          task: { ...record },
          kind: info.kind,
          filePath: info.filePath,
          ...(info.toolName !== undefined ? { toolName: info.toolName } : {}),
          ...(info.nodeId !== undefined ? { nodeId: info.nodeId } : {}),
        }),
    };

    try {
      const outcome = await this.executor({ spec: record.spec, signal: controller.signal, hooks });
      const cancelledByOutcome = outcome !== undefined && outcome.cancelled === true;
      if (controller.signal.aborted || cancelledByOutcome) {
        record.status = 'cancelled';
        record.completedAt = Date.now();
        this.emit('cancelled', { task: { ...record } });
      } else {
        record.status = 'completed';
        record.completedAt = Date.now();
        this.emit('completed', { task: { ...record } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (controller.signal.aborted) {
        record.status = 'cancelled';
        record.completedAt = Date.now();
        this.emit('cancelled', { task: { ...record } });
      } else {
        record.status = 'failed';
        record.error = message;
        record.completedAt = Date.now();
        this.emit('failed', { task: { ...record }, error: message });
      }
    } finally {
      // Clear AFTER the terminal event so subscribers can read
      // active state without races.
      this.active = null;
      this.cancelRequested = false;
    }
  }

  /**
   * True if `cancel()` has been called on the active task but the
   * executor hasn't returned yet. Surfaced via IPC so the renderer
   * can show "Stopping…" for agent-initiated cancels too.
   */
  isCancelling(): boolean {
    return this.active !== null && this.cancelRequested;
  }
}

/**
 * Test-only helper: reset the task-id counter so per-test ids stay
 * predictable.
 */
export function __resetTaskIdCounterForTesting(): void {
  nextTaskCounter = 0;
}
