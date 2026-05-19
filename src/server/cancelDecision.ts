/**
 * Pure cancel-action decision helper for `ConversationManager.cancelTask`.
 *
 * Why this exists: cancelTask used to silently swallow several cancel-loss
 * cases — `runner.cancel` was gated by a `sessionId === active.spec.sessionId`
 * check (FM1), and there was zero logging anywhere on the cancel path
 * (FM9), so when a Stop got lost in production there were no breadcrumbs
 * to even diagnose with. The 2026-05-19 stuck-Stopping incident traced
 * back to this gate silently dropping every cancel after a session-id
 * rename (chat-reset-on-new-project).
 *
 * Architectural decision: only ONE session is active at a time in the
 * desktop runtime today (single-window, single-chat). That means the
 * sessionId-match gate on `runner.cancel` is unnecessary — if a runner
 * task is alive, it's THIS user's work and Stop should always reach
 * it. If multi-session ever lands, revisit this helper, not the call
 * site.
 *
 * Pure — no I/O, no side effects. Returns the action plan; cancelTask
 * executes it and logs each step.
 */

export interface CancelInputs {
  /** Whether the session exists in the manager's map. */
  sessionExists: boolean;
  /** Whether the session has a pi-agent attached (set when runTask runs). */
  hasAgent: boolean;
  /** Whether the session has an AbortController attached (set during runTask). */
  hasAbortController: boolean;
  /** Active runner task id, or null if the runner is idle. */
  runnerActiveTaskId: string | null;
}

export type CancelOutcome =
  | 'no_session'        // sessionId didn't match any known session — caller bug
  | 'no_active_work'    // session exists but had no agent / controller / runner work
  | 'signals_dispatched'; // at least one cancel signal was sent downstream

export interface CancelActions {
  /** Call `session.agent.stop()`. */
  signalAgent: boolean;
  /** Call `session.abortController.abort()`. */
  fireAbortController: boolean;
  /** Always-fire ComfyUI POST /interrupt to release the GPU. */
  interruptComfy: boolean;
  /** Task id to pass into `runner.cancel(taskId)`, or null to skip. */
  cancelRunnerTaskId: string | null;
  /** Coarse outcome for telemetry / caller branching. */
  outcome: CancelOutcome;
}

export function decideCancelActions(inputs: CancelInputs): CancelActions {
  if (!inputs.sessionExists) {
    return {
      signalAgent: false,
      fireAbortController: false,
      interruptComfy: false,
      cancelRunnerTaskId: null,
      outcome: 'no_session',
    };
  }

  const hasAnyWork =
    inputs.hasAgent ||
    inputs.hasAbortController ||
    inputs.runnerActiveTaskId !== null;

  return {
    signalAgent: inputs.hasAgent,
    fireAbortController: inputs.hasAbortController,
    // ComfyUI's active-job interrupt is process-global, not session-scoped.
    // We fire it whenever the session exists, even when no agent / runner
    // is tracked — covers the edge case where a ComfyUI submission was
    // initiated outside the runner (e.g. probe scripts running in-process).
    interruptComfy: true,
    // FM1 fix: cancel any active runner task unconditionally. The
    // previous sessionId-match gate is removed (single-session model).
    cancelRunnerTaskId: inputs.runnerActiveTaskId,
    outcome: hasAnyWork ? 'signals_dispatched' : 'no_active_work',
  };
}
