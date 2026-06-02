/**
 * Tests pinning the `headlineField` extension on NodeDef.
 *
 * Context: the Inspector Canvas (BUG-020) needs every bundle's
 * json-producing node to declare which JSON field is its "headline" —
 * the dot-path the desktop reads to render the card's primary text
 * (e.g. `deltaText` for qwen-chain shot prompts, vs.
 * `frames.first_frame.imagePrompt` for prompt-relay).
 *
 * Schema is structural — we don't add a runtime validator here; the
 * field is just an optional string. Consumer (the desktop's JsonNode
 * renderer) is responsible for honoring or falling back when absent.
 */
import { describe, it, expect } from 'vitest';
import type { NodeDef } from '../../src/dag/schema.js';

describe('NodeDef.headlineField', () => {
  it('accepts a node declaring headlineField on a json output', () => {
    const node: NodeDef = {
      id: 'shot_image_prompt',
      kind: 'collection',
      inputs: [],
      outputs: { format: 'json', pattern: 'prompts/shot_image/{{item_id}}.json' },
      runner: { tool: 'llm.generate', config: {} },
      displayCapability: 'shot.prompt',
      headlineField: 'deltaText',
    };
    expect(node.headlineField).toBe('deltaText');
  });

  it('treats headlineField as optional — node without it parses cleanly', () => {
    const node: NodeDef = {
      id: 'plot',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'md', pattern: 'plans/plot.md' },
      runner: { tool: 'llm.generate', config: {} },
      displayCapability: 'plot.outline',
    };
    expect(node.headlineField).toBeUndefined();
  });

  it('allows headlineField on non-json nodes (caller decides whether to use it)', () => {
    // Schema is structural. A bundle author MAY declare a headlineField
    // on, say, a text node — the renderer ignores it for non-json kinds.
    // We don't enforce that pairing at the schema level.
    const node: NodeDef = {
      id: 'story_essence',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'md', pattern: 'plans/story_essence.md' },
      runner: { tool: 'llm.generate', config: {} },
      headlineField: 'genre',
    };
    expect(node.headlineField).toBe('genre');
  });

  it('supports dot-path values (nested field selection)', () => {
    // narrative_prompt_relay's shot prompts nest the prompt under
    // `frames.first_frame.imagePrompt`. Dot-paths must round-trip
    // through the schema without transformation.
    const node: NodeDef = {
      id: 'shot_image_prompt',
      kind: 'collection',
      inputs: [],
      outputs: { format: 'json', pattern: 'prompts/shots/{{item_id}}.json' },
      runner: { tool: 'llm.generate', config: {} },
      displayCapability: 'shot.prompt',
      headlineField: 'frames.first_frame.imagePrompt',
    };
    expect(node.headlineField).toBe('frames.first_frame.imagePrompt');
  });
});
