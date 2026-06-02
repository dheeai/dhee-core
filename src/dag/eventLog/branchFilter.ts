/**
 * branchFilter — given a target branch, return a predicate that
 * selects events visible on that branch.
 *
 * Visibility model:
 *   - All events with `branchId == target`.
 *   - Plus all events on the *parent* branch with `seq <= forkSeq`
 *     (the parent's prefix up to the fork point).
 *   - Recursively up the chain to 'main'.
 *
 * This is what gives forks their "shared prefix replays for free"
 * property: the branch doesn't copy events; the projection just folds
 * the right subset.
 *
 * The `branch.created` event carries `parentBranchId` and
 * `forkedFromEventId`; we resolve those into a fork-seq via the event
 * id → seq index.
 */
import type { DheeEvent } from './events.js';

interface VisibleBranchRule {
  branchId: string;
  /** When set, include events on this branch only up to (and including) this seq. */
  upToSeq?: number;
}

export function branchVisibilityFilter(events: DheeEvent[], targetBranch: string): (e: DheeEvent) => boolean {
  // Index event id → seq.
  const idToSeq = new Map<string, number>();
  for (const e of events) idToSeq.set(e.id, e.seq);

  // Map: childBranch -> { parent, forkSeq }
  const parents = new Map<string, { parent: string; forkSeq: number }>();
  for (const e of events) {
    if (e.kind !== 'branch.created') continue;
    const p = e.payload as { branchId: string; parentBranchId?: string; forkedFromEventId?: string };
    if (!p.branchId || !p.parentBranchId || !p.forkedFromEventId) continue;
    const forkSeq = idToSeq.get(p.forkedFromEventId);
    if (forkSeq === undefined) continue;
    parents.set(p.branchId, { parent: p.parentBranchId, forkSeq });
  }

  // Build the visible rules: start at target (no upToSeq cap), walk up
  // the chain inheriting each parent's prefix up to its fork point.
  const visible: VisibleBranchRule[] = [{ branchId: targetBranch }];
  let cur = targetBranch;
  const guard = new Set<string>([cur]); // cycle guard for malformed input
  while (parents.has(cur)) {
    const { parent, forkSeq } = parents.get(cur)!;
    visible.push({ branchId: parent, upToSeq: forkSeq });
    if (guard.has(parent)) break;
    guard.add(parent);
    cur = parent;
  }

  return (e: DheeEvent) => {
    const rule = visible.find((v) => v.branchId === e.branchId);
    if (!rule) return false;
    if (rule.upToSeq !== undefined && e.seq > rule.upToSeq) return false;
    return true;
  };
}
