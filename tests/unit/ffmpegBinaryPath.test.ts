import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { runFFmpeg } from '../../src/core/timeline/FFmpegAssembler.js';
import { getFfmpegPath, getFfprobePath } from '../../src/core/timeline/ffmpegBinaries.js';

/**
 * Packaged Electron apps can't rely on a system-installed ffmpeg —
 * macOS GUI apps don't inherit the user's shell $PATH, and Windows
 * users may not have ffmpeg at all. We expose dhee_FFMPEG_PATH and
 * dhee_FFPROBE_PATH so the desktop wrapper can point dhee-core
 * at its bundled @ffmpeg-installer / @ffprobe-installer binaries.
 */
describe('ffmpeg/ffprobe binary path resolver', () => {
  const prevFfmpeg = process.env.dhee_FFMPEG_PATH;
  const prevFfprobe = process.env.dhee_FFPROBE_PATH;

  beforeEach(() => {
    delete process.env.dhee_FFMPEG_PATH;
    delete process.env.dhee_FFPROBE_PATH;
  });

  afterEach(() => {
    if (prevFfmpeg === undefined) delete process.env.dhee_FFMPEG_PATH;
    else process.env.dhee_FFMPEG_PATH = prevFfmpeg;
    if (prevFfprobe === undefined) delete process.env.dhee_FFPROBE_PATH;
    else process.env.dhee_FFPROBE_PATH = prevFfprobe;
  });

  it('defaults to "ffmpeg" / "ffprobe" when env vars are unset', () => {
    expect(getFfmpegPath()).toBe('ffmpeg');
    expect(getFfprobePath()).toBe('ffprobe');
  });

  it('honors dhee_FFMPEG_PATH and dhee_FFPROBE_PATH overrides', () => {
    process.env.dhee_FFMPEG_PATH = '/opt/bundled/ffmpeg';
    process.env.dhee_FFPROBE_PATH = '/opt/bundled/ffprobe';
    expect(getFfmpegPath()).toBe('/opt/bundled/ffmpeg');
    expect(getFfprobePath()).toBe('/opt/bundled/ffprobe');
  });

  it('reads env vars at call time (not at module load)', () => {
    process.env.dhee_FFMPEG_PATH = '/first/ffmpeg';
    expect(getFfmpegPath()).toBe('/first/ffmpeg');
    process.env.dhee_FFMPEG_PATH = '/second/ffmpeg';
    expect(getFfmpegPath()).toBe('/second/ffmpeg');
  });

  it('runFFmpeg spawns the binary at dhee_FFMPEG_PATH', async () => {
    // Point at a path that definitely doesn't exist — spawn will fail
    // with ENOENT and the error message must reference our path so we
    // know the override took effect (vs. silently falling back to PATH).
    const sentinel = '/nonexistent/dhee-test-ffmpeg-sentinel';
    process.env.dhee_FFMPEG_PATH = sentinel;

    await expect(runFFmpeg(['-version'], 5_000)).rejects.toThrow(sentinel);
  });
});
