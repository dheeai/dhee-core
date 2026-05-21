/**
 * Graph-hygiene self-heal pass.
 *
 * Why this exists: the codebase mutates the dependency graph from
 * several distinct lanes — `expandCollection` (which deletes a parent
 * cleanly after expansion), `migrateGraphToTemplate` Phase-1 synthesis
 * (which recreates missing parents from the template), `applyInvalidation`
 * (which flips statuses), the per-shot chain spawner, etc. Each lane
 * is correct on its own but no single seam guarantees the graph is
 * structurally clean afterwards. The accumulated result on a project
 * that has been through several reset / redo cycles is **orphan nodes**:
 *
 *   - A collection parent (`shot_breakdown:scene_1`, isCollection=true)
 *     left in the graph after per-shot children have already been
 *     expanded. The parent has no real work to do, but the executor's
 *     run loop sees it as pending and tries to LLM-call it — at best
 *     wasting a call, at worst (as seen on Dream's redo) blocking the
 *     scene_video_prompt assembler because it's listed as a dep.
 *   - Dangling dep references: a node lists `dep:X` in its
 *     `dependencies[]` but `X` no longer exists in the graph (deleted
 *     by an earlier hygiene pass, or by a manual edit, or by an
 *     incomplete migration).
 *   - Dependents pointing AT a collection parent rather than its
 *     children — so the dep is satisfied only when the parent is
 *     "done", which doesn't happen if the parent is orphaned.
 *
 * Rather than play whack-a-mole at every mutation site, this pass
 * runs on a known schedule (every `applyInvalidation`, every executor
 * startup pass) and reconciles the graph back to a consistent shape.
 * Self-healing — future mutation bugs we haven't found yet are still
 * absorbed by this sweep.
 *
 * Pure relative to the executor handle — no I/O, no LLM, no template
 * lookup. Three rules, applied in order:
 *
 *   Rule A — Orphan parent: collection parent (isCollection=true) of
 *            typeId T with at least one per-item child of the same
 *            typeId (`T:<parent.itemId>_shot_M`) is redundant. Delete
 *            the parent and re-point its dependents at the children.
 *
 *   Rule B — Parent-as-dep: any node depending on an isCollection
 *            parent that has expanded children swaps the parent dep
 *            for the children's ids. Sweep BEFORE Rule A's delete so
 *            the rewire information is still available, then Rule A
 *            removes the parent itself.
 *
 *   Rule C — Dangling deps: any `dependencies[]` entry whose target
 *            id is missing from the graph is stripped. Same for
 *            `dependents[]` entries pointing at missing ids.
 *
 * Returns a tally of what was repaired so callers can log a single
 * notification per pass instead of one per mutation.
 */
import type { ExecutionNode } from './types.js';
import type { VideoTemplate } from '../templates/types.js';

export interface GraphHygieneResult {
  /** Collection-parent ids that were deleted. */
  orphanParentsPruned: string[];
  /** Edges of the form `dependent.deps += [parent → children]` performed. */
  parentDepsRewiredCount: number;
  /** Dangling `dependencies[]` entries stripped (depId no longer in graph). */
  danglingDepsStripped: number;
  /** Dangling `dependents[]` entries stripped (dependentId no longer in graph). */
  danglingDependentsStripped: number;
  /** Edges where a content-category node was depending on a media-
   *  category node — content→media is a deadlock pattern under the
   *  executor's serial-mode scheduling. Stripped by Rule D. */
  contentToMediaDepsStripped: number;
}

interface ExecutorLike {
  getAllNodes(): ExecutionNode[];
  getNode(id: string): ExecutionNode | undefined;
  removeNode(id: string): boolean;
}

/**
 * Detect orphan collection parents and return the rewire plan a single
 * traversal at a time. A "parent" is `isCollection=true` with an
 * `itemId` that does NOT match the per-shot pattern (`_shot_<N>` at
 * the end). Its "children" are nodes of the same typeId whose itemId
 * starts with the parent's itemId + `_shot_`.
 *
 * Returns one descriptor per parent. Empty when the graph has no
 * orphans — which is the steady-state case and means the hygiene
 * sweep was a no-op (fast, no notification fired).
 */
function findOrphanParents(executor: ExecutorLike): Array<{
  parentId: string;
  parent: ExecutionNode;
  childIds: string[];
}> {
  const out: Array<{ parentId: string; parent: ExecutionNode; childIds: string[] }> = [];
  for (const node of executor.getAllNodes()) {
    if (!node.isCollection) continue;
    if (!node.itemId) continue;
    // Skip nodes that ARE themselves per-shot — those are the
    // children we're trying to keep; only scene-level / type-level
    // parents can be orphans of expansion.
    if (/_shot_\d+$/.test(node.itemId)) continue;
    const childPrefix = `${node.itemId}_shot_`;
    const childIds: string[] = [];
    for (const candidate of executor.getAllNodes()) {
      if (candidate.typeId !== node.typeId) continue;
      if (!candidate.itemId?.startsWith(childPrefix)) continue;
      if (!/_shot_\d+$/.test(candidate.itemId)) continue;
      childIds.push(candidate.id);
    }
    if (childIds.length > 0) {
      out.push({ parentId: node.id, parent: node, childIds });
    }
  }
  return out;
}

