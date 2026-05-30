/**
 * computeCostLedger — fold node.completed events into a spend summary.
 *
 *   - totalUsd — sum of `generation.costUsd` across non-cached completions
 *   - computeCount — every completion event (cached or not)
 *   - cacheHits — completions served from the CAS (no new model call)
 *   - estimatedSavingsUsd — sum of `generation.costUsd` of cached events
 *     (if the runner stamped what the compute would have cost)
 *
 * The ledger is per-branch — pass `{ branchId }` to scope; default
 * 'main'. UIs use this to surface live spend during a walk and total
 * spend across a project / branch.
 */
import type { DheeEvent, NodeCompletedPayload } from './events.js';

export interface CostLedger {
  totalUsd: number;
  computeCount: number;
  cacheHits: number;
  estimatedSavingsUsd: number;
}

export interface CostLedgerOpts {
  branchId?: string;
}

export function computeCostLedger(events: Iterable<DheeEvent>, opts: CostLedgerOpts = {}): CostLedger {
  const branch = opts.branchId ?? 'main';
  let totalUsd = 0;
  let computeCount = 0;
  let cacheHits = 0;
  let estimatedSavingsUsd = 0;

  for (const e of events) {
    if (e.branchId !== branch) continue;
    if (e.kind !== 'node.completed') continue;
    const p = e.payload as NodeCompletedPayload;
    if (!p.generation) continue;
    computeCount += 1;
    if (p.generation.cached) {
      cacheHits += 1;
      if (typeof p.generation.costUsd === 'number') {
        estimatedSavingsUsd += p.generation.costUsd;
      }
    } else if (typeof p.generation.costUsd === 'number') {
      totalUsd += p.generation.costUsd;
    }
  }

  return { totalUsd, computeCount, cacheHits, estimatedSavingsUsd };
}
