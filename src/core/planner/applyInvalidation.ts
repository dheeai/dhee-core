/**
 * Pure invalidation op for `dhee_invalidate`.
 *
 * Walks the supplied id list, marks each existing node `pending` and
 * clears its execution metadata (outputPath, promptPath, completedAt,
 * startedAt, artifactId, error). Records the resulting set on
 * `executorState.lastInvalidatedIds` so a later
 * `dhee_run_to scope='last_invalidated'` can read it.
 *
 * Cascade: by default, every transitive dependent (via each node's
 * `dependents` edge list) is also marked pending. Without this, a
 * surgical "redo this one shot" leaves the downstream `final_video`
 * (and any other aggregator) stuck in `completed` state — the next
 * run skips them, and the regenerated shot never makes it into the
 * final assembly. Pass `cascade: false` for the rare case where you
 * really do want to re-run only the seed nodes (testing, debugging).
 *
 * Mark-pending (not remove-and-rebuild) is the contract: invalidate
 * regenerates EXISTING nodes; the graph topology stays intact. The
 * remove-and-rebuild flavor of the old `dhee_reset` is reachable
 * via a separate `clean: true` opt-in (TBD) when the user has
 * changed something upstream that might alter which per-items exist.
 *
 * Pure: mutates the passed-in object, no I/O. Caller persists.
 */
import type { ExecutorState } from "../project/projectTypes.js";
import { reconcileGraphHygiene } from "./reconcileGraphHygiene.js";

interface ProjectLike {
  executorState: ExecutorState & { lastInvalidatedIds?: string[] };
}

export interface ApplyInvalidationResult {
  /** Ids that existed in the graph and were actually invalidated.
   *  Includes both the seed ids the caller passed AND any cascaded
   *  dependents (when `cascade !== false`), in walk order. */
  invalidated: string[];
  /** The subset of `invalidated` the caller explicitly named. Useful
   *  when the cascade includes dozens of downstream nodes and the UI
   *  wants to highlight just the user's selection. */
  seeds: string[];
  /** Ids that the caller named but didn't exist — left here as a soft
   *  signal (no throw). Cascade misses are not reported here, since
   *  by definition every walked id was found in the graph. */
  notFound: string[];
}

export interface ApplyInvalidationOptions {
  /**
   * When true (default), walk each invalidated node's `dependents`
   * transitively and mark them pending too. The semantic is "this
   * node's output is stale, so anything that consumed it is stale
   * by transitivity". When false, only the seed ids are touched —
   * graph topology stays intact but the downstream cone may be left
   * with stale `completed` status.
   */
  cascade?: boolean;
  /**
   * When true (and `cascade` is also true), only mark cascaded
   * dependents pending if they were `completed`. Pending/failed
   * dependents are left untouched — they'll naturally pick up the
   * new upstream when they run. Mirrors
   * `DependencyGraphExecutor.invalidateNode`'s same-named option.
   * Used by the desktop's "regenerate first/last frame" surgical
   * path to rebuild downstream video without disturbing in-flight
   * or already-pending work.
   */
  cascadeOnlyCompleted?: boolean;
  /**
   * When true, preserve all `outputPaths` entries EXCEPT `singleFrame`.
   * When false (default), clear `outputPaths` entirely.
   *
   * Only applies to the SEED node (the id the caller named). Cascaded
   * dependents always get a full clear since their downstream contract
   * is "regenerate the artifact" — there's no partial state to preserve.
   */
  preserveFramesOther?: boolean;
  /**
   * Frame key to drop from `outputPaths` when `preserveFramesOther` is
   * true (e.g. `"last_frame"`). When `singleFrame === "first_frame"`,
   * `outputPath` is also cleared (it conventionally mirrors first_frame).
   * For other frame keys, `outputPath` is preserved.
   */
  singleFrame?: string;
  /**
   * When true, mark each SEED node with
   * `metadata.forceUseExistingPrompt = true`. The executor's media-node
   * path reads this flag and skips the LLM phase, reading the on-disk
   * prompt file directly. Used after the user hand-edits a setting_image
   * / character_image / object_image prompt JSON and wants only the
   * image to regenerate — without this, the LLM re-runs and overwrites
   * the user's edits because `isPromptStale` is true (a parent dep
   * `completedAt` is newer than the prompt file mtime).
   *
   * Only set on seeds, never on cascaded dependents (a downstream
   * `shot_image` has its own prompt file, unrelated to the ref).
   *
   * When false / omitted, the sentinel is REMOVED from each seed (so a
   * stale value from a previous keep-prompt run doesn't silently
   * suppress LLM regen on a later natural invalidate). The executor's
   * skip-LLM path also clears the sentinel after a successful image
   * generation; this option is the caller-side clear path.
   */
  keepPrompt?: boolean;
}

