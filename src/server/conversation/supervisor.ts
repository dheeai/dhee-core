/**
 * Pure helpers for the runtime supervisor loop.
 *
 * The supervisor is "pi-agent re-invoked on a runner event". When
 * `oversightState.piOversight` is on, ConversationManager subscribes
 * to the runner's `failed` / `completed` / `asset` events and pushes
 * a `[SYSTEM EVENT]` message into the running session via `runTask`.
 * Pi-agent reads it in context with the rest of the conversation
 * and decides — terse text ack, tool call (dhee_invalidate /
 * dhee_run_to scope='last_invalidated' / dhee_show_shot), or
 * escalation back to the user.
 *
 * This module owns three concerns, all pure:
 *   - State shape (per-task counters, last-seen task id)
 *   - The circuit breaker decision (`shouldFireSupervisor`)
 *   - The synthetic-task formatter (`buildSupervisorTask`)
 *
 * The wiring (defer-via-setImmediate, runTask invocation, runner
 * subscription) lives in ConversationManager.
 */

export type SupervisorEvent = "failed" | "completed" | "asset" | "user_invalidate";

/**
 * Per-session supervisor bookkeeping. Keyed by task.id so a fresh
 * task starts with a fresh budget. Two independent caps:
 *
 *   - failed/completed share `failedCompletedCount` and a hard cap
 *     of `MAX_FAILED_COMPLETED_PER_TASK = 2`. One pipeline that
 *     keeps failing can't hammer the LLM forever.
 *   - asset events have `assetCount` and a higher cap of
 *     `MAX_ASSET_PER_TASK = 50`. A typical run produces 50-200
 *     assets; this cap is the soft limit before sampling kicks in
 *     (sampling lives in the wiring layer for now).
 */
export interface SupervisorState {
  /** Most recent task.id we've seen. When this changes, counters reset. */
  taskId: string | null;
  failedCompletedCount: number;
  assetCount: number;
}

export const MAX_FAILED_COMPLETED_PER_TASK = 2;
export const MAX_ASSET_PER_TASK = 50;

export function emptySupervisorState(): SupervisorState {
  return { taskId: null, failedCompletedCount: 0, assetCount: 0 };
}

/**
 * Decide whether the supervisor should fire a turn for this event.
 *
 * Resets counters when the task.id changes (new task = fresh
 * budget). Within a task, asset events check assetCount; failed
 * and completed share failedCompletedCount. Pure — call the
 * paired `recordSupervisorInvocation` to mutate state.
 */
export function shouldFireSupervisor(
  state: SupervisorState,
  event: SupervisorEvent,
  taskId: string,
): boolean {
  // Implicit reset on task-id change: the count for a stale task
  // shouldn't gate decisions on a new one.
  const sameTask = state.taskId === taskId;
  const failedCount = sameTask ? state.failedCompletedCount : 0;
  const assetCount = sameTask ? state.assetCount : 0;
  if (event === "asset") return assetCount < MAX_ASSET_PER_TASK;
  // user_invalidate is a user-driven event (Prompts-tab edit, Redo-
  // from menu) — uncapped on purpose. Each one is an explicit act
  // the user took; pi-agent needs to learn about every one so its
  // mental model of project state stays current. The circuit
  // breaker exists to keep pi-agent from hammering itself on
  // failure loops; user actions aren't a loop.
  if (event === "user_invalidate") return true;
  return failedCount < MAX_FAILED_COMPLETED_PER_TASK;
}

/**
 * Increment the relevant counter and pin the task.id. Returns a
 * new state object — caller persists it however they like.
 */
export function recordSupervisorInvocation(
  state: SupervisorState,
  event: SupervisorEvent,
  taskId: string,
): SupervisorState {
  const sameTask = state.taskId === taskId;
  const failedCompletedCount = sameTask ? state.failedCompletedCount : 0;
  const assetCount = sameTask ? state.assetCount : 0;
  if (event === "asset") {
    return {
      taskId,
      failedCompletedCount,
      assetCount: assetCount + 1,
    };
  }
  if (event === "user_invalidate") {
    // No counter change — user_invalidate is uncapped per
    // `shouldFireSupervisor`. We still bump `taskId` so a fresh
    // task with the same name doesn't inherit stale counts.
    return { taskId, failedCompletedCount, assetCount };
  }
  return {
    taskId,
    failedCompletedCount: failedCompletedCount + 1,
    assetCount,
  };
}

// ── buildSupervisorTask ────────────────────────────────────────────────

interface BaseSupervisorEventInfo {
  taskId: string;
  taskKind: string;
  projectName: string;
}

