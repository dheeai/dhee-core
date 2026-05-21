/**
 * Replan-and-merge for persisted executor graphs.
 *
 * Problem: the executor's `executorState.nodes` is the only live record of
 * "what's been done" in a project. When the narrative template adds a new
 * artifact type (e.g. the hierarchical breakdown refactor adding
 * `scene_shot_plan` + `shot_breakdown`), a project persisted under the old
 * template loads with a graph that's missing those nodes — and any
 * already-completed sibling (e.g. `scene_video_prompt:scene_N`) carries
 * stale dependency edges. The next dispatch either deadlocks or fires the
 * wrong runtime branch.
 *
 * Fix: on graph load, run a two-phase migration pass that:
 *
 *   1. SYNTHESIZE — walk the per-item nodes already in the graph and, for
 *      every template type that declares `scope: 'matching'` on one of
 *      them, ensure the corresponding per-item dependent exists. Repeat
 *      until quiescent so the cascade propagates (e.g. synthesizing
 *      `scene_shot_plan:scene_1` then triggers synthesis of
 *      `shot_breakdown:scene_1`).
 *
 *   2. REWIRE — for each per-item node, compute the dependency set the
 *      current template says it should have. If it differs from the
 *      persisted set (template changed shape — e.g. `scene_video_prompt`
 *      moved from depending on `scene` to depending on `scene_shot_plan`
 *      + `shot_breakdown`), rewire deps AND cascade-invalidate the node
 *      so it (and its downstream) re-runs under the new contract.
 *
 * Status preservation: nodes whose template contract is unchanged keep
 * their persisted `status` + `outputPath`. Only nodes whose deps changed
 * (or whose downstream had a rewire) get marked pending. Plot/story/
 * scenes/characters that already ran stay completed.
 *
 * Pure-ish: mutates the supplied executor, no I/O. Returns a report so
 * the caller can log the migration if anything happened.
 */

import type { VideoTemplate, ArtifactDependency, ArtifactTypeDefinition } from '../templates/types.js';
import type { DependencyGraphExecutor } from './DependencyGraphExecutor.js';
import type { ExecutionNode } from './types.js';

export interface MigrationReport {
  /** Per-item nodes synthesized from the current template (didn't exist
   *  in the persisted graph). */
  synthesized: Array<{ id: string; reason: string }>;
  /** Per-item nodes whose deps were rewired to match the current template. */
  rewired: Array<{ id: string; oldDeps: string[]; newDeps: string[] }>;
  /** Per-item nodes (and their cascaded dependents) forced back to pending
   *  because the contract under them changed. Superset of `rewired` —
   *  includes downstream invalidations triggered by each rewire. */
  invalidated: string[];
  /** Phantom nodes deleted — per-item ids whose itemId form doesn't
   *  match the type's intended granularity (e.g. `scene_video_prompt:
   *  scene_1_shot_3` is a phantom because scene_video_prompt is
   *  per-scene, not per-shot). */
  deleted: string[];
}

/**
 * Types whose per-item itemId MUST be scene-level (`scene_N`) — never
 * shot-level (`scene_N_shot_M`). An earlier wiring bug in
 * expandPendingCollections allowed the cascade in
 * `expandMatchingDependent` to promote these to per-shot when their
 * upstream collection (shot_breakdown) was expanded, leaving phantom
 * `scene_video_prompt:scene_N_shot_M` nodes that deadlock the
 * pipeline. Migration deletes them and Phase 1 synthesis recreates
 * the proper scene-level node.
 */
const SCENE_GRANULARITY_TYPES = new Set([
  'scene_shot_plan',
  'scene_video_prompt',
]);

/** True if an itemId looks like a shot-level id (`scene_N_shot_M`). */
function isShotLevelItemId(itemId: string): boolean {
  return /_shot_\d+$/.test(itemId);
}

/**
 * Compute the dependency set a per-item node SHOULD have under the current
 * template, given its itemId.
 *
 *   - `scope: 'matching'` deps resolve to `{parent.typeId}:{node.itemId}`
 *     if that per-item parent exists; otherwise the type-level name
 *     (the existing graph's `repairMissingNodes` will reconcile later
 *     when expansion fires).
 *   - Any other scope (`all`, `any`, undefined) resolves to the type-
 *     level name. The runtime cascade is what binds those to per-item
 *     children at expansion time.
 */
