/**
 * computeCascadeImpact — pure preview helper for the critique flow.
 *
 * Given a bundle and a target nodeId (optionally + itemId), walks the
 * DAG forward to enumerate every node that would be invalidated AND
 * re-run if the target were critiqued. Returns the list along with
 * each affected node's runner + output format so a downstream caller
 * can count image/video impacts and decide whether to ask the user
 * for confirmation before applying.
 *
 * Pure: no fs reads, no walkState mutation. The caller composes this
 * with project.json + walkState lookup when it needs per-item detail;
 * the bundle-level traversal here gives the structural shape of the
 * cascade, which is what the agent typically needs to communicate
 * impact ("this will rebuild 31 image nodes").
 *
 * BFS, cycle-safe (a malformed bundle with a back-edge terminates).
 */

import type { DagBundle } from './schema.js';

export interface CascadeImpactOpts {
  bundle: DagBundle;
  /** Target node id (e.g. 'characters_plan', 'shot_image_prompt'). */
  nodeId: string;
  /** Reserved for future per-item cascade narrowing. Not used today. */
  itemId?: string;
  /**
   * project.json's walkState. When supplied, downstream nodes that
   * have NEVER been generated (no completed walkState entries for
   * any of their items) are dropped from `affectedNonTextArtifacts`
   * — destroying an artifact that doesn't yet exist isn't a real
   * impact. Optional: when omitted, the full structural cascade is
   * counted (legacy callers).
   */
  walkState?: {
    nodes?: Record<string, { status?: string; outputPath?: string } | undefined>;
  };
}

export interface AffectedNode {
  nodeId: string;
  /** The runner tool that produces this node (e.g. 'llm.generate', 'comfy.image'). */
  runner: string;
  /** The output kind so callers can filter by 'image'/'video'/etc. */
  format: 'md' | 'json' | 'image' | 'video' | 'audio' | 'text';
}

export interface CascadeImpactResult {
  /**
   * Every node that would be re-run if the target were invalidated +
   * critiqued. Includes the target itself as the first entry, in
   * topological BFS order. Empty when `error` is set.
   *
   * This is the FULL structural cascade — it counts text + non-text
   * nodes and doesn't account for walkState. For the user-visible
   * "what will actually be regenerated" impact, see
   * `affectedNonTextArtifacts` below.
   */
  affectedNodes: AffectedNode[];
  /**
   * Subset of `affectedNodes` that produce non-text artifacts (image,
   * video, audio) AND have at least one completed walkState entry
   * (i.e. an artifact that would actually be destroyed and rebuilt).
   *
   * Confirmation gates should key off `affectedNonTextArtifacts.length`,
   * not `affectedNodes.length`:
   *   - text outputs (md/json/text) are derivable + cheap, not what
   *     the user is anxious about losing.
   *   - downstream nodes that have NEVER been generated have nothing
   *     to "destroy" — invalidation on a non-existent artifact is a
   *     no-op.
   *
   * Empty when walkState wasn't supplied (caller didn't ask for the
   * walkState-aware view).
   */
  affectedNonTextArtifacts: AffectedNode[];
  /** Set when nodeId isn't in the bundle. */
  error?: string;
}

/** Set of output formats considered non-text (regen burns real work). */
const NON_TEXT_FORMATS = new Set<AffectedNode['format']>(['image', 'video', 'audio']);

export function computeCascadeImpact(opts: CascadeImpactOpts): CascadeImpactResult {
  const { bundle, nodeId, walkState } = opts;
  const byId = new Map(bundle.nodes.map((n) => [n.id, n]));
  if (!byId.has(nodeId)) {
    return { affectedNodes: [], affectedNonTextArtifacts: [], error: `unknown node: ${nodeId}` };
  }

  // Build a forward adjacency list: for each node, the list of nodes
  // that declare it in their `inputs[].from`. Built once; cheap.
  const downstream = new Map<string, string[]>();
  for (const node of bundle.nodes) {
    for (const input of node.inputs) {
      const list = downstream.get(input.from) ?? [];
      if (!list.includes(node.id)) list.push(node.id);
      downstream.set(input.from, list);
    }
  }

  // BFS forward from the target, cycle-safe via the visited set.
  const visited = new Set<string>([nodeId]);
  const order: string[] = [nodeId];
  const queue: string[] = [nodeId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const next of downstream.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      order.push(next);
      queue.push(next);
    }
  }

  const affectedNodes: AffectedNode[] = order.map((id) => {
    const node = byId.get(id)!;
    return {
      nodeId: id,
      runner: node.runner.tool,
      format: node.outputs.format,
    };
  });

  // walkState-aware "what would actually be destroyed" view.
  // 1. Filter to non-text outputs (text artifacts are cheap derivatives,
  //    not what the confirmation gate is protecting against).
  // 2. Filter to nodes that have at least one COMPLETED entry in
  //    walkState — a downstream collection that's never been
  //    materialized has nothing to invalidate.
  // 3. When walkState isn't supplied, return an empty list (caller
  //    asked for the structural-only view; don't fabricate impact).
  const affectedNonTextArtifacts: AffectedNode[] = (() => {
    if (!walkState?.nodes) return [];
    const nonText = affectedNodes.filter((a) => NON_TEXT_FORMATS.has(a.format));
    return nonText.filter((a) => {
      // The node has at least one completed artifact when any
      // walkState entry whose key is either the bare nodeId or
      // `nodeId:itemId` carries status === 'completed'.
      //
      // 'failed' does NOT count — a failed run wrote no artifact, so
      // there's nothing to destroy on the next pass. Same for pending
      // / missing entries.
      for (const [key, entry] of Object.entries(walkState.nodes!)) {
        if (!entry) continue;
        const bare = key.includes(':') ? key.slice(0, key.indexOf(':')) : key;
        if (bare !== a.nodeId) continue;
        if (entry.status === 'completed') return true;
      }
      return false;
    });
  })();

  return { affectedNodes, affectedNonTextArtifacts };
}
