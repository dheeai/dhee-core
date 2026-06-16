/**
 * extractShotReferences — TDD for the helper that turns a shot prompt
 * JSON into the precise dependency list (which character/setting
 * images this shot actually consumed).
 *
 * Failure modes:
 *  1. Empty/null input → [].
 *  2. references field missing → [].
 *  3. references=[] → [].
 *  4. Single character ref → one NodeDependency with role='reference'.
 *  5. Mixed character + setting refs → both rendered with the right
 *     upstream nodeId.
 *  6. Unknown ref type (e.g. 'prop') → skipped, no crash.
 *  7. references with missing id field → skipped.
 *  8. shot_image_prompt input nodeId is ALWAYS included as 'input'
 *     dependency (the prompt itself is a dep even if it lists no refs).
 *  9. Caller-provided itemId is preserved on the shot_image_prompt
 *     dependency.
 * 10. Dedup: a ref listed twice → only one entry.
 */
import { describe, it, expect } from 'vitest';
import {
  extractShotReferences,
  type ShotReferenceInput,
} from '../../src/dag/runners/extractShotReferences.js';

describe('extractShotReferences', () => {
  it('1. empty input → just the prompt dep', () => {
    const r = extractShotReferences({ promptItemId: 'scene_1_shot_3', prompt: null });
    expect(r).toEqual([
      { nodeId: 'shot_image_prompt', itemId: 'scene_1_shot_3', role: 'input' },
    ]);
  });

  it('2. references field missing', () => {
    const r = extractShotReferences({
      promptItemId: 'scene_1_shot_3',
      prompt: { imagePrompt: 'something' } as ShotReferenceInput['prompt'],
    });
    expect(r).toEqual([
      { nodeId: 'shot_image_prompt', itemId: 'scene_1_shot_3', role: 'input' },
    ]);
  });

  it('3. references=[]', () => {
    const r = extractShotReferences({
      promptItemId: 'scene_1_shot_3',
      prompt: { imagePrompt: 'x', references: [] },
    });
    expect(r).toEqual([
      { nodeId: 'shot_image_prompt', itemId: 'scene_1_shot_3', role: 'input' },
    ]);
  });

  it('4. single character ref', () => {
    const r = extractShotReferences({
      promptItemId: 'scene_1_shot_3',
      prompt: { imagePrompt: 'x', references: [{ id: 'kiyoko', type: 'character' }] },
    });
    expect(r).toEqual([
      { nodeId: 'shot_image_prompt', itemId: 'scene_1_shot_3', role: 'input' },
      { nodeId: 'character_image', itemId: 'kiyoko', role: 'reference' },
    ]);
  });

  it('5. mixed character + setting refs', () => {
    const r = extractShotReferences({
      promptItemId: 'scene_1_shot_3',
      prompt: {
        imagePrompt: 'x',
        references: [
          { id: 'kiyoko', type: 'character' },
          { id: 'bamboo_forest_clearing', type: 'setting' },
        ],
      },
    });
    expect(r).toEqual([
      { nodeId: 'shot_image_prompt', itemId: 'scene_1_shot_3', role: 'input' },
      { nodeId: 'character_image', itemId: 'kiyoko', role: 'reference' },
      { nodeId: 'setting_image', itemId: 'bamboo_forest_clearing', role: 'reference' },
    ]);
  });

  it('6. unknown ref type skipped', () => {
    const r = extractShotReferences({
      promptItemId: 'scene_1_shot_3',
      prompt: {
        imagePrompt: 'x',
        references: [
          { id: 'kiyoko', type: 'character' },
          { id: 'mystery_box', type: 'prop' as unknown as 'character' },
        ],
      },
    });
    expect(r.find((d) => d.itemId === 'mystery_box')).toBeUndefined();
    expect(r.find((d) => d.itemId === 'kiyoko')).toBeDefined();
  });

  it('7. ref with missing id skipped', () => {
    const r = extractShotReferences({
      promptItemId: 'scene_1_shot_3',
      prompt: {
        imagePrompt: 'x',
        references: [
          { id: '', type: 'character' },
          { id: 'kiyoko', type: 'character' },
        ],
      },
    });
    expect(r.filter((d) => d.role === 'reference')).toEqual([
      { nodeId: 'character_image', itemId: 'kiyoko', role: 'reference' },
    ]);
  });

  it('8. prompt dep always present even with no refs', () => {
    const r = extractShotReferences({ promptItemId: 's1_s5', prompt: null });
    expect(r[0]).toEqual({ nodeId: 'shot_image_prompt', itemId: 's1_s5', role: 'input' });
  });

  it('9. caller itemId preserved', () => {
    const r = extractShotReferences({
      promptItemId: 'custom_id',
      prompt: { imagePrompt: 'x', references: [{ id: 'lara', type: 'character' }] },
    });
    const promptDep = r.find((d) => d.nodeId === 'shot_image_prompt');
    expect(promptDep?.itemId).toBe('custom_id');
  });

  it('10. duplicate refs deduped', () => {
    const r = extractShotReferences({
      promptItemId: 's1_s3',
      prompt: {
        imagePrompt: 'x',
        references: [
          { id: 'kiyoko', type: 'character' },
          { id: 'kiyoko', type: 'character' }, // dup
        ],
      },
    });
    const kiyokoDeps = r.filter((d) => d.itemId === 'kiyoko');
    expect(kiyokoDeps).toHaveLength(1);
  });

  // issue #158: the prompt dep must record the ACTUAL upstream prompt node
  // id, not a hardcoded 'shot_image_prompt'. Hardcoding it left the dep graph
  // with a dangling edge in non-narrative bundles (e.g. ugc_ad's
  // 'host_frame_prompt'), so cascade-invalidation never reached the image.
  it('11. records the provided prompt node id (issue #158)', () => {
    const r = extractShotReferences({
      promptNodeId: 'host_frame_prompt',
      promptItemId: '',
      prompt: { imagePrompt: 'x', references: [] },
    });
    expect(r[0]).toEqual({ nodeId: 'host_frame_prompt', itemId: '', role: 'input' });
    // counter: the old hardcoded id must NOT leak in.
    expect(r.some((d) => d.nodeId === 'shot_image_prompt')).toBe(false);
  });

  it('12. defaults prompt node id to shot_image_prompt for back-compat', () => {
    const r = extractShotReferences({ promptItemId: 's1_s5', prompt: null });
    expect(r[0]).toEqual({ nodeId: 'shot_image_prompt', itemId: 's1_s5', role: 'input' });
    const blank = extractShotReferences({ promptNodeId: '  ', promptItemId: 's1', prompt: null });
    expect(blank[0]!.nodeId).toBe('shot_image_prompt');
  });
});