function expectedDepsForNewPerItem(
  itemId: string,
  typeDef: { dependencies: ArtifactDependency[] },
  executor: DependencyGraphExecutor,
): string[] {
  const expected: string[] = [];
  for (const dep of typeDef.dependencies) {
    const resolved = resolveDepNodeId(dep, itemId, executor);
    if (resolved) expected.push(resolved);
  }
  return expected;
}

/**
 * Resolve a single template dep to the concrete node id this per-item
 * node should reference:
 *
 *   - matching scope → per-item if it exists, else type-level if it exists.
 *   - other scopes  → type-level if it exists.
 *   - neither       → null (the target isn't realised in this graph,
 *                    e.g. optional `object_image` for a project with no
 *                    objects). Caller drops it.
 */
function resolveDepNodeId(
  dep: ArtifactDependency,
  itemId: string | undefined,
  executor: DependencyGraphExecutor,
): string | null {
  if (dep.scope === 'matching' && itemId) {
    const perItem = `${dep.artifactTypeId}:${itemId}`;
    if (executor.getNode(perItem)) return perItem;
    if (executor.getNode(dep.artifactTypeId)) return dep.artifactTypeId;
    return null;
  }
  if (executor.getNode(dep.artifactTypeId)) return dep.artifactTypeId;
  return null;
}

/**
 * True when every template-declared dep is REPRESENTED in `currentDeps`.
 *
 * "Represented" is intentionally tolerant of the form:
 *   - matching scope: per-item id OR type-level id present.
 *   - all / any / undefined: type-level id OR any per-item child of that
 *     type present (covers the case where the cascade already rewired
 *     a type-level ref to its per-item children — e.g. scene:scene_1
 *     has `character:alice` in its deps even though the template says
 *     `character` at type-level).
 *
 * Optional deps (`required: false`) are considered represented when no
 * nodes of that type exist in the graph at all (e.g. `object_image`
 * for a project whose story has no objects).
 */
function depsAdequate(
  node: ExecutionNode,
  typeDef: { dependencies: ArtifactDependency[] },
  executor: DependencyGraphExecutor,
): boolean {
  const currentDeps = new Set(node.dependencies);
  for (const dep of typeDef.dependencies) {
    let satisfied = false;

    if (dep.scope === 'matching' && node.itemId) {
      const perItem = `${dep.artifactTypeId}:${node.itemId}`;
      satisfied = currentDeps.has(perItem) || currentDeps.has(dep.artifactTypeId);
      if (!satisfied) {
        // Coarser-granularity match: when the consumer is shot-level
        // (`scene_1_shot_3`) but the dep type is scene-level
        // (`scene_video_prompt:scene_1`), the existing executor cascade
        // wires the consumer to the scene-level node. Accept that as
        // satisfied — otherwise Phase 2 false-positives every shot-level
        // node whose matching dep happens to live one level coarser.
        const prefix = `${dep.artifactTypeId}:`;
        for (const d of currentDeps) {
          if (!d.startsWith(prefix)) continue;
          const depItemId = d.slice(prefix.length);
          // d is `{type}:{depItemId}`. Treat as adequate if depItemId
          // is a strict prefix of the consumer's itemId at an
          // underscore boundary (so `scene_1` matches `scene_1_shot_3`
          // but not `scene_10_shot_3`).
          if (
            node.itemId === depItemId ||
            node.itemId.startsWith(depItemId + '_')
          ) {
            satisfied = true;
            break;
          }
        }
      }
    } else {
      if (currentDeps.has(dep.artifactTypeId)) {
        satisfied = true;
      } else {
        // Accept any per-item of this type (post-expansion form).
        const prefix = `${dep.artifactTypeId}:`;
        for (const d of currentDeps) {
          if (d.startsWith(prefix)) { satisfied = true; break; }
        }
      }
    }

    if (!satisfied) {
      // Optional + type entirely absent from graph → fine.
      if (!dep.required) {
        const anyOfType = executor.getAllNodes().some(n => n.typeId === dep.artifactTypeId);
        if (!anyOfType) continue;
      }
      return false;
    }
  }
  return true;
}

/**
 * Rebuild the `dependents` (reverse) edges on every node from the
 * forward `dependencies` arrays. Older `expandCollection` paths can
 * leave stale dependents pointing at deleted per-item parents — which
 * silently breaks cascade-invalidation. Running this before Phase 2
 * makes sure invalidateNode reaches every downstream consumer.
 */
