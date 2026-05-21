/**
 * Cross-shot reference consolidation — the "Side B in shot 3 and shot 5
 * lands on the SAME render, not two different ones" contract.
 *
 * Today's executor implements dedup via `expandCollection` idempotency:
 * the FIRST call replaces the type-level node with per-item nodes; a
 * SECOND call with the same itemId finds no type-level node to expand
 * and returns []. The pre-existing per-item node is reused as-is.
 *
 * These tests pin that contract end-to-end against the real executor
 * (Must 4.1, 4.3) so a future refactor can't silently break dedup.
 */
import { describe, it, expect } from 'vitest';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import { BackwardPlanner } from '../../src/core/planner/BackwardPlanner.js';
import type { VideoTemplate } from '../../src/core/templates/types.js';
import type { AssetRegistry, UserGoal } from '../../src/core/planner/types.js';

function template(): VideoTemplate {
  return {
    id: 'dedup_test',
    displayName: 'Dedup Test',
    description: 'minimal template — story → character (collection) → character_image (collection)',
    version: '1.0.0',
    defaultStyle: 'default',
    styles: [{ id: 'default', displayName: 'Default', description: '', promptModifiers: [], negativePrompt: [] }],
    inputTypes: [{ id: 'idea', displayName: 'Idea', description: '', examples: [], skipsArtifacts: [], mapsToArtifact: 'story' }],
    artifactTypes: {
      story: {
        id: 'story', displayName: 'Story', category: 'concept', description: '',
        isCollection: false, outputFormat: 'markdown', filePattern: 'story.md',
        agentType: 'content', promptFile: 'story.md', isExpensive: false,
        requiresPerItemApproval: false, dependencies: [],
      },
      character: {
        id: 'character', displayName: 'Characters', category: 'entity', description: '',
        isCollection: true, itemName: 'character', outputFormat: 'markdown',
        filePattern: 'characters/{{name}}.md', agentType: 'content', promptFile: 'character.md',
        isExpensive: false, requiresPerItemApproval: false,
        dependencies: [{ artifactTypeId: 'story', required: true, usage: 'context' }],
      },
      character_image: {
        id: 'character_image', displayName: 'Character Images', category: 'visual_ref', description: '',
        isCollection: true, itemName: 'character image', outputFormat: 'image',
        filePattern: 'assets/characters/{{name}}.png', agentType: 'image', promptFile: 'character_image.md',
        isExpensive: true, requiresPerItemApproval: true,
        dependencies: [{ artifactTypeId: 'character', required: true, usage: 'reference', scope: 'matching' }],
      },
    },
    contextVariables: {},
    orchestratorPrompt: 'orchestrator.md',
  };
}

function buildExecutor(): DependencyGraphExecutor {
  const t = template();
  const planner = new BackwardPlanner(t);
  const goal: UserGoal = {
    targetArtifacts: ['character_image'],
    preferences: {},
    description: 'create character images',
  };
  const registry: AssetRegistry = { assets: new Map(), satisfiedArtifacts: new Map(), lastScanAt: Date.now() };
  const plan = planner.buildPlan(goal, registry);
  return DependencyGraphExecutor.fromPlan(plan, t);
}

