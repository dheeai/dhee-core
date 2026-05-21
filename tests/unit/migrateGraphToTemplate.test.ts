/**
 * GIVEN a persisted executor graph built under an OLD narrative template
 *   (e.g. before the hierarchical scene-breakdown refactor added
 *    `scene_shot_plan` and `shot_breakdown`)
 * WHEN migrateGraphToTemplate runs against the current narrative template
 * THEN:
 *   - The missing per-item nodes (scene_shot_plan:scene_N, shot_breakdown:scene_N)
 *     are synthesized from the current template.
 *   - Per-item nodes whose deps drifted (scene_video_prompt:scene_N moving
 *     from depending on `scene` to depending on `scene_shot_plan`+
 *     `shot_breakdown`) are rewired and forced pending — with their
 *     downstream consumers (shot_image_prompt:scene_N etc.) cascaded too.
 *   - Already-completed nodes whose contract is UNCHANGED (plot, story,
 *     scene markdown, characters, world_style) keep status + outputPath.
 */
import { describe, it, expect } from 'vitest';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import { BackwardPlanner } from '../../src/core/planner/BackwardPlanner.js';
import { narrativeTemplate } from '../../src/templates/narrative.js';
import { migrateGraphToTemplate } from '../../src/core/planner/migrateGraphToTemplate.js';
import type { AssetRegistry, ExecutorState } from '../../src/core/planner/types.js';
import type { VideoTemplate, ArtifactTypeDefinition } from '../../src/core/templates/types.js';

function buildFreshExecutor(): DependencyGraphExecutor {
  const planner = new BackwardPlanner(narrativeTemplate);
  const registry: AssetRegistry = {
    assets: new Map(),
    satisfiedArtifacts: new Map(),
    lastScanAt: Date.now(),
  };
  const plan = planner.buildPlan(
    { targetArtifacts: ['final_video'], preferences: {}, description: 'test' },
    registry,
  );
  return DependencyGraphExecutor.fromPlan(plan, narrativeTemplate);
}

/**
 * Build a synthetic "old-template" persisted executor that mirrors what
 * Dream's project.json looked like before the hierarchical refactor:
 *   - Top of pipeline (plot/story/world_style/scene/etc.) are completed.
 *   - scene_video_prompt:scene_1 exists with deps [scene:scene_1, world_style]
 *     (the OLD shape — no scene_shot_plan / shot_breakdown anywhere).
 *   - shot_image_prompt:scene_1 etc. are pending and reference
 *     scene_video_prompt:scene_1 as their upstream.
 */
function buildLegacyPersistedExecutor(): DependencyGraphExecutor {
  // Take the fresh template, then mutate it to mimic the pre-refactor shape
  // so we can serialise an "old" state with the old type definitions.
  const oldTemplate: VideoTemplate = {
    ...narrativeTemplate,
    artifactTypes: { ...narrativeTemplate.artifactTypes },
  };
  // Pre-refactor: scene_video_prompt depended directly on scene + world_style,
  // and scene_shot_plan / shot_breakdown didn't exist.
  oldTemplate.artifactTypes = {
    ...oldTemplate.artifactTypes,
    scene_video_prompt: {
      ...(oldTemplate.artifactTypes.scene_video_prompt as ArtifactTypeDefinition),
      dependencies: [
        { artifactTypeId: 'scene', required: true, usage: 'context', scope: 'matching' },
        { artifactTypeId: 'world_style', required: true, usage: 'context', scope: 'matching' },
      ],
    },
  };
  delete oldTemplate.artifactTypes.scene_shot_plan;
  delete oldTemplate.artifactTypes.shot_breakdown;

  const planner = new BackwardPlanner(oldTemplate);
  const registry: AssetRegistry = {
    assets: new Map(),
    satisfiedArtifacts: new Map(),
    lastScanAt: Date.now(),
  };
  const plan = planner.buildPlan(
    { targetArtifacts: ['final_video'], preferences: {}, description: 'test' },
    registry,
  );
  const executor = DependencyGraphExecutor.fromPlan(plan, oldTemplate);
  // Drive the executor to a realistic "scene done, breakdown about to start"
  // state by expanding scene + marking the upstream completed.
  executor.markCompleted('plot');
  executor.markCompleted('story');
  executor.expandCollection('character', [{ itemId: 'alice', name: 'Alice' }]);
  executor.expandCollection('setting', [{ itemId: 'arena', name: 'Arena' }]);
  executor.expandCollection('scene', [{ itemId: 'scene_1', name: 'Scene 1' }]);
  executor.markCompleted('character:alice', 'characters/alice.md');
  executor.markCompleted('setting:arena', 'settings/arena.md');
  executor.markCompleted('scene:scene_1', 'chapters/chapter_1/scenes/scene_1.md');
  executor.markCompleted('world_style', 'plans/world_style.md');
  return executor;
}

