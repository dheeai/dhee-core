/**
 * ffmpeg.kenburns — the zoompan filter builder. Pure-function tests: assert the
 * filtergraph each motion produces (the runner itself shells out to ffmpeg, so
 * the filter string is the contract worth pinning).
 */
import { describe, it, expect } from 'vitest';
import { buildKenBurnsFilter } from '../../../src/dag/runners/ffmpegKenBurns.js';

const base = { zoom: 1.1, totalFrames: 300, fps: 30, width: 1280, height: 720 };

describe('buildKenBurnsFilter', () => {
  it('renders at the output size + fps and upscales first (anti-jitter)', () => {
    const f = buildKenBurnsFilter({ ...base, motion: 'in' });
    expect(f).toContain('s=1280x720');
    expect(f).toContain('fps=30');
    expect(f).toContain('zoompan=');
    expect(f).toContain('format=yuv420p');
    // upscales above output before zoompan (4x here)
    expect(f).toContain('scale=5120:2880');
  });

  it('zoom-in ramps zoom UP toward the target', () => {
    const f = buildKenBurnsFilter({ ...base, motion: 'in' });
    expect(f).toContain("z='min(zoom+");
    expect(f).toContain(',1.1)');
  });

  it('zoom-out ramps zoom DOWN toward 1.0', () => {
    const f = buildKenBurnsFilter({ ...base, motion: 'out' });
    expect(f).toContain('max(zoom-');
  });

  it('pan motions move the window using the output-frame index (on/totalFrames)', () => {
    const left = buildKenBurnsFilter({ ...base, motion: 'left' });
    expect(left).toContain('on/300');
    expect(left).toMatch(/x='\(iw-iw\/zoom\)/);
    const down = buildKenBurnsFilter({ ...base, motion: 'down' });
    expect(down).toMatch(/y='\(ih-ih\/zoom\)/);
  });

  it('encodes the duration as the zoompan frame count d=', () => {
    const f = buildKenBurnsFilter({ ...base, motion: 'in' });
    expect(f).toContain('d=300');
  });
});
