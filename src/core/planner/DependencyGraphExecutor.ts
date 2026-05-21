/**
 * Dependency Graph Executor
 *
 * A deterministic, code-driven execution engine that walks a dependency graph
 * node by node. The LLM is called as a pure content generator — no tools,
 * no file I/O, no navigation decisions. All dependency resolution, file reading,
 * file writing, and progress tracking lives here in deterministic code.
 */

import type {
  VideoTemplate,
  ArtifactDependency,
} from '../templates/types.js';
import type {
  ExecutionPlan,
  ExecutionNode,
  ExecutorState,
  ExecutorProgress,
} from './types.js';
import { ArtifactGraph } from '../artifacts/ArtifactGraph.js';
import { filterMismatchedPerItemDeps } from './filterMismatchedPerItemDeps.js';

/**
 * Dependency Graph Executor
 *
 * Owns the execution loop. Deterministically resolves dependencies,
 * dispatches LLM calls, writes outputs, and tracks progress.
 */
export class DependencyGraphExecutor {
  private nodes: Map<string, ExecutionNode>;
  private targetArtifacts: string[];
  private goalDescription: string;
  private template: VideoTemplate;
  private graph: ArtifactGraph;
  private createdAt: number;
  private updatedAt: number;
  private completedAt?: number;

  /**
   * Fires after every public mutation (markStarted, markCompleted,
   * markFailed, invalidateNode, expandCollection, addNode). The
   * callback is responsible for persisting state to disk.
   *
   * Why this exists: prior to this hook, individual mutation sites in
   * ExecutorAgent had to remember to call persistState(). The
   * `expandCollection()` site forgot — a kill between expansion and
   * the first per-item completion lost the per-item nodes from disk,
   * causing non-deterministic re-extraction on restart. Centralising
   * the persist-after-mutate contract here means future mutations
   * cannot forget.
   *
   * Set via `setOnMutation`; pass `undefined` to disable. Errors thrown
   * by the callback are NOT swallowed — they propagate to the caller
   * so persistence failures are visible.
   */
  private onMutation?: () => void;

  private constructor(
    template: VideoTemplate,
    nodes: Map<string, ExecutionNode>,
    targetArtifacts: string[],
    goalDescription: string,
    createdAt?: number,
  ) {
    this.template = template;
    this.graph = new ArtifactGraph(template);
    this.nodes = nodes;
    this.targetArtifacts = targetArtifacts;
    this.goalDescription = goalDescription;
    this.createdAt = createdAt ?? Date.now();
    this.updatedAt = Date.now();
  }

  // ===========================================================================
  // Factory methods
  // ===========================================================================

  /**
   * Build an executor from a BackwardPlanner execution plan.
   * Creates nodes for each plan step and marks skipped artifacts.
   */
  static fromPlan(
    plan: ExecutionPlan,
    template: VideoTemplate,
  ): DependencyGraphExecutor {
    const nodes = new Map<string, ExecutionNode>();
    const graph = new ArtifactGraph(template);

    // Create nodes for each step in the plan
    for (const step of plan.steps) {
      const typeDef = template.artifactTypes[step.artifactTypeId];
      if (!typeDef) continue;

      const nodeId = step.artifactTypeId;
      const deps = graph.getDependencies(step.artifactTypeId);

      // Only include dependencies that are in the plan (not skipped)
      const planTypeIds = new Set(plan.steps.map(s => s.artifactTypeId));
      const activeDeps = deps.filter(d => planTypeIds.has(d));

      nodes.set(nodeId, {
        id: nodeId,
        typeId: step.artifactTypeId,
        status: 'pending',
        displayName: typeDef.displayName,
        isExpensive: typeDef.isExpensive,
        isCollection: typeDef.isCollection,
        dependencies: activeDeps,
        dependents: [],
      });
    }

    // Build reverse edges (dependents)
    for (const [nodeId, node] of nodes) {
      for (const depId of node.dependencies) {
        const depNode = nodes.get(depId);
        if (depNode) {
          depNode.dependents.push(nodeId);
        }
      }
    }

    return new DependencyGraphExecutor(
      template,
      nodes,
      plan.goal.targetArtifacts,
      plan.goal.description,
    );
  }

