/**
 * comfy.wan_bernini — WAN 2.2 "Bernini" multi-reference-to-video runner.
 *
 * The workflow-SPECIFIC part is resolving a scene's references[] into the
 * three fixed Bernini reference slots (image0 / image1 / image2) that the
 * BatchImagesNode batches and the prompt addresses as "…from image0", etc.
 * These tests pin that resolution (the rest is the shared executor, tested
 * elsewhere).
 */
import { describe, it, expect } from 'vitest';
import { resolveWanReferences } from '../../../src/dag/runners/comfyWanBernini.js';

const MAPS = {
  character: { hero: '/p/characters/hero.png', ally: '/p/characters/ally.png' },
  setting: { ridge: '/p/settings/ridge.png' },
};

describe('comfyWanBernini — resolveWanReferences', () => {
  it('maps explicit slots to the right image paths and carries the prompt', () => {
    const scene = {
      videoPrompt: 'The figure from image0 and the figure from image1 walk along the ridge in image2.',
      references: [
        { id: 'hero', type: 'character', slot: 'image0' },
        { id: 'ally', type: 'character', slot: 'image1' },
        { id: 'ridge', type: 'setting', slot: 'image2' },
      ],
    };
    const r = resolveWanReferences(scene, MAPS);
    expect(r.prompt).toBe(scene.videoPrompt);
    expect(r.imageInputs).toEqual({
      image0: '/p/characters/hero.png',
      image1: '/p/characters/ally.png',
      image2: '/p/settings/ridge.png',
    });
    expect(r.missing).toEqual([]);
  });

  it('assigns slots positionally when none are given (order = image0, image1, image2)', () => {
    const scene = {
      videoPrompt: 'x',
      references: [
        { id: 'hero', type: 'character' },
        { id: 'ally', type: 'character' },
        { id: 'ridge', type: 'background' }, // 'background' is an alias for the setting map
      ],
    };
    const r = resolveWanReferences(scene, MAPS);
    expect(r.imageInputs).toEqual({
      image0: '/p/characters/hero.png',
      image1: '/p/characters/ally.png',
      image2: '/p/settings/ridge.png',
    });
  });

  it('reports references it cannot resolve instead of inventing a slot', () => {
    const scene = {
      videoPrompt: 'x',
      references: [
        { id: 'hero', type: 'character', slot: 'image0' },
        { id: 'ghost', type: 'character', slot: 'image1' }, // not in the map
      ],
    };
    const r = resolveWanReferences(scene, MAPS);
    expect(r.imageInputs).toEqual({ image0: '/p/characters/hero.png' });
    expect(r.missing).toContain('ghost');
  });

  it('returns an empty resolution for a null / shapeless scene', () => {
    expect(resolveWanReferences(null, MAPS).imageInputs).toEqual({});
    expect(resolveWanReferences(null, MAPS).prompt).toBeUndefined();
    expect(resolveWanReferences({ videoPrompt: 'x' } as never, MAPS).imageInputs).toEqual({});
  });

  it('never exceeds the three Bernini slots (extra positional refs are dropped)', () => {
    const scene = {
      videoPrompt: 'x',
      references: [
        { id: 'hero', type: 'character' },
        { id: 'ally', type: 'character' },
        { id: 'ridge', type: 'setting' },
        { id: 'hero', type: 'character' }, // a 4th ref — no slot left
      ],
    };
    const r = resolveWanReferences(scene, MAPS);
    expect(Object.keys(r.imageInputs).sort()).toEqual(['image0', 'image1', 'image2']);
  });

  it('honours explicit slots even when they collide with the positional cursor', () => {
    // ally pinned to image2; hero falls into the first free slot (image0).
    const scene = {
      videoPrompt: 'x',
      references: [
        { id: 'ally', type: 'character', slot: 'image2' },
        { id: 'hero', type: 'character' },
      ],
    };
    const r = resolveWanReferences(scene, MAPS);
    expect(r.imageInputs).toEqual({ image2: '/p/characters/ally.png', image0: '/p/characters/hero.png' });
  });
});
