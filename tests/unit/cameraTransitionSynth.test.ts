/**
 * GIVEN a scene whose shots have been anchored (continuity / view_reuse / fresh)
 * WHEN synthesizeCameraTransitions runs
 * THEN cameraWork on every continuity-anchored shot is prepended with a
 *   smooth-movement verb whenever its camera position has shifted from
 *   the anchor source. `fresh` and `view_reuse` shots are left alone.
 */
import { describe, it, expect } from 'vitest';
import { synthesizeCameraTransitions } from '../../src/core/planner/cameraTransitionSynth.js';

describe('synthesizeCameraTransitions — perspective shifts', () => {
  it('main_subject → overhead prepends "slow tilt up and pull back to "', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'close-up, eye level',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'overhead', cameraWork: 'high angle, looking down',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    const patches = synthesizeCameraTransitions(shots);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.shotNumber).toBe(2);
    expect(patches[0]!.reason).toBe('perspective_shift');
    expect(shots[1]!.cameraWork).toBe('slow tilt up and pull back to high angle, looking down');
  });

  it('main_subject → secondary_subject prepends "reverse to "', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'medium on Parvati',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'secondary_subject', cameraWork: 'medium on Isha',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    synthesizeCameraTransitions(shots);
    expect(shots[1]!.cameraWork).toBe('reverse to medium on Isha');
  });

  it('observer → main_subject prepends "push in to "', () => {
    const shots = [
      { shotNumber: 1, perspective: 'observer', cameraWork: 'wide, both characters in frame',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'main_subject', cameraWork: 'close on Parvati\'s face',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    synthesizeCameraTransitions(shots);
    expect(shots[1]!.cameraWork.startsWith('push in to ')).toBe(true);
  });
});

describe('synthesizeCameraTransitions — framing shifts (same perspective)', () => {
  it('wide → extreme close-up prepends a focus-and-push transition', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'wide establishing of the bell',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'main_subject', cameraWork: 'extreme close-up on raindrops striking the bell',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    const patches = synthesizeCameraTransitions(shots);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.reason).toBe('framing_shift');
    expect(shots[1]!.cameraWork.startsWith('rack focus and push-in to ')).toBe(true);
  });

  it('medium → close prepends "slight push-in to "', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'medium shot, side angle',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'main_subject', cameraWork: 'close-up, slight low angle',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    synthesizeCameraTransitions(shots);
    expect(shots[1]!.cameraWork.startsWith('slight push-in to ')).toBe(true);
  });

  it('close → wide prepends "pull back to "', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'close-up on face',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'main_subject', cameraWork: 'wide establishing of the room',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    synthesizeCameraTransitions(shots);
    expect(shots[1]!.cameraWork.startsWith('pull back to ')).toBe(true);
  });
});

describe('synthesizeCameraTransitions — leave-alone cases', () => {
  it('fresh anchor (deliberate reset) is NEVER patched', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'close-up',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'overhead', cameraWork: 'high angle',
        firstFrameAnchor: { reason: 'fresh' as const } }, // explicit reset
    ];
    const before = shots[1]!.cameraWork;
    const patches = synthesizeCameraTransitions(shots);
    expect(patches).toHaveLength(0);
    expect(shots[1]!.cameraWork).toBe(before);
  });

  it('view_reuse anchor is NEVER patched (cutting back to a familiar view)', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'wide',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'main_subject', cameraWork: 'close-up',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
      { shotNumber: 3, perspective: 'main_subject', cameraWork: 'wide',
        firstFrameAnchor: { reason: 'view_reuse' as const, sourceShotNumber: 1 } },
    ];
    const before = shots[2]!.cameraWork;
    synthesizeCameraTransitions(shots);
    expect(shots[2]!.cameraWork).toBe(before);
  });

  it('same perspective + same framing class → not patched', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'medium shot, side angle',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'main_subject', cameraWork: 'medium, slight push-in',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    const before = shots[1]!.cameraWork;
    synthesizeCameraTransitions(shots);
    expect(shots[1]!.cameraWork).toBe(before);
  });

  it('cameraWork already starts with a transition verb → not double-patched (idempotency)', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'wide',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'main_subject', cameraWork: 'slow push-in to close-up on face',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    const before = shots[1]!.cameraWork;
    synthesizeCameraTransitions(shots);
    expect(shots[1]!.cameraWork).toBe(before);
  });

  it('unknown framing class on either side → not patched (avoid clobbering hand-written prose)', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'drone aerial pull-back',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'main_subject', cameraWork: 'handheld follow shot',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    const before = shots[1]!.cameraWork;
    synthesizeCameraTransitions(shots);
    expect(shots[1]!.cameraWork).toBe(before);
  });
});

describe('synthesizeCameraTransitions — patch report', () => {
  it('returns a patch entry per modified shot with before/after/reason', () => {
    const shots = [
      { shotNumber: 1, perspective: 'main_subject', cameraWork: 'wide',
        firstFrameAnchor: { reason: 'fresh' as const } },
      { shotNumber: 2, perspective: 'overhead', cameraWork: 'high angle',
        firstFrameAnchor: { reason: 'continuity' as const, sourceShotNumber: 1 } },
    ];
    const patches = synthesizeCameraTransitions(shots);
    expect(patches).toEqual([
      {
        shotNumber: 2,
        before: 'high angle',
        after: expect.stringMatching(/^slow tilt up/),
        reason: 'perspective_shift',
      },
    ]);
  });
});