/**
 * Reload an executor under a different template — simulates the "kshana-core
 * dist was upgraded between sessions" path. Persists state then re-creates
 * via `fromState`.
 */
function reloadUnderTemplate(
  executor: DependencyGraphExecutor,
  template: VideoTemplate,
): DependencyGraphExecutor {
  const state: ExecutorState = executor.getState();
  return DependencyGraphExecutor.fromState(state, template);
}

describe('migrateGraphToTemplate', () => {
  it('synthesises scene_shot_plan + shot_breakdown per-item nodes when the persisted graph predates the refactor', () => {
    const legacy = buildLegacyPersistedExecutor();
    // Sanity: the legacy graph has none of the new types.
    expect(legacy.getNode('scene_shot_plan:scene_1')).toBeUndefined();
    expect(legacy.getNode('shot_breakdown:scene_1')).toBeUndefined();

    const reloaded = reloadUnderTemplate(legacy, narrativeTemplate);
    const report = migrateGraphToTemplate(reloaded, narrativeTemplate);

    expect(report.synthesized.map(s => s.id)).toEqual(
      expect.arrayContaining(['scene_shot_plan:scene_1', 'shot_breakdown:scene_1']),
    );
    expect(reloaded.getNode('scene_shot_plan:scene_1')).toBeDefined();
    expect(reloaded.getNode('shot_breakdown:scene_1')).toBeDefined();
  });

  it('wires the synthesised scene_shot_plan:scene_1 to the existing scene:scene_1 + world_style', () => {
    const legacy = buildLegacyPersistedExecutor();
    const reloaded = reloadUnderTemplate(legacy, narrativeTemplate);
    migrateGraphToTemplate(reloaded, narrativeTemplate);

    const plan = reloaded.getNode('scene_shot_plan:scene_1');
    expect(plan).toBeDefined();
    expect(plan!.dependencies).toContain('scene:scene_1');
    // world_style is a singleton (isCollection=false) so the matching
    // resolution falls back to the type-level name.
    expect(plan!.dependencies).toContain('world_style');
    // Reverse edge: scene:scene_1 now lists scene_shot_plan:scene_1 as a dependent.
    expect(reloaded.getNode('scene:scene_1')!.dependents).toContain(
      'scene_shot_plan:scene_1',
    );
  });

  it('rewires scene_video_prompt:scene_1 to point at the new scene_shot_plan + shot_breakdown deps', () => {
    const legacy = buildLegacyPersistedExecutor();
    const reloaded = reloadUnderTemplate(legacy, narrativeTemplate);
    const report = migrateGraphToTemplate(reloaded, narrativeTemplate);

    const svp = reloaded.getNode('scene_video_prompt:scene_1');
    expect(svp).toBeDefined();
    expect(svp!.dependencies).toContain('scene_shot_plan:scene_1');
    expect(svp!.dependencies).toContain('shot_breakdown:scene_1');
    // Old direct dep on the scene is gone.
    expect(svp!.dependencies).not.toContain('scene:scene_1');

    const rewireEntry = report.rewired.find(r => r.id === 'scene_video_prompt:scene_1');
    expect(rewireEntry).toBeDefined();
    expect(rewireEntry!.oldDeps).toContain('scene:scene_1');
    expect(rewireEntry!.newDeps).toContain('scene_shot_plan:scene_1');
  });

  it('forces the rewired scene_video_prompt:scene_1 back to pending (its contract changed)', () => {
    const legacy = buildLegacyPersistedExecutor();
    // Pre-rewire: pretend it had run successfully under the old contract.
    legacy.markCompleted('scene_video_prompt:scene_1', 'prompts/videos/scenes/scene_1.json');
    expect(legacy.getNode('scene_video_prompt:scene_1')!.status).toBe('completed');

    const reloaded = reloadUnderTemplate(legacy, narrativeTemplate);
    const report = migrateGraphToTemplate(reloaded, narrativeTemplate);

    const svp = reloaded.getNode('scene_video_prompt:scene_1')!;
    expect(svp.status).toBe('pending');
    expect(svp.outputPath).toBeUndefined();
    expect(report.invalidated).toContain('scene_video_prompt:scene_1');
  });

  it('preserves status + outputPath on nodes whose template contract is unchanged', () => {
    const legacy = buildLegacyPersistedExecutor();
    const reloaded = reloadUnderTemplate(legacy, narrativeTemplate);
    migrateGraphToTemplate(reloaded, narrativeTemplate);

    // plot/story/character/setting/scene/world_style all kept their original
    // template shape across the refactor — they MUST not be invalidated.
    const survivors = [
      ['plot', undefined],
      ['story', undefined],
      ['character:alice', 'characters/alice.md'],
      ['setting:arena', 'settings/arena.md'],
      ['scene:scene_1', 'chapters/chapter_1/scenes/scene_1.md'],
      ['world_style', 'plans/world_style.md'],
    ] as const;
    for (const [id, path] of survivors) {
      const node = reloaded.getNode(id);
      expect(node, `${id} should still exist`).toBeDefined();
      expect(node!.status).toBe('completed');
      if (path !== undefined) {
        expect(node!.outputPath).toBe(path);
      }
    }
  });

  it('cascades invalidation downstream when scene_video_prompt:scene_1 is rewired', () => {
    const legacy = buildLegacyPersistedExecutor();
    // Pretend the whole chain was completed under the old contract — this
    // is the "user dispatched without resetting" scenario.
    legacy.markCompleted('scene_video_prompt:scene_1', 'prompts/videos/scenes/scene_1.json');
    legacy.expandCollection('shot_image_prompt:scene_1', [
      { itemId: 'scene_1_shot_1', name: 'Shot 1' },
    ]);
    legacy.markCompleted('shot_image_prompt:scene_1_shot_1', 'prompts/images/shots/scene-1-shot-1.json');

    const reloaded = reloadUnderTemplate(legacy, narrativeTemplate);
    const report = migrateGraphToTemplate(reloaded, narrativeTemplate);

    expect(report.invalidated).toContain('scene_video_prompt:scene_1');
    expect(report.invalidated).toContain('shot_image_prompt:scene_1_shot_1');
    expect(
      reloaded.getNode('shot_image_prompt:scene_1_shot_1')!.status,
    ).toBe('pending');
  });

  it('is idempotent — running twice does nothing on the second pass', () => {
    const legacy = buildLegacyPersistedExecutor();
    const reloaded = reloadUnderTemplate(legacy, narrativeTemplate);
    const first = migrateGraphToTemplate(reloaded, narrativeTemplate);
    const second = migrateGraphToTemplate(reloaded, narrativeTemplate);

    expect(first.synthesized.length).toBeGreaterThan(0);
    expect(first.rewired.length).toBeGreaterThan(0);
    // Second pass should find nothing to do.
    expect(second.synthesized).toEqual([]);
    expect(second.rewired).toEqual([]);
    expect(second.invalidated).toEqual([]);
  });

  it('is a no-op when the persisted graph already matches the current template', () => {
    const fresh = buildFreshExecutor();
    fresh.expandCollection('scene', [{ itemId: 'scene_1', name: 'Scene 1' }]);
    // Now do the standard cascade-expansion that scene's matching deps would
    // trigger in production — scene_shot_plan:scene_1 etc. are already
    // wired correctly. Persist + reload + migrate.
    const reloaded = reloadUnderTemplate(fresh, narrativeTemplate);
    const report = migrateGraphToTemplate(reloaded, narrativeTemplate);

    expect(report.synthesized).toEqual([]);
    expect(report.rewired).toEqual([]);
    expect(report.invalidated).toEqual([]);
    expect(report.deleted).toEqual([]);
  });

  // Regression: an earlier cascade bug in expandPendingCollections allowed
  // expandMatchingDependent to promote scene_video_prompt:scene_1 to
  // per-shot granularity when shot_breakdown was expanded, leaving
  // phantom `scene_video_prompt:scene_1_shot_M` nodes. Migration must
  // detect and delete those, then Phase 1 synthesis recreates the
  // proper scene-level node.
  it('deletes phantom scene_video_prompt:scene_N_shot_M nodes and resynthesises the scene-level one', () => {
    const fresh = buildFreshExecutor();
    fresh.expandCollection('scene', [{ itemId: 'scene_1', name: 'Scene 1' }]);

    // Inject the phantom shape directly to mimic the old bug. The real
    // graph would have scene_video_prompt:scene_1 deleted and replaced
    // by three phantom per-shot nodes pointing at scene_shot_plan:
    // scene_1_shot_M (also nonexistent).
    fresh.removeNode('scene_video_prompt:scene_1');
    for (const m of [1, 2, 3]) {
      fresh.addNode({
        id: `scene_video_prompt:scene_1_shot_${m}`,
        typeId: 'scene_video_prompt',
        itemId: `scene_1_shot_${m}`,
        status: 'pending',
        displayName: `Scene Breakdown: shot ${m}`,
        isExpensive: false,
        isCollection: false,
        dependencies: [`shot_breakdown:scene_1_shot_${m}`],
        dependents: [],
      });
    }
    expect(fresh.getNode('scene_video_prompt:scene_1')).toBeUndefined();
    expect(fresh.getNode('scene_video_prompt:scene_1_shot_1')).toBeDefined();

    const reloaded = reloadUnderTemplate(fresh, narrativeTemplate);
    const report = migrateGraphToTemplate(reloaded, narrativeTemplate);

    // All three phantoms gone.
    expect(report.deleted).toEqual(
      expect.arrayContaining([
        'scene_video_prompt:scene_1_shot_1',
        'scene_video_prompt:scene_1_shot_2',
        'scene_video_prompt:scene_1_shot_3',
      ]),
    );
    for (const m of [1, 2, 3]) {
      expect(reloaded.getNode(`scene_video_prompt:scene_1_shot_${m}`)).toBeUndefined();
    }
    // Proper scene-level node resynthesised by Phase 1.
    expect(reloaded.getNode('scene_video_prompt:scene_1')).toBeDefined();
    expect(reloaded.getNode('scene_video_prompt:scene_1')!.dependencies).toContain(
      'scene_shot_plan:scene_1',
    );
  });

  it('does NOT delete legitimate scene-level scene_video_prompt:scene_N nodes', () => {
    const fresh = buildFreshExecutor();
    fresh.expandCollection('scene', [
      { itemId: 'scene_1', name: 'Scene 1' },
      { itemId: 'scene_2', name: 'Scene 2' },
    ]);

    const reloaded = reloadUnderTemplate(fresh, narrativeTemplate);
    const report = migrateGraphToTemplate(reloaded, narrativeTemplate);

    expect(report.deleted).toEqual([]);
    expect(reloaded.getNode('scene_video_prompt:scene_1')).toBeDefined();
    expect(reloaded.getNode('scene_video_prompt:scene_2')).toBeDefined();
  });

  // Regression: the previous synthesis logic re-created the phantoms
  // Phase 0 had just deleted, because the template says
  // `scene_video_prompt` has matching scope on `shot_breakdown` — and
  // when `shot_breakdown:scene_1_shot_M` parents exist, the naive
  // synthesis fired `scene_video_prompt:scene_1_shot_M`. Closed-loop
  // bug; the migration's net effect was zero. Phase 1 now skips
  // synthesizing SCENE_GRANULARITY types at shot-level granularity.
  it('does NOT resurrect scene-granularity phantoms from shot-level parents (closed-loop guard)', () => {
    const fresh = buildFreshExecutor();
    fresh.expandCollection('scene', [{ itemId: 'scene_1', name: 'Scene 1' }]);

    // Set up a realistic post-expansion shape: shot_breakdown got
    // expanded into per-shot children. (We force this by injecting the
    // shot-level parents directly.) Then drop the proper scene-level
    // scene_video_prompt so we can observe synthesis behavior.
    fresh.removeNode('scene_video_prompt:scene_1');
    for (const m of [1, 2, 3]) {
      fresh.addNode({
        id: `shot_breakdown:scene_1_shot_${m}`,
        typeId: 'shot_breakdown',
        itemId: `scene_1_shot_${m}`,
        status: 'pending',
        displayName: `Shot Breakdown: scene_1 shot ${m}`,
        isExpensive: false,
        isCollection: false,
        dependencies: ['scene_shot_plan:scene_1'],
        dependents: [],
      });
    }

    const reloaded = reloadUnderTemplate(fresh, narrativeTemplate);
    const report = migrateGraphToTemplate(reloaded, narrativeTemplate);

    // None of the shot-level phantoms got synthesised.
    for (const m of [1, 2, 3]) {
      expect(
        reloaded.getNode(`scene_video_prompt:scene_1_shot_${m}`),
        `scene_video_prompt:scene_1_shot_${m} must NOT be synthesized`,
      ).toBeUndefined();
    }
    // The proper scene-level scene_video_prompt WAS synthesized
    // (from scene_shot_plan:scene_1, which IS scene-level).
    expect(reloaded.getNode('scene_video_prompt:scene_1')).toBeDefined();
    // And it shows up in the report.
    const synthIds = report.synthesized.map(s => s.id);
    expect(synthIds).toContain('scene_video_prompt:scene_1');
    expect(synthIds).not.toContain('scene_video_prompt:scene_1_shot_1');
  });

  // Regression: a follow-on of the closed-loop bug — Phase 1 was also
  // synthesizing collection-parent nodes (e.g. shot_image_prompt:scene_1)
  // when the per-shot children (shot_image_prompt:scene_1_shot_M) were
  // already in the graph. The redundant parent, if later expanded by
  // the runtime, would overwrite the per-shot children's status.
  it('does NOT synthesize a scene-level parent when per-shot children of that type already exist', () => {
    const fresh = buildFreshExecutor();
    fresh.expandCollection('scene', [{ itemId: 'scene_1', name: 'Scene 1' }]);

    // Realistic mid-pipeline shape: shot_image_prompt has been
    // expanded into per-shot children already.
    fresh.removeNode('shot_image_prompt:scene_1');
    for (const m of [1, 2]) {
      fresh.addNode({
        id: `shot_image_prompt:scene_1_shot_${m}`,
        typeId: 'shot_image_prompt',
        itemId: `scene_1_shot_${m}`,
        status: 'completed',
        displayName: `Shot Composition: scene_1 shot ${m}`,
        isExpensive: false,
        isCollection: false,
        dependencies: ['scene_video_prompt:scene_1'],
        dependents: [],
        outputPath: `prompts/images/shots/scene-1-shot-${m}.json`,
      });
    }

    const reloaded = reloadUnderTemplate(fresh, narrativeTemplate);
    const report = migrateGraphToTemplate(reloaded, narrativeTemplate);

    // shot_image_prompt:scene_1 (the parent collection) MUST NOT be
    // re-created — the per-shot children own the work now. A
    // re-created parent, if later expanded by the runtime, would
    // overwrite the per-shot children's status.
    expect(reloaded.getNode('shot_image_prompt:scene_1')).toBeUndefined();
    const synthIds = report.synthesized.map(s => s.id);
    expect(synthIds).not.toContain('shot_image_prompt:scene_1');
    // The per-shot children still exist (status may shift if other deps
    // got rewired in Phase 2 — out of scope for this test).
    expect(reloaded.getNode('shot_image_prompt:scene_1_shot_1')).toBeDefined();
    expect(reloaded.getNode('shot_image_prompt:scene_1_shot_2')).toBeDefined();
  });
});
