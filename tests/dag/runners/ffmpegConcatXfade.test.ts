/**
 * ffmpeg.concat — xfade transition graph builder. Pure-function tests pinning
 * the chained xfade(video) + acrossfade(audio) filtergraph and its cumulative
 * crossfade offsets.
 */
import { describe, it, expect } from 'vitest';
import { buildXfadeGraph } from '../../../src/dag/runners/ffmpegConcat.js';

describe('buildXfadeGraph', () => {
  it('single clip → passthrough labels, no xfade', () => {
    const { filter, vLabel, aLabel } = buildXfadeGraph([10], 'fade', 0.5);
    expect(vLabel).toBe('v0');
    expect(aLabel).toBe('a0');
    expect(filter).not.toContain('xfade=');
  });

  it('chains xfade + acrossfade across N clips, ending in vout/aout', () => {
    const { filter, vLabel, aLabel } = buildXfadeGraph([10, 8, 6], 'fade', 0.5);
    expect(vLabel).toBe('vout');
    expect(aLabel).toBe('aout');
    expect((filter.match(/xfade=transition=fade/g) ?? []).length).toBe(2);
    expect((filter.match(/acrossfade=d=0.5/g) ?? []).length).toBe(2);
  });

  it('computes cumulative offsets = prefixDuration - k*d', () => {
    // durations 10,8,6 with d=0.5:
    //  k=1 offset = 10 - 1*0.5 = 9.5
    //  k=2 offset = (10+8) - 2*0.5 = 17.0
    const { filter } = buildXfadeGraph([10, 8, 6], 'fade', 0.5);
    expect(filter).toContain('offset=9.500');
    expect(filter).toContain('offset=17.000');
  });

  it('honors the chosen transition name', () => {
    const { filter } = buildXfadeGraph([5, 5], 'wipeleft', 0.4);
    expect(filter).toContain('xfade=transition=wipeleft:duration=0.4');
  });

  it('normalizes every input to the target size when given (mixed-dim clips)', () => {
    const { filter } = buildXfadeGraph([5, 5], 'fade', 0.5, { width: 768, height: 1280 });
    // both inputs scaled-to-cover + cropped to the common target before xfade
    expect((filter.match(/scale=768:1280:force_original_aspect_ratio=increase,crop=768:1280,setsar=1/g) ?? []).length).toBe(2);
  });

  it('WITHOUT a target, inputs are not rescaled (counter-test, back-compat)', () => {
    const { filter } = buildXfadeGraph([5, 5], 'fade', 0.5);
    expect(filter).not.toContain('force_original_aspect_ratio');
  });
});
