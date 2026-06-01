/**
 * projectInstanceGraph — events → per-instance dependency graph.
 *
 * The graph the Inspector UI consumes. Sibling projection to
 * projectWalkState / listVersions / computeBranchTree: pure fold over
 * the event log, no file IO, no bundle re-derivation. Lineage is a
 * first-class event-sourced concept.
 *
 * Inputs:
 *   - events (typically from eventLog.read({ branchId }))
 *   - opts.branchId — defaults to 'main'. Branch inheritance handled
 *     via branchVisibilityFilter (parent prefix up to fork).
 *   - opts.asOfSeq — time-travel. Fold only events with seq <= asOfSeq.
 *
 * Output:
 *   - instances[]: one entry per (nodeId, itemId) tuple seen
 *   - edges[]: one entry per (from, to) dependency recorded on a
 *     node.completed event's dependencies[] array
 *
 * Semantics:
 *   - latest-wins: re-completing the same instance overwrites the
 *     prior status/outputPath/versionId
 *   - node.invalidated clears the instance's edges (it'll re-acquire
 *     them on next completion, possibly with different upstreams)
 *   - node.failed records the error, preserves prior outputPath when
 *     present so the UI can still show the previous-good artifact
 *
 * Edges are deduplicated by (from, to, fromItemId, toItemId, role)
 * — the same dispatch may declare the same upstream multiple times
 * under different roles (e.g. shot_image_prompt as both 'input' and
 * 'context'); we keep one.
 */
import type {
  DheeEvent,
  NodeCompletedPayload,
  NodeFailedPayload,
  NodeInvalidatedPayload,
  NodeStartedPayload,
} from './events.js';
import { branchVisibilityFilter } from './branchFilter.js';

export interface InstanceNode {
  nodeId: string;
  itemId?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'invalidated';
  outputPath?: string;
  versionId?: string;
  error?: string;
  /** Tool that produced the last completion. */
  tool?: string;
  /** True if the most recent completion came from CAS. */
  cached?: boolean;
  /** Unix-ms of the latest state change (started/completed/failed/invalidated). */
  ts?: number;
}

export interface InstanceEdge {
  fromNodeId: string;
  fromItemId?: string;
  toNodeId: string;
  toItemId?: string;
  /** Bundle input role hint. */
  role?: string;
}

export interface InstanceGraph {
  instances: InstanceNode[];
  edges: InstanceEdge[];
}

export interface ProjectInstanceGraphOpts {
  branchId?: string;
  /** Time travel — fold only events with seq <= asOfSeq. */
  asOfSeq?: number;
}

function keyOf(nodeId: string, itemId: string | undefined): string {
  return itemId !== undefined ? `${nodeId}:${itemId}` : nodeId;
}

function edgeKey(e: InstanceEdge): string {
  return `${keyOf(e.fromNodeId, e.fromItemId)}->${keyOf(e.toNodeId, e.toItemId)}#${e.role ?? ''}`;
}

