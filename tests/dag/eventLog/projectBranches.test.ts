/**
 * projectBranches — branch tree from branch.created events.
 *
 *   1. No events → just 'main' branch with no parent.
 *   2. One branch.created → main + new branch tagged as child.
 *   3. Nested branches build a tree with parent pointers.
 *   4. label is preserved in the projection.
 *   5. forkedFromEventId is preserved (so UI can show the fork point).
 */
import { describe, it, expect } from 'vitest';
import type { DheeEvent } from '../../../src/dag/eventLog/events.js';
import { computeBranchTree } from '../../../src/dag/eventLog/projectBranches.js';

function mkEvent(seq: number, kind: DheeEvent['kind'], payload: Record<string, unknown>, branchId = 'main'): DheeEvent {
  return { seq, id: `e${seq}`, ts: seq, branchId, actor: 'walker', kind, payload } as unknown as DheeEvent;
}

describe('projectBranches / computeBranchTree', () => {
  it('no events → main branch only', () => {
    const tree = computeBranchTree([]);
    expect(tree.branches.map((b) => b.branchId)).toEqual(['main']);
    expect(tree.branches[0]?.parentBranchId).toBeUndefined();
  });

  it('one branch.created → main + one child', () => {
    const evs = [
      mkEvent(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.md' }),
      mkEvent(2, 'branch.created', { branchId: 'noir', label: 'noir grade', forkedFromEventId: 'e1', parentBranchId: 'main' }),
    ];
    const tree = computeBranchTree(evs);
    const noir = tree.branches.find((b) => b.branchId === 'noir');
    expect(noir).toBeDefined();
    expect(noir?.parentBranchId).toBe('main');
    expect(noir?.label).toBe('noir grade');
    expect(noir?.forkedFromEventId).toBe('e1');
  });

  it('nested branches form a tree', () => {
    const evs = [
      mkEvent(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'out/a.md' }),
      mkEvent(2, 'branch.created', { branchId: 'noir', forkedFromEventId: 'e1', parentBranchId: 'main' }),
      mkEvent(3, 'branch.created', { branchId: 'noir-bright', forkedFromEventId: 'e2', parentBranchId: 'noir' }, 'noir'),
    ];
    const tree = computeBranchTree(evs);
    const bright = tree.branches.find((b) => b.branchId === 'noir-bright');
    expect(bright?.parentBranchId).toBe('noir');
  });
});