type MutableNode = ExecutorState["nodes"][string] & {
  promptPath?: string;
  artifactId?: string;
  outputPaths?: Record<string, string>;
};

function markPending(
  node: MutableNode,
  opts: { preserveFramesOther?: boolean; singleFrame?: string } = {},
): void {
  node.status = "pending";
  node.startedAt = undefined;
  node.completedAt = undefined;
  node.error = undefined;
  // Optional fields written by the runtime executor and resetProjectStage.
  // Not on the narrow ExecutionNode type but real at runtime — clearing
  // them ensures the next run regenerates the artifact rather than
  // short-circuiting on a stale path.
  delete node.promptPath;
  delete node.artifactId;

  const { preserveFramesOther, singleFrame } = opts;
  if (preserveFramesOther && singleFrame && node.outputPaths) {
    // Surgical-frame redo: drop just the named frame, keep the others
    // so ExecutorAgent's incremental-retry check reuses them. Convention:
    // node.outputPath mirrors first_frame, so clear it only when the
    // dropped frame is first_frame.
    delete node.outputPaths[singleFrame];
    if (singleFrame === "first_frame") {
      node.outputPath = undefined;
    }
    return;
  }

  // Full clear path (default).
  node.outputPath = undefined;
  // Per-frame outputs dict (first_frame / last_frame / mid_frame paths).
  // Critical: if we leave this populated, ExecutorAgent's incremental-
  // retry check (ExecutorAgent.ts:5537 + 5579) will reuse the stale
  // frames whenever the on-disk files still exist — invalidation
  // looks like it worked but the next run silently reuses old
  // images. The graph-aware `executor.invalidateNode` does the same
  // clear; this disk-mutating sibling has to match.
  delete node.outputPaths;
}

