/**
 * `upsertSceneShots` plan-change tests — written TDD-style BEFORE fixing
 * the plan-shrink bug (2026-05-19, "The Village" final video stitched 8 old
 * shots after Stage A re-planned to 4).
 *
 * Each `it` here enumerates a real user-action failure mode that
 * `upsertSceneShots` must handle:
 *
 *   1. shrink_filled   — old plan had N filled shots, new plan has N-k
 *   2. grow_filled     — old plan had N filled shots, new plan has N+k
 *   3. shrink_unfilled — N planned (unfilled), new plan has N-k
 *   4. grow_unfilled   — N planned, new plan has N+k
 *   5. scene_isolation — upserting one scene must not touch another's segments
 *   6. drop_all        — new plan has zero shots
 *
 * Cases that ALREADY work (covered by tests/timeline-integration.test.ts):
 *   - same count + compatible metadata (merge path)
 *   - empty timeline + new shots (initial create path)
 *
 * Acceptance criteria after the fix:
 *   - timeline.segments for the upserted scene EXACTLY equals the new plan's
 *     shot count for that scene (no orphans, no missing)
 *   - existing filled segments whose shotNumber survives the new plan keep
 *     their layers / fillStatus / artifactId
 *   - segments past the new plan's shot count are removed
 *   - other scenes' segments are untouched
 *   - totalDuration is recomputed to reflect the new shot durations
 */
import { describe, it, expect } from 'vitest';
import {
  createTimelineSkeleton,
  updateSegmentLayers,
  splitSegmentIntoShots,
  upsertSceneShots,
} from '../../src/core/timeline/TimelineManager.js';
import type { Timeline } from '../../src/core/timeline/types.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function buildShotPlan(count: number, durationPerShot: number = 5) {
  return Array.from({ length: count }, (_, i) => ({
    label: `Shot ${i + 1}`,
    duration: durationPerShot,
    metadata: { shotNumber: i + 1 },
  }));
}

function fillShot(timeline: Timeline, segmentId: string, artifactId: string): Timeline {
  return updateSegmentLayers(
    timeline,
    segmentId,
    [
      {
        type: 'visual',
        artifactId,
        filePath: `assets/videos/${artifactId}.mp4`,
        label: segmentId,
        source: 'generated',
      },
    ],
    'filled',
  );
}

