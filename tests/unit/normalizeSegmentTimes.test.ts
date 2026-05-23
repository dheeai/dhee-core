/**
 * Tests for `normalizeSegmentTimes` — the cascade-reflow function
 * that derives `startTime` / `endTime` / `totalDuration` from segment
 * `duration` + array order.
 *
 * Written for the timeline architecture change that makes `duration`
 * the source of truth and the time-range fields derived. The user's
 * complaint that landed this refactor: "this design where we hold both
 * the start and endtime, which requires every shot to be edited is
 * not good. Why do we even need everything to be shifted if only 1
 * shot needs to change?"
 */

import { describe, it, expect } from 'vitest';
import { normalizeSegmentTimes } from '../../src/core/timeline/TimelineManager.js';
import type { Timeline, TimelineSegment } from '../../src/core/timeline/types.js';

function buildSegment(
  id: string,
  duration: number,
  // Deliberately stale start/end values — they should be overwritten
  // by the normalize pass, not trusted.
  startTime = -999,
  endTime = -999,
): TimelineSegment {
  return {
    id,
    label: id,
    startTime,
    endTime,
    duration,
    compositingMode: 'replace',
    fillStatus: 'empty',
    layers: [],
  };
}

function buildTimeline(segments: TimelineSegment[]): Timeline {
  return {
    version: '1.1',
    totalDuration: -999,
    defaultCompositingMode: 'replace',
    segments,
    globalLayers: [],
    validation: {
      isComplete: false,
      filledDuration: 0,
      gaps: [],
      warnings: [],
    },
  };
}

describe('normalizeSegmentTimes', () => {
  it('derives startTime/endTime/totalDuration from durations in array order', () => {
    const out = normalizeSegmentTimes(
      buildTimeline([
        buildSegment('scene_1_shot_1', 3),
        buildSegment('scene_1_shot_2', 6),
        buildSegment('scene_1_shot_3', 4),
      ]),
    );
    expect(out.segments[0]).toMatchObject({ startTime: 0, endTime: 3, duration: 3 });
    expect(out.segments[1]).toMatchObject({ startTime: 3, endTime: 9, duration: 6 });
    expect(out.segments[2]).toMatchObject({ startTime: 9, endTime: 13, duration: 4 });
    expect(out.totalDuration).toBe(13);
  });

  it('the load-bearing case — bumping one duration auto-shifts all downstream segments', () => {
    // Initial: 3s, 6s, 4s → starts 0/3/9, ends 3/9/13, total 13.
    // Caller bumps segment 0's duration to 5 without touching start/end.
    // Normalize should reflow everything.
    const t = buildTimeline([
      buildSegment('s_1', 3, 0, 3),
      buildSegment('s_2', 6, 3, 9),
      buildSegment('s_3', 4, 9, 13),
    ]);
    t.segments[0]!.duration = 5;
    const out = normalizeSegmentTimes(t);
    expect(out.segments[0]).toMatchObject({ startTime: 0, endTime: 5, duration: 5 });
    expect(out.segments[1]).toMatchObject({ startTime: 5, endTime: 11, duration: 6 });
    expect(out.segments[2]).toMatchObject({ startTime: 11, endTime: 15, duration: 4 });
    expect(out.totalDuration).toBe(15);
  });

  it('ignores stale on-disk startTime/endTime (always recomputes)', () => {
    // Stale values deliberately wrong. The normalize pass must NOT
    // trust them.
    const out = normalizeSegmentTimes(
      buildTimeline([
        buildSegment('s_1', 2, 99, 999),
        buildSegment('s_2', 3, -5, -2),
      ]),
    );
    expect(out.segments[0]).toMatchObject({ startTime: 0, endTime: 2 });
    expect(out.segments[1]).toMatchObject({ startTime: 2, endTime: 5 });
    expect(out.totalDuration).toBe(5);
  });

  it('rounds to 2 decimal places (matches createTimelineSkeleton rounding)', () => {
    const out = normalizeSegmentTimes(
      buildTimeline([
        buildSegment('s_1', 1.234567),
        buildSegment('s_2', 2.345678),
      ]),
    );
    expect(out.segments[0]).toMatchObject({ duration: 1.23, startTime: 0, endTime: 1.23 });
    expect(out.segments[1]).toMatchObject({ duration: 2.35, startTime: 1.23, endTime: 3.58 });
    expect(out.totalDuration).toBe(3.58);
  });

  it('empty segments array → totalDuration = 0, no errors', () => {
    const out = normalizeSegmentTimes(buildTimeline([]));
    expect(out.segments).toEqual([]);
    expect(out.totalDuration).toBe(0);
  });

  it('tolerates missing/undefined duration on a segment (treats as 0)', () => {
    const t = buildTimeline([
      buildSegment('s_1', 3),
      { ...buildSegment('s_2', 0), duration: undefined as unknown as number },
      buildSegment('s_3', 4),
    ]);
    const out = normalizeSegmentTimes(t);
    expect(out.segments[0]).toMatchObject({ startTime: 0, endTime: 3, duration: 3 });
    expect(out.segments[1]).toMatchObject({ startTime: 3, endTime: 3, duration: 0 });
    expect(out.segments[2]).toMatchObject({ startTime: 3, endTime: 7, duration: 4 });
    expect(out.totalDuration).toBe(7);
  });

  it('preserves all non-time segment fields (label, layers, metadata, transitions, etc.)', () => {
    const seg: TimelineSegment = {
      id: 's_1',
      label: 'Hero shot',
      startTime: -999,
      endTime: -999,
      duration: 4,
      compositingMode: 'overlay',
      compositingMetadata: { overlayOpacity: 0.5 },
      fillStatus: 'filled',
      layers: [
        { type: 'visual', filePath: 'a.mp4', label: 'L', source: 'generated' },
      ],
      transition: { type: 'fade', durationMs: 500 },
      metadata: { shotNumber: 1, custom: 'tag' },
    };
    const out = normalizeSegmentTimes(buildTimeline([seg]));
    expect(out.segments[0]).toMatchObject({
      id: 's_1',
      label: 'Hero shot',
      compositingMode: 'overlay',
      compositingMetadata: { overlayOpacity: 0.5 },
      fillStatus: 'filled',
      layers: seg.layers,
      transition: seg.transition,
      metadata: { shotNumber: 1, custom: 'tag' },
      // recomputed
      startTime: 0,
      endTime: 4,
      duration: 4,
    });
  });

  it('preserves top-level timeline fields (version, globalLayers, defaultCompositingMode)', () => {
    const t = buildTimeline([buildSegment('s_1', 2)]);
    t.version = '1.1';
    t.defaultCompositingMode = 'pip';
    t.globalLayers = [
      { type: 'audio', filePath: 'bg.mp3', label: 'BG', source: 'imported' },
    ];
    const out = normalizeSegmentTimes(t);
    expect(out.version).toBe('1.1');
    expect(out.defaultCompositingMode).toBe('pip');
    expect(out.globalLayers).toEqual(t.globalLayers);
  });

  it('does not mutate the input timeline', () => {
    const input = buildTimeline([buildSegment('s_1', 3, 99, 999)]);
    const snapshot = JSON.stringify(input);
    normalizeSegmentTimes(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
