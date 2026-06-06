/**
 * ffmpegBin / ffprobeBin — binary resolution for the ffmpeg runners.
 * Order: env override → bundled @*-installer path → bare PATH name.
 * The bare-name path was the `spawn ffmpeg ENOENT` bug in packaged apps.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { ffmpegBin, ffprobeBin } from '../../src/dag/runners/ffmpegBin.js';

const origFf = process.env['dhee_FFMPEG_PATH'];
const origFp = process.env['dhee_FFPROBE_PATH'];

afterEach(() => {
  if (origFf === undefined) delete process.env['dhee_FFMPEG_PATH'];
  else process.env['dhee_FFMPEG_PATH'] = origFf;
  if (origFp === undefined) delete process.env['dhee_FFPROBE_PATH'];
  else process.env['dhee_FFPROBE_PATH'] = origFp;
});

describe('ffmpegBin / ffprobeBin', () => {
  it('honors the env override first', () => {
    process.env['dhee_FFMPEG_PATH'] = '/custom/ffmpeg';
    process.env['dhee_FFPROBE_PATH'] = '/custom/ffprobe';
    expect(ffmpegBin()).toBe('/custom/ffmpeg');
    expect(ffprobeBin()).toBe('/custom/ffprobe');
  });

  it('falls back to the bundled installer binary — an absolute path, never the bare name', () => {
    delete process.env['dhee_FFMPEG_PATH'];
    delete process.env['dhee_FFPROBE_PATH'];
    // @ffmpeg-installer / @ffprobe-installer are dhee-core deps, so they
    // resolve to a real on-disk path rather than the bare 'ffmpeg' that
    // ENOENT'd in packaged builds.
    expect(ffmpegBin()).not.toBe('ffmpeg');
    expect(ffmpegBin()).toMatch(/ffmpeg/i);
    expect(ffprobeBin()).not.toBe('ffprobe');
    expect(ffprobeBin()).toMatch(/ffprobe/i);
  });

  it('ignores a blank env override', () => {
    process.env['dhee_FFMPEG_PATH'] = '   ';
    expect(ffmpegBin()).not.toBe('   ');
  });
});
