/**
 * Tests for computeCascadeImpact — the pure preview helper that
 * tells the critique flow which nodes would be invalidated if a
 * given (nodeId, itemId?) gets re-fired. Walks the bundle DAG
 * forward from the target.
 *
 * Failure modes enumerated:
 *  - Singleton node → only its direct + transitive downstream nodes.
 *  - Collection node, no itemId → all downstream nodes.
 *  - Collection node WITH itemId → downstream items derived from
 *    that itemId only (NOT the whole downstream collection).
 *  - Target with no downstream nodes → affectedNodes is just [self].
 *  - Bundle with a fan-out (one upstream feeds 2+ downstreams) →
 *    BFS visits both branches.
 *  - Cycle defense: the walk must not infinite-loop if a malformed
 *    bundle has a back-edge.
 *  - Returns runner + format on each affected node so the agent can
 *    count image/video impacts.
 *  - Unknown nodeId → result has `error: 'unknown node'`.
 */
import { describe, it, expect } from 'vitest';
import { computeCascadeImpact } from '../../src/dag/cascadeImpact.js';
import type { DagBundle, NodeDef } from '../../src/dag/schema.js';

function n(
  id: string,
  opts: {
    kind?: 'stage' | 'collection';
    inputs?: string[];
    format?: 'md' | 'json' | 'image' | 'video' | 'audio' | 'text';
    runner?: string;
    itemSource?: string;
  } = {},
): NodeDef {
  return {
    id,
    kind: opts.kind ?? 'stage',
    inputs: (opts.inputs ?? []).map((from) => ({ from, usage: 'input' as const })),
    outputs: { format: opts.format ?? 'json', pattern: `${id}.json` },
    runner: { tool: opts.runner ?? 'llm.generate', config: {} },
    ...(opts.itemSource ? { itemSource: opts.itemSource } : {}),
  };
}

function bundle(...nodes: NodeDef[]): DagBundle {
  return {
    id: 'cascade-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: nodes[nodes.length - 1]?.id ?? 'last',
    nodes,
  };
}