export function projectInstanceGraph(
  events: Iterable<DheeEvent>,
  opts: ProjectInstanceGraphOpts = {},
): InstanceGraph {
  const branch = opts.branchId ?? 'main';
  const asOf = opts.asOfSeq;
  const eventList = [...events];
  const visible = branchVisibilityFilter(eventList, branch);

  // Latest state per instance key.
  const instMap = new Map<string, InstanceNode>();
  // Edges keyed by instance-target → list of incoming edges. Replacing
  // the list on each node.completed (latest-wins for the dependency
  // set) is what makes invalidate-then-re-complete pick up the new
  // upstream IDs cleanly.
  const incomingByTarget = new Map<string, InstanceEdge[]>();

  for (const e of eventList) {
    if (asOf !== undefined && e.seq > asOf) continue;
    if (!visible(e)) continue;

    switch (e.kind) {
      case 'node.started': {
        const p = e.payload as NodeStartedPayload;
        const k = keyOf(p.nodeId, p.itemId);
        const prior = instMap.get(k);
        instMap.set(k, {
          ...prior,
          nodeId: p.nodeId,
          ...(p.itemId !== undefined ? { itemId: p.itemId } : {}),
          status: 'in_progress',
          ts: e.ts,
        });
        break;
      }

      case 'node.completed': {
        const p = e.payload as NodeCompletedPayload;
        const k = keyOf(p.nodeId, p.itemId);
        const prior = instMap.get(k);
        instMap.set(k, {
          ...prior,
          nodeId: p.nodeId,
          ...(p.itemId !== undefined ? { itemId: p.itemId } : {}),
          status: 'completed',
          outputPath: p.outputPath,
          versionId: p.versionId,
          ...(p.generation?.tool ? { tool: p.generation.tool } : {}),
          ...(p.generation?.cached !== undefined ? { cached: p.generation.cached } : {}),
          ts: e.ts,
        });
        // Replace incoming edges for this target — dependencies recorded
        // on this completion supersede any prior set (re-runs may use
        // different upstreams).
        const edges: InstanceEdge[] = (p.dependencies ?? []).map((d) => ({
          fromNodeId: d.nodeId,
          ...(d.itemId !== undefined ? { fromItemId: d.itemId } : {}),
          toNodeId: p.nodeId,
          ...(p.itemId !== undefined ? { toItemId: p.itemId } : {}),
          ...(d.role ? { role: d.role } : {}),
        }));
        incomingByTarget.set(k, edges);
        break;
      }

      case 'node.failed': {
        const p = e.payload as NodeFailedPayload;
        const k = keyOf(p.nodeId, p.itemId);
        const prior = instMap.get(k);
        instMap.set(k, {
          ...prior,
          nodeId: p.nodeId,
          ...(p.itemId !== undefined ? { itemId: p.itemId } : {}),
          status: 'failed',
          error: p.error,
          ts: e.ts,
        });
        break;
      }

      case 'node.invalidated': {
        const p = e.payload as NodeInvalidatedPayload;
        const k = keyOf(p.nodeId, p.itemId);
        const prior = instMap.get(k);
        if (prior) {
          instMap.set(k, {
            ...prior,
            status: 'invalidated',
            ts: e.ts,
          });
        }
        // Clear current edges — on next completion the walker will
        // record the new set.
        incomingByTarget.delete(k);
        break;
      }

      default:
        // Other event kinds (project.created, bundle.bound, version.*,
        // branch.created, runner.*, critique.added) don't contribute
        // to the instance graph projection.
        break;
    }
  }

  const instances = [...instMap.values()];
  const allEdges: InstanceEdge[] = [];
  for (const edges of incomingByTarget.values()) allEdges.push(...edges);

  // Dedupe edges by full key (same target + source + role).
  const dedup = new Map<string, InstanceEdge>();
  for (const e of allEdges) dedup.set(edgeKey(e), e);

  return { instances, edges: [...dedup.values()] };
}

// ── Dependents traversal ──────────────────────────────────────────────

/**
 * Walk the edge graph FORWARD from a starting instance to collect all
 * transitive dependents. UI uses this on hover to show the regen
 * blast radius — "if I reset this card, everything below it goes
 * stale."
 *
 * Returns a set of instance keys (`${nodeId}` or `${nodeId}:${itemId}`).
 */
export interface InstanceRef {
  nodeId: string;
  itemId?: string;
}

export function computeDependents(
  edges: ReadonlyArray<InstanceEdge>,
  start: InstanceRef,
): Set<string> {
  const outgoing = new Map<string, string[]>();
  for (const e of edges) {
    const src = keyOf(e.fromNodeId, e.fromItemId);
    const dst = keyOf(e.toNodeId, e.toItemId);
    const list = outgoing.get(src) ?? [];
    list.push(dst);
    outgoing.set(src, list);
  }
  const startKey = keyOf(start.nodeId, start.itemId);
  const visited = new Set<string>([startKey]);
  const queue = [startKey];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of outgoing.get(cur) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
  visited.delete(startKey);
  return visited;
}
