/**
 * Pattern B (2026-05-04): emit two dep-graph nodes per shot so a
 * last-frame failure doesn't redo the already-generated first frame.
 *
 *   shot_image:scene_X_shot_Y         → first frame ONLY
 *   shot_image_last_frame:scene_X_shot_Y → second pass (edit_first_frame)
 *
 * `shot_image:` keeps its name + ID (~50 in-tree references stay valid)
 * but its execution scope shrinks to first frame only. The companion
 * `shot_image_last_frame:` node depends on it; on retry of a failed
 * last-frame, the first-frame node stays `completed` and is reused.
 *
 * Reset of `shot_image:` cascades to `shot_image_last_frame:` via the
 * existing dependents chain — user-initiated reset still re-runs both.
 *
 * The downstream `shot_video:` node should attach to
 * `shotImageLastFrameId` (not `shotImageId`) so video gen waits for
 * the last frame. That wiring lives in the planner's shot_video block;
 * this helper only owns the image-side surface.
 */

import type { ExecutionNode } from './types.js';

/**
 * Just the surface this helper needs from `DependencyGraphExecutor`.
 * Keeps the helper unit-testable without a fleshed-out VideoTemplate
 * + ArtifactGraph.
 */
export interface AddShotImageNodesExecutorLike {
  getNode(id: string): ExecutionNode | undefined;
  addNode(node: ExecutionNode): void;
}

export interface AddShotImageNodesArgs {
  executor: AddShotImageNodesExecutorLike;
  shot: { itemId: string; name: string };
  allCharImageIds: string[];
  allSettingImageIds: string[];
  /**
   * Previous shot's first-frame node id (for cross-shot chaining via
   * "use prev shot's last frame as ref"). Null for the first shot.
   * Pre-Pattern B this was the ID of the previous shot's atomic
   * shot_image; we keep that ID since shot_image: is still the
   * first-frame node. Cross-shot chains read frames by hopping along
   * the shot_image: graph edge — see crossShotChaining.ts.
   *
   * Falls back to "chain on prior shot's first frame" when the per-
   * shot anchor metadata (see `firstFrameAnchor` below) is missing
   * — legacy graphs and untranslated tests still work.
   */
  prevShotImageId: string | null;
  /**
   * First-frame visual-continuity anchor for this shot. Comes from the
   * assembled scene_video_prompt — the deterministic Stage C anchor
   * decision (see `shotAnchorComputer.ts`). When present, OVERRIDES
   * the default `prevShotImageId` chain:
   *
   *   - `fresh`        → no prior-frame dep (purely setting + chars).
   *   - `continuity`   → depend on the *last frame* of the source
   *                      shot, not the first frame. Smoother visual
   *                      flow than the legacy first-frame chain.
   *   - `view_reuse`   → depend on the source shot's LAST FRAME, even
   *                      when it's not the immediate previous shot.
   */
  firstFrameAnchor?:
    | { reason: 'fresh' }
    | { reason: 'continuity'; sourceShotNumber: number; sourceSceneId?: string }
    | { reason: 'view_reuse'; sourceShotNumber: number; sourceSceneId?: string }
    | null;
  /** Scene id (e.g. `scene_1`) — used to compose the anchor source
   *  node id (`shot_image_last_frame:scene_1_shot_2`). Optional for
   *  back-compat; when absent and an anchor IS supplied, we log and
   *  fall back to `prevShotImageId`. */
  sceneId?: string;
}

export interface AddShotImageNodesResult {
  shotImageId: string;
  shotImageLastFrameId: string;
}

function uniquePush(target: string[], value: string): void {
  if (!target.includes(value)) target.push(value);
}

export function addShotImageNodes(args: AddShotImageNodesArgs): AddShotImageNodesResult {
  const {
    executor,
    shot,
    allCharImageIds,
    allSettingImageIds,
    prevShotImageId,
    firstFrameAnchor,
    sceneId,
  } = args;

  const shotPromptId = `shot_image_prompt:${shot.itemId}`;
  const shotImageId = `shot_image:${shot.itemId}`;
  const shotImageLastFrameId = `shot_image_last_frame:${shot.itemId}`;

  // Decide which (if any) prior-frame node this shot's first frame
  // chains on. The anchor (set by the assembler) is the source of truth
  // when present; otherwise fall back to the legacy first-frame-of-
  // prev-shot chain for back-compat with code paths that haven't been
  // updated yet.
  let priorFrameDep: string | null;
  if (firstFrameAnchor && sceneId) {
    if (firstFrameAnchor.reason === 'fresh') {
      priorFrameDep = null;
    } else {
      // continuity OR view_reuse: depend on the source shot's LAST
      // FRAME node, not its first frame. This is what produces the
      // smooth visual flow — the image-edit pipeline edits the
      // already-rendered last frame into the new first frame.
      //
      // `sourceSceneId` is set when the anchor crosses a scene
      // boundary ("first shot of scene N anchors on scene N-1's last
      // shot"). When absent, the source lives in the same scene as
      // the current shot — the assembler's default for within-scene
      // anchors.
      const sourceSceneId = firstFrameAnchor.sourceSceneId ?? sceneId;
      priorFrameDep = `shot_image_last_frame:${sourceSceneId}_shot_${firstFrameAnchor.sourceShotNumber}`;
    }
  } else {
    priorFrameDep = prevShotImageId;
  }

  // ── First-frame node ──────────────────────────────────────────────
  if (!executor.getNode(shotImageId)) {
    const deps = [shotPromptId, ...allCharImageIds, ...allSettingImageIds];
    if (priorFrameDep) deps.push(priorFrameDep);
    executor.addNode({
      id: shotImageId,
      typeId: 'shot_image',
      itemId: shot.itemId,
      status: 'pending',
      displayName: `Shot Images: ${shot.name}`,
      isExpensive: true,
      isCollection: false,
      dependencies: deps,
      dependents: [shotImageLastFrameId],
    });
    for (const depId of deps) {
      const depNode = executor.getNode(depId);
      if (depNode) uniquePush(depNode.dependents, shotImageId);
    }
  } else {
    // Idempotent path: ensure the new last-frame node is in dependents.
    const existing = executor.getNode(shotImageId)!;
    uniquePush(existing.dependents, shotImageLastFrameId);
  }

  // ── Last-frame node ───────────────────────────────────────────────
  if (!executor.getNode(shotImageLastFrameId)) {
    executor.addNode({
      id: shotImageLastFrameId,
      typeId: 'shot_image_last_frame',
      itemId: shot.itemId,
      status: 'pending',
      displayName: `Shot Last Frame: ${shot.name}`,
      isExpensive: true,
      isCollection: false,
      dependencies: [shotImageId],
      dependents: [],
    });
  } else {
    const existing = executor.getNode(shotImageLastFrameId)!;
    uniquePush(existing.dependencies, shotImageId);
  }

  return { shotImageId, shotImageLastFrameId };
}