describe('computeCascadeImpact', () => {
  it('returns only the target when nothing depends on it (leaf node)', () => {
    const b = bundle(
      n('story', { runner: 'llm.generate' }),
      n('characters_plan', { runner: 'llm.generate', inputs: ['story'] }),
    );
    const r = computeCascadeImpact({ bundle: b, nodeId: 'characters_plan' });
    expect(r.error).toBeUndefined();
    expect(r.affectedNodes.map((a) => a.nodeId)).toEqual(['characters_plan']);
  });

  it('walks transitive downstream nodes via BFS', () => {
    const b = bundle(
      n('story', { runner: 'llm.generate' }),
      n('characters_plan', { runner: 'llm.generate', inputs: ['story'] }),
      n('shot_prompt', { runner: 'llm.generate', inputs: ['characters_plan'] }),
      n('shot_image', { runner: 'comfy.image', format: 'image', inputs: ['shot_prompt'] }),
    );
    const r = computeCascadeImpact({ bundle: b, nodeId: 'story' });
    expect(r.affectedNodes.map((a) => a.nodeId)).toEqual([
      'story',
      'characters_plan',
      'shot_prompt',
      'shot_image',
    ]);
  });

  it('handles fan-out — one upstream feeds multiple downstreams', () => {
    const b = bundle(
      n('story', { runner: 'llm.generate' }),
      n('characters', { runner: 'llm.generate', inputs: ['story'] }),
      n('settings', { runner: 'llm.generate', inputs: ['story'] }),
    );
    const r = computeCascadeImpact({ bundle: b, nodeId: 'story' });
    const ids = r.affectedNodes.map((a) => a.nodeId).sort();
    expect(ids).toEqual(['characters', 'settings', 'story']);
  });

  it('surfaces runner tool + output format on each affected node', () => {
    const b = bundle(
      n('shot_prompt', { runner: 'llm.generate', format: 'json' }),
      n('shot_image', { runner: 'comfy.image', format: 'image', inputs: ['shot_prompt'] }),
      n('shot_video', { runner: 'comfy.ltx_director', format: 'video', inputs: ['shot_image'] }),
    );
    const r = computeCascadeImpact({ bundle: b, nodeId: 'shot_prompt' });
    expect(r.affectedNodes).toEqual([
      { nodeId: 'shot_prompt', runner: 'llm.generate', format: 'json' },
      { nodeId: 'shot_image', runner: 'comfy.image', format: 'image' },
      { nodeId: 'shot_video', runner: 'comfy.ltx_director', format: 'video' },
    ]);
  });

  it('does not infinite-loop on a malformed bundle with a back-edge', () => {
    const b = bundle(
      n('a', { runner: 'llm.generate', inputs: ['b'] }),
      n('b', { runner: 'llm.generate', inputs: ['a'] }),
    );
    const r = computeCascadeImpact({ bundle: b, nodeId: 'a' });
    expect(r.error).toBeUndefined();
    // Visits both, terminates.
    expect(r.affectedNodes.map((a) => a.nodeId).sort()).toEqual(['a', 'b']);
  });

  it('returns error: unknown node when target is not in the bundle', () => {
    const b = bundle(n('story', { runner: 'llm.generate' }));
    const r = computeCascadeImpact({ bundle: b, nodeId: 'no_such_node' });
    expect(r.error).toMatch(/unknown node/i);
    expect(r.affectedNodes).toEqual([]);
  });

  it('counts image vs non-image affected nodes (helper for confirmation gate)', () => {
    const b = bundle(
      n('prompt', { runner: 'llm.generate', format: 'json' }),
      n('img1', { runner: 'comfy.image', format: 'image', inputs: ['prompt'] }),
      n('img2', { runner: 'comfy.image', format: 'image', inputs: ['prompt'] }),
      n('vid', { runner: 'comfy.video', format: 'video', inputs: ['img1'] }),
    );
    const r = computeCascadeImpact({ bundle: b, nodeId: 'prompt' });
    const imageOrVideoCount = r.affectedNodes.filter(
      (a) => a.format === 'image' || a.format === 'video',
    ).length;
    expect(imageOrVideoCount).toBe(3); // img1, img2, vid
  });

  it('walkState-aware: drops text-format nodes from affectedNonTextArtifacts', () => {
    const b = bundle(
      n('prompt', { runner: 'llm.generate', format: 'json' }),
      n('img', { runner: 'comfy.image', format: 'image', inputs: ['prompt'] }),
    );
    const r = computeCascadeImpact({
      bundle: b,
      nodeId: 'prompt',
      walkState: { nodes: { prompt: { status: 'completed' }, img: { status: 'completed' } } },
    });
    // Structural view counts both:
    expect(r.affectedNodes.map((a) => a.nodeId)).toEqual(['prompt', 'img']);
    // walkState-aware view drops the json prompt; only the image counts.
    expect(r.affectedNonTextArtifacts.map((a) => a.nodeId)).toEqual(['img']);
  });

  it('walkState-aware: drops downstream nodes that have never been generated', () => {
    const b = bundle(
      n('prompt', { runner: 'llm.generate', format: 'json' }),
      n('img', { runner: 'comfy.image', format: 'image', inputs: ['prompt'] }),
      n('vid', { runner: 'comfy.video', format: 'video', inputs: ['img'] }),
      n('final', { runner: 'ffmpeg.concat', format: 'video', inputs: ['vid'] }),
    );
    // Image rendered; video + final never have. Critiquing the prompt
    // would only destroy the image; the never-rendered video + final
    // don't count.
    const r = computeCascadeImpact({
      bundle: b,
      nodeId: 'prompt',
      walkState: {
        nodes: {
          prompt: { status: 'completed' },
          img: { status: 'completed' },
          // vid and final absent — never generated.
        },
      },
    });
    expect(r.affectedNonTextArtifacts.map((a) => a.nodeId)).toEqual(['img']);
  });

  it('walkState-aware: counts collection nodes when ANY of their items are completed', () => {
    const b = bundle(
      n('prompt', { runner: 'llm.generate', format: 'json' }),
      n('imgs', { runner: 'comfy.image', format: 'image', inputs: ['prompt'] }),
    );
    const r = computeCascadeImpact({
      bundle: b,
      nodeId: 'prompt',
      walkState: {
        nodes: {
          prompt: { status: 'completed' },
          'imgs:scene_1_shot_1': { status: 'completed' },
          'imgs:scene_1_shot_2': { status: 'pending' },
        },
      },
    });
    // imgs has one completed item → counts.
    expect(r.affectedNonTextArtifacts.map((a) => a.nodeId)).toEqual(['imgs']);
  });

  it('walkState-aware: failed entries DO NOT count (no artifact on disk to destroy)', () => {
    const b = bundle(
      n('prompt', { runner: 'llm.generate', format: 'json' }),
      n('img', { runner: 'comfy.image', format: 'image', inputs: ['prompt'] }),
    );
    const r = computeCascadeImpact({
      bundle: b,
      nodeId: 'prompt',
      walkState: { nodes: { prompt: { status: 'completed' }, img: { status: 'failed' } } },
    });
    // failed === artifact never written; the cascade has nothing to destroy here.
    expect(r.affectedNonTextArtifacts).toEqual([]);
  });

  it('walkState-aware: pending-only downstream is dropped (no completed item yet)', () => {
    const b = bundle(
      n('prompt', { runner: 'llm.generate', format: 'json' }),
      n('img', { runner: 'comfy.image', format: 'image', inputs: ['prompt'] }),
    );
    const r = computeCascadeImpact({
      bundle: b,
      nodeId: 'prompt',
      walkState: { nodes: { prompt: { status: 'completed' }, img: { status: 'pending' } } },
    });
    expect(r.affectedNonTextArtifacts).toEqual([]);
  });

  it('without walkState: affectedNonTextArtifacts is empty (legacy path)', () => {
    const b = bundle(
      n('prompt', { runner: 'llm.generate', format: 'json' }),
      n('img', { runner: 'comfy.image', format: 'image', inputs: ['prompt'] }),
    );
    const r = computeCascadeImpact({ bundle: b, nodeId: 'prompt' });
    expect(r.affectedNodes.length).toBe(2);
    expect(r.affectedNonTextArtifacts).toEqual([]);
  });
});
