/**
 * TDD tests for `enforceSceneBoundaryTransition`. Failure modes
 * (real things that happen and warrant correction or non-action):
 *
 *   FM1.  continuityRole='entry' + transition='cut' → forced to 'fade'.
 *         (The Soft Seinen scene 2 shot 1 case.)
 *
 *   FM2.  continuityRole='entry' + transition='fade' → unchanged.
 *         LLM already picked the right value.
 *
 *   FM3.  continuityRole='entry' + transition='dip_to_black' → unchanged.
 *         A more dramatic but still valid scene-boundary transition.
 *
 *   FM4.  continuityRole='entry' + transition='crossfade' → unchanged.
 *         The LLM picking crossfade for an entry is a legitimate soft
 *         transition; only `cut` is the default-we-correct case.
 *
 *   FM5.  continuityRole='none' + transition='cut' → unchanged.
 *         Default within-scene cut; the guide endorses this.
 *
 *   FM6.  continuityRole='bridge' + transition='cut' → unchanged.
 *         Bridge shots are an in-scene mechanism; out of scope for the
 *         scene-boundary rule.
 *
 *   FM7.  continuityRole='exit' + transition='cut' → unchanged.
 *         Exit IS the last shot of a scene; its `transition` describes
 *         coming FROM the previous within-scene shot. Not a boundary.
 *
 *   FM8.  missing continuityRole → unchanged.
 *
 *   FM9.  missing transition → unchanged.
 *         (LLM omission. Surface as a validation issue separately.)
 *
 *   FM10. Empty shots array → no-op, returns empty change log.
 *
 *   FM11. Idempotency: running twice produces the same result and the
 *         second run reports no changes.
 *
 *   FM12. Multiple entry shots in one scene array (e.g. shot 1 entry +
 *         shot 5 entry for an in-scene location shift) → both are
 *         normalized.
 *
 *   FM13. The change log carries shotNumber + from + to so executor.log
 *         can render "[scene-boundary-transition] shot N: cut→fade".
 */
import { describe, expect, it } from 'vitest';
import {
  enforceSceneBoundaryTransition,
  DEFAULT_ENTRY_TRANSITION,
  type BoundaryShotForNormalization,
} from '../../src/core/planner/enforceSceneBoundaryTransition.js';

describe('enforceSceneBoundaryTransition', () => {
  it('FM1: continuityRole=entry + transition=cut → forced to fade', () => {
    const shots = [
      { shotNumber: 1, continuityRole: 'entry', transition: 'cut' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(shots[0]!.transition).toBe('fade');
    expect(changes).toEqual([{ shotNumber: 1, from: 'cut', to: 'fade' }]);
  });

  it('FM2: continuityRole=entry + transition=fade → unchanged', () => {
    const shots = [
      { shotNumber: 1, continuityRole: 'entry', transition: 'fade' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(shots[0]!.transition).toBe('fade');
    expect(changes).toEqual([]);
  });

  it('FM3: continuityRole=entry + transition=dip_to_black → unchanged', () => {
    const shots = [
      { shotNumber: 1, continuityRole: 'entry', transition: 'dip_to_black' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(shots[0]!.transition).toBe('dip_to_black');
    expect(changes).toEqual([]);
  });

  it('FM4: continuityRole=entry + transition=crossfade → unchanged (legit soft)', () => {
    const shots = [
      { shotNumber: 1, continuityRole: 'entry', transition: 'crossfade' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(shots[0]!.transition).toBe('crossfade');
    expect(changes).toEqual([]);
  });

  it('FM5: continuityRole=none + transition=cut → unchanged (within-scene default)', () => {
    const shots = [
      { shotNumber: 2, continuityRole: 'none', transition: 'cut' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(shots[0]!.transition).toBe('cut');
    expect(changes).toEqual([]);
  });

  it('FM6: continuityRole=bridge + transition=cut → unchanged (out of scope)', () => {
    const shots = [
      { shotNumber: 4, continuityRole: 'bridge', transition: 'cut' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(shots[0]!.transition).toBe('cut');
    expect(changes).toEqual([]);
  });

  it('FM7: continuityRole=exit + transition=cut → unchanged (last shot, within-scene)', () => {
    const shots = [
      { shotNumber: 7, continuityRole: 'exit', transition: 'cut' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(shots[0]!.transition).toBe('cut');
    expect(changes).toEqual([]);
  });

  it('FM8: missing continuityRole → unchanged', () => {
    const shots = [{ shotNumber: 1, transition: 'cut' }];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(shots[0]!.transition).toBe('cut');
    expect(changes).toEqual([]);
  });

  it('FM9: continuityRole=entry but missing transition → unchanged (separate validation)', () => {
    const shots: BoundaryShotForNormalization[] = [
      { shotNumber: 1, continuityRole: 'entry' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(shots[0]!.transition).toBeUndefined();
    expect(changes).toEqual([]);
  });

  it('FM10: empty shots array → no-op', () => {
    const changes = enforceSceneBoundaryTransition([]);
    expect(changes).toEqual([]);
  });

  it('FM11: idempotency — second run reports no changes', () => {
    const shots = [
      { shotNumber: 1, continuityRole: 'entry', transition: 'cut' },
      { shotNumber: 2, continuityRole: 'none', transition: 'cut' },
    ];
    const first = enforceSceneBoundaryTransition(shots);
    expect(first).toHaveLength(1);
    const second = enforceSceneBoundaryTransition(shots);
    expect(second).toEqual([]);
    expect(shots[0]!.transition).toBe('fade');
    expect(shots[1]!.transition).toBe('cut');
  });

  it('FM12: multiple entry shots in one scene array → all normalized', () => {
    const shots = [
      { shotNumber: 1, continuityRole: 'entry', transition: 'cut' },
      { shotNumber: 2, continuityRole: 'none', transition: 'cut' },
      { shotNumber: 3, continuityRole: 'none', transition: 'cut' },
      { shotNumber: 4, continuityRole: 'entry', transition: 'cut' },
      { shotNumber: 5, continuityRole: 'none', transition: 'cut' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(changes.map(c => c.shotNumber)).toEqual([1, 4]);
    expect(shots[0]!.transition).toBe('fade');
    expect(shots[3]!.transition).toBe('fade');
    expect(shots[1]!.transition).toBe('cut');
    expect(shots[2]!.transition).toBe('cut');
    expect(shots[4]!.transition).toBe('cut');
  });

  it('FM13: change log carries shotNumber + from + to for executor.log', () => {
    const shots = [
      { shotNumber: 5, continuityRole: 'entry', transition: 'cut' },
    ];
    const changes = enforceSceneBoundaryTransition(shots);
    expect(changes[0]).toEqual({ shotNumber: 5, from: 'cut', to: 'fade' });
  });

  it('DEFAULT_ENTRY_TRANSITION is fade (the conservative cinematic default)', () => {
    expect(DEFAULT_ENTRY_TRANSITION).toBe('fade');
  });
});
