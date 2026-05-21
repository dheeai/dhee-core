/**
 * Tests for the graph-hygiene self-heal pass.
 *
 * Three rules under test, plus the "no-op when graph is clean" steady
 * state. The pass is exercised against a real DependencyGraphExecutor
 * with hand-built node maps so the rewire / delete behaviour can be
 * inspected directly.
 */
import { describe, it, expect } from 'vitest';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import {
  reconcileGraphHygiene,
  summariseHygieneResult,
} from '../../src/core/planner/reconcileGraphHygiene.js';
import type { ExecutionNode, ExecutorState } from '../../src/core/planner/types.js';

function node(partial: Partial<ExecutionNode> & { id: string }): ExecutionNode {
  return {
    typeId: partial.id.split(':')[0]!,
    status: 'pending',
    isExpensive: false,
    isCollection: false,
    displayName: partial.id,
    dependencies: [],
    dependents: [],
    ...partial,
  } as ExecutionNode;
}

function buildExecutor(nodes: ExecutionNode[]): DependencyGraphExecutor {
  const byId: Record<string, ExecutionNode> = {};
  for (const n of nodes) byId[n.id] = n;
  const state: ExecutorState = {
    nodes: byId,
    targetArtifacts: [],
    goalDescription: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as ExecutorState;
  return DependencyGraphExecutor.fromState(state, { artifactTypes: {} } as never);
}

describe('reconcileGraphHygiene — Rule A: orphan parent pruning', () => {
  it('deletes a collection parent when per-shot children of the same typeId exist', () => {
    // The Dream-on-redo failure mode: shot_breakdown:scene_1 (parent)
    // lingers after per-shot children 1..8 were already expanded.
    const executor = buildExecutor([
      node({
        id: 'shot_breakdown:scene_1',
        typeId: 'shot_breakdown',
        itemId: 'scene_1',
        isCollection: true,
      }),
      ...[1, 2, 3].map((n) =>
        node({
          id: `shot_breakdown:scene_1_shot_${n}`,
          typeId: 'shot_breakdown',
          itemId: `scene_1_shot_${n}`,
          status: 'completed',
        }),
      ),
    ]);

    const r = reconcileGraphHygiene(executor);

    expect(r.orphanParentsPruned).toEqual(['shot_breakdown:scene_1']);
    expect(executor.getNode('shot_breakdown:scene_1')).toBeUndefined();
    // Children survive untouched.
    for (const n of [1, 2, 3]) {
      expect(executor.getNode(`shot_breakdown:scene_1_shot_${n}`)).toBeDefined();
    }
  });

  it('leaves a collection parent alone when it has NO per-shot children (legitimate pre-expansion state)', () => {
    const executor = buildExecutor([
      node({
        id: 'shot_breakdown:scene_2',
        typeId: 'shot_breakdown',
        itemId: 'scene_2',
        isCollection: true,
      }),
    ]);

    const r = reconcileGraphHygiene(executor);

    expect(r.orphanParentsPruned).toEqual([]);
    expect(executor.getNode('shot_breakdown:scene_2')).toBeDefined();
  });

  it('does NOT prune per-shot nodes themselves (they look like parents but their itemId ends in _shot_N)', () => {
    // Defensive: the orphan-detection regex must not misfire on a
    // per-shot node that happens to have isCollection=true (shouldn't
    // happen in practice but staying robust to bad inputs).
    const executor = buildExecutor([
      node({
        id: 'shot_breakdown:scene_1_shot_1',
        typeId: 'shot_breakdown',
        itemId: 'scene_1_shot_1',
        isCollection: true, // intentionally wrong, hygiene must not delete
      }),
    ]);
    reconcileGraphHygiene(executor);
    expect(executor.getNode('shot_breakdown:scene_1_shot_1')).toBeDefined();
  });
});

describe('reconcileGraphHygiene — Rule B: rewire parent-as-dep onto children', () => {
  it('swaps a parent dep for the children when a downstream node listed the parent in dependencies[]', () => {
    // Dream's exact failure: scene_video_prompt:scene_1 had
    // shot_breakdown:scene_1 (parent) in its deps; assembler stays
    // blocked until the parent "completes" which never happens.
    const executor = buildExecutor([
      node({
        id: 'shot_breakdown:scene_1',
        typeId: 'shot_breakdown',
        itemId: 'scene_1',
        isCollection: true,
        dependents: ['scene_video_prompt:scene_1'],
      }),
      ...[1, 2].map((n) =>
        node({
          id: `shot_breakdown:scene_1_shot_${n}`,
          typeId: 'shot_breakdown',
          itemId: `scene_1_shot_${n}`,
          status: 'completed',
        }),
      ),
      node({
        id: 'scene_video_prompt:scene_1',
        typeId: 'scene_video_prompt',
        itemId: 'scene_1',
        dependencies: ['shot_breakdown:scene_1', 'scene_shot_plan:scene_1'],
      }),
      node({
        id: 'scene_shot_plan:scene_1',
        typeId: 'scene_shot_plan',
        itemId: 'scene_1',
        status: 'completed',
        dependents: ['scene_video_prompt:scene_1'],
      }),
    ]);

    const r = reconcileGraphHygiene(executor);

    expect(r.parentDepsRewiredCount).toBe(1);
    const svp = executor.getNode('scene_video_prompt:scene_1');
    expect(svp).toBeDefined();
    expect(svp!.dependencies).not.toContain('shot_breakdown:scene_1');
    expect(svp!.dependencies).toContain('shot_breakdown:scene_1_shot_1');
    expect(svp!.dependencies).toContain('shot_breakdown:scene_1_shot_2');
    // The other (non-orphan) dep is preserved.
    expect(svp!.dependencies).toContain('scene_shot_plan:scene_1');
    // The orphan parent itself is gone.
    expect(executor.getNode('shot_breakdown:scene_1')).toBeUndefined();
    // Children now know about the new dependent (bidirectional wiring).
    for (const n of [1, 2]) {
      const child = executor.getNode(`shot_breakdown:scene_1_shot_${n}`);
      expect(child!.dependents).toContain('scene_video_prompt:scene_1');
    }
  });

  it('does not double-add a child dep that the dependent was already wired to', () => {
    // Edge case: scene_video_prompt was wired BOTH to the orphan
    // parent AND to one of its children directly. After rewire, the
    // child dep should appear exactly once.
    const executor = buildExecutor([
      node({
        id: 'shot_breakdown:scene_1',
        typeId: 'shot_breakdown',
        itemId: 'scene_1',
        isCollection: true,
        dependents: ['scene_video_prompt:scene_1'],
      }),
      node({
        id: 'shot_breakdown:scene_1_shot_1',
        typeId: 'shot_breakdown',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        dependents: ['scene_video_prompt:scene_1'],
      }),
      node({
        id: 'scene_video_prompt:scene_1',
        typeId: 'scene_video_prompt',
        itemId: 'scene_1',
        dependencies: [
          'shot_breakdown:scene_1', // orphan parent
          'shot_breakdown:scene_1_shot_1', // child already wired
        ],
      }),
    ]);

    reconcileGraphHygiene(executor);

    const svp = executor.getNode('scene_video_prompt:scene_1');
    const childCount = svp!.dependencies.filter(
      (d) => d === 'shot_breakdown:scene_1_shot_1',
    ).length;
    expect(childCount).toBe(1);
  });
});

describe('reconcileGraphHygiene — Rule C: dangling references', () => {
  it('strips dependencies pointing at ids that no longer exist', () => {
    const executor = buildExecutor([
      node({
        id: 'shot_video:scene_1_shot_1',
        typeId: 'shot_video',
        itemId: 'scene_1_shot_1',
        dependencies: ['shot_image_last_frame:scene_1_shot_1', 'ghost:does_not_exist'],
      }),
      node({
        id: 'shot_image_last_frame:scene_1_shot_1',
        typeId: 'shot_image_last_frame',
        itemId: 'scene_1_shot_1',
        status: 'completed',
      }),
    ]);

    const r = reconcileGraphHygiene(executor);

    expect(r.danglingDepsStripped).toBe(1);
    expect(
      executor.getNode('shot_video:scene_1_shot_1')!.dependencies,
    ).toEqual(['shot_image_last_frame:scene_1_shot_1']);
  });

  it('strips dependents pointing at ids that no longer exist', () => {
    const executor = buildExecutor([
      node({
        id: 'shot_breakdown:scene_1_shot_1',
        typeId: 'shot_breakdown',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        dependents: ['ghost:also_does_not_exist'],
      }),
    ]);

    const r = reconcileGraphHygiene(executor);

    expect(r.danglingDependentsStripped).toBe(1);
    expect(
      executor.getNode('shot_breakdown:scene_1_shot_1')!.dependents,
    ).toEqual([]);
  });
});

describe('reconcileGraphHygiene — no-op on a clean graph', () => {
  it('returns all-zero counts when the graph has no orphans / no dangling refs', () => {
    const executor = buildExecutor([
      node({
        id: 'scene_shot_plan:scene_1',
        typeId: 'scene_shot_plan',
        itemId: 'scene_1',
        status: 'completed',
        dependents: ['shot_breakdown:scene_1_shot_1'],
      }),
      node({
        id: 'shot_breakdown:scene_1_shot_1',
        typeId: 'shot_breakdown',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        dependencies: ['scene_shot_plan:scene_1'],
      }),
    ]);

    const r = reconcileGraphHygiene(executor);

    expect(r).toEqual({
      orphanParentsPruned: [],
      parentDepsRewiredCount: 0,
      danglingDepsStripped: 0,
      danglingDependentsStripped: 0,
      contentToMediaDepsStripped: 0,
    });
  });
});

describe('reconcileGraphHygiene — Rule D: content→media dep edges (serial-mode deadlock guard)', () => {
  // Minimal template fixture. The rule uses categories, not the
  // template's declared dep list — visual_ref / clip / final are
  // "media", everything else is "content". Content nodes depending
  // on media nodes trip serial-mode deadlock.
  const template = {
    artifactTypes: {
      shot_image_prompt: { id: 'shot_image_prompt', category: 'structure', isCollection: true, isExpensive: false, dependencies: [], displayName: 'Shot Composition' },
      scene_video_prompt: { id: 'scene_video_prompt', category: 'structure', isCollection: true, isExpensive: false, dependencies: [], displayName: 'Scene Video Prompt' },
      world_style: { id: 'world_style', category: 'concept', isCollection: false, isExpensive: false, dependencies: [], displayName: 'World Style' },
      character_image: { id: 'character_image', category: 'visual_ref', isCollection: true, isExpensive: true, dependencies: [], displayName: 'Character Image' },
      shot_image: { id: 'shot_image', category: 'visual_ref', isCollection: true, isExpensive: true, dependencies: [], displayName: 'Shot Image' },
    },
  } as never;

  it('strips a shot_image_prompt → character_image dep (content depending on media)', () => {
    const executor = buildExecutor([
      node({
        id: 'shot_image_prompt:scene_1_shot_2',
        typeId: 'shot_image_prompt',
        itemId: 'scene_1_shot_2',
        dependencies: [
          'scene_video_prompt:scene_1', // legit
          'world_style', // legit
          'character_image:protagonist', // template violation
        ],
      }),
      node({
        id: 'scene_video_prompt:scene_1',
        typeId: 'scene_video_prompt',
        itemId: 'scene_1',
        status: 'completed',
        dependents: ['shot_image_prompt:scene_1_shot_2'],
      }),
      node({
        id: 'world_style',
        typeId: 'world_style',
        status: 'completed',
        dependents: ['shot_image_prompt:scene_1_shot_2'],
      }),
      node({
        id: 'character_image:protagonist',
        typeId: 'character_image',
        itemId: 'protagonist',
        status: 'pending',
        dependents: ['shot_image_prompt:scene_1_shot_2'],
      }),
    ]);

    const r = reconcileGraphHygiene(executor, template);

    expect(r.contentToMediaDepsStripped).toBe(1);
    const sip = executor.getNode('shot_image_prompt:scene_1_shot_2');
    expect(sip!.dependencies).toEqual(['scene_video_prompt:scene_1', 'world_style']);
    expect(sip!.dependencies).not.toContain('character_image:protagonist');
    // The inverse edge is also cleaned on the bogus-dep node.
    expect(
      executor.getNode('character_image:protagonist')!.dependents,
    ).not.toContain('shot_image_prompt:scene_1_shot_2');
  });

  it('PRESERVES media→media cross-shot chain edges (shot_image → prior shot_image is legit)', () => {
    // Regression: an earlier version of Rule D used the template's
    // declared deps as an allow-list, which false-positived on every
    // cross-shot visual-continuity edge wired by addShotImageNodes.
    // The fix narrows Rule D to content→media only — media→media
    // chain edges stay.
    const executor = buildExecutor([
      node({
        id: 'shot_image:scene_1_shot_2',
        typeId: 'shot_image',
        itemId: 'scene_1_shot_2',
        dependencies: [
          'shot_image_prompt:scene_1_shot_2', // prompt (content) — fine
          'character_image:protagonist', // template-declared ref — fine
          'shot_image:scene_1_shot_1', // cross-shot chain (media→media) — legit
        ],
      }),
      node({
        id: 'shot_image_prompt:scene_1_shot_2',
        typeId: 'shot_image_prompt',
        itemId: 'scene_1_shot_2',
        dependents: ['shot_image:scene_1_shot_2'],
      }),
      node({
        id: 'character_image:protagonist',
        typeId: 'character_image',
        itemId: 'protagonist',
        dependents: ['shot_image:scene_1_shot_2'],
      }),
      node({
        id: 'shot_image:scene_1_shot_1',
        typeId: 'shot_image',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        dependents: ['shot_image:scene_1_shot_2'],
      }),
    ]);

    const r = reconcileGraphHygiene(executor, template);

    // No content→media stripping (shot_image is media — only its
    // content dependents get checked).
    expect(r.contentToMediaDepsStripped).toBe(0);
    const si = executor.getNode('shot_image:scene_1_shot_2');
    expect(si!.dependencies).toContain('shot_image:scene_1_shot_1');
    expect(si!.dependencies).toContain('character_image:protagonist');
    expect(si!.dependencies).toContain('shot_image_prompt:scene_1_shot_2');
  });

  it('is a no-op when no template is supplied (applyInvalidation path)', () => {
    // applyInvalidation runs hygiene without a template handle. Rule
    // D becomes a no-op there; the other rules still run.
    const executor = buildExecutor([
      node({
        id: 'shot_image_prompt:scene_1_shot_2',
        typeId: 'shot_image_prompt',
        itemId: 'scene_1_shot_2',
        dependencies: ['character_image:protagonist'],
      }),
      node({
        id: 'character_image:protagonist',
        typeId: 'character_image',
        itemId: 'protagonist',
        dependents: ['shot_image_prompt:scene_1_shot_2'],
      }),
    ]);

    const r = reconcileGraphHygiene(executor); // no template
    expect(r.contentToMediaDepsStripped).toBe(0);
    expect(
      executor.getNode('shot_image_prompt:scene_1_shot_2')!.dependencies,
    ).toContain('character_image:protagonist');
  });
});

describe('summariseHygieneResult', () => {
  it('returns null when nothing was repaired (no log spam on steady state)', () => {
    expect(
      summariseHygieneResult({
        orphanParentsPruned: [],
        parentDepsRewiredCount: 0,
        danglingDepsStripped: 0,
        danglingDependentsStripped: 0,
        contentToMediaDepsStripped: 0,
      }),
    ).toBeNull();
  });

  it('joins each non-zero category into a single comma-separated summary', () => {
    expect(
      summariseHygieneResult({
        orphanParentsPruned: ['shot_breakdown:scene_1'],
        parentDepsRewiredCount: 1,
        danglingDepsStripped: 2,
        danglingDependentsStripped: 0,
        contentToMediaDepsStripped: 3,
      }),
    ).toBe(
      'pruned 1 orphan collection parent(s), rewired 1 parent-as-dep edge(s), stripped 2 dangling dep edge(s), stripped 3 content→media dep edge(s) (would deadlock serial-mode scheduler)',
    );
  });
});