  /**
   * Restore an executor from persisted state (session resume).
   */
  static fromState(
    state: ExecutorState,
    template: VideoTemplate,
  ): DependencyGraphExecutor {
    const nodes = new Map<string, ExecutionNode>();
    for (const [id, node] of Object.entries(state.nodes)) {
      nodes.set(id, { ...node });
    }

    const executor = new DependencyGraphExecutor(
      template,
      nodes,
      state.targetArtifacts,
      state.goalDescription,
      state.createdAt,
    );
    executor.completedAt = state.completedAt;
    return executor;
  }

  // ===========================================================================
  // Graph navigation (deterministic)
  // ===========================================================================

  /**
   * Get all nodes whose dependencies are ALL completed or skipped.
   * These nodes are ready to be processed.
   */
  getNextReady(): ExecutionNode[] {
    const ready: ExecutionNode[] = [];

    for (const node of this.nodes.values()) {
      if (node.status !== 'pending') continue;

      // Type-level collection nodes must be expanded into per-item nodes before execution.
      // Skip if: isCollection=true AND (no itemId, OR itemId equals typeId — corrupted state)
      if (node.isCollection && (!node.itemId || node.itemId === node.typeId)) continue;

      const allDepsSatisfied = node.dependencies.every(depId => {
        const dep = this.nodes.get(depId);
        if (!dep) return false;
        if (dep.status !== 'completed' && dep.status !== 'skipped') return false;

        // Guard against the "unreachable-cascade satisfies non-collection
        // dependents" bug (task #9): if `dep` is a skipped UNEXPANDED
        // collection AND `node` is a non-collection consumer (e.g.
        // final_video), the collection has no real output to depend on.
        // `final_video` would assemble 0 shot_videos and fail with an
        // empty timeline. Distinguish from legitimate empty collections
        // (e.g. story has no objects → object collection skipped with no
        // children, downstream proceeds): check whether ANY per-item
        // sibling of `dep` exists in the graph. If yes, the collection
        // ran and produced no items legitimately. If no, the collection
        // was skipped via unreachable-cascade and the dependent must
        // wait for a future expansion pass.
        if (
          dep.isCollection &&
          dep.status === 'skipped' &&
          (dep.itemId === undefined || dep.itemId === dep.typeId) &&
          !node.isCollection
        ) {
          for (const sibling of this.nodes.values()) {
            if (sibling.typeId === dep.typeId && sibling.itemId && sibling.itemId !== dep.typeId) {
              return true; // legitimate empty-after-expansion
            }
          }
          return false; // unreachable cascade — wait
        }

        return true;
      });

      if (allDepsSatisfied) {
        ready.push(node);
      }
    }

    return ready;
  }

  /**
   * Register a persistence callback that fires after every public
   * mutation. Pass `undefined` to disable. See `onMutation` field
   * docs for rationale.
   */
  setOnMutation(fn: (() => void) | undefined): void {
    this.onMutation = fn;
  }

