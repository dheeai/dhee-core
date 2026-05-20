import { describe, it, expect } from 'vitest';
import {
  findBlockingFailures,
  shouldAwaitPendingMediaOnExit,
} from '../../src/core/planner/executorTermination.js';
import type { ExecutionNode } from '../../src/core/planner/types.js';

function node(overrides: Partial<ExecutionNode>): ExecutionNode {
  return {
    id: overrides.id ?? 'x',
    typeId: overrides.typeId ?? 'plot',
    displayName: overrides.displayName ?? 'X',
    status: overrides.status ?? 'pending',
    dependencies: overrides.dependencies ?? [],
    dependents: overrides.dependents ?? [],
    ...overrides,
  } as ExecutionNode;
}

describe('findBlockingFailures', () => {
  it('GIVEN a failed node with a pending dependent WHEN scanning THEN returns the failed node as a blocker', () => {
    // Mirrors today's bug: shot_image_prompt:shot_9 failed,
    // shot_motion_directive:shot_9 is pending — that pair is what
    // causes the serial-mode "deadlock" 6 seconds later.
    const failed = node({
      id: 'shot_image_prompt:shot_9',
      displayName: 'Shot Composition: shot_9',
      status: 'failed',
      error: 'Invalid JSON output after retry: ...',
      dependents: ['shot_motion_directive:shot_9'],
    });
    const pending = node({
      id: 'shot_motion_directive:shot_9',
      status: 'pending',
      dependencies: ['shot_image_prompt:shot_9'],
    });

    const blockers = findBlockingFailures([failed, pending]);

    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.id).toBe('shot_image_prompt:shot_9');
  });

  it('GIVEN a failed node whose dependents are all completed WHEN scanning THEN returns no blocker (failure no longer blocks anything)', () => {
    const failed = node({
      id: 'plot',
      status: 'failed',
      dependents: ['story'],
    });
    const downstream = node({
      id: 'story',
      status: 'completed',
      dependencies: ['plot'],
    });

    expect(findBlockingFailures([failed, downstream])).toEqual([]);
  });

  it('GIVEN no failed nodes WHEN scanning THEN returns an empty array', () => {
    const a = node({ id: 'a', status: 'completed' });
    const b = node({ id: 'b', status: 'pending', dependencies: ['a'] });
    expect(findBlockingFailures([a, b])).toEqual([]);
  });

  it('GIVEN a failed node whose dependents are themselves failed or skipped WHEN scanning THEN returns no blocker (cascade already propagated)', () => {
    const failed = node({
      id: 'a',
      status: 'failed',
      dependents: ['b', 'c'],
    });
    const cascadedFail = node({ id: 'b', status: 'failed', dependencies: ['a'] });
    const skipped = node({ id: 'c', status: 'skipped', dependencies: ['a'] });
    expect(findBlockingFailures([failed, cascadedFail, skipped])).toEqual([]);
  });

  it('GIVEN multiple failed nodes WHEN some have pending dependents and some do not THEN returns only the ones still blocking', () => {
    const blockingFailed = node({
      id: 'shot_image_prompt:shot_9',
      status: 'failed',
      dependents: ['shot_motion_directive:shot_9'],
    });
    const downstreamPending = node({
      id: 'shot_motion_directive:shot_9',
      status: 'pending',
      dependencies: ['shot_image_prompt:shot_9'],
    });
    const harmlessFailed = node({
      id: 'orphaned_node',
      status: 'failed',
      dependents: [],
    });

    const blockers = findBlockingFailures([
      blockingFailed,
      downstreamPending,
      harmlessFailed,
    ]);

    expect(blockers.map(n => n.id)).toEqual(['shot_image_prompt:shot_9']);
  });

  it('GIVEN a dependent id that does not exist in the node list WHEN scanning THEN does not throw and ignores the dangling reference', () => {
    const failed = node({
      id: 'a',
      status: 'failed',
      dependents: ['ghost_id_not_in_list'],
    });
    expect(findBlockingFailures([failed])).toEqual([]);
  });
});

describe('shouldAwaitPendingMediaOnExit', () => {
  it('GIVEN stopReason=failed WHEN deciding THEN returns false (skip the await — risk of hanging on stuck media)', () => {
    expect(shouldAwaitPendingMediaOnExit('failed')).toBe(false);
  });

  it('GIVEN stopReason=cancelled WHEN deciding THEN returns false (user already aborted, nothing to drain)', () => {
    expect(shouldAwaitPendingMediaOnExit('cancelled')).toBe(false);
  });

  it('GIVEN stopReason=complete WHEN deciding THEN returns true (drain so the final summary reflects all completed work)', () => {
    expect(shouldAwaitPendingMediaOnExit('complete')).toBe(true);
  });

  it('GIVEN stopReason=paused_at_stage WHEN deciding THEN returns true (stage gate is a clean pause, drain in-flight cleanly)', () => {
    expect(shouldAwaitPendingMediaOnExit('paused_at_stage')).toBe(true);
  });

  it('GIVEN stopReason=null (loop exited naturally without setting one) WHEN deciding THEN returns true (treat as complete)', () => {
    expect(shouldAwaitPendingMediaOnExit(null)).toBe(true);
  });
});
