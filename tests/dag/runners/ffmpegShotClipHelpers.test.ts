/**
 * ffmpegShotClip pure helpers: palette selection + filter_complex string
 * building. Unexported before pass 4 (reachable only past a real ffmpeg
 * spawn), so the per-shot filtergraph construction had no coverage.
 * Exported purely for testability — no behavior change.
 */
import { describe, it, expect } from 'vitest';
import {
  paletteForStyle,
  buildFilterComplex,
  type PaletteEntry,
} from '../../../src/dag/runners/ffmpegShotClip.js';

describe('paletteForStyle', () => {
  it('returns the noir palette for any style containing "noir" (case-insensitive)', () => {
    expect(paletteForStyle('Cinematic NOIR').bg).toBe('0x0c1320');
  });

  it('returns the anime palette for "anime" or "animation"', () => {
    expect(paletteForStyle('anime').bg).toBe('0x18406b');
    expect(paletteForStyle('2D Animation').bg).toBe('0x18406b');
  });

  it('falls back to the warm cinematic-realism default', () => {
    expect(paletteForStyle('photoreal').bg).toBe('0x402611');
    expect(paletteForStyle('').bg).toBe('0x402611');
  });
});

describe('buildFilterComplex', () => {
  const palette: PaletteEntry = { bg: '0x111111', fgA: '0xaaaaaa', fgB: '0xbbbbbb' };

  it('always produces a yuv420p-terminated drawbox graph using the palette colors', () => {
    for (const shot of [1, 2, 3]) {
      const fc = buildFilterComplex(shot, palette, 1920, 1080, 10);
      expect(fc.startsWith('[0:v]drawbox')).toBe(true);
      expect(fc.endsWith('format=yuv420p')).toBe(true);
      expect(fc).toContain(palette.fgA);
      expect(fc).toContain(palette.fgB);
    }
  });

  it('produces a distinct graph per shot index (a concatenated reel reads as a sequence)', () => {
    const a = buildFilterComplex(1, palette, 1920, 1080, 10);
    const b = buildFilterComplex(2, palette, 1920, 1080, 10);
    const c = buildFilterComplex(3, palette, 1920, 1080, 10);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('scales box geometry from the given width/height', () => {
    const fc = buildFilterComplex(1, palette, 1000, 1000, 10);
    // shot 1 box width = floor(1000 * 0.18) = 180
    expect(fc).toContain('w=180');
  });

  it('encodes the duration in the time-normalized motion expression', () => {
    const fc = buildFilterComplex(1, palette, 1920, 1080, 7);
    expect(fc).toContain('(t/7)');
  });
});
