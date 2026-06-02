/**
 * resolveRunnerForInstance — fold runner.swapped events into a
 * concrete runner choice for a single (nodeId, itemId) dispatch.
 *
 * The walker calls this on EVERY dispatch (right before calling
 * `getRunner(tool)`). Without it, `dhee_swap_runner` events landed
 * in the event log but the walker ignored them — swaps were audit
 * only.
 *
 * Matching rules:
 *   - nodeId must match exactly.
 *   - itemId equality is strict: a swap on `shot_image` (no itemId)
 *     applies to bare `shot_image` dispatches only, NOT to
 *     `shot_image:scene_1_shot_3`. Symmetrically, a swap on
 *     `shot_image:scene_1_shot_3` doesn't apply to bare queries.
 *   - When `branchId` is given, only events with the same `branchId`
 *     are considered. Otherwise events from all branches contribute
 *     (legacy callers).
 *   - LATEST seq wins on ties (so a follow-up swap or rollback
 *     overrides an earlier one).
 *
 * Pure-ish: reads the on-disk event log; no other side effects.
 */
import { openEventLog } from './eventLog/EventLog.js';
import type { DheeEvent } from './eventLog/events.js';

export interface ResolveRunnerForInstanceOpts {
  projectDir: string;
  nodeId: string;
  /** Item id for collection nodes. Omit (or undefined) for bare stage nodes. */
  itemId?: string;
  /** Default tool from the bundle's `node.runner.tool`. */
  fallbackTool: string;
  /** Branch filter; events on other branches are ignored when this is set. */
  branchId?: string;
}

export interface ResolvedRunner {
  /** Tool the walker should dispatch. */
  tool: string;
  /** Optional config to merge on top of `node.runner.config`. */
  configOverride?: Record<string, unknown>;
}

export function resolveRunnerForInstance(
  opts: ResolveRunnerForInstanceOpts,
): ResolvedRunner {
  const log = openEventLog(opts.projectDir);
  let chosen: DheeEvent<'runner.swapped'> | null = null;
  for (const e of log.read()) {
    if (e.kind !== 'runner.swapped') continue;
    if (opts.branchId && e.branchId !== opts.branchId) continue;
    const ev = e as DheeEvent<'runner.swapped'>;
    if (ev.payload.nodeId !== opts.nodeId) continue;
    // Strict itemId equality: undefined matches undefined; any other
    // mismatch is a no-match.
    if ((ev.payload.itemId ?? undefined) !== (opts.itemId ?? undefined)) continue;
    if (!chosen || ev.seq > chosen.seq) chosen = ev;
  }
  if (!chosen) return { tool: opts.fallbackTool };
  const out: ResolvedRunner = { tool: chosen.payload.toTool };
  if (chosen.payload.configOverride) {
    out.configOverride = chosen.payload.configOverride;
  }
  return out;
}
