/**
 * projectInstanceGraph — per-instance dependency graph projection.
 *
 * The graph the desktop's Inspector cards UI consumes. Like every
 * other projection, it's a pure fold over the event log — no file
 * reads, no bundle re-parsing on the renderer side.
 *
 * Failure modes:
 *   1. Empty events → empty graph.
 *   2. One node.completed → one instance, no edges.
 *   3. Completed with dependencies → instance + an edge per dep.
 *   4. Stage upstream → collection downstream: one edge from the
 *      stage to each downstream instance.
 *   5. Same instance completed twice → ONE instance entry (latest wins
 *      for status / outputPath).
 *   6. node.invalidated → instance status flips back to 'invalidated';
 *      edges from prior dependencies are dropped.
 *   7. node.failed → instance status 'failed', error preserved.
 *   8. Branch isolation — events on a non-target branch are excluded.
 *   9. Time-travel asOfSeq — graph reflects only events up to seq.
 *  10. Roles preserved on edges (input vs context vs reference).
 */
import { describe, it, expect } from 'vitest';
import type { DheeEvent } from '../../../src/dag/eventLog/events.js';
import { projectInstanceGraph } from '../../../src/dag/eventLog/projectInstanceGraph.js';

function ev(seq: number, kind: DheeEvent['kind'], payload: Record<string, unknown>, branchId = 'main'): DheeEvent {
  return { seq, id: `e${seq}`, ts: seq, branchId, actor: 'walker', kind, payload } as unknown as DheeEvent;
}

