/**
 * Tests for the capability-tagged-nodes query API. This is the
 * contract the desktop relies on for bundle-agnostic view rendering.
 */
import { describe, it, expect } from 'vitest';
import { findByCapability, findInstanceByCapability, listCompletedItemIds } from '../../src/dag/capabilities.js';
import type { DagBundle, NodeDef } from '../../src/dag/schema.js';

function n(id: string, capability?: string, kind: 'stage' | 'collection' = 'collection'): NodeDef {
  return {
    id,
    kind,
    inputs: [],
    outputs: { format: 'json', pattern: `${id}.json` },
    runner: { tool: 'stub', config: {} },
    ...(capability ? { displayCapability: capability } : {}),
  };
}

function bundle(...nodes: NodeDef[]): DagBundle {
  return {
    id: 'cap-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: nodes[nodes.length - 1]?.id ?? 'last',
    nodes,
  };
}

describe('capabilities query API', () => {
  describe('findByCapability', () => {
    it('returns nodes tagged with the requested capability', () => {
      const b = bundle(
        n('shot_image_prompt', 'shot.prompt'),
        n('shot_motion', 'shot.motion'),
        n('shot_image', 'shot.first_frame'),
      );
      const result = findByCapability(b, { nodes: {} }, 'shot.prompt');
      expect(result).toHaveLength(1);
      expect(result[0]!.node.id).toBe('shot_image_prompt');
    });

    it('returns multiple nodes when more than one shares the same capability', () => {
      // Hypothetical: a bundle that has TWO sources of shot prompts
      // (e.g. one for normal shots, one for inserts).
      const b = bundle(
        n('shot_image_prompt', 'shot.prompt'),
        n('insert_shot_prompt', 'shot.prompt'),
      );
      const result = findByCapability(b, { nodes: {} }, 'shot.prompt');
      expect(result).toHaveLength(2);
      expect(result.map((r) => r.node.id)).toEqual(['shot_image_prompt', 'insert_shot_prompt']);
    });

    it('returns empty array when no node has the capability', () => {
      const b = bundle(n('plot', 'plot.outline'));
      expect(findByCapability(b, { nodes: {} }, 'shot.prompt')).toEqual([]);
    });

    it('returns empty array when bundle has no capability-tagged nodes at all', () => {
      const b = bundle(n('plot'), n('story'));
      expect(findByCapability(b, { nodes: {} }, 'shot.prompt')).toEqual([]);
    });

    it('pairs each node with its completed collection instances from walkState', () => {
      const b = bundle(n('shot_image_prompt', 'shot.prompt'));
      const state = {
        nodes: {
          shot_image_prompt: { status: 'pending' },
          'shot_image_prompt:scene_1_shot_1': {
            status: 'completed',
            outputPath: 'prompts/shot_image/scene_1_shot_1.json',
          },
          'shot_image_prompt:scene_1_shot_2': {
            status: 'completed',
            outputPath: 'prompts/shot_image/scene_1_shot_2.json',
          },
          'shot_image_prompt:scene_1_shot_3': { status: 'failed' },
        },
      };
      const result = findByCapability(b, state, 'shot.prompt');
      expect(result).toHaveLength(1);
      const insts = result[0]!.instances;
      // Expect all 4 — the parent (no itemId) + 3 collection instances.
      expect(insts).toHaveLength(4);
      const completed = insts.filter((i) => i.status === 'completed');
      expect(completed).toHaveLength(2);
      expect(completed.map((i) => i.itemId).sort()).toEqual(['scene_1_shot_1', 'scene_1_shot_2']);
      expect(completed[0]!.outputPath).toMatch(/scene_1_shot_1\.json$/);
    });

    it('pairs a stage node (no collection instance) with a single instance entry', () => {
      const b = bundle(n('plot', 'plot.outline', 'stage'));
      const state = { nodes: { plot: { status: 'completed', outputPath: 'plans/plot.md' } } };
      const result = findByCapability(b, state, 'plot.outline');
      expect(result[0]!.instances).toHaveLength(1);
      expect(result[0]!.instances[0]!.itemId).toBeUndefined();
      expect(result[0]!.instances[0]!.outputPath).toBe('plans/plot.md');
    });

    it('handles missing walkState gracefully (no nodes, no instances)', () => {
      const b = bundle(n('shot_image_prompt', 'shot.prompt'));
      expect(findByCapability(b, undefined, 'shot.prompt')[0]!.instances).toEqual([]);
      expect(findByCapability(b, null, 'shot.prompt')[0]!.instances).toEqual([]);
      expect(findByCapability(b, { nodes: {} }, 'shot.prompt')[0]!.instances).toEqual([]);
    });

    it('does not confuse two nodes whose ids share a prefix', () => {
      // 'shot_image' shouldn't match instances of 'shot_image_prompt'.
      const b = bundle(
        n('shot_image_prompt', 'shot.prompt'),
        n('shot_image', 'shot.first_frame'),
      );
      const state = {
        nodes: {
          'shot_image_prompt:scene_1_shot_1': { status: 'completed', outputPath: 'a.json' },
          'shot_image:scene_1_shot_1': { status: 'completed', outputPath: 'b.png' },
        },
      };
      const prompts = findByCapability(b, state, 'shot.prompt');
      const frames = findByCapability(b, state, 'shot.first_frame');
      expect(prompts[0]!.instances).toHaveLength(1);
      expect(prompts[0]!.instances[0]!.outputPath).toBe('a.json');
      expect(frames[0]!.instances).toHaveLength(1);
      expect(frames[0]!.instances[0]!.outputPath).toBe('b.png');
    });
  });

  describe('findInstanceByCapability (single-item lookup)', () => {
    it('returns the matching completed instance', () => {
      const b = bundle(n('shot_image_prompt', 'shot.prompt'));
      const state = {
        nodes: {
          'shot_image_prompt:scene_1_shot_1': { status: 'completed', outputPath: 'p1.json' },
          'shot_image_prompt:scene_1_shot_2': { status: 'completed', outputPath: 'p2.json' },
        },
      };
      expect(findInstanceByCapability(b, state, 'shot.prompt', 'scene_1_shot_1')?.outputPath).toBe('p1.json');
    });

    it('returns undefined when the item id is not completed (e.g. still pending)', () => {
      const b = bundle(n('shot_image_prompt', 'shot.prompt'));
      const state = { nodes: { 'shot_image_prompt:scene_1_shot_1': { status: 'pending' } } };
      expect(findInstanceByCapability(b, state, 'shot.prompt', 'scene_1_shot_1')).toBeUndefined();
    });

    it('returns undefined when the capability has no nodes', () => {
      const b = bundle(n('plot', 'plot.outline'));
      expect(findInstanceByCapability(b, { nodes: {} }, 'shot.prompt', 'x')).toBeUndefined();
    });
  });

  describe('listCompletedItemIds', () => {
    it('returns the unique completed item ids, sorted', () => {
      const b = bundle(n('shot_image_prompt', 'shot.prompt'));
      const state = {
        nodes: {
          'shot_image_prompt:scene_1_shot_2': { status: 'completed' },
          'shot_image_prompt:scene_1_shot_1': { status: 'completed' },
          'shot_image_prompt:scene_2_shot_1': { status: 'completed' },
          'shot_image_prompt:scene_2_shot_2': { status: 'pending' },
        },
      };
      expect(listCompletedItemIds(b, state, 'shot.prompt')).toEqual([
        'scene_1_shot_1', 'scene_1_shot_2', 'scene_2_shot_1',
      ]);
    });

    it('dedupes when two nodes share the same capability + same item id', () => {
      const b = bundle(
        n('shot_image_prompt', 'shot.prompt'),
        n('insert_shot_prompt', 'shot.prompt'),
      );
      const state = {
        nodes: {
          'shot_image_prompt:scene_1_shot_1': { status: 'completed' },
          'insert_shot_prompt:scene_1_shot_1': { status: 'completed' },
        },
      };
      expect(listCompletedItemIds(b, state, 'shot.prompt')).toEqual(['scene_1_shot_1']);
    });
  });

  describe('unknown capabilities (whacky bundles)', () => {
    it('honors any string as a capability — dhee-core does not gatekeep names', () => {
      // A user-authored bundle invents a capability like 'storyboard.panel'.
      // The query still works; only desktop views that recognize the name
      // will render. Unknown names just don't show in any view.
      const b = bundle(n('panel_1', 'storyboard.panel'));
      const state = { nodes: { 'panel_1': { status: 'completed', outputPath: 'sb/1.png' } } };
      const result = findByCapability(b, state, 'storyboard.panel');
      expect(result[0]!.instances[0]!.outputPath).toBe('sb/1.png');
    });
  });
});
