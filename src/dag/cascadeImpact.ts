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
   */
  affectedNodes: AffectedNode[];
  /** Set when nodeId isn't in the bundle. */
  error?: string;
}

export function computeCascadeImpact(opts: CascadeImpactOpts): CascadeImpactResult {
  const { bundle, nodeId } = opts;
  const byId = new Map(bundle.nodes.map((n) => [n.id, n]));
  if (!byId.has(nodeId)) {
    return { affectedNodes: [], error: `unknown node: ${nodeId}` };
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

  return { affectedNodes };
}
