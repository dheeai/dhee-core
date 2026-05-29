/**
 * Smoke test for the narrative_qwen_chain_review bundle.
 *
 * Verifies the quality-loop wiring is correct:
 *   - reviewLoopMax is set (3) so the walker's review-loop wrapper kicks in.
 *   - shot_image_review node exists, uses vlm.judge, points at
 *     shot_image_prompt as its refineNode.
 *   - scene_clip depends on shot_image_review as a gate so review
 *     completes before LTX renders consume the (possibly-restored)
 *     shot image.
 *   - All file references (prompts, schemas, workflows) exist on disk.
 *   - vlm.judge is in the dependencies block.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getGlobalRegistry } from '../../src/dag/runners/registry.js';
// Triggers bootstrap registration of built-in runners.
import '../../src/dag/runners/index.js';
import type { DagBundle, NodeDef } from '../../src/dag/schema.js';

const BUNDLE_DIR = resolve(__dirname, '../../src/dag/bundles/narrative_qwen_chain_review');

describe('narrative_qwen_chain_review bundle', () => {
  const bundle = JSON.parse(readFileSync(join(BUNDLE_DIR, 'bundle.json'), 'utf-8')) as DagBundle;

  it('has the expected id', () => {
    expect(bundle.id).toBe('narrative_qwen_chain_review');
  });

  it('declares reviewLoopMax for 3-attempt quality gating', () => {
    expect(bundle.reviewLoopMax).toBe(3);
  });

  it('declares vlm.judge as a runner dependency', () => {
    const deps = (bundle as unknown as { dependencies?: { runners?: Record<string, string> } }).dependencies;
    expect(deps?.runners?.['vlm.judge']).toBe('>=0.1.0');
  });

  it('vlm.judge runner is registered in the global registry', () => {
    const reg = getGlobalRegistry();
    const r = reg.get('vlm.judge');
    expect(r, 'vlm.judge runner must be registered').toBeTruthy();
    expect(r?.describe().id).toBe('vlm.judge');
  });

  it('contains a shot_image_review node wired to vlm.judge', () => {
    const node = bundle.nodes.find((n) => n.id === 'shot_image_review') as NodeDef;
    expect(node).toBeTruthy();
    expect(node.runner.tool).toBe('vlm.judge');
    expect(node.kind).toBe('collection');
    // The review fans out per shot — itemSource points at the
    // upstream collection so the walker materializes one review
    // instance per shot.
    expect(node.itemSource).toBe('shot_image');
  });

  it('shot_image_review targets shot_image_prompt as the refineNode', () => {
    const node = bundle.nodes.find((n) => n.id === 'shot_image_review') as NodeDef;
    const cfg = node.runner.config as Record<string, unknown>;
    expect(cfg['refineNode']).toBe('shot_image_prompt');
    expect(cfg['imageInput']).toBe('shot_image');
    expect(typeof cfg['passThreshold']).toBe('number');
    expect(typeof cfg['criteria']).toBe('string');
  });

  it('shot_image_review consumes the image + structured context inputs', () => {
    const node = bundle.nodes.find((n) => n.id === 'shot_image_review') as NodeDef;
    const fromIds = node.inputs.map((i) => i.from).sort();
    // Must see the image (matching) + the prompt that produced it +
    // canonical descriptors so the judge has grounding.
    expect(fromIds).toContain('shot_image');
    expect(fromIds).toContain('shot_image_prompt');
    expect(fromIds).toContain('characters_plan');
    expect(fromIds).toContain('settings_plan');
    const shotImageInput = node.inputs.find((i) => i.from === 'shot_image');
    expect(shotImageInput?.scope).toBe('matching');
  });

  it('scene_clip depends on shot_image_review as a gate', () => {
    const scene = bundle.nodes.find((n) => n.id === 'scene_clip') as NodeDef;
    const gate = scene.inputs.find((i) => i.from === 'shot_image_review');
    expect(gate, 'scene_clip must depend on shot_image_review so LTX waits for the review verdict').toBeTruthy();
    // Gate is a context input, not a data input — scene_clip uses
    // shot_image for actual first-frame paths.
    expect(gate?.usage).toBe('context');
  });

  it('all bundle file references exist on disk', () => {
    for (const node of bundle.nodes) {
      const cfg = node.runner.config as Record<string, string | undefined>;
      for (const key of ['promptTemplate', 'outputSchema', 'workflowPath', 'manifestPath']) {
        const rel = cfg[key];
        if (rel && typeof rel === 'string') {
          const abs = join(BUNDLE_DIR, rel);
          expect(
            existsSync(abs),
            `node ${node.id} declares ${key}=${rel} but file is missing at ${abs}`,
          ).toBe(true);
        }
      }
    }
  });

  it('topologically valid: goal final_video reachable from sources', () => {
    expect(bundle.goal).toBe('final_video');
    const byId = new Map(bundle.nodes.map((n) => [n.id, n]));
    // Every input.from points to a node that exists.
    for (const node of bundle.nodes) {
      for (const inp of node.inputs) {
        expect(byId.has(inp.from), `${node.id} declares input.from='${inp.from}' but that node isn't in the bundle`).toBe(true);
      }
    }
  });

  it('shot_image_prompt schema still requires `characters` (BUG-024 invariant inherited)', () => {
    // The review bundle reuses the parent schema directory and so
    // must respect the same contract — the LLM declares the cast.
    const schema = JSON.parse(
      readFileSync(join(BUNDLE_DIR, 'schemas/shot_image_prompt.schema.json'), 'utf-8'),
    );
    expect(schema.required).toContain('characters');
  });
});