export function applyInvalidation(
  project: ProjectLike,
  ids: string[],
  opts: ApplyInvalidationOptions = {},
): ApplyInvalidationResult {
  const cascade = opts.cascade !== false;
  const cascadeOnlyCompleted = opts.cascadeOnlyCompleted === true;
  const { preserveFramesOther, singleFrame } = opts;
  const nodes = project.executorState.nodes;
  const invalidated: string[] = [];
  const seeds: string[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();

  // Phase 0: rebuild `dependents` deterministically from `dependencies`.
  // Without this, the cascade BFS below walks stale dependents arrays
  // and silently stops short of downstream per-item nodes. Observed on
  // noir_detective_story_setup-3: invalidating 'plot' cascaded through
  // plot → story → scene → scene_shot_plan → scene_video_prompt but
  // never reached shot_breakdown / shot_image_prompt / shot_video /
  // final_video because scene_shot_plan.dependents had been truncated
  // to only contain [scene_video_prompt:scene_1]. The pipeline appeared
  // to "skip from ref images to complete" because all the downstream
  // shot work stayed in its prior completed state.
  //
  // The ExecutorAgent's state-heal runs at run-start and would have
  // fixed the dependents — but the cascade in this function runs
  // BEFORE the executor starts, so the heal arrives too late. Doing
  // an explicit inverse-rebuild here closes the timing gap. The
  // inverse rebuild is also strictly safer than partial heals: a
  // node's dependents IS the set of nodes whose `dependencies` list
  // names it, by definition.
  const allIds = Object.keys(nodes);
  const newDependents: Record<string, string[]> = {};
  for (const id of allIds) newDependents[id] = [];
  for (const id of allIds) {
    const node = nodes[id] as MutableNode | undefined;
    if (!node) continue;
    const deps = Array.isArray(node.dependencies) ? node.dependencies : [];
    for (const depId of deps) {
      if (!newDependents[depId]) newDependents[depId] = [];
      if (!newDependents[depId].includes(id)) newDependents[depId].push(id);
    }
  }
  for (const id of allIds) {
    const node = nodes[id] as MutableNode | undefined;
    if (node) node.dependents = newDependents[id] ?? [];
  }

  // Phase 1: seed walk — mark each user-named id pending. The seed gets
  // the surgical-frame options; cascaded dependents in phase 2 always
  // get a full clear (their downstream contract is "regenerate this
  // artifact", no partial state to preserve).
  const queue: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    const node = nodes[id] as MutableNode | undefined;
    if (!node) {
      notFound.push(id);
      continue;
    }
    seen.add(id);
    markPending(node, {
      ...(preserveFramesOther !== undefined ? { preserveFramesOther } : {}),
      ...(singleFrame !== undefined ? { singleFrame } : {}),
    });
    // keepPrompt: seeds only. Set the sentinel when true, clear it
    // when false/omitted so a stale value from a previous keep-prompt
    // run doesn't silently suppress LLM regen on a later natural
    // invalidate.
    const nodeWithMeta = node as MutableNode & {
      metadata?: Record<string, unknown>;
    };
    if (opts.keepPrompt) {
      nodeWithMeta.metadata = {
        ...(nodeWithMeta.metadata ?? {}),
        forceUseExistingPrompt: true,
      };
    } else if (nodeWithMeta.metadata && "forceUseExistingPrompt" in nodeWithMeta.metadata) {
      delete (nodeWithMeta.metadata as Record<string, unknown>)["forceUseExistingPrompt"];
    }
    invalidated.push(id);
    seeds.push(id);
    queue.push(id);
  }

  // Phase 2: cascade — BFS along `dependents` edges. The `dependents`
  // list can carry duplicates from older project files (we observed
  // 4× final_video in the wild on Baker-and-the-Bee), so dedupe via
  // the shared `seen` set. Missing dependents (graph drift) are
  // silently skipped — there's no user intent to surface that.
  //
  // cascadeOnlyCompleted: skip dependents that aren't currently
  // 'completed'. Pending/failed/in_progress dependents are left alone —
  // they'll pick up the new upstream when they run, and the walker
  // doesn't descend through them either (their downstream is either
  // already pending or will be by the time it gets there).
  if (cascade) {
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const curNode = nodes[cur] as MutableNode | undefined;
      const deps = curNode?.dependents ?? [];
      for (const depId of deps) {
        if (seen.has(depId)) continue;
        const depNode = nodes[depId] as MutableNode | undefined;
        if (!depNode) continue;
        if (cascadeOnlyCompleted && depNode.status !== "completed") continue;
        seen.add(depId);
        markPending(depNode);
        invalidated.push(depId);
        queue.push(depId);
      }
    }
  }

  // Whitelist for `dhee_run_to scope='last_invalidated'`. Always
  // overwrite — most-recent-invalidate wins. Empty list when nothing
  // matched (rather than leaving a stale older list around). The
  // whitelist intentionally includes cascaded ids so the targeted
  // re-run actually re-renders the final video / aggregator nodes.
  project.executorState.lastInvalidatedIds = invalidated;

  // Graph hygiene — self-heal orphan collection parents and dangling
  // dep refs. This is the moment the graph is most likely to contain
  // accumulated cruft from prior reset / redo cycles, so reconcile
  // here so the NEXT run sees a clean graph regardless of how it
  // arrived at this state. See reconcileGraphHygiene.ts for the rules.
  applyHygieneToNodes(nodes);

  return { invalidated, seeds, notFound };
}

/**
 * Run the graph-hygiene self-heal pass against a raw nodes record
 * (rather than a DependencyGraphExecutor instance). applyInvalidation
 * operates on persisted project state — pre-executor-construction —
 * so it can't use the executor's removeNode directly. This adapter
 * presents the same shape and mutates the underlying record in place.
 */
function applyHygieneToNodes(nodes: Record<string, MutableNode>): void {
  const executorLike = {
    getAllNodes: (): MutableNode[] => Object.values(nodes),
    getNode: (id: string): MutableNode | undefined => nodes[id],
    removeNode: (id: string): boolean => {
      const node = nodes[id];
      if (!node) return false;
      for (const depId of node.dependencies ?? []) {
        const dep = nodes[depId];
        if (dep) dep.dependents = (dep.dependents ?? []).filter((d) => d !== id);
      }
      for (const dependentId of node.dependents ?? []) {
        const dependent = nodes[dependentId];
        if (dependent) dependent.dependencies = (dependent.dependencies ?? []).filter((d) => d !== id);
      }
      delete nodes[id];
      return true;
    },
  };
  reconcileGraphHygiene(executorLike as never);
}
