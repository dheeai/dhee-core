/**
 * Tests for DependencyGraphExecutor
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import { BackwardPlanner } from '../../src/core/planner/BackwardPlanner.js';
import type { VideoTemplate } from '../../src/core/templates/types.js';
import type { AssetRegistry, UserGoal } from '../../src/core/planner/types.js';

// Reuse the same test template from BackwardPlanner tests
const createTestTemplate = (): VideoTemplate => ({
  id: 'test_template',
  displayName: 'Test Template',
  description: 'A template for testing',
  version: '1.0.0',
  defaultStyle: 'default',
  styles: [
    {
      id: 'default',
      displayName: 'Default',
      description: 'Default style',
      promptModifiers: [],
      negativePrompt: [],
    },
  ],
  inputTypes: [
    {
      id: 'idea',
      displayName: 'Idea',
      description: 'A simple idea',
      examples: ['A story about...'],
      skipsArtifacts: [],
      mapsToArtifact: 'plot',
    },
  ],
  artifactTypes: {
    plot: {
      id: 'plot',
      displayName: 'Plot',
      category: 'concept',
      description: 'The plot outline',
      isCollection: false,
      outputFormat: 'markdown',
      filePattern: 'plot.md',
      agentType: 'planning',
      promptFile: 'plot.md',
      isExpensive: false,
      requiresPerItemApproval: false,
      dependencies: [],
    },
    story: {
      id: 'story',
      displayName: 'Story',
      category: 'structure',
      description: 'The full story',
      isCollection: false,
      outputFormat: 'markdown',
      filePattern: 'story.md',
      agentType: 'content',
      promptFile: 'story.md',
      isExpensive: false,
      requiresPerItemApproval: false,
      dependencies: [
        { artifactTypeId: 'plot', required: true, usage: 'context' },
      ],
    },
    character: {
      id: 'character',
      displayName: 'Characters',
      category: 'entity',
      description: 'Story characters',
      isCollection: true,
      itemName: 'character',
      outputFormat: 'markdown',
      filePattern: 'characters/{{name}}.md',
      agentType: 'content',
      promptFile: 'character.md',
      isExpensive: false,
      requiresPerItemApproval: false,
      dependencies: [
        { artifactTypeId: 'story', required: true, usage: 'context' },
      ],
    },
    character_image: {
      id: 'character_image',
      displayName: 'Character Images',
      category: 'visual_ref',
      description: 'Images of characters',
      isCollection: true,
      itemName: 'character image',
      outputFormat: 'image',
      filePattern: 'assets/characters/{{name}}.png',
      agentType: 'image',
      promptFile: 'character_image.md',
      isExpensive: true,
      requiresPerItemApproval: true,
      dependencies: [
        { artifactTypeId: 'character', required: true, usage: 'reference', scope: 'matching' },
      ],
    },
    scene: {
      id: 'scene',
      displayName: 'Scenes',
      category: 'segment',
      description: 'Story scenes',
      isCollection: true,
      itemName: 'scene',
      outputFormat: 'markdown',
      filePattern: 'scenes/scene_{{index}}.md',
      agentType: 'content',
      promptFile: 'scene.md',
      isExpensive: false,
      requiresPerItemApproval: false,
      dependencies: [
        { artifactTypeId: 'story', required: true, usage: 'context' },
        { artifactTypeId: 'character', required: true, usage: 'context', scope: 'all' },
      ],
    },
    scene_image: {
      id: 'scene_image',
      displayName: 'Scene Images',
      category: 'visual_ref',
      description: 'Images for scenes',
      isCollection: true,
      itemName: 'scene image',
      outputFormat: 'image',
      filePattern: 'assets/scenes/{{name}}.png',
      agentType: 'image',
      promptFile: 'scene_image.md',
      isExpensive: true,
      requiresPerItemApproval: true,
      dependencies: [
        { artifactTypeId: 'scene', required: true, usage: 'context', scope: 'matching' },
        { artifactTypeId: 'character_image', required: true, usage: 'reference', scope: 'matching' },
      ],
    },
    final_video: {
      id: 'final_video',
      displayName: 'Final Video',
      category: 'final',
      description: 'The final assembled video',
      isCollection: false,
      outputFormat: 'video',
      filePattern: 'assets/final_video.mp4',
      agentType: 'video',
      promptFile: 'final_video.md',
      isExpensive: true,
      requiresPerItemApproval: false,
      dependencies: [
        { artifactTypeId: 'scene_image', required: true, usage: 'input', scope: 'all' },
      ],
    },
  },
  contextVariables: {
    $plot: 'plot',
    $story: 'story',
  },
  orchestratorPrompt: 'orchestrator.md',
});

const createEmptyRegistry = (): AssetRegistry => ({
  assets: new Map(),
  satisfiedArtifacts: new Map(),
  lastScanAt: Date.now(),
});

function buildExecutor(template?: VideoTemplate) {
  const t = template ?? createTestTemplate();
  const planner = new BackwardPlanner(t);
  const goal: UserGoal = {
    targetArtifacts: ['final_video'],
    preferences: {},
    description: 'Create a final video',
  };
  const registry = createEmptyRegistry();
  const plan = planner.buildPlan(goal, registry);
  return DependencyGraphExecutor.fromPlan(plan, t);
}

describe('DependencyGraphExecutor', () => {
  let template: VideoTemplate;

  beforeEach(() => {
    template = createTestTemplate();
  });

  describe('fromPlan', () => {
    it('creates nodes for all plan steps', () => {
      const executor = buildExecutor(template);
      const nodes = executor.getAllNodes();
      // Should have all 7 artifact types as nodes
      expect(nodes.length).toBe(7);
    });

    it('all nodes start as pending', () => {
      const executor = buildExecutor(template);
      for (const node of executor.getAllNodes()) {
        expect(node.status).toBe('pending');
      }
    });
  });

  describe('getNextReady', () => {
    it('returns only root nodes (no dependencies) initially', () => {
      const executor = buildExecutor(template);
      const ready = executor.getNextReady();
      expect(ready.length).toBe(1);
      expect(ready[0].typeId).toBe('plot');
    });

    it('returns story after plot completes', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markCompleted('plot', 'plot.md');

      const ready = executor.getNextReady();
      expect(ready.length).toBe(1);
      expect(ready[0].typeId).toBe('story');
    });

    it('collection nodes are not returned by getNextReady (must be expanded first)', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markCompleted('plot', 'plot.md');
      executor.markStarted('story');
      executor.markCompleted('story', 'story.md');

      const ready = executor.getNextReady();
      const typeIds = ready.map(n => n.typeId).sort();
      // character and scene are collection nodes (isCollection=true, no itemId)
      // so they are skipped by getNextReady — they must be expanded into per-item nodes first
      expect(typeIds).toEqual([]);
    });

    it('returns no nodes when all are completed', () => {
      const executor = buildExecutor(template);
      // Complete everything in order
      for (const typeId of ['plot', 'story', 'character', 'character_image', 'scene', 'scene_image', 'final_video']) {
        executor.markStarted(typeId);
        executor.markCompleted(typeId);
      }
      expect(executor.getNextReady()).toEqual([]);
      expect(executor.isComplete()).toBe(true);
    });
  });

  describe('markCompleted', () => {
    it('returns newly ready dependents', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      const newlyReady = executor.markCompleted('plot', 'plot.md');
      expect(newlyReady.length).toBe(1);
      expect(newlyReady[0].typeId).toBe('story');
    });

    it('stores outputPath and artifactId', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markCompleted('plot', 'plans/plot.md', 'artifact_123');

      const node = executor.getNode('plot');
      expect(node?.outputPath).toBe('plans/plot.md');
      expect(node?.artifactId).toBe('artifact_123');
      expect(node?.completedAt).toBeDefined();
    });
  });

  describe('markFailed', () => {
    it('sets error and failed status', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markFailed('plot', 'LLM call failed');

      const node = executor.getNode('plot');
      expect(node?.status).toBe('failed');
      expect(node?.error).toBe('LLM call failed');
    });

    it('blocks dependents from becoming ready', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markFailed('plot', 'failed');

      const ready = executor.getNextReady();
      expect(ready).toEqual([]);
    });
  });

  describe('getSummary', () => {
    it('GIVEN one failed node WHEN getSummary runs THEN summary surfaces the node displayName and its error message', () => {
      // Why this matters: getSummary() is one of two paths through which
      // executor failure reaches the user's chat. When story_essence
      // fails with "402 Credits exhausted", a generic "Status: Blocked"
      // line tells the user nothing actionable. The displayName + error
      // pair is the minimum information needed to diagnose.
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markFailed(
        'plot',
        'LLM generate failed (model=Qwen3.5-9B-HighIQ-Heretic): 402 "Credits exhausted"',
      );

      const summary = executor.getSummary();

      // Failed-count rollup line still present.
      expect(summary).toContain('Failed: 1 node(s)');
      // Node identity (displayName) + the actual error string.
      expect(summary).toContain('Plot');
      expect(summary).toContain('402');
      expect(summary).toContain('Credits exhausted');
    });

    it('GIVEN multiple failed nodes WHEN getSummary runs THEN every failure is listed with its own error', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markFailed('plot', 'plot LLM 402');
      // story depends on plot but markFailed allows independent failures
      // for collection items; emulate by failing plot and a sibling.
      executor.markStarted('story');
      executor.markFailed('story', 'story timeout after 90s');

      const summary = executor.getSummary();

      expect(summary).toContain('plot LLM 402');
      expect(summary).toContain('story timeout after 90s');
    });

    it('GIVEN no failed nodes WHEN getSummary runs THEN no failure listing appears', () => {
      const executor = buildExecutor(template);
      const summary = executor.getSummary();
      expect(summary).not.toMatch(/Failed:/);
    });
  });

  describe('invalidateNode (redo)', () => {
    it('resets the target node and all downstream dependents', () => {
      const executor = buildExecutor(template);

      // Complete the whole chain: plot → story → character
      executor.markStarted('plot');
      executor.markCompleted('plot', 'plot.md');
      executor.markStarted('story');
      executor.markCompleted('story', 'story.md');
      executor.markStarted('character');
      executor.markCompleted('character', 'chars.md');

      // Invalidate story — should cascade to character (and beyond)
      const invalidated = executor.invalidateNode('story');
      const invalidatedIds = invalidated.map(n => n.id).sort();

      expect(invalidatedIds).toContain('story');
      expect(invalidatedIds).toContain('character');
      // scene also depends on story
      expect(invalidatedIds).toContain('scene');

      // story should now be pending, plot should still be completed
      expect(executor.getNode('story')?.status).toBe('pending');
      expect(executor.getNode('plot')?.status).toBe('completed');

      // story should be the next ready node (its dep — plot — is still completed)
      const ready = executor.getNextReady();
      expect(ready.length).toBe(1);
      expect(ready[0].typeId).toBe('story');
    });

    it('clears completedAt on the executor', () => {
      const executor = buildExecutor(template);
      // Complete everything
      for (const typeId of ['plot', 'story', 'character', 'character_image', 'scene', 'scene_image', 'final_video']) {
        executor.markStarted(typeId);
        executor.markCompleted(typeId);
      }
      expect(executor.isComplete()).toBe(true);

      executor.invalidateNode('story');
      expect(executor.isComplete()).toBe(false);
    });

    it('cascadeOnlyCompleted skips pending dependents but invalidates completed ones', () => {
      const executor = buildExecutor(template);

      // Complete plot, story, character — but leave character_image and scene pending
      executor.markStarted('plot');
      executor.markCompleted('plot');
      executor.markStarted('story');
      executor.markCompleted('story');
      executor.markStarted('character');
      executor.markCompleted('character');
      // character_image, scene, scene_image, final_video remain pending

      const invalidated = executor.invalidateNode('story', {
        cascade: true,
        cascadeOnlyCompleted: true,
      });
      const invalidatedIds = invalidated.map(n => n.id).sort();

      // Target + completed dependents are invalidated
      expect(invalidatedIds).toContain('story');
      expect(invalidatedIds).toContain('character');
      // Pending dependents (and their downstream) are left alone
      expect(invalidatedIds).not.toContain('character_image');
      expect(invalidatedIds).not.toContain('scene');
      expect(invalidatedIds).not.toContain('final_video');

      // Pending nodes remain pending (unchanged)
      expect(executor.getNode('character_image')?.status).toBe('pending');
      expect(executor.getNode('scene')?.status).toBe('pending');
    });
  });

  describe('expandCollection', () => {
    it('replaces type-level node with per-item nodes', () => {
      const executor = buildExecutor(template);

      // Complete up to character being ready
      executor.markStarted('plot');
      executor.markCompleted('plot');
      executor.markStarted('story');
      executor.markCompleted('story');

      // Expand character into alice and bob
      const newNodes = executor.expandCollection('character', [
        { itemId: 'alice', name: 'Alice' },
        { itemId: 'bob', name: 'Bob' },
      ]);

      expect(newNodes.length).toBe(2);
      expect(executor.getNode('character')).toBeUndefined(); // old node removed
      expect(executor.getNode('character:alice')).toBeDefined();
      expect(executor.getNode('character:bob')).toBeDefined();

      // Per-item nodes should inherit the original dependencies
      expect(executor.getNode('character:alice')?.dependencies).toContain('story');
      expect(executor.getNode('character:bob')?.dependencies).toContain('story');
    });

    it('newly created item nodes are ready if dependencies are completed', () => {
      const executor = buildExecutor(template);

      executor.markStarted('plot');
      executor.markCompleted('plot');
      executor.markStarted('story');
      executor.markCompleted('story');

      executor.expandCollection('character', [
        { itemId: 'alice', name: 'Alice' },
      ]);

      const ready = executor.getNextReady();
      const readyIds = ready.map(n => n.id);
      expect(readyIds).toContain('character:alice');
    });

    it('rewires matching-scope dependents to per-item nodes', () => {
      const executor = buildExecutor(template);

      executor.markStarted('plot');
      executor.markCompleted('plot');
      executor.markStarted('story');
      executor.markCompleted('story');

      // Expand character — character_image has matching scope on character
      executor.expandCollection('character', [
        { itemId: 'alice', name: 'Alice' },
        { itemId: 'bob', name: 'Bob' },
      ]);

      // character_image should now also be expanded into per-item nodes
      expect(executor.getNode('character_image')).toBeUndefined(); // old node removed
      expect(executor.getNode('character_image:alice')).toBeDefined();
      expect(executor.getNode('character_image:bob')).toBeDefined();

      // character_image:alice should depend on character:alice
      expect(executor.getNode('character_image:alice')?.dependencies).toContain('character:alice');
    });
  });

  describe('getProgress', () => {
    it('returns correct counts', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markCompleted('plot');
      executor.markStarted('story');

      const progress = executor.getProgress();
      expect(progress.completed).toBe(1);
      expect(progress.inProgress).toBe(1);
      expect(progress.pending).toBe(5);
      expect(progress.total).toBe(7);
    });
  });

  describe('serialization (session resume)', () => {
    it('round-trips through getState/fromState', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markCompleted('plot', 'plot.md', 'art_1');

      const state = executor.getState();
      const restored = DependencyGraphExecutor.fromState(state, template);

      // Restored executor should have same state
      expect(restored.getNode('plot')?.status).toBe('completed');
      expect(restored.getNode('plot')?.outputPath).toBe('plot.md');
      expect(restored.getNode('story')?.status).toBe('pending');

      // getNextReady should return story
      const ready = restored.getNextReady();
      expect(ready.length).toBe(1);
      expect(ready[0].typeId).toBe('story');
    });
  });

  describe('producesCollectionItems', () => {
    it('returns true for nodes with collection dependents', () => {
      const executor = buildExecutor(template);
      const storyNode = executor.getNode('story')!;
      // story has character (collection) and scene (collection) as dependents
      expect(executor.producesCollectionItems(storyNode)).toBe(true);
    });

    it('returns false for leaf nodes', () => {
      const executor = buildExecutor(template);
      const finalNode = executor.getNode('final_video')!;
      expect(executor.producesCollectionItems(finalNode)).toBe(false);
    });
  });

  describe('recursive cascade expansion', () => {
    // Template with scene → scene_video_prompt → shot_image_prompt chain
    // scene_image depends on shot_image_prompt (matching), final_video depends on scene_image
    const createCascadeTemplate = (): VideoTemplate => {
      const base = createTestTemplate();
      return {
        ...base,
        artifactTypes: {
          plot: base.artifactTypes.plot,
          story: base.artifactTypes.story,
          character: base.artifactTypes.character,
          scene: {
            ...base.artifactTypes.scene,
            dependencies: [
              { artifactTypeId: 'story', required: true, usage: 'context' },
            ],
          },
          scene_video_prompt: {
            id: 'scene_video_prompt',
            displayName: 'Motion Prompts',
            category: 'structure',
            description: 'Shot breakdown',
            isCollection: true,
            itemName: 'motion prompt',
            outputFormat: 'markdown',
            filePattern: 'prompts/videos/{{name}}.motion.md',
            agentType: 'content',
            promptFile: 'svp.md',
            isExpensive: false,
            requiresPerItemApproval: false,
            dependencies: [
              { artifactTypeId: 'scene', required: true, usage: 'context', scope: 'matching' },
            ],
          },
          shot_image_prompt: {
            id: 'shot_image_prompt',
            displayName: 'Shot Image Prompts',
            category: 'structure',
            description: 'Per-shot image prompts',
            isCollection: true,
            itemName: 'shot prompt',
            outputFormat: 'markdown',
            filePattern: 'prompts/images/shots/scene-{{index}}-shot-{{subindex}}.prompt.md',
            agentType: 'content',
            promptFile: 'sip.md',
            isExpensive: false,
            requiresPerItemApproval: false,
            dependencies: [
              { artifactTypeId: 'scene_video_prompt', required: true, usage: 'context', scope: 'matching' },
            ],
          },
          scene_image: {
            ...base.artifactTypes.scene_image,
            dependencies: [
              { artifactTypeId: 'shot_image_prompt', required: true, usage: 'context', scope: 'matching' },
            ],
          },
          final_video: {
            ...base.artifactTypes.final_video,
            dependencies: [
              { artifactTypeId: 'scene_image', required: true, usage: 'input', scope: 'all' },
            ],
          },
        },
      };
    };

    it('cascades scene expansion through scene_video_prompt to shot_image_prompt', () => {
      const t = createCascadeTemplate();
      const executor = buildExecutor(t);

      // Complete prerequisites
      executor.markStarted('plot');
      executor.markCompleted('plot');
      executor.markStarted('story');
      executor.markCompleted('story');

      // Expand scenes — should cascade to scene_video_prompt AND shot_image_prompt
      executor.expandCollection('scene', [
        { itemId: 'scene_1', name: 'Scene 1' },
        { itemId: 'scene_2', name: 'Scene 2' },
      ]);

      // scene_video_prompt should be expanded per-scene
      expect(executor.getNode('scene_video_prompt')).toBeUndefined();
      expect(executor.getNode('scene_video_prompt:scene_1')).toBeDefined();
      expect(executor.getNode('scene_video_prompt:scene_2')).toBeDefined();

      // shot_image_prompt should ALSO be expanded per-scene (recursive cascade)
      expect(executor.getNode('shot_image_prompt')).toBeUndefined();
      expect(executor.getNode('shot_image_prompt:scene_1')).toBeDefined();
      expect(executor.getNode('shot_image_prompt:scene_2')).toBeDefined();

      // shot_image_prompt:scene_1 should depend on scene_video_prompt:scene_1
      expect(executor.getNode('shot_image_prompt:scene_1')?.dependencies).toContain('scene_video_prompt:scene_1');
    });

    it('allows per-shot expansion of shot_image_prompt:scene_N', () => {
      const t = createCascadeTemplate();
      const executor = buildExecutor(t);

      executor.markStarted('plot');
      executor.markCompleted('plot');
      executor.markStarted('story');
      executor.markCompleted('story');

      // First expansion: scenes
      executor.expandCollection('scene', [
        { itemId: 'scene_1', name: 'Scene 1' },
      ]);

      // Verify shot_image_prompt:scene_1 exists and is a collection
      const sipNode = executor.getNode('shot_image_prompt:scene_1');
      expect(sipNode).toBeDefined();
      expect(sipNode?.isCollection).toBe(true);

      // Second expansion: shots within scene_1
      executor.expandCollection('shot_image_prompt:scene_1', [
        { itemId: 'scene_1_shot_1', name: 'Shot 1' },
        { itemId: 'scene_1_shot_2', name: 'Shot 2' },
        { itemId: 'scene_1_shot_3', name: 'Shot 3' },
      ]);

      // Per-shot nodes should exist
      expect(executor.getNode('shot_image_prompt:scene_1')).toBeUndefined(); // replaced
      expect(executor.getNode('shot_image_prompt:scene_1_shot_1')).toBeDefined();
      expect(executor.getNode('shot_image_prompt:scene_1_shot_2')).toBeDefined();
      expect(executor.getNode('shot_image_prompt:scene_1_shot_3')).toBeDefined();

      // Each should depend on scene_video_prompt:scene_1
      expect(executor.getNode('shot_image_prompt:scene_1_shot_1')?.dependencies).toContain('scene_video_prompt:scene_1');
    });
  });

  describe('media node determinism', () => {
    it('marks node as failed when media generation returns null (not completed with prompt path)', () => {
      const executor = buildExecutor(template);
      executor.markStarted('plot');
      executor.markCompleted('plot');
      executor.markStarted('story');
      executor.markCompleted('story');
      executor.markStarted('character');
      executor.markCompleted('character');

      // Simulate: character_image starts, LLM writes prompt, media gen fails
      executor.markStarted('character_image');
      // If media fails, it should be markFailed not markCompleted
      executor.markFailed('character_image', 'Media generation failed');

      expect(executor.getNode('character_image')?.status).toBe('failed');
      // Dependents should not be ready
      expect(executor.getNextReady().map(n => n.typeId)).not.toContain('scene_image');
    });
  });
});
