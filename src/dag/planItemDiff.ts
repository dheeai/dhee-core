/**
 * planItemDiff — diff two versions of a plan node's item array by itemId.
 *
 * When a plan node (e.g. characters_plan) is rewritten whole, the engine
 * must NOT blow away every downstream instance — only the ones whose
 * source item actually changed. This computes, between the prior and new
 * plan JSON:
 *   - added:   itemIds present only in the new array
 *   - removed: itemIds present only in the old array
 *   - changed: itemIds in both but whose item JSON differs
 *
 * Callers (writeNodeContent's item-aware invalidation) invalidate the
 * downstream of `removed ∪ changed` and leave untouched siblings — and
 * their generated files — intact. `added` simply materialize on the next
 * walk.
 *
 * itemIds are derived with the shared deriveItemId() so they match what
 * the walker materializes. Entries with no derivable id are skipped (a
 * malformed plan can't be diffed item-wise; the caller falls back to the
 * coarse cascade).
 */
import { deriveItemId, type PlanItem } from './itemId.js';

export interface PlanItemDiff {
  added: string[];
  removed: string[];
  changed: string[];
}

/**
 * Extract the item array from a plan object. `itemKey` (the node's
 * declared fan-out key, e.g. 'characters' / 'shots') wins; otherwise the
 * first array-valued property is used — mirroring the walker's
 * materialization fallback. Returns [] when no array is found.
 */
export function extractPlanItems(planJson: unknown, itemKey?: string): PlanItem[] {
  if (planJson == null || typeof planJson !== 'object') return [];
  const obj = planJson as Record<string, unknown>;
  if (itemKey && Array.isArray(obj[itemKey])) return obj[itemKey] as PlanItem[];
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) return v as PlanItem[];
  }
  return [];
}

/** Build an itemId → canonical-JSON map, skipping unkeyable entries. */
function byItemId(items: PlanItem[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const it of items) {
    const id = deriveItemId(it);
    if (!id) continue;
    // First occurrence wins, matching the walker (which would also key
    // the first); a duplicate id in a plan is itself a bug surfaced
    // elsewhere (add_item enforces uniqueness).
    if (!m.has(id)) m.set(id, JSON.stringify(it));
  }
  return m;
}

/**
 * Diff prior vs new plan item arrays by itemId. `oldJson` may be null
 * (no prior file) → everything in `newJson` is `added`.
 */
export function diffPlanItems(
  oldJson: unknown,
  newJson: unknown,
  itemKey?: string,
): PlanItemDiff {
  const oldMap = byItemId(extractPlanItems(oldJson, itemKey));
  const newMap = byItemId(extractPlanItems(newJson, itemKey));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [id, json] of newMap) {
    if (!oldMap.has(id)) added.push(id);
    else if (oldMap.get(id) !== json) changed.push(id);
  }
  for (const id of oldMap.keys()) {
    if (!newMap.has(id)) removed.push(id);
  }

  return { added, removed, changed };
}
