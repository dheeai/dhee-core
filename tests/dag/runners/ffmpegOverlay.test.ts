/**
 * ffmpeg.overlay — deterministic PiP/screen-inset composite.
 *
 * buildOverlayFilter is the contract (the runner shells out to ffmpeg). Plus a
 * behavioral test: composite a real PNG over a real clip and ffprobe that the
 * output is a valid yuv420p video at the BASE dimensions (overlay didn't resize
 * the canvas) — the deterministic, no-model path.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildOverlayFilter } from '../../../src/dag/runners/ffmpegOverlay.js';
import { ffmpegBin, ffprobeBin } from '../../../src/dag/runners/ffmpegBin.js';

describe('buildOverlayFilter', () => {
  const base = { baseWidth: 800, scale: 0.5, margin: 40, borderWidth: 0, borderColor: 'white' as const };

  it('scales the overlay to a fraction of the base width and positions top-centered', () => {
    const f = buildOverlayFilter({ ...base, position: 'top' });
    expect(f).toContain('[1:v]scale=400:-2');            // 800 * 0.5
    expect(f).toContain('overlay=(main_w-overlay_w)/2:40');
    expect(f.trim().endsWith('[v]')).toBe(true);
  });

  it('positions bottom-right with margins using overlay-filter expressions', () => {
    const f = buildOverlayFilter({ ...base, position: 'bottom-right' });
    expect(f).toContain('overlay=main_w-overlay_w-40:main_h-overlay_h-40');
  });

  it('adds a border via pad when borderWidth > 0', () => {
    const f = buildOverlayFilter({ ...base, position: 'top', borderWidth: 6, borderColor: 'white' });
    expect(f).toContain('pad=iw+12:ih+12:6:6:white');
  });
});

describe('ffmpeg.overlay behavioral (deterministic composite)', () => {
  let dir: string, base: string, ov: string, out: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'overlay-'));
    base = join(dir, 'base.mp4'); ov = join(dir, 'ov.png'); out = join(dir, 'out.mp4');
    spawnSync(ffmpegBin(), ['-y','-f','lavfi','-i','testsrc=size=400x720:rate=24:duration=1',
      '-c:v','libx264','-pix_fmt','yuv420p',base], { stdio: 'ignore' });
    spawnSync(ffmpegBin(), ['-y','-f','lavfi','-i','color=c=red:size=200x120','-frames:v','1',ov], { stdio: 'ignore' });
  });
  afterAll(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  it('overlays a PNG onto a clip, output keeps base dims + yuv420p', () => {
    const filter = buildOverlayFilter({ baseWidth: 400, position: 'top', scale: 0.5, margin: 20, borderWidth: 0, borderColor: 'white' });
    const r = spawnSync(ffmpegBin(), ['-hide_banner','-loglevel','error','-y','-i',base,'-i',ov,
      '-filter_complex',filter,'-map','[v]','-c:v','libx264','-pix_fmt','yuv420p',out], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    const probe = spawnSync(ffprobeBin(), ['-v','error','-select_streams','v:0',
      '-show_entries','stream=width,height,pix_fmt','-of','default=nw=1',out], { encoding: 'utf8' }).stdout;
    expect(probe).toContain('width=400');
    expect(probe).toContain('height=720');
    expect(probe).toContain('pix_fmt=yuv420p');
  });
});
