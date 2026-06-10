/**
 * pruneKleinReferences — pure graph surgery for klein.json's optional
 * reference branches. The integration-level comfy.klein test asserts the
 * END state via the queued workflow; this exercises the helper DIRECTLY
 * against the real shipped klein.json so the per-branch delete/redirect
 * topology is locked in independent of the runner's resolution path.
 *
 * Topology (from comfyKlein.ts KLEIN_REFERENCE_BRANCHES):
 *   base (76 → ReferenceLatent 92:79:*) is REQUIRED, never pruned.
 *   reference_image_1 → LoadImage 81, branch nodes 92:85 / 92:84:*
 *   reference_image_2 → LoadImage 82, branch nodes 92:87 / 92:88:*
 *   reference_image_3 → LoadImage 83, branch nodes 92:89 / 92:89:*
 * Pruning an absent ref deletes its branch and redirects the chain to the
 * previous branch's ReferenceLatent outputs, cascading down to base.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { pruneKleinReferences } from '../../../src/dag/runners/comfyKlein.js';
import type { ComfyWorkflow } from '../../../src/dag/runners/comfyExecutor.js';

const REAL_KLEIN = resolve('src/dag/bundles/narrative_prompt_relay/workflows/klein.json');

function loadWorkflow(): ComfyWorkflow {
  return JSON.parse(readFileSync(REAL_KLEIN, 'utf-8')) as ComfyWorkflow;
}

describe('pruneKleinReferences', () => {
  it('prunes nothing when all 3 optional references are present', () => {
    const wf = loadWorkflow();
    const before = Object.keys(wf).length;
    const deleted = pruneKleinReferences(
      wf,
      new Set(['reference_image_1', 'reference_image_2', 'reference_image_3']),
    );
    expect(deleted.size).toBe(0);
    expect(Object.keys(wf).length).toBe(before);
    // All LoadImage slots intact.
    expect(wf['81']).toBeDefined();
    expect(wf['82']).toBeDefined();
    expect(wf['83']).toBeDefined();
  });

  it('with base + ref1: deletes ref2 + ref3 branches, leaves ref1', () => {
    const wf = loadWorkflow();
    const deleted = pruneKleinReferences(wf, new Set(['reference_image_1']));
    // ref1 LoadImage kept.
    expect(wf['81']).toBeDefined();
    // ref2 + ref3 LoadImages + their branch nodes gone.
    expect(wf['82']).toBeUndefined();
    expect(wf['83']).toBeUndefined();
    expect(deleted.has('82')).toBe(true);
    expect(deleted.has('83')).toBe(true);
    expect(deleted.has('81')).toBe(false);
    // The CFGGuider's conditioning now points at ref1's ReferenceLatent
    // (92:84:*) since ref2/ref3 redirect back to ref1.
    expect(wf['92:63']!.inputs['positive']).toEqual(['92:84:77', 0]);
    expect(wf['92:63']!.inputs['negative']).toEqual(['92:84:76', 0]);
  });

  it('with base only: deletes all 3 optional branches, chain falls back to base latents', () => {
    const wf = loadWorkflow();
    const deleted = pruneKleinReferences(wf, new Set());
    expect(wf['81']).toBeUndefined();
    expect(wf['82']).toBeUndefined();
    expect(wf['83']).toBeUndefined();
    for (const id of ['81', '82', '83']) expect(deleted.has(id)).toBe(true);
    // Base LoadImage (76) survives.
    expect(wf['76']).toBeDefined();
    // CFGGuider falls all the way back to base's ReferenceLatent (92:79:*).
    expect(wf['92:63']!.inputs['positive']).toEqual(['92:79:77', 0]);
    expect(wf['92:63']!.inputs['negative']).toEqual(['92:79:76', 0]);
  });

  it('with base + ref1 + ref2 (ref3 absent): only ref3 branch is deleted', () => {
    const wf = loadWorkflow();
    const deleted = pruneKleinReferences(
      wf,
      new Set(['reference_image_1', 'reference_image_2']),
    );
    expect(wf['81']).toBeDefined();
    expect(wf['82']).toBeDefined();
    expect(wf['83']).toBeUndefined();
    expect(deleted.has('83')).toBe(true);
    expect(deleted.has('82')).toBe(false);
    // CFGGuider reads ref2's ReferenceLatent (92:88:*) — the last present.
    expect(wf['92:63']!.inputs['positive']).toEqual(['92:88:77', 0]);
    expect(wf['92:63']!.inputs['negative']).toEqual(['92:88:76', 0]);
  });

  it('deletes the branch helper nodes (not just the LoadImage) for an absent ref', () => {
    const wf = loadWorkflow();
    pruneKleinReferences(wf, new Set(['reference_image_1']));
    // ref2 branch: per KLEIN_REFERENCE_BRANCHES, '82','92:87','92:88:*'.
    for (const id of ['82', '92:87', '92:88:78', '92:88:77', '92:88:76']) {
      expect(wf[id]).toBeUndefined();
    }
    // ref3 branch.
    for (const id of ['83', '92:89', '92:89:78', '92:89:77', '92:89:76']) {
      expect(wf[id]).toBeUndefined();
    }
  });

  it('does not mutate a fresh workflow when nothing is pruned (returns empty set)', () => {
    const wf = loadWorkflow();
    const json = JSON.stringify(wf);
    const deleted = pruneKleinReferences(
      wf,
      new Set(['reference_image_1', 'reference_image_2', 'reference_image_3']),
    );
    expect(deleted.size).toBe(0);
    expect(JSON.stringify(wf)).toBe(json);
  });
});
