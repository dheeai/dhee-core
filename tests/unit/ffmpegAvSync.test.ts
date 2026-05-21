import { describe, it, expect } from 'vitest';
import {
  buildAudioFilter,
  buildVideoFilter,
  buildWatermarkOverlayFilter,
  computeXfadeOffset,
  mobileCompatibleEncodeArgs,
  xfadeTransitionDuration,
} from '../../src/core/timeline/FFmpegAssembler.js';

describe('FFmpegAssembler audio padding (AV-sync regression)', () => {
  // LTX 2.3 outputs we observed on woman_medieval_village_betrothed:
  //   video=3.041667s, audio=3.029s  (12 ms short)
  //   video=8.041667s, audio=8.021s  (20 ms short)
  // Across 17 clips that compounded to a noticeable lead in voice vs
  // lip movement in the final assembly. Fix pads each clip's audio with
  // apad then trims to the video duration so every [v_i][a_i] pair has
  // identical length entering the concat filter.

  it('pads + trims audio to the video duration when audio is present', () => {
    const f = buildAudioFilter(2, /*hasAudio=*/ true, 3.041667, /*silence=*/ -1);
    expect(f).toBe('[2:a]asetpts=PTS-STARTPTS,apad,atrim=duration=3.041667[a2]');
  });

  it('uses each segment’s OWN video duration (not a shared/timeline duration)', () => {
    // Different clips → different durations. Verify we’re per-clip, not
    // accidentally pulling a single value.
    const a = buildAudioFilter(0, true, 3.041667, -1);
    const b = buildAudioFilter(1, true, 8.041667, -1);
    const c = buildAudioFilter(2, true, 6.041667, -1);
    expect(a).toContain('atrim=duration=3.041667');
    expect(b).toContain('atrim=duration=8.041667');
    expect(c).toContain('atrim=duration=6.041667');
  });

  it('slices silence to the video duration for clips without audio', () => {
    // silence source is at input index 17 (after 17 video inputs)
    const f = buildAudioFilter(5, /*hasAudio=*/ false, 4.5, /*silence=*/ 17);
    expect(f).toBe('[17:a]atrim=duration=4.5,asetpts=PTS-STARTPTS[a5]');
  });

  it('emits a [v_i] label that matches the [a_i] label position for concat pairing', () => {
    // The concat filter expects interleaved [v0][a0][v1][a1]... — labels
    // must agree on index. Sanity-check a few indices.
    for (const i of [0, 7, 16]) {
      const v = buildVideoFilter(i, 1280, 720);
      const a = buildAudioFilter(i, true, 5.0, -1);
      expect(v).toContain(`[v${i}]`);
      expect(a).toContain(`[a${i}]`);
    }
  });

  it('video filter scales and pads to the requested resolution with PTS reset', () => {
    const v = buildVideoFilter(3, 1920, 1080);
    expect(v).toBe(
      '[3:v]scale=1920:1080:force_original_aspect_ratio=decrease,' +
        'pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setpts=PTS-STARTPTS[v3]',
    );
  });
});

describe('computeXfadeOffset (timeline-vs-actual duration regression)', () => {
  // The first run produced final_video.mp4 with video=44.7s, audio=82.9s
  // because xfade offsets used segments[i].duration (planned, e.g. 2.14 s)
  // while LTX 2.3 actually emitted ~3.04 s clips. xfade then truncated
  // each clip to its planned length, dropping nearly half the video.

  it('uses ACTUAL clip duration for the running offset, not the planned timeline duration', () => {
    // Step 0: clip 0 actual = 3.04 s. Step 1: 0.5 s fade.
    const step1 = computeXfadeOffset(3.04, 3.04, 0.5);
    // offset = 3.04 - 0.5 = 2.54 s into the running output, fade begins
    expect(step1.offset).toBeCloseTo(2.54, 6);
    // accumulator advances by 3.04 - 0.5 = 2.54
    expect(step1.nextAccumulatedDuration).toBeCloseTo(5.58, 6);
  });

  it('clamps offset to 0 if accumulator < transition duration (first clip shorter than fade)', () => {
    // Edge case: first clip is 0.3 s, fade is 0.5 s. Offset would be
    // negative — must clamp to 0 so xfade doesn't error.
    const step = computeXfadeOffset(0.3, 1.0, 0.5);
    expect(step.offset).toBe(0);
    expect(step.nextAccumulatedDuration).toBeCloseTo(0.8, 6); // 0.3 + 1.0 - 0.5
  });

  it('cuts of total duration matches sum of actual clips minus transitions', () => {
    // Replay woman_medieval_village_betrothed: 3 clips at 3.04 s with two
    // 0.5 s fades. Expected total = 3*3.04 - 2*0.5 = 9.12 - 1.0 = 8.12 s.
    let acc = 3.04;
    const s1 = computeXfadeOffset(acc, 3.04, 0.5);
    acc = s1.nextAccumulatedDuration;
    const s2 = computeXfadeOffset(acc, 3.04, 0.5);
    acc = s2.nextAccumulatedDuration;
    expect(acc).toBeCloseTo(8.12, 6);
  });
});

