import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { getGlobalRegistry } from '../../src/dag/runners/registry.js';
import '../../src/dag/runners/index.js';
import type { DagBundle } from '../../src/dag/schema.js';

const BUNDLE_IDS = [
  'narrative_prompt_relay',
  'narrative_shot_by_shot',
  'narrative_text_only',
  'narrative_text_video',
  'narrative_qwen_chain_relay',
  'narrative_qwen_chain_review',
  'narrative_klein_relay_review',
] as const;

const BUNDLES_DIR = resolve(__dirname, '../../src/dag/bundles');

function loadBundle(id: string): DagBundle {
  return JSON.parse(readFileSync(join(BUNDLES_DIR, id, 'bundle.json'), 'utf-8')) as DagBundle;
}

describe('built-in narrative bundles', () => {
  it('all seven validate against the registered built-in runners', () => {
    const reg = getGlobalRegistry();
    const failures: Record<string, string[]> = {};

    for (const id of BUNDLE_IDS) {
      const result = reg.validateBundle(loadBundle(id));
      if (!result.ok) failures[id] = result.errors;
    }

    expect(failures).toEqual({});
  });

  it('motion directive nodes require transition in their output schema', () => {
    for (const id of BUNDLE_IDS) {
      const bundle = loadBundle(id);
      const motionNode = bundle.nodes.find((node) => node.id === 'shot_motion_directive');
      if (!motionNode) continue;

      const cfg = motionNode.runner.config as Record<string, string | undefined>;
      expect(cfg.outputSchema, `${id}: shot_motion_directive must declare outputSchema`).toBe(
        'schemas/shot_motion_directive.schema.json',
      );

      const schema = JSON.parse(
        readFileSync(join(BUNDLES_DIR, id, cfg.outputSchema as string), 'utf-8'),
      ) as { required?: string[]; properties?: Record<string, unknown> };
      expect(schema.required, `${id}: motion schema must require transition`).toContain('transition');
      expect(schema.properties?.transition, `${id}: motion schema must define transition`).toBeTruthy();
    }
  });
});