/**
 * Build two lookup maps from the template:
 *   - `categoryByType`: typeId → category (e.g. 'visual_ref', 'clip',
 *     'structure', 'final').
 *   - `allowedDepsByType`: only populated for `content`-category types
 *     (everything except visual_ref / clip / final). The legacy "any
 *     dep not in template is a violation" rule was too strict —
 *     `addShotImageNodes` and friends LEGITIMATELY wire cross-shot
 *     chain deps that aren't declared in the template (shot_image →
 *     prev shot_image, shot_video → prev shot_video for V2V, …). We
 *     don't want to strip those. The original deadlock-causing bug
 *     was specifically: a CONTENT node depending on a MEDIA node,
 *     which traps the executor's "all content before any media"
 *     serial mode. So Rule D below only inspects content nodes; for
 *     them we strip any media-targeting dep.
 *
 * Returns null when no template is supplied — Rule D becomes a no-op
 * in that case (applyInvalidation operates pre-executor-construction
 * and can't always reach the template).
 */
const MEDIA_CATEGORIES = new Set(['visual_ref', 'clip', 'final']);

interface TemplateLookups {
  categoryByType: Map<string, string>;
  /** typeId of `shot_image_last_frame` lives outside the template
   *  (it's spawned by addShotImageNodes) but behaves as media. Listed
   *  here so the category check still flags it. */
  syntheticMediaTypes: Set<string>;
}

function buildTemplateLookups(
  template: VideoTemplate | undefined,
): TemplateLookups | null {
  if (!template) return null;
  const categoryByType = new Map<string, string>();
  for (const [typeId, typeDef] of Object.entries(template.artifactTypes)) {
    categoryByType.set(typeId, typeDef.category);
  }
  return {
    categoryByType,
    syntheticMediaTypes: new Set(['shot_image_last_frame']),
  };
}

function isMediaTypeId(typeId: string, lookups: TemplateLookups): boolean {
  if (lookups.syntheticMediaTypes.has(typeId)) return true;
  const cat = lookups.categoryByType.get(typeId);
  return cat ? MEDIA_CATEGORIES.has(cat) : false;
}

function isContentTypeId(typeId: string, lookups: TemplateLookups): boolean {
  if (lookups.syntheticMediaTypes.has(typeId)) return false;
  const cat = lookups.categoryByType.get(typeId);
  if (!cat) return false;
  return !MEDIA_CATEGORIES.has(cat);
}

