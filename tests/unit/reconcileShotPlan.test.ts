/**
 * Tests for `reconcileShotPlan.ts` — the pure-function helpers that drive
 * per-shot graph reconciliation when scene_shot_plan re-runs with a
 * different shot count.
 */
import { describe, it, expect } from 'vitest';
import {
  diffShotPlanAgainstGraph,
  perShotNodeIds,
  planShotNumbersFromJson,
  PER_SHOT_NODE_TYPES,
} from '../../src/core/planner/reconcileShotPlan.js';

describe('diffShotPlanAgainstGraph', () => {
  it('returns empty stale/missing when graph matches plan exactly', () => {
    const diff = diffShotPlanAgainstGraph(new Set([1, 2, 3]), new Set([1, 2, 3]));
    expect(diff.stale).toEqual([]);
    expect(diff.missing).toEqual([]);
  });

  it('flags shots that exist in the graph but not the plan as stale', () => {
    // Real-world: plan shrunk from 8 shots to 7 on redo.
    const planShots = new Set([1, 2, 3, 4, 5, 6, 7]);
    const graphShots = new Set([1, 2, 3, 4, 5, 6, 7, 8]);
    const diff = diffShotPlanAgainstGraph(planShots, graphShots);
    expect(diff.stale).toEqual([8]);
    expect(diff.missing).toEqual([]);
  });

  it('flags shots in the plan but not the graph as missing', () => {
    // Plan grew from 5 shots to 7.
    const planShots = new Set([1, 2, 3, 4, 5, 6, 7]);
    const graphShots = new Set([1, 2, 3, 4, 5]);
    const diff = diffShotPlanAgainstGraph(planShots, graphShots);
    expect(diff.stale).toEqual([]);
    expect(diff.missing).toEqual([6, 7]);
  });

  it('handles non-contiguous shot numbers in both directions', () => {
    const planShots = new Set([1, 3, 5, 7]);
    const graphShots = new Set([1, 2, 4, 5, 8]);
    const diff = diffShotPlanAgainstGraph(planShots, graphShots);
    expect(diff.stale).toEqual([2, 4, 8]);
    expect(diff.missing).toEqual([3, 7]);
  });

  it('returns sorted arrays even when input Sets iterate out of order', () => {
    // Set iteration order is insertion-order; deliberately insert
    // out-of-order to verify the diff sorts.
    const planShots = new Set([3, 1, 5]);
    const graphShots = new Set([8, 2, 4]);
    const diff = diffShotPlanAgainstGraph(planShots, graphShots);
    expect(diff.stale).toEqual([2, 4, 8]);
    expect(diff.missing).toEqual([1, 3, 5]);
  });
});

describe('perShotNodeIds', () => {
  it('returns one node id per per-shot type, all with the same itemId', () => {
    const ids = perShotNodeIds('scene_1', 8);
    expect(ids).toHaveLength(PER_SHOT_NODE_TYPES.length);
    for (const id of ids) {
      expect(id.endsWith(':scene_1_shot_8')).toBe(true);
    }
  });

  it('covers the full per-shot chain — caller can rely on a single pass to remove orphans', () => {
    const ids = perShotNodeIds('scene_2', 1);
    expect(new Set(ids)).toEqual(
      new Set([
        'shot_breakdown:scene_2_shot_1',
        'shot_image_prompt:scene_2_shot_1',
        'shot_image:scene_2_shot_1',
        'shot_image_last_frame:scene_2_shot_1',
        'shot_motion_directive:scene_2_shot_1',
        'shot_video:scene_2_shot_1',
      ]),
    );
  });
});

describe('planShotNumbersFromJson', () => {
  it('extracts shotNumbers from a well-formed plan', () => {
    const plan = {
      sceneNumber: 1,
      shotPlan: [
        { shotNumber: 1, duration: 4 },
        { shotNumber: 2, duration: 5 },
        { shotNumber: 3, duration: 3 },
      ],
    };
    expect(Array.from(planShotNumbersFromJson(plan)).sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('returns an empty Set for non-object input — caller must treat this as "no plan, skip reconcile"', () => {
    expect(planShotNumbersFromJson(null)).toEqual(new Set());
    expect(planShotNumbersFromJson('not a plan')).toEqual(new Set());
    expect(planShotNumbersFromJson(42)).toEqual(new Set());
  });

  it('returns an empty Set when shotPlan is missing or non-array', () => {
    expect(planShotNumbersFromJson({})).toEqual(new Set());
    expect(planShotNumbersFromJson({ shotPlan: null })).toEqual(new Set());
    expect(planShotNumbersFromJson({ shotPlan: 'oops' })).toEqual(new Set());
  });

  it('skips plan entries with missing / non-integer / non-positive shotNumbers', () => {
    const plan = {
      shotPlan: [
        { shotNumber: 1 },
        { shotNumber: '2' }, // string, skipped
        { shotNumber: 0 }, // non-positive, skipped
        { shotNumber: -3 }, // negative, skipped
        { shotNumber: 1.5 }, // non-integer, skipped
        { shotNumber: 4 },
        { /* missing */ },
      ],
    };
    expect(Array.from(planShotNumbersFromJson(plan)).sort((a, b) => a - b)).toEqual([1, 4]);
  });
});
