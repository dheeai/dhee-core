/**
 * cascadeInvalidationKeys — TDD for the precise cascade-invalidator.
 *
 * Folds the project's events.jsonl into a per-instance dependency
 * graph (using node.completed.dependencies[]), then forward-BFS from
 * the target to find every downstream item that consumed it
 * (transitively). Returns the target + all downstream — the keys
 * invalidateNodes will clear.
 *
 * Key property: precision. Hovering kiyoko should only highlight
 * shots that listed her as a reference, not every shot. The fix in
 * commit 406636f (per-shot ref subset on node.completed) makes the
 * event data honest; this helper consumes that data correctly.
 *
 * Failure modes:
 *   1. No events → just the target.
 *   2. Target with no downstream → just the target.
 *   3. Linear chain A→B→C (A is upstream of B; B of C) → [A, B, C].
 *   4. Diamond A→{B,C}→D → [A, B, C, D].
 *   5. Item-precise: char:kiyoko consumed only by shot:1 and shot:3.
 *      Invalidate char:kiyoko → kiyoko + shot:1 + shot:3 (NOT shot:2).
 *   6. Transitive: char:kiyoko → shot:1 → scene_clip → final_video.
 *      Invalidate char:kiyoko → all four.
 *   7. Multiple completions of same instance (re-renders): use the
 *      LATEST event's deps (the older renders' deps are stale).
 *   8. Cycle in deps → terminates without infinite loop (defensive).
 *   9. branchId filter: deps on a different branch don't count.
 *  10. Target itself appears in the output (it's invalidated too).
 *  11. node.invalidated events erase the corresponding deps (the
 *      instance was already cleared; not currently a consumer).
 */
import { describe, it, expect } from 'vitest';
import { cascadeInvalidationKeys } from '../../src/dag/cascadeInvalidationKeys.js';
import type { DheeEvent } from '../../src/dag/eventLog/events.js';

function completed(
  nodeId: string,
  itemId: string | undefined,
  deps: Array<{ nodeId: string; itemId?: string }>,
  seq: number,
  branchId: string = 'main',
): DheeEvent<'node.completed'> {
  return {
    seq,
    id: `e${seq}`,
    ts: 1000 + seq,
    branchId,
    actor: 'walker',
    kind: 'node.completed',
    payload: {
      nodeId,
      ...(itemId !== undefined ? { itemId } : {}),
      versionId: `v${seq}`,
      outputPath: `assets/${nodeId}${itemId ? `_${itemId}` : ''}.bin`,
      artifact: { format: 'image' },
      dependencies: deps.map((d) => ({ ...d, role: 'reference' as const })),
    },
  };
}

function invalidated(
  nodeId: string,
  itemId: string | undefined,
  seq: number,
): DheeEvent<'node.invalidated'> {
  return {
    seq,
    id: `e${seq}`,
    ts: 1000 + seq,
    branchId: 'main',
    actor: 'agent',
    kind: 'node.invalidated',
    payload: { nodeId, ...(itemId !== undefined ? { itemId } : {}) },
  };
}

function keysOf(arr: Array<{ nodeId: string; itemId?: string }>): string[] {
  return arr.map((k) => (k.itemId ? `${k.nodeId}:${k.itemId}` : k.nodeId)).sort();
}

