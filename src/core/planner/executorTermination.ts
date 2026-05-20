/**
 * Pure predicates that decide WHEN the executor's run loop should
 * terminate vs. keep looping. Lives in its own module so the
 * decision logic is unit-testable without spinning up a full
 * ExecutorAgent.
 *
 * Two failure modes the run loop must handle cleanly:
 *
 * 1. A content node has been marked `failed` and its dependents
 *    (some of which are content too) are still `pending`. Continuing
 *    is pointless — no path to completion exists — and the silent
 *    "wait 25 ticks then declare deadlock" path produces a confusing
 *    UX. `findBlockingFailures` returns those failed nodes so the
 *    run loop can end the run immediately with a useful notification.
 *
 * 2. After a failure-induced exit, the post-loop code historically
 *    `await`-ed every entry in `pendingMedia`. If any of them is
 *    a stuck ComfyUI / video gen with no internal timeout, the
 *    finalize step hangs forever — the executor never emits its
 *    terminal `agent_status: 'completed'`, so the BackgroundTaskRunner
 *    never marks the task done, and the chat UI shows "still
 *    running" indefinitely. `shouldAwaitPendingMediaOnExit` is
 *    the gate that opts out of that wait when the run is already
 *    failed/cancelled.
 */
import type { ExecutionNode } from './types.js';

/**
 * Find failed nodes whose dependents include at least one pending
 * (or in-progress) node. Each entry represents a permanent blocker —
 * the failure stops downstream from ever progressing, so the run
 * has no path to completion.
 *
 * Returns an empty array when no such blocker exists, including
 * the legitimate cases:
 *  - no failures at all
 *  - failures whose dependents have all been completed already
 *    (e.g. the failure happened on a leaf-ish node whose dependents
 *    were already satisfied via a different path)
 *  - failures whose dependents are themselves failed/skipped (the
 *    blockage already propagated)
 */
export function findBlockingFailures(nodes: ExecutionNode[]): ExecutionNode[] {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const blockers: ExecutionNode[] = [];
  for (const n of nodes) {
    if (n.status !== 'failed') continue;
    const hasPendingDependent = n.dependents.some(depId => {
      const d = byId.get(depId);
      return d?.status === 'pending' || d?.status === 'in_progress';
    });
    if (hasPendingDependent) blockers.push(n);
  }
  return blockers;
}

export type ExecutorStopReason = 'complete' | 'paused_at_stage' | 'cancelled' | 'failed' | null;

/**
 * After the run loop's `while` exits, the post-loop code may want
 * to drain `pendingMedia` so a final summary reflects everything
 * that did finish. We only want that drain on a *successful* /
 * paused exit — on `failed` or `cancelled` it risks hanging
 * forever on stuck media, so we skip it and let the controller
 * signal abort whatever is in flight.
 */
export function shouldAwaitPendingMediaOnExit(stopReason: ExecutorStopReason): boolean {
  return stopReason !== 'failed' && stopReason !== 'cancelled';
}
