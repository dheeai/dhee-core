/**
 * TDD for Pattern B (2026-05-04): split shot image generation across
 * two dep-graph nodes so a last-frame failure doesn't poison the
 * already-completed first-frame status.
 *
 * Old shape (atomic):
 *   shot_image_prompt:X → shot_image:X → shot_video:X
 *   shot_image:X did first_frame + last_frame in one go; failure of
 *   either marked the whole node failed and forced regen of both.
 *
 * New shape (split):
 *   shot_image_prompt:X → shot_image:X → shot_image_last_frame:X → shot_video:X
 *   - shot_image:X keeps its name + ID; its job shrinks to "first frame
 *     only" (~50 touchpoints stay valid vs ~400 if we renamed it)
 *   - shot_image_last_frame:X is new; depends on shot_image:X; does
 *     only the edit_first_frame → last_frame step
 *   - shot_video:X moves its dependency from shot_image:X to
 *     shot_image_last_frame:X
 *
 * Reset of shot_image:X cascades to shot_image_last_frame:X via the
 * existing dependents chain, so user-initiated reset still re-runs
 * everything. Failure of last_frame leaves shot_image:X completed →
 * retry only re-runs the failed last_frame node.
 */

import { describe, it, expect } from 'vitest';
import type { ExecutionNode } from '../../src/core/planner/types.js';
import {
  addShotImageNodes,
  type AddShotImageNodesExecutorLike,
} from '../../src/core/planner/addShotImageNodes.js';

function makeNode(over: Partial<ExecutionNode> & Pick<ExecutionNode, 'id' | 'typeId'>): ExecutionNode {
  return {
    status: 'pending',
    displayName: over.id,
    dependencies: [],
    dependents: [],
    isCollection: false,
    ...over,
  } as ExecutionNode;
}

function buildExecutor(seedNodes: ExecutionNode[]): AddShotImageNodesExecutorLike {
  const map = new Map<string, ExecutionNode>();
  for (const n of seedNodes) map.set(n.id, n);
  return {
    getNode: (id) => map.get(id),
    addNode: (node) => { map.set(node.id, node); },
  };
}