export function reconcileGraphHygiene(
  executor: ExecutorLike,
  template?: VideoTemplate,
): GraphHygieneResult {
  const result: GraphHygieneResult = {
    orphanParentsPruned: [],
    parentDepsRewiredCount: 0,
    danglingDepsStripped: 0,
    danglingDependentsStripped: 0,
    contentToMediaDepsStripped: 0,
  };
  const templateLookups = buildTemplateLookups(template);

  const orphans = findOrphanParents(executor);
  const orphanByParentId = new Map(orphans.map((o) => [o.parentId, o]));

  // ── Rule B: dependent.dependencies[parentId] → dependent.dependencies + childIds
  //
  // Sweep ALL nodes' dep lists in one pass; whenever we see a dep that
  // points at an orphan parent, swap in the children. Doing this here
  // (before deleting the parent in Rule A) means downstream stays
  // wired without having to walk parent.dependents in addition.
  for (const node of executor.getAllNodes()) {
    // Some persisted state and test fixtures omit `dependencies` /
    // `dependents` entirely. Default to empty so the hygiene pass
    // doesn't throw when it encounters a partially-shaped node.
    if (!Array.isArray(node.dependencies)) node.dependencies = [];
    if (!Array.isArray(node.dependents)) node.dependents = [];
    let mutated = false;
    const newDeps: string[] = [];
    const alreadyAdded = new Set<string>(node.dependencies);
    for (const depId of node.dependencies) {
      const orphan = orphanByParentId.get(depId);
      if (!orphan) {
        newDeps.push(depId);
        continue;
      }
      // Drop the parent dep, add each child (skipping anything already
      // listed so we don't double up when the dependent was already
      // wired to some children individually).
      mutated = true;
      result.parentDepsRewiredCount += 1;
      alreadyAdded.delete(depId);
      for (const childId of orphan.childIds) {
        if (!alreadyAdded.has(childId)) {
          newDeps.push(childId);
          alreadyAdded.add(childId);
        }
      }
    }
    if (mutated) {
      node.dependencies = newDeps;
      // Mirror the edge on each child: it should know this node
      // depends on it.
      for (const depId of newDeps) {
        const dep = executor.getNode(depId);
        if (dep && !dep.dependents.includes(node.id)) {
          dep.dependents.push(node.id);
        }
      }
    }
  }

  // ── Rule A: delete orphan parents.
  for (const orphan of orphans) {
    if (executor.removeNode(orphan.parentId)) {
      result.orphanParentsPruned.push(orphan.parentId);
    }
  }

  // ── Rule C: strip dangling references in `dependencies[]` and
  // `dependents[]` everywhere. removeNode already does this for the
  // node being deleted, but other mutation lanes (manual graph edits,
  // partial-state restores, migration phases) can leave stragglers.
  const liveIds = new Set(executor.getAllNodes().map((n) => n.id));
  for (const node of executor.getAllNodes()) {
    const filteredDeps = node.dependencies.filter((id) => liveIds.has(id));
    if (filteredDeps.length !== node.dependencies.length) {
      result.danglingDepsStripped += node.dependencies.length - filteredDeps.length;
      node.dependencies = filteredDeps;
    }
    const filteredDependents = node.dependents.filter((id) => liveIds.has(id));
    if (filteredDependents.length !== node.dependents.length) {
      result.danglingDependentsStripped += node.dependents.length - filteredDependents.length;
      node.dependents = filteredDependents;
    }
  }

  // ── Rule D: strip content→media dep edges.
  //
  // The pipeline runs in "serial mode" — ALL content nodes (LLM-based
  // structure/concept/segment outputs) must complete before ANY media
  // node (visual_ref/clip/final image or video file) starts. So a
  // CONTENT node depending on a MEDIA node is a deadlock recipe:
  // content can't start until media does; media won't start until
  // content does.
  //
  // The bug we hit: `spawnMissingPerShotChain` was wiring
  // character_image + setting_image (media) as deps of
  // shot_image_prompt (content). Rule D strips any such edge so the
  // executor can drain content first as the serial scheduler expects.
  //
  // Media→media cross-shot chain deps (shot_image:scene_1_shot_2
  // depends on shot_image:scene_1_shot_1 for visual continuity) are
  // EXPLICITLY ALLOWED — those are added by addShotImageNodes for
  // runtime sequencing and aren't in the template, but they don't
  // cause a deadlock. Earlier versions of this rule used the
  // template's declared deps as the allow-list, which false-
  // positived on every cross-shot chain edge.
  if (templateLookups) {
    for (const node of executor.getAllNodes()) {
      if (!isContentTypeId(node.typeId, templateLookups)) continue;
      const cleaned = node.dependencies.filter((depId) => {
        const depTypeId = depId.split(':')[0]!;
        return !isMediaTypeId(depTypeId, templateLookups);
      });
      if (cleaned.length !== node.dependencies.length) {
        // Mirror: strip the inverse edge on each removed dep so the
        // graph stays consistent.
        const removedDeps = node.dependencies.filter((d) => !cleaned.includes(d));
        for (const removedId of removedDeps) {
          const removedNode = executor.getNode(removedId);
          if (removedNode) {
            removedNode.dependents = removedNode.dependents.filter((d) => d !== node.id);
          }
        }
        result.contentToMediaDepsStripped += node.dependencies.length - cleaned.length;
        node.dependencies = cleaned;
      }
    }
  }

  return result;
}

/**
 * Summarise the hygiene result for a single log/notification line.
 * Returns null when nothing was repaired (steady-state — no notification
 * needed). Called by `applyInvalidation` and the expand-loop entry so
 * each hygiene-driven repair gets exactly one user-visible message.
 */
export function summariseHygieneResult(r: GraphHygieneResult): string | null {
  const parts: string[] = [];
  if (r.orphanParentsPruned.length > 0) {
    parts.push(`pruned ${r.orphanParentsPruned.length} orphan collection parent(s)`);
  }
  if (r.parentDepsRewiredCount > 0) {
    parts.push(`rewired ${r.parentDepsRewiredCount} parent-as-dep edge(s)`);
  }
  if (r.danglingDepsStripped > 0) {
    parts.push(`stripped ${r.danglingDepsStripped} dangling dep edge(s)`);
  }
  if (r.danglingDependentsStripped > 0) {
    parts.push(`stripped ${r.danglingDependentsStripped} dangling dependent edge(s)`);
  }
  if (r.contentToMediaDepsStripped > 0) {
    parts.push(`stripped ${r.contentToMediaDepsStripped} content→media dep edge(s) (would deadlock serial-mode scheduler)`);
  }
  return parts.length === 0 ? null : parts.join(', ');
}
