/**
 * Dependency Propagation Tests
 *
 * When a parent collection (e.g. `scene`) is expanded into per-item nodes
 * (`scene:scene_1`, `scene:scene_2`), every downstream artifact that has a
 * matching-scope dependency on the parent (`scene_video_prompt`,
 * `character_image`, `setting_image`, `object_image`) MUST have its
 * per-item dependency rewired to the matching per-item parent.
 *
 * If this rewiring breaks, per-item nodes generate content with zero
 * context — character_image reads only world_style.md (never the
 * character), scene_video_prompt invents plot because it never sees the
 * scene script, etc.
 *
 * This test locks down the invariant: after expansion,
 *   - `character_image:alice.dependencies` contains `character:alice`
 *   - `scene_video_prompt:scene_1.dependencies` contains `scene:scene_1`
 *   - etc.
 *
 * It also exercises the exact ordering that production uses (ExecutorAgent's
 * Strategy C expands character → setting → scene → object SEQUENTIALLY,
 * with the post-expansion dangling-dep cleanup running once per parent
 * expansion — NOT once at the end). A lot of cascade bugs only show up
 * when expansions happen one at a time.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import { BackwardPlanner } from '../../src/core/planner/BackwardPlanner.js';
import { narrativeTemplate } from '../../src/templates/narrative.js';
import type { AssetRegistry } from '../../src/core/planner/types.js';

function buildExecutor(): DependencyGraphExecutor {
  const planner = new BackwardPlanner(narrativeTemplate);
  const registry: AssetRegistry = { assets: new Map(), satisfiedArtifacts: new Map(), lastScanAt: Date.now() };
  // includeOptional: true so the graph includes `object` and `object_image`
  // (which are optional reference types but fully wired in production flows
  // where the story mentions a prop — e.g. the Lazarus Drive).
  const plan = planner.buildPlan(
    { targetArtifacts: ['final_video'], preferences: {}, description: 'test' },
    registry,
    { includeOptional: true },
  );
  return DependencyGraphExecutor.fromPlan(plan, narrativeTemplate);
}

describe('expandCollection cascades matching-scope deps to dependent collections', () => {
  let executor: DependencyGraphExecutor;

  beforeEach(() => {
    executor = buildExecutor();
    // Simulate story completed — per-item parents haven't been created yet.
    executor.markStarted('story');
    executor.markCompleted('story', 'chapters/chapter_1/plans/story.md');
  });

  it('character expansion cascades to character_image per-item nodes', () => {
    executor.expandCollection('character', [
      { itemId: 'alice', name: 'Alice' },
      { itemId: 'bob', name: 'Bob' },
    ]);

    // character_image should now be expanded per-item, with each referencing its
    // matching character node.
    const alice = executor.getNode('character_image:alice');
    const bob = executor.getNode('character_image:bob');
    expect(alice, 'character_image:alice should exist after character expansion').toBeDefined();
    expect(bob, 'character_image:bob should exist after character expansion').toBeDefined();
    expect(alice!.dependencies).toContain('character:alice');
    expect(bob!.dependencies).toContain('character:bob');

    // The type-level character_image node should be gone.
    expect(executor.getNode('character_image')).toBeUndefined();
  });

  it('setting expansion cascades to setting_image per-item nodes', () => {
    executor.expandCollection('setting', [
      { itemId: 'park', name: 'Park' },
      { itemId: 'house', name: 'House' },
    ]);

    const park = executor.getNode('setting_image:park');
    const house = executor.getNode('setting_image:house');
    expect(park, 'setting_image:park should exist').toBeDefined();
    expect(house, 'setting_image:house should exist').toBeDefined();
    expect(park!.dependencies).toContain('setting:park');
    expect(house!.dependencies).toContain('setting:house');
    expect(executor.getNode('setting_image')).toBeUndefined();
  });

  it('object expansion cascades to object_image per-item nodes', () => {
    executor.expandCollection('object', [
      { itemId: 'drive', name: 'Drive' },
    ]);

    const drive = executor.getNode('object_image:drive');
    expect(drive, 'object_image:drive should exist').toBeDefined();
    expect(drive!.dependencies).toContain('object:drive');
    expect(executor.getNode('object_image')).toBeUndefined();
  });

  it('scene expansion cascades to scene_shot_plan per-item nodes (Stage A of hierarchical breakdown)', () => {
    executor.expandCollection('scene', [
      { itemId: 'scene_1', name: 'Scene 1' },
      { itemId: 'scene_2', name: 'Scene 2' },
    ]);

    // Post-refactor: scene text feeds scene_shot_plan (Stage A LLM),
    // not scene_video_prompt (which is now a deterministic assembler
    // that consumes the plan + per-shot breakdowns).
    const plan1 = executor.getNode('scene_shot_plan:scene_1');
    const plan2 = executor.getNode('scene_shot_plan:scene_2');
    expect(plan1, 'scene_shot_plan:scene_1 should exist').toBeDefined();
    expect(plan2, 'scene_shot_plan:scene_2 should exist').toBeDefined();
    expect(plan1!.dependencies).toContain('scene:scene_1');
    expect(plan2!.dependencies).toContain('scene:scene_2');
    expect(executor.getNode('scene_shot_plan')).toBeUndefined();
  });

  it('parent per-item nodes record expanded dependents (reverse edges)', () => {
    executor.expandCollection('scene', [
      { itemId: 'scene_1', name: 'Scene 1' },
      { itemId: 'scene_2', name: 'Scene 2' },
    ]);

    const scene1 = executor.getNode('scene:scene_1');
    expect(scene1).toBeDefined();
    // The per-item scene_shot_plan:scene_1 must be in scene:scene_1's
    // dependents — otherwise ready-node detection can't propagate completion.
    expect(scene1!.dependents).toContain('scene_shot_plan:scene_1');
  });
});

describe('per-item nodes keep their matching-scope deps across full expansion sequence', () => {
  it('scene_video_prompt:N keeps scene:N dep after the full parent expansion sequence', () => {
    // Simulates the exact production ordering from ExecutorAgent Strategy C:
    // each parent is expanded one at a time, each in its own expandPendingCollections
    // pass (which in production also triggers a post-expansion dangling-dep cleanup).
    const executor = buildExecutor();
    executor.markStarted('story');
    executor.markCompleted('story', 'chapters/chapter_1/plans/story.md');

    // 1. character first
    executor.expandCollection('character', [
      { itemId: 'alice', name: 'Alice' },
      { itemId: 'bob', name: 'Bob' },
    ]);
    // 2. setting
    executor.expandCollection('setting', [
      { itemId: 'park', name: 'Park' },
    ]);
    // 3. scene
    executor.expandCollection('scene', [
      { itemId: 'scene_1', name: 'Scene 1' },
      { itemId: 'scene_2', name: 'Scene 2' },
    ]);
    // 4. object
    executor.expandCollection('object', [
      { itemId: 'drive', name: 'Drive' },
    ]);

    // All downstream per-item deps must be correctly wired to their parents.
    // Post-refactor: scene → scene_shot_plan (Stage A) is the matching-scope
    // edge that must survive the cascade. scene_video_prompt:N depends on
    // scene_shot_plan:N + shot_breakdown:N instead.
    const plan1 = executor.getNode('scene_shot_plan:scene_1');
    expect(plan1).toBeDefined();
    expect(plan1!.dependencies).toContain('scene:scene_1');
    expect(plan1!.dependencies).toContain('world_style');
    // Never leak the parent type-level name as a dangling dep.
    expect(plan1!.dependencies).not.toContain('scene');

    const svp1 = executor.getNode('scene_video_prompt:scene_1');
    expect(svp1).toBeDefined();
    expect(svp1!.dependencies).toContain('scene_shot_plan:scene_1');
    expect(svp1!.dependencies).not.toContain('scene_shot_plan');

    const charImg = executor.getNode('character_image:alice');
    expect(charImg).toBeDefined();
    expect(charImg!.dependencies).toContain('character:alice');
    expect(charImg!.dependencies).not.toContain('character');

    const settingImg = executor.getNode('setting_image:park');
    expect(settingImg).toBeDefined();
    expect(settingImg!.dependencies).toContain('setting:park');
    expect(settingImg!.dependencies).not.toContain('setting');

    const objImg = executor.getNode('object_image:drive');
    expect(objImg).toBeDefined();
    expect(objImg!.dependencies).toContain('object:drive');
    expect(objImg!.dependencies).not.toContain('object');
  });
});

describe('no per-item node is left depending on a deleted type-level parent', () => {
  it('every per-item dep in the graph must resolve to an existing node', () => {
    const executor = buildExecutor();
    executor.markStarted('story');
    executor.markCompleted('story', 'chapters/chapter_1/plans/story.md');

    executor.expandCollection('character', [
      { itemId: 'alice', name: 'Alice' },
    ]);
    executor.expandCollection('setting', [
      { itemId: 'park', name: 'Park' },
    ]);
    executor.expandCollection('scene', [
      { itemId: 'scene_1', name: 'Scene 1' },
    ]);
    executor.expandCollection('object', [
      { itemId: 'drive', name: 'Drive' },
    ]);

    // No node in the graph should have a dependency pointing to a node
    // that doesn't exist — whether that's a dangling type-level ref
    // (e.g. 'scene' after scene was expanded) or a stale per-item ref.
    for (const node of executor.getAllNodes()) {
      for (const depId of node.dependencies) {
        expect(
          executor.getNode(depId),
          `${node.id} depends on ${depId} which does not exist in the graph`,
        ).toBeDefined();
      }
    }
  });
});

describe('state-heal on session resume repairs missing matching-scope deps', () => {
  // Reproduces the exact persisted-state shape observed in the broken
  // lazarus_drive.dhee/project.json: per-item nodes exist and are completed,
  // but their matching-scope deps were stripped by the old dangling-dep
  // cleanup. On resume, the fix must detect and restore those deps so that
  // resets (or re-runs of downstream nodes) correctly see parent content.
  it('healStaleMatchingDeps restores missing character:X dep on character_image:X', async () => {
    const { healStaleMatchingDeps } = await import('../../src/core/planner/stateHeal.js');

    const executor = buildExecutor();
    executor.markStarted('story');
    executor.markCompleted('story', 'chapters/chapter_1/plans/story.md');
    executor.expandCollection('character', [
      { itemId: 'alice', name: 'Alice' },
    ]);

    // Simulate the broken state: character_image:alice is missing its
    // matching dep on character:alice (only has world_style).
    const charImg = executor.getNode('character_image:alice')!;
    charImg.dependencies = charImg.dependencies.filter(d => !d.startsWith('character:'));
    const charNode = executor.getNode('character:alice')!;
    charNode.dependents = charNode.dependents.filter(d => d !== 'character_image:alice');

    // Sanity-check: yes, this looks broken
    expect(charImg.dependencies).not.toContain('character:alice');

    const report = healStaleMatchingDeps(executor, narrativeTemplate);

    // Fixed both forward and reverse edge.
    expect(executor.getNode('character_image:alice')!.dependencies).toContain('character:alice');
    expect(executor.getNode('character:alice')!.dependents).toContain('character_image:alice');
    expect(report.added).toBeGreaterThan(0);
  });

  it('heals every stripped matching-scope dep across the whole graph', async () => {
    const { healStaleMatchingDeps } = await import('../../src/core/planner/stateHeal.js');

    const executor = buildExecutor();
    executor.markStarted('story');
    executor.markCompleted('story', 'chapters/chapter_1/plans/story.md');
    executor.expandCollection('character', [{ itemId: 'alice', name: 'Alice' }]);
    executor.expandCollection('setting', [{ itemId: 'park', name: 'Park' }]);
    executor.expandCollection('scene', [{ itemId: 'scene_1', name: 'Scene 1' }]);
    executor.expandCollection('object', [{ itemId: 'drive', name: 'Drive' }]);

    // Simulate the exact lazarus_drive corruption: strip every matching-scope
    // dep from per-item children.
    // Post-hierarchical-refactor: scene → scene_shot_plan is the matching-
    // scope edge that needs healing (scene_video_prompt no longer has a
    // direct scene dep — it depends on scene_shot_plan + shot_breakdown).
    const victims = [
      'character_image:alice',
      'setting_image:park',
      'object_image:drive',
      'scene_shot_plan:scene_1',
    ];
    const matchingDepsByType: Record<string, string> = {
      character_image: 'character:alice',
      setting_image: 'setting:park',
      object_image: 'object:drive',
      scene_shot_plan: 'scene:scene_1',
    };
    for (const id of victims) {
      const n = executor.getNode(id)!;
      const strip = matchingDepsByType[n.typeId]!;
      n.dependencies = n.dependencies.filter(d => d !== strip);
      const parent = executor.getNode(strip);
      if (parent) parent.dependents = parent.dependents.filter(d => d !== id);
    }

    // All victims are now broken — prove it.
    for (const id of victims) {
      const n = executor.getNode(id)!;
      expect(n.dependencies, `${id} pre-heal`).not.toContain(matchingDepsByType[n.typeId]);
    }

    const report = healStaleMatchingDeps(executor, narrativeTemplate);
    expect(report.added).toBe(victims.length);

    // All victims restored.
    for (const id of victims) {
      const n = executor.getNode(id)!;
      const expected = matchingDepsByType[n.typeId]!;
      expect(n.dependencies, `${id} post-heal`).toContain(expected);
      expect(executor.getNode(expected)!.dependents).toContain(id);
    }
  });

  it('is a no-op when deps are already healthy (idempotent)', async () => {
    const { healStaleMatchingDeps } = await import('../../src/core/planner/stateHeal.js');

    const executor = buildExecutor();
    executor.markStarted('story');
    executor.markCompleted('story', 'chapters/chapter_1/plans/story.md');
    executor.expandCollection('character', [{ itemId: 'alice', name: 'Alice' }]);

    const before = executor.getNode('character_image:alice')!.dependencies.slice();
    const report = healStaleMatchingDeps(executor, narrativeTemplate);
    expect(report.added).toBe(0);
    expect(executor.getNode('character_image:alice')!.dependencies).toEqual(before);
  });
});

describe('lazarus_drive production scenario regression', () => {
  // Reproduces the bug observed in the real `lazarus_drive.dhee` project:
  // every character_image, setting_image, object_image, and scene_video_prompt
  // ended up with dependencies = ['world_style'] only, because the post-
  // expansion dangling-dep cleanup stripped the `character`/`setting`/`scene`/
  // `object` type-level dep from still-type-level collection nodes.
  //
  // The manifestations were visible in the generated content: character refs
  // drifted from the story, scene breakdowns hallucinated plot, and Glitch
  // (a cat) was rendered as a humanoid figure.
  it('each per-item reference-image node keeps its matching parent dep', () => {
    const executor = buildExecutor();
    executor.markStarted('story');
    executor.markCompleted('story', 'chapters/chapter_1/plans/story.md');

    // Production expansion order (from ExecutorAgent Strategy C):
    // character → setting → scene → object.
    executor.expandCollection('character', [
      { itemId: 'johnathan', name: "Johnathan O'Hare" },
      { itemId: 'andy', name: 'Andy' },
      { itemId: 'glitch', name: 'Glitch' },
    ]);
    executor.expandCollection('setting', [
      { itemId: 'andys_bar', name: "Andy's Bar" },
      { itemId: 'fog_docks', name: 'Fog-shrouded Docks' },
    ]);
    executor.expandCollection('scene', [
      { itemId: 'scene_1', name: 'Bar Reflection' },
      { itemId: 'scene_2', name: 'Dock Confrontation' },
      { itemId: 'scene_3', name: 'Apartment Absorption' },
    ]);
    executor.expandCollection('object', [
      { itemId: 'lazarus_drive', name: 'Lazarus Drive' },
    ]);

    // Character images must see their character.md.
    for (const charId of ['johnathan', 'andy', 'glitch']) {
      const n = executor.getNode(`character_image:${charId}`);
      expect(n, `character_image:${charId} missing`).toBeDefined();
      expect(
        n!.dependencies,
        `character_image:${charId} should depend on character:${charId}`,
      ).toContain(`character:${charId}`);
    }

    // Setting images must see their setting.md.
    for (const settingId of ['andys_bar', 'fog_docks']) {
      const n = executor.getNode(`setting_image:${settingId}`);
      expect(n, `setting_image:${settingId} missing`).toBeDefined();
      expect(
        n!.dependencies,
        `setting_image:${settingId} should depend on setting:${settingId}`,
      ).toContain(`setting:${settingId}`);
    }

    // Object images must see their object.md.
    const objNode = executor.getNode('object_image:lazarus_drive');
    expect(objNode).toBeDefined();
    expect(objNode!.dependencies).toContain('object:lazarus_drive');

    // Scene breakdowns must see the scene script — this is what drove the
    // hallucinated plot in the observed failure. Post-refactor that edge
    // lives on scene_shot_plan (Stage A LLM), not scene_video_prompt
    // (deterministic Stage C assembler).
    for (const sceneId of ['scene_1', 'scene_2', 'scene_3']) {
      const n = executor.getNode(`scene_shot_plan:${sceneId}`);
      expect(n, `scene_shot_plan:${sceneId} missing`).toBeDefined();
      expect(
        n!.dependencies,
        `scene_shot_plan:${sceneId} should depend on scene:${sceneId}`,
      ).toContain(`scene:${sceneId}`);
      // And must NOT still carry the stripped type-level ref.
      expect(n!.dependencies).not.toContain('scene');
    }

    // Reverse edges must reflect the expanded relationships so
    // getNextReady() can propagate completion.
    expect(executor.getNode('scene:scene_1')!.dependents)
      .toContain('scene_shot_plan:scene_1');
    expect(executor.getNode('character:johnathan')!.dependents)
      .toContain('character_image:johnathan');
  });
});
