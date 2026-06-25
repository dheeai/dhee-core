/**
 * Display capability lookup — the contract between bundle artifacts and
 * desktop UI views.
 *
 * Bundles tag their nodes with `displayCapability` (e.g. 'shot.prompt',
 * 'scene.video', 'final.video'). The desktop queries by capability —
 * never by node id or filesystem path — so any bundle, including
 * third-party / user-authored ones, can show up in the UI without
 * desktop code changes.
 *
 * Functions here are PURE: they take a bundle + walkState pair (the
 * data the desktop already has in hand) and produce structured query
 * results. No filesystem access. The caller decides how to render the
 * results.
 *
 * Reserved capability names are kebab-with-dots, lowercased, grouped
 * by domain. The dhee-core "platform" capabilities are listed in
 * src/dag/schema.ts NodeDef.displayCapability JSDoc.
 */
import type { DagBundle, NodeDef } from './schema.js';

/** Single capability-matched node, with its declaration + any completed instances from walkState. */
export interface CapabilityNode {
  node: NodeDef;
  /** Per-instance materializations from walkState (parsed item id, status, output path). */
  instances: CapabilityInstance[];
}

export interface CapabilityInstance {
  /** The collection instance key: '<nodeId>:<itemId>' for collections, '<nodeId>' for stages. */
  stateKey: string;
  /** The item id, e.g. 'scene_1_shot_2' (collection) or undefined (stage). */
  itemId?: string;
  /** Walker-reported status (completed/pending/failed). */
  status: 'completed' | 'pending' | 'failed' | string;
  /**
   * If the walker recorded an outputPath for this instance, it's
   * relative to the project dir (e.g. 'prompts/shot_image/scene_1_shot_1.json').
   * Absent means the instance hasn't completed yet OR the runner wrote
   * to a custom location not tracked in walkState.
   */
  outputPath?: string;
  /** Optional cross-output map for multi-file producers (e.g. shot_image_first + shot_image_last). */
  outputPaths?: Record<string, string>;
}

/** Minimal walkState shape we read — both legacy executorState and bundle-arch walkState match this. */
export interface ProjectStateLike {
  nodes?: Record<string, {
    outputPath?: string;
    outputPaths?: Record<string, string>;
    status?: string;
  }>;
}

/**
 * Find all bundle nodes tagged with the given capability and pair them
 * with their completed instances from walkState.
 *
 * Returns an empty array when:
 *   - the bundle has no nodes with that capability tag
 *   - walkState is empty / missing
 *
 * Does NOT filter by status — callers can decide whether to show
 * pending/failed instances (e.g. with a status badge) or only
 * 'completed' ones.
 */
export function findByCapability(
  bundle: DagBundle,
  state: ProjectStateLike | undefined | null,
  capability: string,
): CapabilityNode[] {
  const stateNodes = state?.nodes ?? {};
  const out: CapabilityNode[] = [];
  for (const node of bundle.nodes) {
    if (node.displayCapability !== capability) continue;
    const instances: CapabilityInstance[] = [];
    // For collections, instance keys look like '<nodeId>:<itemId>'.
    // For stages, the key is just '<nodeId>'.
    for (const [key, entry] of Object.entries(stateNodes)) {
      const isStageKey = key === node.id;
      const collectionPrefix = `${node.id}:`;
      const isCollectionKey = key.startsWith(collectionPrefix);
      if (!isStageKey && !isCollectionKey) continue;
      const itemId = isCollectionKey ? key.slice(collectionPrefix.length) : undefined;
      instances.push({
        stateKey: key,
        ...(itemId !== undefined ? { itemId } : {}),
        status: entry.status ?? 'pending',
        ...(entry.outputPath ? { outputPath: entry.outputPath } : {}),
        ...(entry.outputPaths ? { outputPaths: entry.outputPaths } : {}),
      });
    }
    out.push({ node, instances });
  }
  return out;
}

/**
 * Convenience: find a single completed instance by capability + itemId.
 * Returns the {outputPath, ...} record or undefined.
 */
export function findInstanceByCapability(
  bundle: DagBundle,
  state: ProjectStateLike | undefined | null,
  capability: string,
  itemId: string,
): CapabilityInstance | undefined {
  for (const cn of findByCapability(bundle, state, capability)) {
    const match = cn.instances.find((i) => i.itemId === itemId && i.status === 'completed');
    if (match) return match;
  }
  return undefined;
}

/**
 * Get all unique completed item ids across all nodes tagged with the
 * given capability. Useful for "what shots have first frames?" type
 * queries.
 */
export function listCompletedItemIds(
  bundle: DagBundle,
  state: ProjectStateLike | undefined | null,
  capability: string,
): string[] {
  const set = new Set<string>();
  for (const cn of findByCapability(bundle, state, capability)) {
    for (const inst of cn.instances) {
      if (inst.itemId && inst.status === 'completed') set.add(inst.itemId);
    }
  }
  return Array.from(set).sort();
}
