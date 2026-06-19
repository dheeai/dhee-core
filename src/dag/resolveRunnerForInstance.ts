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
 *   - scope='instance' applies only to the exact itemId.
 *   - scope='node' applies to every instance of that node.
 *   - legacy events with no scope keep the old strict itemId behavior.
 *   - instance-scope wins over node-scope, regardless of seq.
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
  runtimeBindings?: Array<{ configKey: string; fromInput: string }>;
  forced?: boolean;
  scope?: 'node' | 'instance' | 'legacy';
  eventSeq?: number;
}

export function resolveRunnerForInstance(
  opts: ResolveRunnerForInstanceOpts,
): ResolvedRunner {
  const log = openEventLog(opts.projectDir);
  let instanceChosen: DheeEvent<'runner.swapped'> | null = null;
  let nodeChosen: DheeEvent<'runner.swapped'> | null = null;
  for (const e of log.read()) {
    if (e.kind !== 'runner.swapped') continue;
    if (opts.branchId && e.branchId !== opts.branchId) continue;
    const ev = e as DheeEvent<'runner.swapped'>;
    if (ev.payload.nodeId !== opts.nodeId) continue;
    if (ev.payload.scope === 'node') {
      if (!nodeChosen || ev.seq > nodeChosen.seq) nodeChosen = ev;
      continue;
    }
    if (ev.payload.scope === 'instance') {
      if ((ev.payload.itemId ?? undefined) !== (opts.itemId ?? undefined)) continue;
      if (!instanceChosen || ev.seq > instanceChosen.seq) instanceChosen = ev;
      continue;
    }
    // Legacy strict itemId equality: undefined matches undefined; any
    // other mismatch is a no-match. This preserves the old item-only
    // behavior for events emitted before scope existed.
    if ((ev.payload.itemId ?? undefined) !== (opts.itemId ?? undefined)) continue;
    if (!instanceChosen || ev.seq > instanceChosen.seq) instanceChosen = ev;
  }
  const chosen = instanceChosen ?? nodeChosen;
  if (!chosen) return { tool: opts.fallbackTool };
  const configOverride = {
    ...(chosen.payload.generatedConfigOverride ?? {}),
    ...(chosen.payload.configOverride ?? {}),
  };
  const out: ResolvedRunner = {
    tool: chosen.payload.toTool,
    ...(Object.keys(configOverride).length > 0 ? { configOverride } : {}),
    ...(chosen.payload.runtimeBindings ? { runtimeBindings: chosen.payload.runtimeBindings } : {}),
    ...(chosen.payload.forced ? { forced: true } : {}),
    scope: chosen.payload.scope ?? 'legacy',
    eventSeq: chosen.seq,
  };
  return out;
}
