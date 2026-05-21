import { describe, expect, it } from 'vitest';

import {
  getNextPendingTimelineSegment,
  getPendingTimelineSegments,
  parseShotSegmentId,
  splitSegmentIntoShots,
  upsertSceneShots,
} from '../../src/core/timeline/TimelineManager.js';
import type { Timeline } from '../../src/core/timeline/types.js';

function createTimeline(): Timeline {
  return {
    version: '1.0',
    totalDuration: 13,
    defaultCompositingMode: 'replace',
    segments: [
      {
        id: 'segment_0',
        label: 'Intro',
        startTime: 0,
        endTime: 4,
        duration: 4,
        compositingMode: 'replace',
        fillStatus: 'filled',
        layers: [],
      },
      {
        id: 'segment_1',
        label: 'Scene 1',
        startTime: 4,
        endTime: 9,
        duration: 5,
        compositingMode: 'overlay',
        compositingMetadata: { overlayOpacity: 0.6 },
        fillStatus: 'planned',
        layers: [],
        transition: {
          type: 'crossfade',
          durationMs: 250,
        },
      },
      {
        id: 'segment_2',
        label: 'Outro',
        startTime: 9,
        endTime: 13,
        duration: 4,
        compositingMode: 'replace',
        fillStatus: 'empty',
        layers: [],
      },
    ],
    globalLayers: [],
    validation: {
      isComplete: false,
      filledDuration: 4,
      gaps: [],
      warnings: [],
    },
  };
}

