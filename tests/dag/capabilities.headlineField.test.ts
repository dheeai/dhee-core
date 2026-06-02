/**
 * Tests pinning that the capability query API surfaces `format` and
 * `headlineField` from the bundle's NodeDef to its consumers
 * (the desktop Inspector Canvas — BUG-020).
 *
 * The capability node returned by findByCapability already carries the
 * full NodeDef under `.node`, so technically a consumer could reach in
 * for these fields directly. These tests pin the access pattern as the
 * contract — when we evolve the surface later, these tests will fail
 * if format/headlineField become unreachable.
 */
import { describe, it, expect } from 'vitest';
import { findByCapability, findInstanceByCapability } from '../../src/dag/capabilities.js';
import type { DagBundle, NodeDef } from '../../src/dag/schema.js';

function bundle(nodes: NodeDef[]): DagBundle {
  return {
    id: 'cap-headline-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: nodes[nodes.length - 1]?.id ?? 'last',
    nodes,
  };
}

describe('capability surface — format + headlineField', () => {
  it('CapabilityNode.node exposes outputs.format', () => {
    const b = bundle([
      {
        id: 'shot_image_prompt',
        kind: 'collection',
        inputs: [],
        outputs: { format: 'json', pattern: 'prompts/{{item_id}}.json' },
        runner: { tool: 'llm.generate', config: {} },
        displayCapability: 'shot.prompt',
        headlineField: 'deltaText',
      },
    ]);
    const result = findByCapability(b, { nodes: {} }, 'shot.prompt');
    expect(result).toHaveLength(1);
    expect(result[0]!.node.outputs.format).toBe('json');
  });

  it('CapabilityNode.node exposes headlineField when declared', () => {
    const b = bundle([
      {
        id: 'shot_image_prompt',
        kind: 'collection',
        inputs: [],
        outputs: { format: 'json', pattern: 'prompts/{{item_id}}.json' },
        runner: { tool: 'llm.generate', config: {} },
        displayCapability: 'shot.prompt',
        headlineField: 'deltaText',
      },
    ]);
    const [cap] = findByCapability(b, { nodes: {} }, 'shot.prompt');
    expect(cap!.node.headlineField).toBe('deltaText');
  });

  it('CapabilityNode.node has no headlineField when not declared', () => {
    const b = bundle([
      {
        id: 'shot_image',
        kind: 'collection',
        inputs: [],
        outputs: { format: 'image', pattern: 'assets/shots/{{item_id}}.png' },
        runner: { tool: 'comfy.image', config: {} },
        displayCapability: 'shot.first_frame',
      },
    ]);
    const [cap] = findByCapability(b, { nodes: {} }, 'shot.first_frame');
    expect(cap!.node.headlineField).toBeUndefined();
  });

  it('findInstanceByCapability resolves to a completed instance whose parent node still exposes format/headlineField via the bundle', () => {
    const b = bundle([
      {
        id: 'shot_image_prompt',
        kind: 'collection',
        inputs: [],
        outputs: { format: 'json', pattern: 'prompts/{{item_id}}.json' },
        runner: { tool: 'llm.generate', config: {} },
        displayCapability: 'shot.prompt',
        headlineField: 'deltaText',
      },
    ]);
    const state = {
      nodes: {
        'shot_image_prompt:scene_1_shot_1': {
          status: 'completed',
          outputPath: 'prompts/scene_1_shot_1.json',
        },
      },
    };
    const inst = findInstanceByCapability(b, state, 'shot.prompt', 'scene_1_shot_1');
    expect(inst).toBeDefined();
    expect(inst!.outputPath).toBe('prompts/scene_1_shot_1.json');
    // And the bundle still tells the renderer how to render this instance:
    const [cap] = findByCapability(b, state, 'shot.prompt');
    expect(cap!.node.outputs.format).toBe('json');
    expect(cap!.node.headlineField).toBe('deltaText');
  });
});