describe('cascadeInvalidationKeys', () => {
  it('1. no events → just target', () => {
    const r = cascadeInvalidationKeys([], { nodeId: 'plot' });
    expect(keysOf(r)).toEqual(['plot']);
  });

  it('2. target has no downstream → just target', () => {
    const events = [
      completed('plot', undefined, [], 1),
      completed('story', undefined, [{ nodeId: 'plot' }], 2),
    ];
    const r = cascadeInvalidationKeys(events, { nodeId: 'final_video' });
    expect(keysOf(r)).toEqual(['final_video']);
  });

  it('3. linear chain A→B→C', () => {
    const events = [
      completed('plot', undefined, [], 1),
      completed('story', undefined, [{ nodeId: 'plot' }], 2),
      completed('scenes', undefined, [{ nodeId: 'story' }], 3),
    ];
    const r = cascadeInvalidationKeys(events, { nodeId: 'plot' });
    expect(keysOf(r)).toEqual(['plot', 'scenes', 'story']);
  });

  it('4. diamond A→{B,C}→D', () => {
    const events = [
      completed('plot', undefined, [], 1),
      completed('story', undefined, [{ nodeId: 'plot' }], 2),
      completed('chars', undefined, [{ nodeId: 'plot' }], 3),
      completed('scenes', undefined, [{ nodeId: 'story' }, { nodeId: 'chars' }], 4),
    ];
    const r = cascadeInvalidationKeys(events, { nodeId: 'plot' });
    expect(keysOf(r)).toEqual(['chars', 'plot', 'scenes', 'story']);
  });

  it('5. item-precise: char:kiyoko → only consuming shots', () => {
    const events = [
      completed('character_image', 'kiyoko', [], 1),
      completed('character_image', 'male_swordsman', [], 2),
      // shot_1 references kiyoko only
      completed('shot_image', 'scene_1_shot_1', [{ nodeId: 'character_image', itemId: 'kiyoko' }], 3),
      // shot_2 references male only — should NOT cascade from kiyoko
      completed('shot_image', 'scene_1_shot_2', [{ nodeId: 'character_image', itemId: 'male_swordsman' }], 4),
      // shot_3 references both
      completed('shot_image', 'scene_1_shot_3', [
        { nodeId: 'character_image', itemId: 'kiyoko' },
        { nodeId: 'character_image', itemId: 'male_swordsman' },
      ], 5),
    ];
    const r = cascadeInvalidationKeys(events, { nodeId: 'character_image', itemId: 'kiyoko' });
    expect(keysOf(r)).toEqual([
      'character_image:kiyoko',
      'shot_image:scene_1_shot_1',
      'shot_image:scene_1_shot_3',
    ]);
  });

  it('6. transitive: char:kiyoko → shot:1 → scene_clip → final_video', () => {
    const events = [
      completed('character_image', 'kiyoko', [], 1),
      completed('shot_image', 'scene_1_shot_1', [{ nodeId: 'character_image', itemId: 'kiyoko' }], 2),
      completed('scene_clip', 'scene_1_chunk_1', [{ nodeId: 'shot_image', itemId: 'scene_1_shot_1' }], 3),
      completed('final_video', undefined, [{ nodeId: 'scene_clip', itemId: 'scene_1_chunk_1' }], 4),
    ];
    const r = cascadeInvalidationKeys(events, { nodeId: 'character_image', itemId: 'kiyoko' });
    expect(keysOf(r)).toEqual([
      'character_image:kiyoko',
      'final_video',
      'scene_clip:scene_1_chunk_1',
      'shot_image:scene_1_shot_1',
    ]);
  });

  it('7. multiple completions of same instance → latest deps win', () => {
    const events = [
      completed('plot', undefined, [], 1),
      // Old story render depended on plot
      completed('story', undefined, [{ nodeId: 'plot' }], 2),
      // Re-render: story no longer depends on plot (hypothetical bundle change)
      completed('story', undefined, [], 3),
    ];
    const r = cascadeInvalidationKeys(events, { nodeId: 'plot' });
    // story was re-completed without plot as a dep, so it doesn't cascade
    expect(keysOf(r)).toEqual(['plot']);
  });

  it('8. cycle in deps terminates', () => {
    const events = [
      completed('a', undefined, [{ nodeId: 'b' }], 1),
      completed('b', undefined, [{ nodeId: 'a' }], 2),
    ];
    const r = cascadeInvalidationKeys(events, { nodeId: 'a' });
    expect(keysOf(r)).toEqual(['a', 'b']);
  });

  it('9. branchId filter: cross-branch deps ignored', () => {
    const events = [
      completed('plot', undefined, [], 1, 'main'),
      completed('story', undefined, [{ nodeId: 'plot' }], 2, 'experiment'),
    ];
    const r = cascadeInvalidationKeys(events, { nodeId: 'plot' }, { branchId: 'main' });
    // story was completed on experiment branch, so it's not in main's
    // dependency graph.
    expect(keysOf(r)).toEqual(['plot']);
  });

  it('10. target always present in output', () => {
    const r = cascadeInvalidationKeys([], { nodeId: 'shot_image', itemId: 'scene_1_shot_3' });
    expect(keysOf(r)).toEqual(['shot_image:scene_1_shot_3']);
  });

  it('11. node.invalidated erases the consumer from cascade', () => {
    const events = [
      completed('plot', undefined, [], 1),
      completed('story', undefined, [{ nodeId: 'plot' }], 2),
      invalidated('story', undefined, 3),
    ];
    const r = cascadeInvalidationKeys(events, { nodeId: 'plot' });
    // story was invalidated AFTER it completed; its deps are no
    // longer the current state, so it shouldn't appear in cascade.
    expect(keysOf(r)).toEqual(['plot']);
  });
});