describe('splitSegmentIntoShots', () => {
  it('preserves exact shot durations and shifts downstream segments forward', () => {
    const result = splitSegmentIntoShots(createTimeline(), 'segment_1', [
      { label: 'Shot 1', duration: 2 },
      { label: 'Shot 2', duration: 4 },
      { label: 'Shot 3', duration: 1 },
    ]);

    expect(result.totalDuration).toBe(15);
    expect(result.segments.map(segment => ({
      id: segment.id,
      startTime: segment.startTime,
      endTime: segment.endTime,
      duration: segment.duration,
    }))).toEqual([
      { id: 'segment_0', startTime: 0, endTime: 4, duration: 4 },
      { id: 'segment_1_shot_1', startTime: 4, endTime: 6, duration: 2 },
      { id: 'segment_1_shot_2', startTime: 6, endTime: 10, duration: 4 },
      { id: 'segment_1_shot_3', startTime: 10, endTime: 11, duration: 1 },
      { id: 'segment_2', startTime: 11, endTime: 15, duration: 4 },
    ]);
    expect(result.segments[1]).toEqual(
      expect.objectContaining({
        compositingMode: 'overlay',
        compositingMetadata: { overlayOpacity: 0.6 },
        transition: {
          type: 'crossfade',
          durationMs: 250,
        },
      })
    );
    expect(result.validation.gaps).toEqual([]);
  });

  it('preserves exact shot durations and shifts downstream segments backward', () => {
    const result = splitSegmentIntoShots(createTimeline(), 'segment_1', [
      { label: 'Shot 1', duration: 1.5 },
      { label: 'Shot 2', duration: 1.5 },
    ]);

    expect(result.totalDuration).toBe(11);
    expect(result.segments.map(segment => ({
      id: segment.id,
      startTime: segment.startTime,
      endTime: segment.endTime,
      duration: segment.duration,
    }))).toEqual([
      { id: 'segment_0', startTime: 0, endTime: 4, duration: 4 },
      { id: 'segment_1_shot_1', startTime: 4, endTime: 5.5, duration: 1.5 },
      { id: 'segment_1_shot_2', startTime: 5.5, endTime: 7, duration: 1.5 },
      { id: 'segment_2', startTime: 7, endTime: 11, duration: 4 },
    ]);
    expect(result.validation.gaps).toEqual([]);
  });

  it('re-splits an already split scene without duplicating shot branches', () => {
    const initial = splitSegmentIntoShots(createTimeline(), 'segment_1', [
      { label: 'Shot 1', duration: 2 },
      { label: 'Shot 2', duration: 3 },
    ]);

    const result = splitSegmentIntoShots(initial, 'segment_1', [
      { label: 'Shot A', duration: 1 },
      { label: 'Shot B', duration: 1 },
      { label: 'Shot C', duration: 2 },
    ]);

    expect(result.totalDuration).toBe(12);
    expect(result.segments.map(segment => ({
      id: segment.id,
      startTime: segment.startTime,
      endTime: segment.endTime,
      duration: segment.duration,
    }))).toEqual([
      { id: 'segment_0', startTime: 0, endTime: 4, duration: 4 },
      { id: 'segment_1_shot_1', startTime: 4, endTime: 5, duration: 1 },
      { id: 'segment_1_shot_2', startTime: 5, endTime: 6, duration: 1 },
      { id: 'segment_1_shot_3', startTime: 6, endTime: 8, duration: 2 },
      { id: 'segment_2', startTime: 8, endTime: 12, duration: 4 },
    ]);
    expect(result.validation.gaps).toEqual([]);
  });

  it('returns pending segments in timeline order and exposes the first unfilled shot', () => {
    const initial = splitSegmentIntoShots(createTimeline(), 'segment_1', [
      { label: 'Shot 1', duration: 2 },
      { label: 'Shot 2', duration: 3 },
    ]);

    initial.segments[1] = {
      ...initial.segments[1]!,
      fillStatus: 'filled',
      layers: [
        {
          type: 'visual',
          label: 'Shot 1 video',
          source: 'generated',
          filePath: 'assets/videos/scene-2-shot-1.mp4',
        },
      ],
    };

    const pendingSegments = getPendingTimelineSegments(initial);

    expect(pendingSegments).toEqual([
      {
        segmentId: 'segment_1_shot_2',
        label: 'Shot 2',
        fillStatus: 'planned',
        sceneNumber: 2,
        shotNumber: 2,
      },
      {
        segmentId: 'segment_2',
        label: 'Outro',
        fillStatus: 'empty',
      },
    ]);
    expect(getNextPendingTimelineSegment(initial)).toEqual(pendingSegments[0]);
  });

  it('parses shot segment ids into scene and shot numbers', () => {
    expect(parseShotSegmentId('segment_2_shot_4')).toEqual({
      sceneIndex: 2,
      sceneNumber: 3,
      shotNumber: 4,
    });
    expect(parseShotSegmentId('segment_2')).toBeNull();
  });

  it('rebuilds the scene under a new plan when shot count changes, carrying forward already-filled shots', () => {
    // Plan resize semantics (the 2026-05-19 "Village" bug fix in
    // TimelineManager.upsertSceneShots, lines 961-1002): when the new
    // plan's shot count differs from the existing count, the timeline IS
    // rebuilt to match the new plan — but any already-filled shot's
    // layers / fillStatus carry forward by shotNumber. preservedExistingShots
    // is true iff at least one filled shot was preserved.
    //
    // Before the resize branch, this case bailed out entirely (returned
    // initial unchanged), which left an 8-shot timeline behind when Stage A
    // re-planned to 4 shots, and the FFmpeg assembler stitched a final
    // video out of two different plans.
    const initial = splitSegmentIntoShots(createTimeline(), 'segment_1', [
      { label: 'Shot 1', duration: 2, metadata: { shotType: 'close_up' } },
      { label: 'Shot 2', duration: 3, metadata: { shotType: 'wide' } },
    ]);

    const filledLayer = {
      type: 'visual' as const,
      label: 'Shot 1 video',
      source: 'generated' as const,
      filePath: 'assets/videos/scene-2-shot-1.mp4',
      metadata: { prompt: 'Existing shot one' },
    };
    initial.segments[1] = {
      ...initial.segments[1]!,
      fillStatus: 'filled',
      metadata: { shotType: 'close_up' },
      layers: [filledLayer],
    };

    const result = upsertSceneShots(initial, 'segment_1', [
      { label: 'Replacement 1', duration: 1 },
      { label: 'Replacement 2', duration: 1 },
      { label: 'Replacement 3', duration: 2 },
    ]);

    expect(result.preservedExistingShots).toBe(true);
    // New plan has 3 shots — timeline must now contain 3 shot segments
    // under segment_1 (NOT the original 2).
    const shotSegments = result.timeline.segments.filter(s =>
      s.id.startsWith('segment_1_shot_'),
    );
    expect(shotSegments).toHaveLength(3);
    // The previously-filled shot (shot 1) keeps its layers and fillStatus.
    const newShot1 = shotSegments.find(s => s.id === 'segment_1_shot_1');
    expect(newShot1).toBeDefined();
    expect(newShot1!.fillStatus).toBe('filled');
    expect(newShot1!.layers).toEqual([filledLayer]);
    // Replacement metadata (shotType lives in old metadata, label is from
    // the new plan) merges over the old.
    expect(newShot1!.label).toBe('Replacement 1');
    // The two new shots (2 and 3) come out planned/empty — they have no
    // prior filled work to carry forward.
    const newShot3 = shotSegments.find(s => s.id === 'segment_1_shot_3');
    expect(newShot3).toBeDefined();
    expect(newShot3!.layers).toEqual([]);
  });

  it('merges safe metadata updates onto existing filled shot segments without resetting progress', () => {
    const initial = splitSegmentIntoShots(createTimeline(), 'segment_1', [
      { label: 'Shot 1', duration: 2, metadata: { shotType: 'close_up', prompt: 'old prompt' } },
      { label: 'Shot 2', duration: 3, metadata: { shotType: 'wide' } },
    ]);

    initial.segments[1] = {
      ...initial.segments[1]!,
      fillStatus: 'filled',
      metadata: { shotType: 'close_up', prompt: 'old prompt' },
      layers: [
        {
          type: 'visual',
          label: 'Shot 1 video',
          source: 'generated',
          filePath: 'assets/videos/scene-2-shot-1.mp4',
          metadata: { prompt: 'Existing shot one' },
        },
      ],
      versionInfo: { activeVersion: 2, totalVersions: 2 },
    };
    initial.segments[2] = {
      ...initial.segments[2]!,
      fillStatus: 'planned',
      metadata: { shotType: 'wide' },
    };

    const result = upsertSceneShots(initial, 'segment_1', [
      {
        label: 'Shot 1 refined',
        duration: 2,
        metadata: { shotType: 'close_up', prompt: 'new prompt', continuity_anchor: 'same face' },
      },
      {
        label: 'Shot 2 refined',
        duration: 3,
        metadata: { shotType: 'wide', setting_lock: 'same diner booth' },
      },
    ]);

    expect(result.preservedExistingShots).toBe(true);
    expect(result.mergedMetadataIntoExistingShots).toBe(true);
    expect(result.timeline.segments[1]).toEqual(
      expect.objectContaining({
        id: 'segment_1_shot_1',
        label: 'Shot 1 refined',
        fillStatus: 'filled',
        startTime: 4,
        endTime: 6,
        duration: 2,
        versionInfo: { activeVersion: 2, totalVersions: 2 },
        layers: [
          expect.objectContaining({
            filePath: 'assets/videos/scene-2-shot-1.mp4',
          }),
        ],
        metadata: {
          shotType: 'close_up',
          prompt: 'new prompt',
          continuity_anchor: 'same face',
        },
      })
    );
    expect(result.timeline.segments[2]).toEqual(
      expect.objectContaining({
        id: 'segment_1_shot_2',
        label: 'Shot 2 refined',
        fillStatus: 'planned',
        startTime: 6,
        endTime: 9,
        duration: 3,
        metadata: {
          shotType: 'wide',
          setting_lock: 'same diner booth',
        },
      })
    );
  });

  it('preserves existing filled shots unchanged when a re-approved scene materially conflicts', () => {
    const initial = splitSegmentIntoShots(createTimeline(), 'segment_1', [
      { label: 'Shot 1', duration: 2, metadata: { shotType: 'close_up', prompt: 'old prompt' } },
      { label: 'Shot 2', duration: 3, metadata: { shotType: 'wide' } },
    ]);

    initial.segments[1] = {
      ...initial.segments[1]!,
      fillStatus: 'filled',
      metadata: { shotType: 'close_up', prompt: 'old prompt' },
      layers: [
        {
          type: 'visual',
          label: 'Shot 1 video',
          source: 'generated',
          filePath: 'assets/videos/scene-2-shot-1.mp4',
        },
      ],
      versionInfo: { activeVersion: 2, totalVersions: 2 },
    };

    const result = upsertSceneShots(initial, 'segment_1', [
      {
        label: 'Shot 1 conflicting rewrite',
        duration: 1,
        metadata: { shotType: 'over_the_shoulder', prompt: 'completely different shot' },
      },
      {
        label: 'Shot 2 conflicting rewrite',
        duration: 1,
        metadata: { shotType: 'wide' },
      },
    ]);

    expect(result.preservedExistingShots).toBe(true);
    expect(result.mergedMetadataIntoExistingShots).toBe(false);
    expect(result.timeline).toEqual(initial);
  });
});
