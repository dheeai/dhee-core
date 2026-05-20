/**
 * Process-wide oversight state.
 *
 * Holds the two runtime toggles that gate pi-agent oversight and
 * vision-LLM calls. Replaces the earlier per-project storage in
 * `project.json` — these are global preferences now, set in the
 * desktop's Settings panel and surfaced as quick-toggle buttons in
 * the chat header. One set of values applies everywhere.
 *
 * Pinned on globalThis (same trick as BackgroundTaskRunner's singleton
 * at backgroundTaskRunnerSingleton.ts) so every bundle copy of this
 * module reads the same instance. Without this, the runner singleton's
 * bundle would see one state and the manager bundle's setters would
 * mutate another.
 */

export interface OversightState {
  /**
   * Pi-agent oversight: when true, pi-agent is auto-engaged on
   * runner events (failed / completed / per-asset-when-vlmJudge-on).
   * Default: true.
   */
  piOversight: boolean;
  /**
   * VLM master switch: gates all vision-LLM calls (the new oversight
   * describeImageWithVLM AND the legacy in-executor reviewImageWithVLM
   * retry-once gate). Effective only when piOversight is also true —
   * VLM standalone has no consumer. Default: true.
   */
  vlmJudge: boolean;
}

const SINGLETON_KEY = "__dhee_oversight_state__";

interface Holder {
  [SINGLETON_KEY]?: OversightState;
}

function holder(): Holder {
  return globalThis as unknown as Holder;
}

function ensure(): OversightState {
  const g = holder();
  let state = g[SINGLETON_KEY];
  if (!state) {
    state = { piOversight: true, vlmJudge: true };
    g[SINGLETON_KEY] = state;
  }
  return state;
}

/**
 * Snapshot of the current state. Returns a copy — callers can mutate
 * the returned object without touching the global.
 */
export function getOversight(): OversightState {
  const s = ensure();
  return { piOversight: s.piOversight, vlmJudge: s.vlmJudge };
}

export function setPiOversight(enabled: boolean): void {
  ensure().piOversight = enabled;
}

export function setVLMJudge(enabled: boolean): void {
  ensure().vlmJudge = enabled;
}

/** Test-only — drop the singleton so the next get rebuilds defaults. */
export function __resetOversightForTesting(): void {
  delete holder()[SINGLETON_KEY];
}