function rebuildReverseEdges(executor: DependencyGraphExecutor): void {
  // Clear all existing dependents.
  for (const node of executor.getAllNodes()) {
    node.dependents = [];
  }
  // Rebuild from dependencies.
  for (const node of executor.getAllNodes()) {
    for (const depId of node.dependencies) {
      const depNode = executor.getNode(depId);
      if (depNode && !depNode.dependents.includes(node.id)) {
        depNode.dependents.push(node.id);
      }
    }
  }
}

export function migrateGraphToTemplate(
  executor: DependencyGraphExecutor,
  template: VideoTemplate,
): MigrationReport {
  const report: MigrationReport = {
    synthesized: [],
    rewired: [],
    invalidated: [],
    deleted: [],
  };

  // ── Phase 0: delete phantom per-shot nodes for scene-only types ───────
  //
  // An earlier cascade bug in expandPendingCollections allowed types like
  // `scene_video_prompt` (per-scene by construction) to be promoted to
  // per-shot granularity by the matching-scope cascade when their
  // upstream `shot_breakdown` was expanded. Result: phantom
  // `scene_video_prompt:scene_1_shot_3` nodes with no scene_shot_plan
  // counterpart to assemble from, dead-locking the assembler.
  //
  // Delete them outright; Phase 1 synthesis will recreate the proper
  // scene-level node (e.g. `scene_video_prompt:scene_1`) from the
  // existing `scene_shot_plan:scene_1` per the current template.
  for (const node of executor.getAllNodes()) {
    if (!node.itemId) continue;
    if (!SCENE_GRANULARITY_TYPES.has(node.typeId)) continue;
    if (!isShotLevelItemId(node.itemId)) continue;
    executor.removeNode(node.id);
    report.deleted.push(node.id);
  }

  // ── Phase 1: synthesize missing per-item nodes ────────────────────────
  //
  // For each per-item parent already in the graph, for each template type
  // that declares `scope: 'matching'` on that parent's typeId, ensure
  // `{depType}:{parent.itemId}` exists. Iterate until quiescent so the
  // cascade propagates (e.g. synthesizing scene_shot_plan:scene_1 then
  // makes shot_breakdown:scene_1 eligible for synthesis on the next pass).
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const parent of executor.getAllNodes()) {
      if (!parent.itemId) continue;

      for (const [depTypeId, depTypeDefRaw] of Object.entries(template.artifactTypes)) {
        const depTypeDef = depTypeDefRaw as ArtifactTypeDefinition;
        const matchingDep = depTypeDef.dependencies.find(
          (d: ArtifactDependency) => d.artifactTypeId === parent.typeId && d.scope === 'matching',
        );
        if (!matchingDep) continue;

        // Granularity guard: SCENE_GRANULARITY types (scene_video_prompt,
        // scene_shot_plan) are per-scene by construction. If a parent
        // gives us shot-level granularity (itemId looks like
        // `scene_N_shot_M`), synthesizing `{depType}:scene_N_shot_M`
        // would recreate the exact phantoms Phase 0 just deleted —
        // closed loop, same bug.
        //
        // Skip. The scene-level synthesis will fire from this parent's
        // own scene-level ancestor (e.g. scene_shot_plan:scene_N gets
        // synthesized from scene:scene_N elsewhere in this iteration).
        if (SCENE_GRANULARITY_TYPES.has(depTypeId) && isShotLevelItemId(parent.itemId)) {
          continue;
        }

        // Don't synthesize a parent-level collection node when per-shot
        // children of the same type already exist. The parent would be
        // a redundant collection that, if expanded by the runtime,
        // would overwrite the existing per-shot children.
        const childPrefix = `${depTypeId}:${parent.itemId}_shot_`;
        const hasPerShotChildren = executor.getAllNodes().some(
          n => n.typeId === depTypeId && n.id.startsWith(childPrefix),
        );
        if (hasPerShotChildren) continue;

        const expectedId = `${depTypeId}:${parent.itemId}`;
        if (executor.getNode(expectedId)) continue; // already present

        const deps = expectedDepsForNewPerItem(parent.itemId, depTypeDef, executor);
        const newNode: ExecutionNode = {
          id: expectedId,
          typeId: depTypeId,
          itemId: parent.itemId,
          status: 'pending',
          displayName: `${depTypeDef.displayName}: ${parent.itemId}`,
          isExpensive: depTypeDef.isExpensive ?? false,
          isCollection: depTypeDef.isCollection ?? false,
          dependencies: deps,
          dependents: [],
        };
        executor.addNode(newNode);
        // Wire reverse edges.
        for (const depId of deps) {
          const depNode = executor.getNode(depId);
          if (depNode && !depNode.dependents.includes(expectedId)) {
            depNode.dependents.push(expectedId);
          }
        }

        report.synthesized.push({
          id: expectedId,
          reason: `template adds ${depTypeId} (matching ${parent.typeId})`,
        });
        progressed = true;
      }
    }
  }

  // Before Phase 2: rebuild reverse edges. Older expansion paths can
  // leave stale dependents pointing at deleted per-item parents
  // (e.g. shot_image_prompt:scene_1 stays on scene_video_prompt:scene_1's
  // dependents even after expanding to shot_image_prompt:scene_1_shot_*).
  // Without this, the cascade-invalidate below can't reach downstream.
  rebuildReverseEdges(executor);

  // ── Phase 2: ensure each per-item node's deps cover the current ─────
  //            template; cascade-invalidate the ones that didn't
  //
  // We don't try to compute the canonical expected dep list and replace
  // wholesale — the runtime cascade (matching-scope expansion, per-item
  // rewiring) makes that form-fragile, and replacing the array would
  // false-positive on graphs where a type-level dep was legitimately
  // rewritten to per-item children at expansion time.
  //
  // Instead: an ADEQUACY check. If every template-declared dep is
  // represented somewhere in the node's current deps, leave it alone.
  // If not (e.g. scene_video_prompt:scene_1's old deps were
  // [scene:scene_1, world_style] but the new template needs
  // scene_shot_plan:scene_1 + shot_breakdown:scene_1 — neither
  // represented), ADD the missing deps and cascade-invalidate.
  for (const node of executor.getAllNodes()) {
    if (!node.itemId) continue;
    const typeDef = template.artifactTypes[node.typeId];
    if (!typeDef) continue;
    if (depsAdequate(node, typeDef, executor)) continue;

    const oldDeps = [...node.dependencies];
    const currentSet = new Set(node.dependencies);
    const added: string[] = [];

    for (const dep of typeDef.dependencies) {
      const resolved = resolveDepNodeId(dep, node.itemId, executor);
      if (!resolved) continue; // optional / absent — fine.

      // Already represented?
      if (currentSet.has(resolved)) continue;
      // For non-matching, accept any per-item child as representation.
      if (dep.scope !== 'matching') {
        const prefix = `${dep.artifactTypeId}:`;
        let alreadyRepresented = false;
        for (const d of currentSet) {
          if (d.startsWith(prefix)) { alreadyRepresented = true; break; }
        }
        if (alreadyRepresented) continue;
      }

      // Not represented — add it.
      node.dependencies.push(resolved);
      currentSet.add(resolved);
      added.push(resolved);
      const depNode = executor.getNode(resolved);
      if (depNode && !depNode.dependents.includes(node.id)) {
        depNode.dependents.push(node.id);
      }
    }

    // Prune deps whose typeId is no longer mentioned in this node's
    // template dep list at all. Example: pre-refactor
    // scene_video_prompt:scene_1 had `scene:scene_1` and `world_style`
    // in deps; the new template only declares scene_shot_plan +
    // shot_breakdown. Keeping the old refs is functionally harmless
    // (they're completed nodes that don't block) but adds graph noise
    // and a wrong contract. Drop them.
    const allowedTypeIds = new Set(typeDef.dependencies.map(d => d.artifactTypeId));
    const pruned: string[] = [];
    node.dependencies = node.dependencies.filter(depId => {
      const colonIdx = depId.indexOf(':');
      const depType = colonIdx >= 0 ? depId.slice(0, colonIdx) : depId;
      if (allowedTypeIds.has(depType)) return true;
      pruned.push(depId);
      // Drop reverse edge.
      const oldDepNode = executor.getNode(depId);
      if (oldDepNode) {
        oldDepNode.dependents = oldDepNode.dependents.filter(d => d !== node.id);
      }
      return false;
    });

    if (added.length === 0 && pruned.length === 0) continue;

    report.rewired.push({ id: node.id, oldDeps, newDeps: [...node.dependencies] });

    // Cascade-invalidate — this node's contract changed, so its old
    // output (if any) is suspect and everything downstream of it that
    // was generated under the old contract is too.
    const cascaded = executor.invalidateNode(node.id);
    for (const c of cascaded) {
      if (!report.invalidated.includes(c.id)) {
        report.invalidated.push(c.id);
      }
    }
  }

  return report;
}