  /**
   * Mark a node as started (in_progress).
   */
  markStarted(nodeId: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);
    node.status = 'in_progress';
    node.startedAt = Date.now();
    this.updatedAt = Date.now();
    this.onMutation?.();
  }

  /**
   * Mark a node as completed. Returns newly ready dependent nodes.
   */
  markCompleted(nodeId: string, outputPath?: string, artifactId?: string): ExecutionNode[] {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);

    node.status = 'completed';
    node.completedAt = Date.now();
    if (outputPath) node.outputPath = outputPath;
    if (artifactId) node.artifactId = artifactId;
    this.updatedAt = Date.now();

    // Check if all targets are now complete
    if (this.isComplete()) {
      this.completedAt = Date.now();
    }

    this.onMutation?.();

    // Return newly ready dependents
    return this.getNewlyReady(node.dependents);
  }

  /**
   * Mark a node as failed.
   */
  markFailed(nodeId: string, error: string): void {
    const node = this.nodes.get(nodeId);
    if (!node) throw new Error(`Unknown node: ${nodeId}`);
    node.status = 'failed';
    node.error = error;
    this.updatedAt = Date.now();
    this.onMutation?.();
  }

  /**
   * Auto-reset any failed nodes whose failure came from an abort (user Stop
   * click, system shutdown, ComfyUI WebSocket teardown). Bug 16 / Bug 17:
   * abort-induced failures are recoverable — the user wants to resume from
   * where they paused, not be forced to manually invalidate every node that
   * got caught by an abort signal.
   *
   * Returns the list of node IDs that were reset.
   */
  resetAbortedNodes(): string[] {
    const reset: string[] = [];
    for (const node of this.nodes.values()) {
      if (node.status !== 'failed' || !node.error) continue;
      const err = node.error;
      const isAbort =
        err.includes('agent.stop()') ||
        err.includes('aborted:') ||
        err.includes('aborted by user') ||
        err.includes('AbortError') ||
        err.includes('shutdown');
      if (!isAbort) continue;
      node.status = 'pending';
      node.error = undefined;
      node.startedAt = undefined;
      node.completedAt = undefined;
      reset.push(node.id);
    }
    if (reset.length > 0) {
      this.updatedAt = Date.now();
      this.onMutation?.();
    }
    return reset;
  }

  /**
   * Invalidate a node (for redo).
   *
   * Options:
   *   - `cascade` (default true): also invalidate downstream dependents.
   *     Set false for isolated single-node redo (e.g. a single frame).
   *   - `cascadeOnlyCompleted` (default false): when cascading, only invalidate
   *     dependents whose status was 'completed'. Dependents still pending are
   *     left alone (they'll pick up the new upstream naturally when they run).
   *     Useful for edit flows where we only want to regenerate already-produced
   *     downstream artifacts.
   *   - `preserveFramesOther` (default false): for multi-frame nodes, preserve
   *     all `outputPaths` entries EXCEPT the key in `singleFrame`. When false,
   *     clear `outputPaths` entirely (forces full regeneration).
   *   - `singleFrame`: when `preserveFramesOther=true`, this is the frame key
   *     to drop from `outputPaths` (e.g. "last_frame").
   *
   * Returns the list of nodes that were reset.
   */
  invalidateNode(
    nodeId: string,
    options: {
      cascade?: boolean;
      cascadeOnlyCompleted?: boolean;
      preserveFramesOther?: boolean;
      singleFrame?: string;
    } = {},
  ): ExecutionNode[] {
    const { cascade = true, cascadeOnlyCompleted = false, preserveFramesOther = false, singleFrame } = options;

    const invalidated: ExecutionNode[] = [];
    const queue = [nodeId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      const node = this.nodes.get(currentId);
      if (!node) continue;

      const isTarget = currentId === nodeId;

      // When cascading with cascadeOnlyCompleted, skip cascaded dependents that
      // haven't completed yet — they'll naturally pick up the new upstream when
      // they run. Don't descend into their dependents either.
      if (!isTarget && cascadeOnlyCompleted && node.status !== 'completed') {
        continue;
      }

      // Reset the node
      node.status = 'pending';
      node.completedAt = undefined;
      node.startedAt = undefined;
      node.artifactId = undefined;
      node.error = undefined;

      if (isTarget && preserveFramesOther && singleFrame && node.outputPaths) {
        // Single-frame redo: drop just the target frame, keep others so the
        // executor's incremental retry check skips them.
        delete node.outputPaths[singleFrame];
        // Clear outputPath since it points to first_frame by convention and
        // will be re-set during generation.
        if (singleFrame === 'first_frame') {
          node.outputPath = undefined;
        }
      } else {
        // Full invalidation: clear everything so all frames regenerate.
        node.outputPath = undefined;
        node.outputPaths = undefined;
      }

      invalidated.push(node);

      // Cascade to dependents only when requested
      if (cascade) {
        for (const depId of node.dependents) {
          queue.push(depId);
        }
      }
    }

    this.completedAt = undefined;
    this.updatedAt = Date.now();
    this.onMutation?.();
    return invalidated;
  }

  /**
   * Rewire matching-scope type-level deps to their per-item equivalents for a
   * newly created per-item node.
   *
   * Given a per-item node for `typeId:itemId` being created, for each dep in
   * `deps`:
   *   - If it's a type-level ref (no colon) AND the template declares it with
   *     scope='matching' AND a per-item parent (`dep:itemId`) exists, rewire
   *     to that per-item node.
   *   - Otherwise leave it alone.
   *
   * Also wires the reverse `dependents` edge on the rewired parent so
   * `getNextReady` can propagate completion correctly.
   *
   * This is the backbone of dep propagation during expansion: any time a
   * per-item node is created, ALL its matching-scope deps that point to
   * already-expanded parents get rewired — not just the source of the current
   * cascade. Without this, a per-item node cascaded from parent A (e.g.
   * shot_motion_directive) would correctly point to A:item but leave its
   * other matching-scope deps (e.g. shot_image_prompt) pointing at type-level
   * ghosts that have already been expanded away.
   */
  private rewireMatchingDepsForItem(
    nodeId: string,
    typeId: string,
    itemId: string,
    deps: string[],
  ): string[] {
    const typeDef = this.template.artifactTypes[typeId];
    if (!typeDef) return [...deps];

    // Index matching-scope deps from the template
    const matchingScopeTypes = new Set<string>();
    for (const dep of typeDef.dependencies) {
      if (dep.scope === 'matching') matchingScopeTypes.add(dep.artifactTypeId);
    }

    const rewired: string[] = [];
    for (const depId of deps) {
      if (depId.includes(':')) {
        // Already per-item — leave alone
        rewired.push(depId);
        continue;
      }
      if (!matchingScopeTypes.has(depId)) {
        // Not a matching-scope dep — leave alone
        rewired.push(depId);
        continue;
      }
      const perItemDepId = `${depId}:${itemId}`;
      if (this.nodes.get(perItemDepId)) {
        rewired.push(perItemDepId);
        // Wire the reverse edge on the parent
        const parent = this.nodes.get(perItemDepId);
        if (parent && !parent.dependents.includes(nodeId)) {
          parent.dependents.push(nodeId);
        }
      } else {
        // Per-item parent doesn't exist yet — keep type-level.
        // It'll be rewired either when the parent gets expanded, or
        // by repairMissingNodes on next startup.
        rewired.push(depId);
      }
    }
    return rewired;
  }

  /**
   * Expand a collection node into per-item nodes.
   * Works with both type-level nodes ("character") and item-level nodes ("shot_image_prompt:scene_1").
   * Rewires dependency and dependent edges appropriately.
   *
   * For example, expanding "character" with items ["alice", "bob"] creates:
   *   character:alice, character:bob
   * And rewires dependents like character_image to create:
   *   character_image:alice → depends on character:alice
   *   character_image:bob → depends on character:bob
   */
  expandCollection(
    nodeId: string,
    items: Array<{ itemId: string; name: string; metadata?: import('./types.js').ExecutionNodeMetadata }>,
  ): ExecutionNode[] {
    const existingNode = this.nodes.get(nodeId);
    if (!existingNode) return [];

    // Resolve the base typeId (strip item suffix) for template lookup
    const baseTypeId = existingNode.typeId;
    const typeDef = this.template.artifactTypes[baseTypeId];
    if (!typeDef) return [];

    // Sibling-pollution filter: when this collection node has already
    // accumulated per-item refs of matching-scope dep types from a prior
    // cascade (e.g. shot_video:scene_1.dependencies includes ALL of
    // shot_motion_directive:scene_1_shot_1..N), each per-item clone must
    // strip the OTHER items' refs and keep only its own. Without this,
    // shot_video:scene_1_shot_1 inherits shot_motion_directive:scene_1_shot_2..N
    // and renders block / wire to the wrong dependencies. (Ruby V3 bug.)
    const matchingScopeTypes = new Set<string>();
    for (const dep of typeDef.dependencies) {
      if (dep.scope === 'matching') matchingScopeTypes.add(dep.artifactTypeId);
    }

    // Create per-item nodes. Rewire each per-item's matching-scope deps to
    // per-item parents that already exist (e.g. `scene` → `scene:scene_1`
    // if scene was previously expanded). This covers the case where a
    // collection gets expanded AFTER its parents — without this, the per-item
    // nodes inherit stale type-level refs that later get stripped by
    // dangling-dep cleanup, leaving the per-item blind to its parent's content.
    const newNodes: ExecutionNode[] = [];
    for (const item of items) {
      const itemNodeId = `${baseTypeId}:${item.itemId}`;
      const filteredDeps = filterMismatchedPerItemDeps(
        existingNode.dependencies,
        item.itemId,
        matchingScopeTypes,
      );
      const rewiredDeps = this.rewireMatchingDepsForItem(
        itemNodeId,
        baseTypeId,
        item.itemId,
        filteredDeps,
      );
      const itemNode: ExecutionNode = {
        id: itemNodeId,
        typeId: baseTypeId,
        itemId: item.itemId,
        status: 'pending',
        displayName: `${typeDef.displayName}: ${item.name}`,
        isExpensive: typeDef.isExpensive,
        isCollection: false,
        dependencies: rewiredDeps,
        dependents: [],
        ...(item.metadata ? { metadata: item.metadata } : {}),
      };
      newNodes.push(itemNode);
      this.nodes.set(itemNodeId, itemNode);
    }

    // Rewire dependents of the old type-level node
    for (const dependentId of existingNode.dependents) {
      const dependent = this.nodes.get(dependentId);
      if (!dependent) continue;

      const dependentTypeDef = this.template.artifactTypes[dependent.typeId];
      if (!dependentTypeDef) continue;

      // Find the dependency relationship (check both base type and node id)
      const depRelation = dependentTypeDef.dependencies.find(
        (d: ArtifactDependency) => d.artifactTypeId === baseTypeId,
      );

      if (!depRelation) continue;

      if (depRelation.scope === 'matching' && dependent.isCollection) {
        // For matching scope on a collection dependent: expand that dependent too
        this.expandMatchingDependent(dependent, baseTypeId, items, depRelation);
      } else if (depRelation.scope === 'all' || !depRelation.scope) {
        // For 'all' scope: the dependent depends on ALL item nodes
        dependent.dependencies = dependent.dependencies.filter(d => d !== nodeId);
        for (const itemNode of newNodes) {
          dependent.dependencies.push(itemNode.id);
          itemNode.dependents.push(dependentId);
        }
      } else if (depRelation.scope === 'any') {
        dependent.dependencies = dependent.dependencies.filter(d => d !== nodeId);
        if (newNodes.length > 0) {
          for (const itemNode of newNodes) {
            dependent.dependencies.push(itemNode.id);
            itemNode.dependents.push(dependentId);
          }
        }
      }
    }

    // Remove the old node
    this.nodes.delete(nodeId);
    this.updatedAt = Date.now();

    this.onMutation?.();
    return newNodes;
  }

  /**
   * Expand a dependent collection node that has 'matching' scope on the source collection.
   * Creates per-item dependent nodes wired to their matching source items.
   */
  private expandMatchingDependent(
    dependent: ExecutionNode,
    sourceTypeId: string,
    items: Array<{ itemId: string; name: string }>,
    _depRelation: ArtifactDependency,
  ): void {
    const depTypeDef = this.template.artifactTypes[dependent.typeId];
    if (!depTypeDef) return;

    // Index of dep types declared as matching-scope on this dependent's
    // template definition. Used to filter out per-item refs of matching
    // types whose itemId doesn't match the item being created — those
    // are sibling refs accumulated from prior expansions and would
    // otherwise leak into every clone (the shot_video bug: each per-shot
    // clone would inherit ALL of the scene's per-shot motion directives
    // instead of just its own).
    const matchingScopeTypes = new Set<string>();
    for (const dep of depTypeDef.dependencies) {
      if (dep.scope === 'matching') matchingScopeTypes.add(dep.artifactTypeId);
    }

    // Create per-item nodes for the dependent.
    // For each matching-scope dep on the template, rewire to the per-item
    // parent — not just the source-of-cascade dep. This ensures a per-item
    // node with multiple matching-scope deps (e.g. shot_video depending on
    // both shot_image and shot_motion_directive — both matching) gets ALL
    // its deps pointed at per-item parents if they exist.
    const newDepNodes: ExecutionNode[] = [];
    for (const item of items) {
      const itemNodeId = `${dependent.typeId}:${item.itemId}`;

      // Start from the template deps filtered to what's in the plan (the
      // dependent node's current dependencies), then rewire. Drop the old
      // source type-level ref so it doesn't resurface as dangling.
      // ALSO drop sibling per-item refs of matching-scope types whose
      // itemId != THIS item — those came from earlier expansions and
      // belong to a different per-item clone, not this one.
      const baselineDeps = dependent.dependencies.filter(d => d !== dependent.typeId);
      const noSiblings = filterMismatchedPerItemDeps(
        baselineDeps,
        item.itemId,
        matchingScopeTypes,
      );
      const preRewire: string[] = [...noSiblings];
      // Ensure the source per-item dep is in the list (even if the template
      // dep wasn't previously populated — e.g. plan without the parent type).
      const sourceItemId = `${sourceTypeId}:${item.itemId}`;
      if (!preRewire.includes(sourceItemId)) preRewire.push(sourceItemId);
      const itemDeps = this.rewireMatchingDepsForItem(
        itemNodeId,
        dependent.typeId,
        item.itemId,
        preRewire,
      );

      // Preserve isCollection from type def — allows further sub-expansion
      // (e.g., shot_image_prompt per-scene → per-shot)
      const itemNode: ExecutionNode = {
        id: itemNodeId,
        typeId: dependent.typeId,
        itemId: item.itemId,
        status: 'pending',
        displayName: `${depTypeDef.displayName}: ${item.name}`,
        isExpensive: depTypeDef.isExpensive,
        isCollection: depTypeDef.isCollection,  // preserve from type def for further expansion
        dependencies: itemDeps,
        dependents: [...dependent.dependents],
      };
      newDepNodes.push(itemNode);
      this.nodes.set(itemNodeId, itemNode);

      // Wire the source item's dependent list (rewireMatchingDepsForItem
      // handles other matching parents, but not the source — handle it here
      // to be explicit).
      const sourceItem = this.nodes.get(sourceItemId);
      if (sourceItem && !sourceItem.dependents.includes(itemNodeId)) {
        sourceItem.dependents.push(itemNodeId);
      }
    }

    // Update any nodes that depended on the old type-level dependent
    // Collect downstream nodes before modifying to avoid mutation during iteration
    const downstreamIds = [...dependent.dependents];
    const downstreamCollections: ExecutionNode[] = [];

    for (const downstreamId of downstreamIds) {
      const downstream = this.nodes.get(downstreamId);
      if (!downstream) continue;

      // Replace the old dependent reference with all new item nodes
      downstream.dependencies = downstream.dependencies.filter(d => d !== dependent.id);
      for (const newDep of newDepNodes) {
        downstream.dependencies.push(newDep.id);
        newDep.dependents.push(downstreamId);
      }

      // Track collection dependents for recursive cascade
      if (downstream.isCollection) {
        downstreamCollections.push(downstream);
      }
    }

    // Remove the old type-level dependent node
    this.nodes.delete(dependent.id);

    // Post-expansion rewire: any per-item node that was created earlier in
    // this cascade chain may still hold a type-level ref to the type we just
    // expanded (e.g. shot_video:scene_1 created from shot_image cascade has
    // dep on 'shot_motion_directive' type-level, which is now gone and has
    // per-item shot_motion_directive:scene_1 etc.). Walk all nodes and rewire
    // matching-scope type-level refs to their per-item equivalent.
    this.rewireTypeLevelRefsToPerItem(dependent.typeId);

    // Recursive cascade: expand any downstream collection nodes that have
    // matching scope on the type we just expanded.
    //
    // Re-entrancy guard: a downstream collection may appear here AFTER a
    // sibling cascade already expanded it (e.g. when scene_video_prompt
    // has matching-scope deps on BOTH scene_shot_plan AND shot_breakdown,
    // expanding scene_shot_plan triggers a chain that recursively expands
    // shot_breakdown — whose own cascade expands scene_video_prompt. The
    // outer scene_shot_plan loop then tries to expand scene_video_prompt
    // again from the stale `downstreamCollections` snapshot, overwriting
    // the per-item nodes' freshly-populated dependents). Skip downstreams
    // that no longer exist in the graph.
    for (const downstream of downstreamCollections) {
      if (!this.nodes.has(downstream.id)) continue;
      const downstreamTypeDef = this.template.artifactTypes[downstream.typeId];
      if (!downstreamTypeDef) continue;

      const downstreamDep = downstreamTypeDef.dependencies.find(
        (d: ArtifactDependency) => d.artifactTypeId === dependent.typeId,
      );

      if (downstreamDep?.scope === 'matching') {
        this.expandMatchingDependent(downstream, dependent.typeId, items, downstreamDep);
      }
    }
  }

  /**
   * After a type-level collection has been expanded into per-item nodes,
   * sweep the graph for any remaining type-level refs to it on per-item
   * nodes and rewire to the matching per-item version.
   *
   * This covers the order-of-operations case where a per-item node was
   * created BEFORE its matching-scope sibling got expanded (e.g.
   * shot_video:scene_1 was created from shot_image cascade while
   * shot_motion_directive was still type-level; later when
   * shot_motion_directive cascades, shot_video:scene_1 still holds the stale
   * type-level ref and needs to be rewired).
   */
  private rewireTypeLevelRefsToPerItem(expandedTypeId: string): void {
    for (const node of this.nodes.values()) {
      if (!node.itemId) continue; // Only rewire per-item nodes
      let changed = false;
      const newDeps: string[] = [];
      for (const depId of node.dependencies) {
        if (depId !== expandedTypeId) {
          newDeps.push(depId);
          continue;
        }
        const perItemDepId = `${expandedTypeId}:${node.itemId}`;
        const perItemParent = this.nodes.get(perItemDepId);
        if (perItemParent) {
          newDeps.push(perItemDepId);
          if (!perItemParent.dependents.includes(node.id)) {
            perItemParent.dependents.push(node.id);
          }
          changed = true;
        } else {
          // Couldn't find a matching per-item parent — keep the type-level
          // ref. It'll show up as a dangling dep later, but we shouldn't
          // silently drop required deps.
          newDeps.push(depId);
        }
      }
      if (changed) node.dependencies = newDeps;
    }
  }

  // ===========================================================================
  // Status queries
  // ===========================================================================

  /**
   * Check if all target artifacts are completed or skipped.
   */
  isComplete(): boolean {
    // Check all nodes — the executor is complete when no pending/in_progress/ready remain
    for (const node of this.nodes.values()) {
      if (node.status === 'pending' || node.status === 'in_progress' || node.status === 'ready') {
        return false;
      }
    }
    return true;
  }

  /**
   * Get progress summary.
   */
  getProgress(): ExecutorProgress {
    const progress: ExecutorProgress = {
      total: 0,
      completed: 0,
      inProgress: 0,
      pending: 0,
      failed: 0,
      skipped: 0,
    };

    for (const node of this.nodes.values()) {
      progress.total++;
      switch (node.status) {
        case 'completed': progress.completed++; break;
        case 'in_progress': case 'ready': progress.inProgress++; break;
        case 'pending': progress.pending++; break;
        case 'failed': progress.failed++; break;
        case 'skipped': progress.skipped++; break;
      }
    }

    return progress;
  }

  /**
   * Get a specific node by ID.
   */
  getNode(nodeId: string): ExecutionNode | undefined {
    return this.nodes.get(nodeId);
  }

  /**
   * Add a node to the graph. Used for repairing missing nodes on session restore.
   */
  addNode(node: ExecutionNode): void {
    this.nodes.set(node.id, node);
    this.updatedAt = Date.now();
    this.onMutation?.();
  }

  /**
   * Remove a node from the graph and clean up every other node's
   * `dependencies` / `dependents` lists. Used by the template-migration
   * pass to delete phantom nodes the old graph wiring produced
   * (e.g. `scene_video_prompt:scene_N_shot_M` nodes that an earlier
   * cascade bug created at shot-level granularity for a scene-level
   * type).
   *
   * No-op for unknown ids. Returns whether the node existed.
   */
  removeNode(nodeId: string): boolean {
    const node = this.nodes.get(nodeId);
    if (!node) return false;
    // Strip outbound edges (remove from each dep's dependents).
    for (const depId of node.dependencies) {
      const depNode = this.nodes.get(depId);
      if (depNode) {
        depNode.dependents = depNode.dependents.filter(d => d !== nodeId);
      }
    }
    // Strip inbound edges (remove from each dependent's dependencies).
    for (const dependentId of node.dependents) {
      const dependent = this.nodes.get(dependentId);
      if (dependent) {
        dependent.dependencies = dependent.dependencies.filter(d => d !== nodeId);
      }
    }
    this.nodes.delete(nodeId);
    this.updatedAt = Date.now();
    this.onMutation?.();
    return true;
  }

  /**
   * Get all nodes.
   */
  getAllNodes(): ExecutionNode[] {
    return Array.from(this.nodes.values());
  }

  /**
   * Get the template.
   */
  getTemplate(): VideoTemplate {
    return this.template;
  }

  /**
   * Get the artifact graph.
   */
  getGraph(): ArtifactGraph {
    return this.graph;
  }

  /**
   * Check if a node type produces collection items that need expansion.
   * For example, 'story' produces characters/settings/scenes.
   */
  producesCollectionItems(node: ExecutionNode): boolean {
    // A node produces collection items if any of its dependents are
    // collection nodes that haven't been expanded yet
    for (const depId of node.dependents) {
      const dep = this.nodes.get(depId);
      if (dep && dep.isCollection) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get collection type IDs of dependents that need expansion after this node.
   */
  getCollectionDependents(node: ExecutionNode): string[] {
    const result: string[] = [];
    for (const depId of node.dependents) {
      const dep = this.nodes.get(depId);
      if (dep && dep.isCollection) {
        result.push(dep.typeId);
      }
    }
    return result;
  }

  // ===========================================================================
  // Serialization
  // ===========================================================================

  /**
   * Get serializable state for persistence to project.json.
   */
  getState(): ExecutorState {
    const nodes: Record<string, ExecutionNode> = {};
    for (const [id, node] of this.nodes) {
      nodes[id] = { ...node };
    }

    return {
      nodes,
      targetArtifacts: this.targetArtifacts,
      goalDescription: this.goalDescription,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      completedAt: this.completedAt,
    };
  }

  /**
   * Get a human-readable summary of the current state.
   */
  getSummary(): string {
    const progress = this.getProgress();
    const lines: string[] = [];

    lines.push(`Goal: ${this.goalDescription}`);
    lines.push(`Progress: ${progress.completed}/${progress.total} nodes completed`);

    if (progress.failed > 0) {
      lines.push(`Failed: ${progress.failed} node(s)`);
      // Surface each failure's displayName + error so the user sees
      // what actually went wrong, not just "Blocked". Without this
      // the user is left to dig through executor.log to discover a
      // 402 / timeout / API key mismatch — a silent-failure UX.
      const failed = this.getAllNodes().filter(n => n.status === 'failed');
      for (const n of failed) {
        const err = n.error?.trim();
        lines.push(err ? `  - ${n.displayName}: ${err}` : `  - ${n.displayName}`);
      }
    }

    const ready = this.getNextReady();
    if (ready.length > 0) {
      lines.push(`Next: ${ready.map(n => n.displayName).join(', ')}`);
    } else if (this.isComplete()) {
      lines.push('Status: Complete');
    } else {
      lines.push('Status: Blocked (dependencies have failures)');
    }

    return lines.join('\n');
  }

  // ===========================================================================
  // Private helpers
  // ===========================================================================

  /**
   * From a list of node IDs, return those that are now ready
   * (all their dependencies are completed/skipped).
   */
  private getNewlyReady(candidateIds: string[]): ExecutionNode[] {
    const ready: ExecutionNode[] = [];

    for (const id of candidateIds) {
      const node = this.nodes.get(id);
      if (!node || node.status !== 'pending') continue;

      const allDepsSatisfied = node.dependencies.every(depId => {
        const dep = this.nodes.get(depId);
        return dep && (dep.status === 'completed' || dep.status === 'skipped');
      });

      if (allDepsSatisfied) {
        ready.push(node);
      }
    }

    return ready;
  }
}