describe('mobileCompatibleEncodeArgs — WhatsApp/iOS/Android playback', () => {
  // Diagnosed on 2026-04-27: overlay+watermark path produced yuv444p +
  // High 4:4:4 Predictive + moov-at-end. Played in VLC, refused on
  // WhatsApp mobile. These args lock the encode to a profile every
  // mobile decoder accepts.

  const args = mobileCompatibleEncodeArgs();

  it('forces yuv420p pixel format', () => {
    expect(args).toContain('-pix_fmt');
    const idx = args.indexOf('-pix_fmt');
    expect(args[idx + 1]).toBe('yuv420p');
  });

  it('caps H.264 at High@4.1 (mobile-safe ceiling)', () => {
    const profIdx = args.indexOf('-profile:v');
    const levelIdx = args.indexOf('-level:v');
    expect(args[profIdx + 1]).toBe('high');
    expect(args[levelIdx + 1]).toBe('4.1');
  });

  it('locks audio to 48 kHz stereo (some Android players reject 24 kHz)', () => {
    const arIdx = args.indexOf('-ar');
    const acIdx = args.indexOf('-ac');
    expect(args[arIdx + 1]).toBe('48000');
    expect(args[acIdx + 1]).toBe('2');
  });

  it('moves the moov atom to the front (+faststart) for streaming previews', () => {
    const idx = args.indexOf('-movflags');
    expect(args[idx + 1]).toBe('+faststart');
  });
});