describe('projectInstanceGraph', () => {
  it('empty events → empty graph', () => {
    const g = projectInstanceGraph([]);
    expect(g.instances).toEqual([]);
    expect(g.edges).toEqual([]);
  });

  it('one node.completed → one instance, no edges', () => {
    const g = projectInstanceGraph([
      ev(1, 'node.completed', {
        nodeId: 'plot', versionId: 'v1', outputPath: 'plans/plot.md',
      }),
    ]);
    expect(g.instances).toHaveLength(1);
    expect(g.instances[0]).toMatchObject({
      nodeId: 'plot',
      status: 'completed',
      outputPath: 'plans/plot.md',
      versionId: 'v1',
    });
    expect(g.edges).toEqual([]);
  });

  it('node.completed with dependencies → instance + an edge per dep', () => {
    const g = projectInstanceGraph([
      ev(1, 'node.completed', {
        nodeId: 'plot', versionId: 'v1', outputPath: 'plans/plot.md',
      }),
      ev(2, 'node.completed', {
        nodeId: 'scenes_plan', versionId: 'v1', outputPath: 'plans/scenes_plan.json',
        dependencies: [{ nodeId: 'plot' }],
      }),
    ]);
    expect(g.instances.map((i) => i.nodeId)).toEqual(['plot', 'scenes_plan']);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0]).toMatchObject({
      fromNodeId: 'plot',
      toNodeId: 'scenes_plan',
    });
  });

  it('collection edges carry itemIds', () => {
    const g = projectInstanceGraph([
      ev(1, 'node.completed', {
        nodeId: 'character_image', itemId: 'lara_croft',
        versionId: 'c1', outputPath: 'chars/lara.png',
      }),
      ev(2, 'node.completed', {
        nodeId: 'shot_image', itemId: 'scene_1_shot_3',
        versionId: 's1', outputPath: 'shots/3.png',
        dependencies: [
          { nodeId: 'character_image', itemId: 'lara_croft', role: 'reference' },
          { nodeId: 'shot_image_prompt', itemId: 'scene_1_shot_3', role: 'input' },
        ],
      }),
    ]);
    expect(g.instances).toHaveLength(2);
    expect(g.edges).toHaveLength(2);
    const charEdge = g.edges.find((e) => e.fromNodeId === 'character_image');
    expect(charEdge).toMatchObject({
      fromNodeId: 'character_image',
      fromItemId: 'lara_croft',
      toNodeId: 'shot_image',
      toItemId: 'scene_1_shot_3',
      role: 'reference',
    });
  });

  it('same instance completed twice → ONE instance entry (latest wins)', () => {
    const g = projectInstanceGraph([
      ev(1, 'node.completed', {
        nodeId: 'shot_image', itemId: 's1', versionId: 'v1', outputPath: 'shots/s1.png',
      }),
      ev(2, 'node.invalidated', { nodeId: 'shot_image', itemId: 's1' }),
      ev(3, 'node.completed', {
        nodeId: 'shot_image', itemId: 's1', versionId: 'v2', outputPath: 'shots/s1.v2.png',
      }),
    ]);
    expect(g.instances).toHaveLength(1);
    expect(g.instances[0]).toMatchObject({
      versionId: 'v2',
      outputPath: 'shots/s1.v2.png',
      status: 'completed',
    });
  });

  it('node.invalidated → status flips back; dependencies are dropped', () => {
    const g = projectInstanceGraph([
      ev(1, 'node.completed', { nodeId: 'plot', versionId: 'v1', outputPath: 'a' }),
      ev(2, 'node.completed', {
        nodeId: 'scenes_plan', versionId: 'v1', outputPath: 'b',
        dependencies: [{ nodeId: 'plot' }],
      }),
      ev(3, 'node.invalidated', { nodeId: 'scenes_plan' }),
    ]);
    const scenes = g.instances.find((i) => i.nodeId === 'scenes_plan');
    expect(scenes?.status).toBe('invalidated');
    // Edge gone because the invalidated instance has no current
    // dependencies (it'll re-acquire them on next completion).
    expect(g.edges.filter((e) => e.toNodeId === 'scenes_plan')).toHaveLength(0);
  });

  it('node.failed → instance status failed with error', () => {
    const g = projectInstanceGraph([
      ev(1, 'node.failed', { nodeId: 'x', error: 'boom' }),
    ]);
    expect(g.instances[0]).toMatchObject({ nodeId: 'x', status: 'failed', error: 'boom' });
  });

  it('node.started before node.completed → in_progress instance', () => {
    const g = projectInstanceGraph([
      ev(1, 'node.started', { nodeId: 'shot_image', itemId: 's3' }),
    ]);
    expect(g.instances[0]).toMatchObject({
      nodeId: 'shot_image', itemId: 's3', status: 'in_progress',
    });
  });

  it('branch isolation: only target branch events fold in', () => {
    const g = projectInstanceGraph([
      ev(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'a' }),
      ev(2, 'node.completed', { nodeId: 'b', versionId: 'v1', outputPath: 'b' }, 'noir'),
    ]);
    expect(g.instances.map((i) => i.nodeId)).toEqual(['a']);
    const noir = projectInstanceGraph([
      ev(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'a' }),
      ev(2, 'node.completed', { nodeId: 'b', versionId: 'v1', outputPath: 'b' }, 'noir'),
    ], { branchId: 'noir' });
    // Branch noir inherits main's prefix (per branchVisibilityFilter)
    // OR doesn't, depending on whether the noir branch has a
    // branch.created event referencing main. With no branch.created
    // event, noir is a standalone branch and inherits nothing.
    expect(noir.instances.map((i) => i.nodeId)).toEqual(['b']);
  });

  it('asOfSeq → time-travel snapshot of the graph', () => {
    const events = [
      ev(1, 'node.completed', { nodeId: 'a', versionId: 'v1', outputPath: 'a' }),
      ev(2, 'node.completed', {
        nodeId: 'b', versionId: 'v1', outputPath: 'b',
        dependencies: [{ nodeId: 'a' }],
      }),
      ev(3, 'node.completed', {
        nodeId: 'c', versionId: 'v1', outputPath: 'c',
        dependencies: [{ nodeId: 'b' }],
      }),
    ];
    const at2 = projectInstanceGraph(events, { asOfSeq: 2 });
    expect(at2.instances.map((i) => i.nodeId).sort()).toEqual(['a', 'b']);
    const at3 = projectInstanceGraph(events);
    expect(at3.instances.map((i) => i.nodeId).sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('projectInstanceGraph — dependents helper', () => {
  it('computeDependents returns the transitive forward set', async () => {
    const { computeDependents } = await import('../../../src/dag/eventLog/projectInstanceGraph.js');
    const edges = [
      { fromNodeId: 'a', toNodeId: 'b' },
      { fromNodeId: 'b', toNodeId: 'c' },
      { fromNodeId: 'b', toNodeId: 'd' },
      { fromNodeId: 'x', toNodeId: 'y' },
    ];
    const deps = computeDependents(edges, { nodeId: 'a' });
    expect([...deps].sort()).toEqual(['b', 'c', 'd']);
  });

  it('itemId-scoped dependents', async () => {
    const { computeDependents } = await import('../../../src/dag/eventLog/projectInstanceGraph.js');
    const edges = [
      { fromNodeId: 'char', fromItemId: 'lara', toNodeId: 'shot', toItemId: 's3' },
      { fromNodeId: 'char', fromItemId: 'lara', toNodeId: 'shot', toItemId: 's7' },
      { fromNodeId: 'char', fromItemId: 'beth', toNodeId: 'shot', toItemId: 's2' },
      { fromNodeId: 'shot', fromItemId: 's3', toNodeId: 'final' },
    ];
    // Only shots referencing lara — and the final cut downstream of shot s3.
    const deps = computeDependents(edges, { nodeId: 'char', itemId: 'lara' });
    expect([...deps].sort()).toEqual(['final', 'shot:s3', 'shot:s7']);
  });
});
