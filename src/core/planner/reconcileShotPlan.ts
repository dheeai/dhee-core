/**
 * Pure helpers for keeping a scene's per-shot graph children in sync with
 * the `scene_shot_plan` Stage-A output.
 *
 * The bug this fixes: when a user redoes a stage upstream of
 * `scene_shot_plan` (e.g. "Scene scripts"), the cascade correctly
 * invalidates everything downstream — but per-shot graph nodes from a
 * PRIOR plan (e.g. `shot_breakdown:scene_1_shot_8` when the new plan
 * has only 7 shots) remain in the graph, get re-run, and produce a
 * shot output the assembler refuses ("shot output has shotNumber 8
 * but the plan does not list it"). This module's job is to compute
 * which per-shot indices are stale vs missing so the executor can
 * prune / add accordingly.
 *
 * Everything here is pure — no I/O, no graph mutation. The caller
 * (`ExecutorAgent.reconcilePerShotChildrenForScene`) does the
 * file read + `removeNode` work.
 */

export interface ShotPlanDiff {
  /** Shot numbers present in the graph but NOT in the updated plan. */
  stale: number[];
  /** Shot numbers in the updated plan but NOT yet in the graph. */
  missing: number[];
}

/**
 * Diff the plan-authoritative shot numbers against what the graph
 * currently has. Both inputs are full Sets of shotNumber integers.
 * Returned arrays are sorted ascending for stable logging / iteration.
 */
export function diffShotPlanAgainstGraph(
  planShotNums: ReadonlySet<number>,
  graphShotNums: ReadonlySet<number>,
): ShotPlanDiff {
  const stale: number[] = [];
  for (const n of graphShotNums) {
    if (!planShotNums.has(n)) stale.push(n);
  }
  const missing: number[] = [];
  for (const n of planShotNums) {
    if (!graphShotNums.has(n)) missing.push(n);
  }
  stale.sort((a, b) => a - b);
  missing.sort((a, b) => a - b);
  return { stale, missing };
}

/**
 * Per-shot graph types spawned by the executor's collection expansion.
 * Every entry here gets removed when a shot is pruned — leaving any
 * one behind would orphan a downstream node and confuse the executor.
 */
export const PER_SHOT_NODE_TYPES = [
  'shot_breakdown',
  'shot_image_prompt',
  'shot_image',
  'shot_image_last_frame',
  'shot_motion_directive',
  'shot_video',
] as const;

/**
 * Build the canonical set of node ids that make up one shot's chain.
 * Caller passes a sceneId (`scene_1`) and shot number (`8`); returns
 * the 6 node ids the executor would have spawned for that shot.
 */
export function perShotNodeIds(sceneId: string, shotNumber: number): string[] {
  const itemId = `${sceneId}_shot_${shotNumber}`;
  return PER_SHOT_NODE_TYPES.map((typeId) => `${typeId}:${itemId}`);
}

/**
 * Extract the shotNumber set from a parsed `scene_shot_plan` JSON object.
 * Tolerates missing / malformed entries by skipping them; an empty Set
 * signals "no usable plan" to the caller (don't reconcile against
 * nothing — leave the graph alone).
 */
export function planShotNumbersFromJson(planJson: unknown): Set<number> {
  const out = new Set<number>();
  if (!planJson || typeof planJson !== 'object') return out;
  const shotPlan = (planJson as { shotPlan?: unknown }).shotPlan;
  if (!Array.isArray(shotPlan)) return out;
  for (const entry of shotPlan) {
    if (!entry || typeof entry !== 'object') continue;
    const n = (entry as { shotNumber?: unknown }).shotNumber;
    if (typeof n === 'number' && Number.isInteger(n) && n > 0) {
      out.add(n);
    }
  }
  return out;
}
