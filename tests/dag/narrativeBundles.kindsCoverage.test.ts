/**
 * Lint-style coverage tests across the 3 built-in narrative bundles.
 *
 * The Inspector Canvas (BUG-020) renders one card per bundle node and
 * picks a renderer based on the node's `outputs.format`. For JSON-
 * format nodes that are surfaced via `displayCapability`, the desktop
 * needs a `headlineField` dot-path to render a non-empty card —
 * otherwise the tile shows a generic key/value tree.
 *
 * This file catches missing tags at build time so a bundle author who
 * adds a new capability-tagged json node can't forget to give the
 * desktop a headline path to render.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DagBundle } from '../../src/dag/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const BUNDLE_IDS = [
  'narrative_qwen_chain_relay',
  'narrative_prompt_relay',
  'narrative_shot_by_shot',
];

function loadBundle(id: string): DagBundle {
  const path = join(__dirname, '..', '..', 'src', 'dag', 'bundles', id, 'bundle.json');
  return JSON.parse(readFileSync(path, 'utf-8')) as DagBundle;
}

const VALID_FORMATS = new Set(['md', 'json', 'image', 'video', 'audio', 'text']);

describe('built-in narrative bundles — Inspector Canvas coverage', () => {
  for (const id of BUNDLE_IDS) {
    describe(id, () => {
      const bundle = loadBundle(id);

      it('every node declares a valid outputs.format', () => {
        const offenders: Array<{ node: string; format: string | undefined }> = [];
        for (const node of bundle.nodes) {
          if (!node.outputs?.format || !VALID_FORMATS.has(node.outputs.format)) {
            offenders.push({ node: node.id, format: node.outputs?.format });
          }
        }
        expect(offenders).toEqual([]);
      });

      it('every COLLECTION json node surfaced via displayCapability declares a headlineField', () => {
        // Collection json nodes render as a rail of tiles; each tile
        // shows a headline derived from this field. Stage json nodes
        // (one instance, e.g. characters_plan) render as a tree —
        // headlineField doesn't apply.
        const offenders: string[] = [];
        for (const node of bundle.nodes) {
          if (node.kind !== 'collection') continue;
          if (node.outputs.format !== 'json') continue;
          if (!node.displayCapability) continue;
          if (!node.headlineField) offenders.push(node.id);
        }
        expect(offenders).toEqual([]);
      });
    });
  }

  describe('narrative_shot_by_shot specifically', () => {
    it('shot_video node has a displayCapability tag', () => {
      const bundle = loadBundle('narrative_shot_by_shot');
      const shotVideo = bundle.nodes.find((n) => n.id === 'shot_video');
      expect(shotVideo).toBeDefined();
      expect(shotVideo!.displayCapability).toBeDefined();
    });
  });
});
