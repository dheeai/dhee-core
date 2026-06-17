/**
 * ffmpeg.demo_overlay — screenshot inset → expand → fullscreen → collapse.
 *
 * computeDemoSegments is the contract (the runner shells out to ffmpeg): the
 * xfaded phase lengths must sum to the base duration D so the muxed continuous
 * audio stays aligned (lip-sync). Plus a behavioral test rendering a real clip.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { computeDemoSegments, createFfmpegDemoOverlayRunner } from '../../../src/dag/runners/ffmpegDemoOverlay.js';
import { ffmpegBin, ffprobeBin } from '../../../src/dag/runners/ffmpegBin.js';

describe('computeDemoSegments', () => {
  it('xfaded phase lengths sum to D (audio alignment)', () => {
    const D = 35;
    const s = computeDemoSegments(D, { appearAt: 6, insetHold: 5, expandDur: 1, fullscreenHold: 10, collapseDur: 1 });
    // total after 2 xfades = clip1 + full - expandDur + clip3 - collapseDur
    const total = s.clip1Dur + s.fullDur - 1 + s.clip3Dur - 1;
    expect(total).toBeCloseTo(D, 1);
    expect(s.appearAt).toBeCloseTo(6, 5);
    expect(s.tExpand).toBeCloseTo(11, 5);          // appearAt + insetHold
    expect(s.clip3Start).toBeCloseTo(22, 5);        // tExpand + expandDur + fullscreenHold
  });

  it('compresses the choreography to fit a short base (still sums to D)', () => {
    const D = 12;
    const s = computeDemoSegments(D, { appearAt: 6, insetHold: 5, expandDur: 1, fullscreenHold: 10, collapseDur: 1 });
    const total = s.clip1Dur + s.fullDur - 1 + s.clip3Dur - 1;
    expect(total).toBeCloseTo(D, 1);
    expect(s.clip3Start).toBeLessThan(D);
  });
});

describe('ffmpeg.demo_overlay behavioral', () => {
  let dir: string, base: string, shot: string, out: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'demo-ov-'));
    base = join(dir, 'base.mp4'); shot = join(dir, 'shot.png'); out = join(dir, 'out.mp4');
    // 12s 640x360 base clip WITH a (silent) audio track
    spawnSync(ffmpegBin(), ['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=24:duration=12',
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', base], { stdio: 'ignore' });
    spawnSync(ffmpegBin(), ['-y', '-f', 'lavfi', '-i', 'color=c=blue:size=1280x720', '-frames:v', '1', shot], { stdio: 'ignore' });
  });
  afterAll(() => { if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true }); });

  it('produces a clip ~= base duration, base dims, with audio (lip-sync alignment)', async () => {
    const runner = createFfmpegDemoOverlayRunner();
    const ctx = {
      projectDir: dir,
      node: { inputs: [{ from: 'base' }], runner: { tool: 'ffmpeg.demo_overlay', config: {
        baseInput: 'base', overlayInput: 'shot', appearAt: 2, insetHold: 2, expandDur: 1, fullscreenHold: 3, collapseDur: 1, outputPath: 'out.mp4',
      } } },
      inputs: { base, shot },
      log: () => {},
    } as never;
    // write to the temp dir directly
    (ctx as { node: { runner: { config: { outputPath: string } } } }).node.runner.config.outputPath = 'out.mp4';
    const r = await runner.run(ctx);
    expect(r.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    const dur = parseFloat(spawnSync(ffprobeBin(), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], { encoding: 'utf8' }).stdout.trim());
    expect(dur).toBeGreaterThan(10.5);
    expect(dur).toBeLessThan(13);
    const probe = spawnSync(ffprobeBin(), ['-v', 'error', '-show_entries', 'stream=width,height,codec_type', '-of', 'default=nw=1', out], { encoding: 'utf8' }).stdout;
    expect(probe).toContain('width=640');
    expect(probe).toContain('codec_type=audio');
  }, 60000);
});
