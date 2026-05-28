/**
 * Smoke test for the narrative_qwen_chain_relay bundle:
 *   - Bundle JSON is loadable and valid.
 *   - All referenced files (prompts/, schemas/, workflows/) exist.
 *   - The new runner 'comfy.qwen_edit_chain' is registered.
 *   - The shot_image collection declares scope='previousN' on its own
 *     output AND on shot_image_prompt's input (closes the chain loop).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getGlobalRegistry } from '../../src/dag/runners/registry.js';
// Triggers the bootstrap registration of built-in runners.
import '../../src/dag/runners/index.js';
import type { DagBundle, NodeDef } from '../../src/dag/schema.js';

const BUNDLE_DIR = resolve(__dirname, '../../src/dag/bundles/narrative_qwen_chain_relay');

describe('narrative_qwen_chain_relay bundle', () => {
  const bundle = JSON.parse(readFileSync(join(BUNDLE_DIR, 'bundle.json'), 'utf-8')) as DagBundle;

  it('has the expected id and version', () => {
    expect(bundle.id).toBe('narrative_qwen_chain_relay');
    expect(bundle.version).toBe('0.1.0');
  });

  it('declares comfy.qwen_edit_chain as a runner dependency', () => {
    const deps = (bundle as unknown as { dependencies?: { runners?: Record<string, string> } }).dependencies;
    expect(deps?.runners?.['comfy.qwen_edit_chain']).toBe('>=0.1.0');
  });

  it('all node-referenced files exist on disk', () => {
    for (const node of bundle.nodes) {
      const cfg = node.runner.config as Record<string, string | undefined>;
      for (const key of ['promptTemplate', 'outputSchema', 'workflowPath', 'manifestPath']) {
        const rel = cfg[key];
        if (rel && typeof rel === 'string') {
          const abs = join(BUNDLE_DIR, rel);
          expect(existsSync(abs), `node ${node.id} declares ${key}=${rel} but file is missing at ${abs}`).toBe(true);
        }
      }
    }
  });

  it('shot_image uses the comfy.qwen_edit_chain runner', () => {
    const node = bundle.nodes.find((n) => n.id === 'shot_image') as NodeDef;
    expect(node).toBeTruthy();
    expect(node.runner.tool).toBe('comfy.qwen_edit_chain');
  });

  it('shot_image_prompt self-references with previousN for chain awareness', () => {
    const node = bundle.nodes.find((n) => n.id === 'shot_image_prompt') as NodeDef;
    expect(node).toBeTruthy();
    // Self-reference: LLM sees its own prior outputs (deltaTexts) to make
    // chain-base choices. References to shot_image directly won't work
    // because shot_image hasn't run for prior shots at this point in topo.
    const prev = node.inputs.find((i) => i.from === 'shot_image_prompt' && i.scope === 'previousN');
    expect(prev, 'shot_image_prompt must reference shot_image_prompt with scope=previousN').toBeTruthy();
    expect(prev?.n).toBeGreaterThanOrEqual(1);
  });

  it('shot_image has a previousN self-input', () => {
    const node = bundle.nodes.find((n) => n.id === 'shot_image') as NodeDef;
    const prev = node.inputs.find((i) => i.from === 'shot_image' && i.scope === 'previousN');
    expect(prev, 'shot_image must reference shot_image with scope=previousN').toBeTruthy();
  });

  it('schema enums match runner expectations', () => {
    const schema = JSON.parse(readFileSync(join(BUNDLE_DIR, 'schemas/shot_image_prompt.schema.json'), 'utf-8'));
    expect(schema.required).toContain('chosenBaseShotNumber');
    expect(schema.required).toContain('deltaText');
    expect(schema.properties.view.enum).toContain('back-right quarter view');
    expect(schema.properties.view.enum).toContain('front view');
    expect(schema.properties.distance.enum).toEqual(['close-up', 'medium shot', 'wide shot']);
  });

  it('comfy.qwen_edit_chain runner is registered in the global registry', () => {
    const reg = getGlobalRegistry();
    const r = reg.get('comfy.qwen_edit_chain');
    expect(r, 'comfy.qwen_edit_chain runner must be registered').toBeTruthy();
    expect(r?.describe().id).toBe('comfy.qwen_edit_chain');
  });
});
