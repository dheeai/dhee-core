/**
 * Tests for the `onMutation` callback added to DependencyGraphExecutor.
 *
 * Why this exists: today's `expandCollection()` does not call
 * persistState() — a process killed between collection expansion and
 * the first per-item completion lost the per-item nodes from disk.
 * On restart, Strategy A finds nothing and falls through to LLM
 * extraction (Strategy C), which is non-deterministic and produces a
 * different number of items than the first run.
 *
 * Fix: a single executor-level `onMutation` callback that fires after
 * every public mutation method. ExecutorAgent wires it to
 * persistState(). The 22 manual persistState() calls scattered through
 * ExecutorAgent become belt-and-suspenders; new mutation sites cannot
 * forget to persist.
 *
 * The watchdog test below asserts the in-memory state observed at
 * callback invocation matches the executor's getState() output, which
 * is what gets persisted to disk.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import { BackwardPlanner } from '../../src/core/planner/BackwardPlanner.js';
import type { VideoTemplate } from '../../src/core/templates/types.js';
import type { AssetRegistry, ExecutorState, UserGoal } from '../../src/core/planner/types.js';

// Minimal template for callback tests — same shape as the main
// DependencyGraphExecutor.test.ts, just inlined to keep this file
// self-contained.
const minimalTemplate = (): VideoTemplate => ({
  id: 'cb_test',
  displayName: 'CB Test',
  description: 'Persistence callback test template',
  version: '1.0.0',
  defaultStyle: 'default',
  styles: [{ id: 'default', displayName: 'D', description: 'D', promptModifiers: [], negativePrompt: [] }],
  inputTypes: [{ id: 'idea', displayName: 'I', description: '', examples: [], skipsArtifacts: [], mapsToArtifact: 'plot' }],
  artifactTypes: {
    plot: {
      id: 'plot', displayName: 'Plot', category: 'concept', description: '',
      isCollection: false, outputFormat: 'markdown', filePattern: 'plot.md',
      agentType: 'planning', promptFile: 'p.md', isExpensive: false,
      requiresPerItemApproval: false, dependencies: [],
    },
    story: {
      id: 'story', displayName: 'Story', category: 'structure', description: '',
      isCollection: false, outputFormat: 'markdown', filePattern: 'story.md',
      agentType: 'content', promptFile: 's.md', isExpensive: false,
      requiresPerItemApproval: false,
      dependencies: [{ artifactTypeId: 'plot', required: true, usage: 'context' }],
    },
    character: {
      id: 'character', displayName: 'Characters', category: 'entity', description: '',
      isCollection: true, itemName: 'character', outputFormat: 'markdown',
      filePattern: 'characters/{{name}}.md', agentType: 'content', promptFile: 'c.md',
      isExpensive: false, requiresPerItemApproval: false,
      dependencies: [{ artifactTypeId: 'story', required: true, usage: 'context' }],
    },
  },
  phases: [],
  contextVariables: { $plot: 'plot', $story: 'story' },
  orchestratorPrompt: 'orchestrator.md',
});

const emptyRegistry = (): AssetRegistry => ({
  assets: new Map(),
  satisfiedArtifacts: new Map(),
  lastScanAt: Date.now(),
});

function buildExecutor(): DependencyGraphExecutor {
  const t = minimalTemplate();
  const planner = new BackwardPlanner(t);
  const goal: UserGoal = { targetArtifacts: ['character'], preferences: {}, description: 'test' };
  const plan = planner.buildPlan(goal, emptyRegistry());
  return DependencyGraphExecutor.fromPlan(plan, t);
}

describe('DependencyGraphExecutor.setOnMutation', () => {
  let executor: DependencyGraphExecutor;
  let calls: number;
  let lastSnapshot: ExecutorState | null;

  beforeEach(() => {
    executor = buildExecutor();
    calls = 0;
    lastSnapshot = null;
    executor.setOnMutation(() => {
      calls += 1;
      lastSnapshot = executor.getState();
    });
  });

  it('fires after markStarted', () => {
    executor.markStarted('plot');
    expect(calls).toBe(1);
    expect(lastSnapshot!.nodes['plot']!.status).toBe('in_progress');
  });

  it('fires after markCompleted', () => {
    executor.markStarted('plot');
    executor.markCompleted('plot', 'plot.md');
    expect(calls).toBe(2);
    expect(lastSnapshot!.nodes['plot']!.status).toBe('completed');
    expect(lastSnapshot!.nodes['plot']!.outputPath).toBe('plot.md');
  });

  it('fires after markFailed and the snapshot carries the error', () => {
    executor.markStarted('plot');
    executor.markFailed('plot', 'LLM timeout');
    expect(calls).toBe(2);
    expect(lastSnapshot!.nodes['plot']!.status).toBe('failed');
    expect(lastSnapshot!.nodes['plot']!.error).toBe('LLM timeout');
  });

  it('fires after invalidateNode (the redo path that motivated this)', () => {
    executor.markStarted('plot');
    executor.markCompleted('plot', 'plot.md');
    calls = 0;
    executor.invalidateNode('plot', { cascade: false });
    expect(calls).toBe(1);
    expect(lastSnapshot!.nodes['plot']!.status).toBe('pending');
  });

  it('fires after expandCollection — the bug that lost work today', () => {
    // Pre-conditions: complete plot+story so character can expand
    executor.markStarted('plot');
    executor.markCompleted('plot', 'plot.md');
    executor.markStarted('story');
    executor.markCompleted('story', 'story.md');
    calls = 0;
    executor.expandCollection('character', [
      { itemId: 'jan', name: 'Jan' },
      { itemId: 'bishwa', name: 'Bishwa' },
    ]);
    expect(calls).toBe(1);
    // Per-item nodes appear in the persisted snapshot.
    expect(lastSnapshot!.nodes['character:jan']).toBeDefined();
    expect(lastSnapshot!.nodes['character:bishwa']).toBeDefined();
  });

  it('fires after addNode', () => {
    calls = 0;
    executor.addNode({
      id: 'character:custom',
      typeId: 'character',
      itemId: 'custom',
      status: 'pending',
      displayName: 'Character: Custom',
      isExpensive: false,
      isCollection: false,
      dependencies: ['story'],
      dependents: [],
    });
    expect(calls).toBe(1);
    expect(lastSnapshot!.nodes['character:custom']).toBeDefined();
  });

  it('does not fire when the callback was unset (idempotent / opt-out)', () => {
    executor.setOnMutation(undefined);
    executor.markStarted('plot');
    expect(calls).toBe(0);
  });

  it('does not fire when a mutation throws (e.g. unknown node id)', () => {
    expect(() => executor.markStarted('nonexistent')).toThrow();
    expect(calls).toBe(0);
  });

  it('callbacks are sticky across factory boundaries — fromState rehydration keeps no callback by default', () => {
    executor.markStarted('plot');
    const state = executor.getState();
    const restored = DependencyGraphExecutor.fromState(state, minimalTemplate());
    let restoredCalls = 0;
    restored.setOnMutation(() => { restoredCalls += 1; });
    restored.markCompleted('plot', 'plot.md');
    expect(restoredCalls).toBe(1);
  });
});

describe('ExecutionNode.metadata — round-trip', () => {
  it('persists name + summary metadata through getState/fromState', () => {
    const executor = buildExecutor();
    executor.markStarted('plot');
    executor.markCompleted('plot', 'plot.md');

    // Mutate metadata directly on the node — the executor exposes a node
    // accessor; metadata is just a property on the ExecutionNode shape.
    // Note: approval / regeneration / feedback fields are intentionally
    // NOT in the ExecutionNodeMetadata shape; pi-agent owns the
    // approval domain, not dhee-core. Don't reintroduce them here.
    const node = executor.getNode('plot')!;
    node.metadata = {
      name: 'My Plot',
      summary: 'a one-line plot summary',
    };

    const state = executor.getState();
    const restored = DependencyGraphExecutor.fromState(state, minimalTemplate());
    const restoredNode = restored.getNode('plot')!;
    expect(restoredNode.metadata).toEqual({
      name: 'My Plot',
      summary: 'a one-line plot summary',
    });
  });

  it('node without metadata round-trips with metadata undefined (not null)', () => {
    const executor = buildExecutor();
    const state = executor.getState();
    const restored = DependencyGraphExecutor.fromState(state, minimalTemplate());
    expect(restored.getNode('plot')!.metadata).toBeUndefined();
  });
});