describe('expandCollection dedup — Must 4.1 (same itemId twice → one node, no duplicate render)', () => {
  it('expanding the same upstream collection with the same itemId twice produces ONE per-item node', () => {
    const exec = buildExecutor();
    // First expansion: shot 3 turn-2 proposes setting_image:bus_station_reverse
    // (here we use `character` as the test stand-in because the template is minimal).
    exec.expandCollection('character', [{ itemId: 'ruby', name: 'Ruby' }]);
    const afterFirst = exec.getAllNodes().filter(n => n.id === 'character:ruby');
    expect(afterFirst).toHaveLength(1);

    // Second expansion (shot 5 turn-2 independently proposes the same itemId):
    // expandCollection on an already-expanded type returns [] (the type-level
    // node was removed by the first call). The existing per-item node persists.
    const r = exec.expandCollection('character', [{ itemId: 'ruby', name: 'Ruby' }]);
    expect(r).toHaveLength(0);

    const afterSecond = exec.getAllNodes().filter(n => n.id === 'character:ruby');
    expect(afterSecond).toHaveLength(1);
    // The node identity is preserved across the second call — same node,
    // not a fresh replacement that would re-fire image generation.
    expect(afterSecond[0]).toBe(afterFirst[0]);
  });

  it('the cascaded image node (character_image:ruby) is created ONCE and reused on the second proposal', () => {
    const exec = buildExecutor();
    exec.expandCollection('character', [{ itemId: 'ruby', name: 'Ruby' }]);
    const firstImage = exec.getNode('character_image:ruby');
    expect(firstImage).toBeDefined();

    exec.expandCollection('character', [{ itemId: 'ruby', name: 'Ruby' }]);
    const secondImage = exec.getNode('character_image:ruby');
    expect(secondImage).toBeDefined();
    expect(secondImage).toBe(firstImage);
  });

  it('metadata written on the second proposal does NOT clobber metadata written on the first', () => {
    // Real-world case: shot 3 proposes a new ref with description X.
    // Shot 5 proposes the SAME refId but no description (it just matched
    // an existing entry). The first proposal's metadata must survive —
    // expandCollection's no-op on the second call means we won't get
    // a chance to overwrite via the constructor path.
    const exec = buildExecutor();
    exec.expandCollection('character', [
      { itemId: 'ruby', name: 'Ruby', metadata: { description: 'Red hair, green eyes' } },
    ]);
    const first = exec.getNode('character:ruby');
    expect(first?.metadata?.description).toBe('Red hair, green eyes');

    // Second proposal carries no description — the type-level no-op
    // means the per-item node's existing metadata is untouched.
    exec.expandCollection('character', [{ itemId: 'ruby', name: 'Ruby' }]);
    expect(exec.getNode('character:ruby')?.metadata?.description).toBe('Red hair, green eyes');
  });
});

describe('expandCollection dedup — Must 4.3 (status=new on already-existing itemId is a no-op, not an overwrite)', () => {
  it('expansion is idempotent — no per-item duplicates accumulate across many redundant proposals', () => {
    const exec = buildExecutor();
    for (let i = 0; i < 5; i++) {
      exec.expandCollection('character', [{ itemId: 'ruby', name: 'Ruby' }]);
    }
    const all = exec.getAllNodes().filter(n => n.id === 'character:ruby');
    expect(all).toHaveLength(1);
    const allImg = exec.getAllNodes().filter(n => n.id === 'character_image:ruby');
    expect(allImg).toHaveLength(1);
  });

  it('different itemIds in the SAME batch each get their own per-item node', () => {
    const exec = buildExecutor();
    exec.expandCollection('character', [
      { itemId: 'ruby', name: 'Ruby' },
      { itemId: 'angel', name: 'Angel' },
    ]);
    expect(exec.getNode('character:ruby')).toBeDefined();
    expect(exec.getNode('character:angel')).toBeDefined();
    expect(exec.getNode('character_image:ruby')).toBeDefined();
    expect(exec.getNode('character_image:angel')).toBeDefined();
  });

  it('two batches with overlapping itemIds — only the NEW itemId gets a fresh node; the overlapping one is reused', () => {
    const exec = buildExecutor();
    exec.expandCollection('character', [{ itemId: 'ruby', name: 'Ruby' }]);
    const rubyFirst = exec.getNode('character:ruby');

    // Second batch proposes ruby (existing) + angel (new). Because the
    // type-level node is already gone, expandCollection returns [].
    // Angel ends up MISSING — this documents today's behavior: lazy ref
    // proposals after the first cascade can't piggyback on the same
    // upstream collection. Callers (refineShotImageRefs) must handle
    // each new itemId individually if the type-level has already been
    // collapsed.
    exec.expandCollection('character', [
      { itemId: 'ruby', name: 'Ruby' },
      { itemId: 'angel', name: 'Angel' },
    ]);
    expect(exec.getNode('character:ruby')).toBe(rubyFirst);
    // Angel is NOT created by the second call — this is the known
    // limit of dedup-via-no-op. The user's prompt today proposes
    // one ref at a time, which sidesteps the issue, but a future
    // batch proposal would need a different code path.
    expect(exec.getNode('character:angel')).toBeUndefined();
  });
});
