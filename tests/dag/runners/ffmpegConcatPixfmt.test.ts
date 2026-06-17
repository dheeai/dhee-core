/**
 * ffmpeg.concat — watermark re-encode pass output format regression.
 *
 * Bug: the final watermark/overlay pass omitted `-pix_fmt yuv420p`, so libx264
 * preserved the overlay filtergraph's 4:4:4 chroma and produced an
 * "H.264 High 4:4:4 Predictive / yuv444p" mp4. Phones and WhatsApp's H.264
 * decoder cannot play 4:4:4, so the shared final video silently failed to open.
 *
 * This is a BEHAVIORAL test: it generates a real clip + a real watermark PNG,
 * runs the actual reencodePass, and ffprobes the OUTPUT pixel format. It would
 * fail (yuv444p) without the `-pix_fmt yuv420p` fix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { reencodePass } from '../../../src/dag/runners/ffmpegConcat.js';
import { ffmpegBin, ffprobeBin } from '../../../src/dag/runners/ffmpegBin.js';

const stubCtx = { log: () => {} } as never;

function probePixFmt(file: string): string {
  const r = spawnSync(ffprobeBin(), [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=pix_fmt', '-of', 'default=nw=1:nk=1', file,
  ], { encoding: 'utf8' });
  return r.stdout.trim();
}

let dir: string;
let input: string;
let watermark: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ffmpeg-pixfmt-'));
  input = join(dir, 'input.mp4');
  watermark = join(dir, 'watermark.png');
  // 1s 256x256 yuv420p test clip with a silent audio track.
  spawnSync(ffmpegBin(), [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=256x256:rate=24:duration=1',
    '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-shortest',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input,
  ], { stdio: 'ignore' });
  // a small semi-transparent rgba watermark
  spawnSync(ffmpegBin(), [
    '-y', '-f', 'lavfi', '-i', 'color=c=white@0.5:size=64x64,format=rgba',
    '-frames:v', '1', watermark,
  ], { stdio: 'ignore' });
});

afterAll(() => {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe('ffmpegConcat reencodePass output format (WhatsApp playback regression)', () => {
  it('produces a fixture clip and watermark to encode', () => {
    expect(existsSync(input)).toBe(true);
    expect(existsSync(watermark)).toBe(true);
  });

  it('forces yuv420p in the watermark pass output (not yuv444p)', async () => {
    const out = join(dir, 'out.mp4');
    const r = await reencodePass(stubCtx, input, out, watermark);
    expect(r.ok).toBe(true);
    expect(existsSync(out)).toBe(true);
    // The fix: output MUST be 4:2:0 so phones/WhatsApp can decode it.
    expect(probePixFmt(out)).toBe('yuv420p');
  });
});
