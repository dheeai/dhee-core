/**
 * cascadeInvalidationKeys — fold events into a per-instance dependency
 * graph, then forward-BFS from `target` to find every downstream item
 * that should be invalidated when `target` is.
 *
 * Source of truth: `node.completed.dependencies[]`. Each completed
 * event names the upstream instances the runner actually consumed
 * (post-fix from commit 406636f for shot_image — only what was
 * referenced, not every scope='all' item).
 *
 * The "current state" honored by this helper:
 *   - For each (nodeId, itemId) pair we use the LATEST completion's
 *     deps (older deps are stale).
 *   - `node.invalidated` events erase a consumer from the live
 *     graph (the instance was already cleared; it's no longer a
 *     consumer of anything until it re-completes).
 *
 * Returns the target + every transitive consumer as
 * `{nodeId, itemId?}` keys. The target is always included even when
 * no events reference it.
 *
 * Cycles are guarded with a visited set.
 *
 * Note on `branchId`: when set, only events on that branch
 * contribute to the graph; cross-branch deps are ignored.
 */
import type { DheeEvent } from './eventLog/events.js';

export interface CascadeTarget {
  nodeId: string;
  itemId?: string;
}

export interface CascadeOpts {
  /** When set, only events on this branch contribute. */
  branchId?: string;
}

function keyOf(nodeId: string, itemId?: string): string {
  return itemId !== undefined ? `${nodeId}:${itemId}` : nodeId;
}

function parseKey(key: string): CascadeTarget {
  const idx = key.indexOf(':');
  if (idx < 0) return { nodeId: key };
  return { nodeId: key.slice(0, idx), itemId: key.slice(idx + 1) };
}

export function cascadeInvalidationKeys(
  events: Iterable<DheeEvent>,
  target: CascadeTarget,
  opts: CascadeOpts = {},
): CascadeTarget[] {
  // Step 1 — build the live (consumer-key → upstream-keys[]) map.
  // Each completion REPLACES the prior entry; invalidations REMOVE it.
  const liveDeps = new Map<string, string[]>();
  for (const e of events) {
    if (opts.branchId && e.branchId !== opts.branchId) continue;
    if (e.kind === 'node.completed') {
      const p = (e as DheeEvent<'node.completed'>).payload;
      const consumer = keyOf(p.nodeId, p.itemId);
      const upstream = (p.dependencies ?? []).map((d) => keyOf(d.nodeId, d.itemId));
      liveDeps.set(consumer, upstream);
    } else if (e.kind === 'node.invalidated') {
      const p = (e as DheeEvent<'node.invalidated'>).payload;
      liveDeps.delete(keyOf(p.nodeId, p.itemId));
    }
  }

  // Step 2 — invert into upstream→consumers[] adjacency.
  const consumersOf = new Map<string, Set<string>>();
  for (const [consumer, deps] of liveDeps.entries()) {
    for (const dep of deps) {
      const list = consumersOf.get(dep) ?? new Set<string>();
      list.add(consumer);
      consumersOf.set(dep, list);
    }
  }

  // Step 3 — forward-BFS from target (cycle-safe).
  const targetKey = keyOf(target.nodeId, target.itemId);
  const visited = new Set<string>([targetKey]);
  const queue: string[] = [targetKey];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of consumersOf.get(cur) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }

  return [...visited].map(parseKey);
}