describe('addShotImageNodes (Pattern B graph split)', () => {
  it('emits BOTH a shot_image and a shot_image_last_frame node for the shot', () => {
    const exec = buildExecutor([
      makeNode({ id: 'shot_image_prompt:scene_1_shot_1', typeId: 'shot_image_prompt' }),
    ]);

    const ids = addShotImageNodes({
      executor: exec,
      shot: { itemId: 'scene_1_shot_1', name: 'Wide on Arthur' },
      allCharImageIds: [],
      allSettingImageIds: [],
      prevShotImageId: null,
    });

    expect(ids.shotImageId).toBe('shot_image:scene_1_shot_1');
    expect(ids.shotImageLastFrameId).toBe('shot_image_last_frame:scene_1_shot_1');
    expect(exec.getNode('shot_image:scene_1_shot_1')).toBeDefined();
    expect(exec.getNode('shot_image_last_frame:scene_1_shot_1')).toBeDefined();
  });

  it('shot_image_last_frame depends on shot_image and is its dependent (cascade survives)', () => {
    const exec = buildExecutor([
      makeNode({ id: 'shot_image_prompt:scene_1_shot_1', typeId: 'shot_image_prompt' }),
    ]);

    addShotImageNodes({
      executor: exec,
      shot: { itemId: 'scene_1_shot_1', name: 'Wide' },
      allCharImageIds: [],
      allSettingImageIds: [],
      prevShotImageId: null,
    });

    const firstFrame = exec.getNode('shot_image:scene_1_shot_1')!;
    const lastFrame = exec.getNode('shot_image_last_frame:scene_1_shot_1')!;

    expect(lastFrame.dependencies).toContain('shot_image:scene_1_shot_1');
    expect(firstFrame.dependents).toContain('shot_image_last_frame:scene_1_shot_1');
  });

  it('shot_image (first frame) keeps its prompt+ref-image dependencies; last_frame does NOT inherit them', () => {
    const exec = buildExecutor([
      makeNode({ id: 'shot_image_prompt:scene_1_shot_1', typeId: 'shot_image_prompt' }),
      makeNode({ id: 'character_image:arthur', typeId: 'character_image', itemId: 'arthur' }),
      makeNode({ id: 'setting_image:diner', typeId: 'setting_image', itemId: 'diner' }),
    ]);

    addShotImageNodes({
      executor: exec,
      shot: { itemId: 'scene_1_shot_1', name: 'Wide' },
      allCharImageIds: ['character_image:arthur'],
      allSettingImageIds: ['setting_image:diner'],
      prevShotImageId: null,
    });

    const firstFrame = exec.getNode('shot_image:scene_1_shot_1')!;
    const lastFrame = exec.getNode('shot_image_last_frame:scene_1_shot_1')!;

    expect(firstFrame.dependencies).toContain('shot_image_prompt:scene_1_shot_1');
    expect(firstFrame.dependencies).toContain('character_image:arthur');
    expect(firstFrame.dependencies).toContain('setting_image:diner');

    // last_frame only depends on the now-completed first_frame for the edit op.
    // It does NOT need the prompt or ref images directly — those are already
    // baked into the first_frame artifact.
    expect(lastFrame.dependencies).toEqual(['shot_image:scene_1_shot_1']);
  });

  it('cross-shot chain: prevShotImageId attaches to the new shot_image (not to last_frame)', () => {
    const exec = buildExecutor([
      makeNode({ id: 'shot_image_prompt:scene_1_shot_1', typeId: 'shot_image_prompt' }),
      makeNode({ id: 'shot_image:scene_1_shot_1', typeId: 'shot_image', itemId: 'scene_1_shot_1', status: 'completed' }),
      makeNode({ id: 'shot_image_prompt:scene_1_shot_2', typeId: 'shot_image_prompt' }),
    ]);

    addShotImageNodes({
      executor: exec,
      shot: { itemId: 'scene_1_shot_2', name: 'Reverse' },
      allCharImageIds: [],
      allSettingImageIds: [],
      prevShotImageId: 'shot_image:scene_1_shot_1',
    });

    const newFirst = exec.getNode('shot_image:scene_1_shot_2')!;
    expect(newFirst.dependencies).toContain('shot_image:scene_1_shot_1');
  });

  // ── firstFrameAnchor (visual continuity) ───────────────────────────
  // Anchor overrides the legacy prevShotImageId chain. Per the
  // sceneVideoPromptAssembler's deterministic anchor decision:
  //   - 'fresh'        → no prior-frame dep at all
  //   - 'continuity'   → depend on prior shot's LAST FRAME (smoother
  //                      than the legacy first-frame chain)
  //   - 'view_reuse'   → depend on a specific earlier shot's last
  //                      frame, not the immediate prior
  describe('firstFrameAnchor overrides the legacy chain', () => {
    it('reason=fresh → no prior-frame dep, even when prevShotImageId is supplied', () => {
      const exec = buildExecutor([
        makeNode({ id: 'shot_image_prompt:scene_1_shot_5', typeId: 'shot_image_prompt' }),
        makeNode({ id: 'shot_image:scene_1_shot_4', typeId: 'shot_image', itemId: 'scene_1_shot_4', status: 'completed' }),
      ]);

      addShotImageNodes({
        executor: exec,
        shot: { itemId: 'scene_1_shot_5', name: 'Hard cut into new view' },
        allCharImageIds: [],
        allSettingImageIds: [],
        prevShotImageId: 'shot_image:scene_1_shot_4', // would be the legacy chain
        firstFrameAnchor: { reason: 'fresh' },
        sceneId: 'scene_1',
      });

      const newFirst = exec.getNode('shot_image:scene_1_shot_5')!;
      expect(newFirst.dependencies).not.toContain('shot_image:scene_1_shot_4');
      expect(newFirst.dependencies).not.toContain('shot_image_last_frame:scene_1_shot_4');
    });

    it('reason=continuity → depends on the prior shot\'s LAST FRAME node (not the first-frame one)', () => {
      const exec = buildExecutor([
        makeNode({ id: 'shot_image_prompt:scene_1_shot_2', typeId: 'shot_image_prompt' }),
        makeNode({ id: 'shot_image:scene_1_shot_1', typeId: 'shot_image', itemId: 'scene_1_shot_1', status: 'completed' }),
        makeNode({ id: 'shot_image_last_frame:scene_1_shot_1', typeId: 'shot_image_last_frame', itemId: 'scene_1_shot_1', status: 'completed' }),
      ]);

      addShotImageNodes({
        executor: exec,
        shot: { itemId: 'scene_1_shot_2', name: 'Continuation' },
        allCharImageIds: [],
        allSettingImageIds: [],
        prevShotImageId: 'shot_image:scene_1_shot_1',
        firstFrameAnchor: { reason: 'continuity', sourceShotNumber: 1 },
        sceneId: 'scene_1',
      });

      const newFirst = exec.getNode('shot_image:scene_1_shot_2')!;
      // The new chain anchors on shot 1's LAST frame, not its first.
      expect(newFirst.dependencies).toContain('shot_image_last_frame:scene_1_shot_1');
      expect(newFirst.dependencies).not.toContain('shot_image:scene_1_shot_1');
    });

    it('reason=view_reuse → depends on the SPECIFIED source shot\'s last frame, not the immediate prior', () => {
      const exec = buildExecutor([
        makeNode({ id: 'shot_image_prompt:scene_1_shot_5', typeId: 'shot_image_prompt' }),
        makeNode({ id: 'shot_image_last_frame:scene_1_shot_2', typeId: 'shot_image_last_frame', itemId: 'scene_1_shot_2', status: 'completed' }),
        makeNode({ id: 'shot_image_last_frame:scene_1_shot_4', typeId: 'shot_image_last_frame', itemId: 'scene_1_shot_4', status: 'completed' }),
      ]);

      addShotImageNodes({
        executor: exec,
        shot: { itemId: 'scene_1_shot_5', name: 'Return to shot 2 view' },
        allCharImageIds: [],
        allSettingImageIds: [],
        prevShotImageId: 'shot_image:scene_1_shot_4', // immediate prior — should be IGNORED
        firstFrameAnchor: { reason: 'view_reuse', sourceShotNumber: 2 },
        sceneId: 'scene_1',
      });

      const newFirst = exec.getNode('shot_image:scene_1_shot_5')!;
      expect(newFirst.dependencies).toContain('shot_image_last_frame:scene_1_shot_2');
      expect(newFirst.dependencies).not.toContain('shot_image_last_frame:scene_1_shot_4');
      expect(newFirst.dependencies).not.toContain('shot_image:scene_1_shot_4');
    });

    it('no anchor + no sceneId → legacy prevShotImageId chain (back-compat for callers not yet updated)', () => {
      const exec = buildExecutor([
        makeNode({ id: 'shot_image_prompt:scene_1_shot_2', typeId: 'shot_image_prompt' }),
        makeNode({ id: 'shot_image:scene_1_shot_1', typeId: 'shot_image', itemId: 'scene_1_shot_1', status: 'completed' }),
      ]);

      addShotImageNodes({
        executor: exec,
        shot: { itemId: 'scene_1_shot_2', name: 'Legacy' },
        allCharImageIds: [],
        allSettingImageIds: [],
        prevShotImageId: 'shot_image:scene_1_shot_1',
        // no anchor, no sceneId — falls back to old behavior
      });

      const newFirst = exec.getNode('shot_image:scene_1_shot_2')!;
      expect(newFirst.dependencies).toContain('shot_image:scene_1_shot_1');
    });
  });

  it('is idempotent — calling twice for the same shot does not duplicate nodes', () => {
    const exec = buildExecutor([
      makeNode({ id: 'shot_image_prompt:scene_1_shot_1', typeId: 'shot_image_prompt' }),
    ]);

    addShotImageNodes({
      executor: exec,
      shot: { itemId: 'scene_1_shot_1', name: 'Wide' },
      allCharImageIds: [],
      allSettingImageIds: [],
      prevShotImageId: null,
    });
    addShotImageNodes({
      executor: exec,
      shot: { itemId: 'scene_1_shot_1', name: 'Wide' },
      allCharImageIds: [],
      allSettingImageIds: [],
      prevShotImageId: null,
    });

    const firstFrame = exec.getNode('shot_image:scene_1_shot_1')!;
    const lastFrame = exec.getNode('shot_image_last_frame:scene_1_shot_1')!;

    // dependents shouldn't accumulate duplicates
    const dupes = firstFrame.dependents.filter(d => d === 'shot_image_last_frame:scene_1_shot_1');
    expect(dupes.length).toBe(1);
    expect(lastFrame.dependencies.filter(d => d === 'shot_image:scene_1_shot_1').length).toBe(1);
  });
});