interface FailedEventInfo extends BaseSupervisorEventInfo {
  event: "failed";
  reason: string;
}

interface CompletedEventInfo extends BaseSupervisorEventInfo {
  event: "completed";
}

interface AssetEventInfo extends BaseSupervisorEventInfo {
  event: "asset";
  /** Path the executor reported (relative to projectDir). */
  assetPath: string;
  /** Prompt that was used to generate this asset. */
  assetPrompt: string;
  /**
   * Vision-LLM description of the image. Absent when VLM is off —
   * pi-agent then has no vision feedback, only path + prompt.
   */
  vlmDescription?: string;
}

/**
 * The user did something to the project state OUTSIDE of pi-agent's
 * conversation — saved an edit in the Prompts tab, picked "Redo
 * from..." in the dropdown, etc. The desktop's IPC layer calls
 * ConversationManager.invalidateNodes, which routes that mutation
 * through here so pi-agent learns about it.
 *
 * Without this event, pi-agent's in-context memory of project state
 * stays stuck at "everything was completed when I last looked", and
 * a follow-up "resume" instruction confidently reports "nothing to
 * do". The cooldown/prompt fixes shipped earlier nag pi-agent to
 * recheck — this event tells it WHAT changed and why.
 */
interface UserInvalidateEventInfo extends BaseSupervisorEventInfo {
  event: "user_invalidate";
  /** Node ids the user invalidated (seed set). Cascade ids are NOT
   *  included — pi-agent can derive them with dhee_status if it
   *  cares; the seeds are the user's intent. */
  seeds: string[];
  /** Where the invalidation originated. Free-form string so the
   *  desktop can pass "prompts_tab_save" / "redo_from_menu" /
   *  whatever — pi-agent doesn't dispatch on it, just for context. */
  source?: string;
}

export type SupervisorEventInfo =
  | FailedEventInfo
  | CompletedEventInfo
  | AssetEventInfo
  | UserInvalidateEventInfo;

/**
 * Format a runner event as a `[SYSTEM EVENT]` task message that
 * runTask can ingest. The prefix tells pi-agent (via the
 * orchestrator-prompt addition) that this is from the runtime, not
 * the user — so it should evaluate concisely and act if needed,
 * not respond conversationally.
 *
 * Pure formatter. No I/O, no truncation of inputs (callers send the
 * descriptions they want pi-agent to see).
 */
export function buildSupervisorTask(info: SupervisorEventInfo): string {
  const head = `[SYSTEM EVENT] task=${info.taskId} kind=${info.taskKind} project=${info.projectName}`;
  if (info.event === "failed") {
    return `${head}\nstatus=failed\nreason: ${info.reason}\n\nDecide: redo a node, escalate to the user, or accept. Reply briefly.`;
  }
  if (info.event === "completed") {
    return `${head}\nstatus=completed\n\nIf there's anything worth flagging from this run, do it now. Otherwise a one-line ack is fine.`;
  }
  if (info.event === "user_invalidate") {
    const sourceLine = info.source ? `source: ${info.source}` : `source: ui`;
    const seedList = info.seeds.length > 0
      ? info.seeds.map((s) => `  - ${s}`).join("\n")
      : "  (none)";
    return [
      head,
      `status=user_invalidated`,
      sourceLine,
      `seeds:`,
      seedList,
      ``,
      `The user invalidated the above nodes via the desktop UI (NOT via chat). Your prior view of "everything is completed" is now stale — the seeds + their dependents are pending again. When the user next asks you to "resume" / "run" / "what's left", call dhee_status FIRST to refresh, then act on the fresh state. A one-line ack here is fine ("Noted — N nodes pending, ready when you say go."). Do NOT auto-dispatch dhee_run_to from this event — the user decides when to resume.`,
    ].join("\n");
  }
  // asset
  const visionLine = info.vlmDescription
    ? `vlm_description: ${info.vlmDescription}`
    : `vlm_description: (none — VLM off, no vision feedback)`;
  return [
    head,
    `status=asset_generated`,
    `path: ${info.assetPath}`,
    `prompt: ${info.assetPrompt}`,
    visionLine,
    ``,
    `Judge two things:`,
    `1. Does the description match the prompt? (subject, setting, action, mood)`,
    `2. Are there significant generation artifacts? (anatomical errors, doubled subjects, broken composition, severe texture issues)`,
    ``,
    `If EITHER fails clearly, call dhee_invalidate node=<id> for this asset. Otherwise a one-line ack is fine.`,
  ].join('\n');
}