function getShotIds(timeline: Timeline, sceneId: string): string[] {
  const pat = new RegExp(`^${sceneId}_shot_\\d+$`);
  return timeline.segments.filter(s => pat.test(s.id)).map(s => s.id);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('upsertSceneShots — plan change handling', () => {
  describe('shrink_filled — Stage A re-plans to fewer shots, existing ones rendered', () => {
    it('drops orphan filled segments past the new plan length', () => {
      // Setup: 8-shot plan, every shot filled with a video.
      let timeline = createTimelineSkeleton(40, [{ id: 'scene_1', label: 'Scene 1' }]);
      timeline = splitSegmentIntoShots(timeline, 'scene_1', buildShotPlan(8));
      for (let n = 1; n <= 8; n++) {
        timeline = fillShot(timeline, `scene_1_shot_${n}`, `vid_${n}`);
      }
      expect(getShotIds(timeline, 'scene_1').length).toBe(8); // sanity

      // Stage A re-plans to 4 shots.
      const result = upsertSceneShots(timeline, 'scene_1', buildShotPlan(4));

      // The bug: timeline currently still has 8 segments because the "preserve
      // filled" branch returns the timeline unchanged. After the fix it MUST
      // be exactly 4 for this scene.
      expect(getShotIds(result.timeline, 'scene_1')).toEqual([
        'scene_1_shot_1',
        'scene_1_shot_2',
        'scene_1_shot_3',
        'scene_1_shot_4',
      ]);
    });

    it('preserves the filled layers on the surviving shots (1..N-k)', () => {
      let timeline = createTimelineSkeleton(40, [{ id: 'scene_1', label: 'Scene 1' }]);
      timeline = splitSegmentIntoShots(timeline, 'scene_1', buildShotPlan(8));
      for (let n = 1; n <= 8; n++) {
        timeline = fillShot(timeline, `scene_1_shot_${n}`, `vid_${n}`);
      }
      const result = upsertSceneShots(timeline, 'scene_1', buildShotPlan(4));

      const shot1 = result.timeline.segments.find(s => s.id === 'scene_1_shot_1')!;
      expect(shot1.fillStatus).toBe('filled');
      expect(shot1.layers[0]?.artifactId).toBe('vid_1');
      const shot4 = result.timeline.segments.find(s => s.id === 'scene_1_shot_4')!;
      expect(shot4.fillStatus).toBe('filled');
      expect(shot4.layers[0]?.artifactId).toBe('vid_4');
    });

    it('totalDuration reflects the new (shorter) plan', () => {
      let timeline = createTimelineSkeleton(40, [{ id: 'scene_1', label: 'Scene 1' }]);
      timeline = splitSegmentIntoShots(timeline, 'scene_1', buildShotPlan(8, 5)); // 8×5=40s
      for (let n = 1; n <= 8; n++) {
        timeline = fillShot(timeline, `scene_1_shot_${n}`, `vid_${n}`);
      }
      const result = upsertSceneShots(timeline, 'scene_1', buildShotPlan(4, 5)); // 4×5=20s
      expect(result.timeline.totalDuration).toBe(20);
    });
  });

  describe('grow_filled — Stage A re-plans to MORE shots, existing ones rendered', () => {
    it('keeps existing filled segments and appends new unfilled segments', () => {
      let timeline = createTimelineSkeleton(20, [{ id: 'scene_1', label: 'Scene 1' }]);
      timeline = splitSegmentIntoShots(timeline, 'scene_1', buildShotPlan(4));
      for (let n = 1; n <= 4; n++) {
        timeline = fillShot(timeline, `scene_1_shot_${n}`, `vid_${n}`);
      }

      const result = upsertSceneShots(timeline, 'scene_1', buildShotPlan(8));

      expect(getShotIds(result.timeline, 'scene_1')).toEqual([
        'scene_1_shot_1',
        'scene_1_shot_2',
        'scene_1_shot_3',
        'scene_1_shot_4',
        'scene_1_shot_5',
        'scene_1_shot_6',
        'scene_1_shot_7',
        'scene_1_shot_8',
      ]);
      // Surviving shots keep their fills.
      expect(
        result.timeline.segments.find(s => s.id === 'scene_1_shot_1')?.fillStatus,
      ).toBe('filled');
      // New tail shots are not filled (no work done for them yet).
      expect(
        result.timeline.segments.find(s => s.id === 'scene_1_shot_5')?.fillStatus,
      ).not.toBe('filled');
      expect(
        result.timeline.segments.find(s => s.id === 'scene_1_shot_8')?.fillStatus,
      ).not.toBe('filled');
    });
  });

  describe('shrink_unfilled — plan compressed while everything is still pending', () => {
    it('drops the tail unfilled segments', () => {
      let timeline = createTimelineSkeleton(40, [{ id: 'scene_1', label: 'Scene 1' }]);
      timeline = splitSegmentIntoShots(timeline, 'scene_1', buildShotPlan(8));
      // No fillShot calls — leave everything 'planned'/'empty'.

      const result = upsertSceneShots(timeline, 'scene_1', buildShotPlan(4));

      expect(getShotIds(result.timeline, 'scene_1')).toEqual([
        'scene_1_shot_1',
        'scene_1_shot_2',
        'scene_1_shot_3',
        'scene_1_shot_4',
      ]);
    });
  });

  describe('grow_unfilled — plan grew while everything still pending', () => {
    it('adds the new segments', () => {
      let timeline = createTimelineSkeleton(20, [{ id: 'scene_1', label: 'Scene 1' }]);
      timeline = splitSegmentIntoShots(timeline, 'scene_1', buildShotPlan(2));

      const result = upsertSceneShots(timeline, 'scene_1', buildShotPlan(4));

      expect(getShotIds(result.timeline, 'scene_1')).toEqual([
        'scene_1_shot_1',
        'scene_1_shot_2',
        'scene_1_shot_3',
        'scene_1_shot_4',
      ]);
    });
  });

  describe('scene_isolation — upsert on one scene must not touch another scene', () => {
    it('leaves scene_2 segments + fills untouched when scene_1 is replanned', () => {
      let timeline = createTimelineSkeleton(40, [
        { id: 'scene_1', label: 'Scene 1' },
        { id: 'scene_2', label: 'Scene 2' },
      ]);
      timeline = splitSegmentIntoShots(timeline, 'scene_1', buildShotPlan(4));
      timeline = splitSegmentIntoShots(timeline, 'scene_2', buildShotPlan(3));
      // Fill scene_2 so we can observe its layers aren't disturbed.
      for (let n = 1; n <= 3; n++) {
        timeline = fillShot(timeline, `scene_2_shot_${n}`, `s2_vid_${n}`);
      }
      const scene2BeforeIds = getShotIds(timeline, 'scene_2');

      const result = upsertSceneShots(timeline, 'scene_1', buildShotPlan(2));

      expect(getShotIds(result.timeline, 'scene_1')).toEqual([
        'scene_1_shot_1',
        'scene_1_shot_2',
      ]);
      // scene_2's IDs are unchanged.
      expect(getShotIds(result.timeline, 'scene_2')).toEqual(scene2BeforeIds);
      // scene_2_shot_2 still filled with its original artifact.
      const s2shot2 = result.timeline.segments.find(s => s.id === 'scene_2_shot_2')!;
      expect(s2shot2.fillStatus).toBe('filled');
      expect(s2shot2.layers[0]?.artifactId).toBe('s2_vid_2');
    });
  });

  describe('shrink_filled — 9 → 6 with sparse fills (asked 2026-05-19)', () => {
    it('preserves filled shots 1-6 by shotNumber, drops 7-9, leaves new gaps unfilled', () => {
      let timeline = createTimelineSkeleton(45, [{ id: 'scene_1', label: 'Scene 1' }]);
      timeline = splitSegmentIntoShots(timeline, 'scene_1', buildShotPlan(9, 5)); // 9 × 5s
      // Sparse fills: 1, 2, 4, 5, 6, 7, 8 filled; 3 and 9 unfilled.
      for (const n of [1, 2, 4, 5, 6, 7, 8]) {
        timeline = fillShot(timeline, `scene_1_shot_${n}`, `vid_${n}`);
      }

      const result = upsertSceneShots(timeline, 'scene_1', buildShotPlan(6, 5));

      // Exactly 6 segments.
      expect(getShotIds(result.timeline, 'scene_1')).toEqual([
        'scene_1_shot_1',
        'scene_1_shot_2',
        'scene_1_shot_3',
        'scene_1_shot_4',
        'scene_1_shot_5',
        'scene_1_shot_6',
      ]);
      // Surviving fills carry over by index.
      for (const n of [1, 2, 4, 5, 6]) {
        const seg = result.timeline.segments.find(s => s.id === `scene_1_shot_${n}`)!;
        expect(seg.fillStatus).toBe('filled');
        expect(seg.layers[0]?.artifactId).toBe(`vid_${n}`);
      }
      // Shot 3 was unfilled in old plan; stays unfilled in new plan.
      const shot3 = result.timeline.segments.find(s => s.id === 'scene_1_shot_3')!;
      expect(shot3.fillStatus).not.toBe('filled');
      // Old fills for shots 7-9 are dropped (segments gone). The MP4s on
      // disk are orphaned (we don't delete files; the user does that).
      expect(
        result.timeline.segments.find(s => s.id === 'scene_1_shot_7'),
      ).toBeUndefined();
      expect(
        result.timeline.segments.find(s => s.id === 'scene_1_shot_8'),
      ).toBeUndefined();
      expect(
        result.timeline.segments.find(s => s.id === 'scene_1_shot_9'),
      ).toBeUndefined();
      // totalDuration reflects the new 6-shot plan (6 × 5s).
      expect(result.timeline.totalDuration).toBe(30);
    });
  });

  describe('drop_all — new plan is empty (no shots)', () => {
    it('removes every shot for that scene', () => {
      let timeline = createTimelineSkeleton(20, [{ id: 'scene_1', label: 'Scene 1' }]);
      timeline = splitSegmentIntoShots(timeline, 'scene_1', buildShotPlan(4));
      for (let n = 1; n <= 4; n++) {
        timeline = fillShot(timeline, `scene_1_shot_${n}`, `vid_${n}`);
      }

      const result = upsertSceneShots(timeline, 'scene_1', []);

      expect(getShotIds(result.timeline, 'scene_1')).toEqual([]);
    });
  });
});
