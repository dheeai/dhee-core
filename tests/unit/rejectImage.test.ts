/**
 * TDD Tests for user image rejection.
 *
 * When a user rejects a generated image:
 * 1. The image node gets invalidated (reset to pending)
 * 2. All downstream dependents get cascaded to pending
 * 3. The executor re-runs and regenerates that node only
 */

import { describe, it, expect } from 'vitest';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import type { ExecutionNode, ExecutorState } from '../../src/core/planner/types.js';

function node(id: string, deps: string[], dependents: string[], opts: Partial<ExecutionNode> = {}): ExecutionNode {
  return {
    id,
    typeId: id.split(':')[0],
    itemId: id.includes(':') ? id.split(':')[1] : undefined,
    status: 'pending',
    dependencies: deps,
    dependents,
    isCollection: false,
    ...opts,
  };
}

function buildExecutor(nodes: Record<string, ExecutionNode>): DependencyGraphExecutor {
  const state: ExecutorState = {
    nodes,
    targetArtifacts: [],
    goalDescription: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  // Use a minimal template-like object
  return DependencyGraphExecutor.fromState(state, { artifactTypes: {} } as any);
}

describe('User image rejection: cascade invalidation', () => {
  it('rejecting character_image resets it and downstream shot_image + shot_video', () => {
    const executor = buildExecutor({
      'character_image:kai': node('character_image:kai', [], ['shot_image:scene_1_shot_1'], { status: 'completed', outputPath: 'assets/images/characters/kai.png' }),
      'shot_image:scene_1_shot_1': node('shot_image:scene_1_shot_1', ['character_image:kai'], ['shot_video:scene_1_shot_1'], { status: 'completed', outputPath: 'assets/images/shots/s1s1.png' }),
      'shot_video:scene_1_shot_1': node('shot_video:scene_1_shot_1', ['shot_image:scene_1_shot_1'], [], { status: 'completed', outputPath: 'assets/videos/shots/s1s1.mp4' }),
    });

    const invalidated = executor.invalidateNode('character_image:kai');

    expect(executor.getNode('character_image:kai')?.status).toBe('pending');
    expect(executor.getNode('shot_image:scene_1_shot_1')?.status).toBe('pending');
    expect(executor.getNode('shot_video:scene_1_shot_1')?.status).toBe('pending');
    expect(invalidated.length).toBe(3);
  });

  it('rejecting shot_image resets only that shot, not other shots', () => {
    const executor = buildExecutor({
      'shot_image:scene_1_shot_1': node('shot_image:scene_1_shot_1', [], ['shot_video:scene_1_shot_1'], { status: 'completed' }),
      'shot_video:scene_1_shot_1': node('shot_video:scene_1_shot_1', ['shot_image:scene_1_shot_1'], [], { status: 'completed' }),
      'shot_image:scene_1_shot_2': node('shot_image:scene_1_shot_2', [], ['shot_video:scene_1_shot_2'], { status: 'completed' }),
      'shot_video:scene_1_shot_2': node('shot_video:scene_1_shot_2', ['shot_image:scene_1_shot_2'], [], { status: 'completed' }),
    });

    executor.invalidateNode('shot_image:scene_1_shot_1');

    expect(executor.getNode('shot_image:scene_1_shot_1')?.status).toBe('pending');
    expect(executor.getNode('shot_video:scene_1_shot_1')?.status).toBe('pending');
    expect(executor.getNode('shot_image:scene_1_shot_2')?.status).toBe('completed');
    expect(executor.getNode('shot_video:scene_1_shot_2')?.status).toBe('completed');
  });

  it('after rejection, getNextReady returns the invalidated node', () => {
    const executor = buildExecutor({
      'character_image:kai': node('character_image:kai', [], ['shot_image:scene_1_shot_1'], { status: 'completed' }),
      'shot_image:scene_1_shot_1': node('shot_image:scene_1_shot_1', ['character_image:kai'], [], { status: 'completed' }),
    });

    executor.invalidateNode('character_image:kai');

    const ready = executor.getNextReady().map(n => n.id);
    expect(ready).toContain('character_image:kai');
    expect(ready).not.toContain('shot_image:scene_1_shot_1'); // blocked by pending dep
  });
});