describe('buildWatermarkOverlayFilter — bottom-right PNG overlay', () => {
  // We use overlay (always-available core filter) instead of drawtext
  // (often missing on Homebrew/system FFmpeg builds because libfreetype
  // is not enabled by default — this exact issue cost us a final-video
  // assembly on 2026-04-27 with "No such filter: 'drawtext'").

  it('places the PNG bottom-right with a 24px margin (W/H, not w/h)', () => {
    const f = buildWatermarkOverlayFilter('concated', 1, 'outv');
    // overlay uses W/H = main width/height, w/h = overlay width/height
    expect(f).toContain('overlay=x=W-w-24:y=H-h-24');
  });

  it('routes the watermark image through format=rgba so alpha is preserved', () => {
    expect(buildWatermarkOverlayFilter('concated', 1, 'outv')).toContain(
      '[1:v]format=rgba,',
    );
  });

  it('scales the watermark proportionally to the output height — 50px @ 720p (design spec)', () => {
    // 50 / 720 ≈ 6.94%. Anything between 48 and 52 is acceptable —
    // we round the ratio to integer pixels.
    const f = buildWatermarkOverlayFilter('concated', 1, 'outv', 720);
    const match = f.match(/scale=-1:(\d+)/);
    expect(match).not.toBeNull();
    const px = parseInt(match![1]!, 10);
    expect(px).toBeGreaterThanOrEqual(48);
    expect(px).toBeLessThanOrEqual(52);
  });

  it('scales proportionally for higher resolutions (1080p → ~75px, 4K → ~150px)', () => {
    const f1080 = buildWatermarkOverlayFilter('concated', 1, 'outv', 1080);
    expect(f1080).toMatch(/scale=-1:(7[3-7])/);
    const f4k = buildWatermarkOverlayFilter('concated', 1, 'outv', 2160);
    expect(f4k).toMatch(/scale=-1:(14[8-9]|15[0-2])/);
  });

  it('clamps to a sensible minimum size for tiny outputs (16px floor)', () => {
    // Vertical-format / portrait videos can have a small dimension —
    // we still want the watermark to render at >= 16px so it stays
    // visible even on the smallest reasonable output.
    const f = buildWatermarkOverlayFilter('concated', 1, 'outv', 100);
    const match = f.match(/scale=-1:(\d+)/);
    expect(match).not.toBeNull();
    expect(parseInt(match![1]!, 10)).toBeGreaterThanOrEqual(16);
  });

  it('defaults to 720p sizing when no output height is supplied (back-compat)', () => {
    // Existing callers that haven't been updated still get a
    // sensible default — same 50ish px as the design spec.
    const f = buildWatermarkOverlayFilter('concated', 1, 'outv');
    expect(f).toMatch(/scale=-1:(4[89]|5[0-2])/);
  });

  it('emits the chained filters separated by a semicolon', () => {
    const f = buildWatermarkOverlayFilter('concated', 1, 'outv');
    expect(f.split(';').length).toBe(2);
  });

  it('respects the input index for the watermark stream', () => {
    expect(buildWatermarkOverlayFilter('concated', 5, 'outv')).toContain('[5:v]');
    expect(buildWatermarkOverlayFilter('concated', 17, 'outv')).toContain('[17:v]');
  });

  it('publishes to the output label provided', () => {
    expect(buildWatermarkOverlayFilter('concated', 1, 'finalv')).toContain('[finalv]');
  });

  it('uses format=auto on overlay to preserve the source pixel format', () => {
    // `format=auto` keeps yuv420p output consistent with libx264
    // expectations downstream.
    expect(buildWatermarkOverlayFilter('a', 1, 'b')).toContain('format=auto');
  });
});

describe('xfadeTransitionDuration (sub-frame xfade regression)', () => {
  // FFmpeg's xfade silently produces broken/truncated output when its
  // `duration` parameter is shorter than 1 frame at the input framerate.
  // The previous code used 0.01s for "cut" — at 24 fps that's < 1 frame
  // and breaks the whole chain (final_video.mp4 came out at 9 s of video
  // against 83 s of audio on woman_medieval_village_betrothed). Two
  // frames at 24 fps (~0.083 s) is the smallest safe value and is
  // visually indistinguishable from a hard cut.

  it('returns ≥1 frame at 24fps for cut transitions', () => {
    const t = xfadeTransitionDuration('cut', undefined);
    expect(t).toBeGreaterThanOrEqual(1 / 24);
    // Also ≥1 frame at 60fps (covers higher-fps inputs too)
    expect(t).toBeGreaterThanOrEqual(1 / 60);
  });

  it('ignores configured duration for cuts (cuts are always the minimum safe duration)', () => {
    // If a planner ever supplies a 0.01s duration thinking it means "fast cut",
    // we must NOT honor that — it triggers the FFmpeg sub-frame bug.
    expect(xfadeTransitionDuration('cut', 0.01)).toBeGreaterThanOrEqual(1 / 24);
    expect(xfadeTransitionDuration('cut', 0)).toBeGreaterThanOrEqual(1 / 24);
  });

  it('uses 0.5s default for fade and dissolve when no override given', () => {
    expect(xfadeTransitionDuration('fade', undefined)).toBe(0.5);
    expect(xfadeTransitionDuration('dissolve', undefined)).toBe(0.5);
    expect(xfadeTransitionDuration('dip_to_black', undefined)).toBe(0.5);
  });

  it('honors configured durations for fade-style transitions', () => {
    expect(xfadeTransitionDuration('fade', 1.2)).toBe(1.2);
    expect(xfadeTransitionDuration('crossfade', 0.3)).toBe(0.3);
  });

  it('caps flash_to_white at 0.3s even when configured longer', () => {
    expect(xfadeTransitionDuration('flash_to_white', 1.0)).toBe(0.3);
    expect(xfadeTransitionDuration('flash_to_white', 0.15)).toBe(0.15);
    expect(xfadeTransitionDuration('flash_to_white', undefined)).toBe(0.2);
  });
});
