/**
 * Integration test for the shot_video dep-graph expansion bug
 * (`todos/shot-video-dep-expansion-bug.md`).
 *
 * Scenario:
 *   1. shot_video is expanded scene-by-scene → shot_video:scene_1 etc.
 *   2. shot_motion_directive:scene_1 is per-shot-expanded into N items.
 *      As a side effect, shot_video:scene_1 (matching dependent) accumulates
 *      per-item refs to ALL N motion directives.
 *   3. expandMatchingDependent then runs on shot_video:scene_1 to create
 *      shot_video:scene_1_shot_K nodes.
 *
 * Bug: every per-shot clone inherited ALL N motion-directive per-item
 * refs (because `preRewire` snapshot reused the polluted parent deps
 * unchanged). The filter in `filterMismatchedPerItemDeps` is supposed to
 * strip those per-shot.
 *
 * Expected: each shot_video:scene_X_shot_K has exactly ONE
 * shot_motion_directive ref — the matching one — and the matching
 * shot_image ref. No sibling pollution.
 */
import { describe, it, expect } from 'vitest';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import type { VideoTemplate } from '../../src/core/templates/types.js';
import type { ExecutionNode } from '../../src/core/planner/types.js';

function shotVideoTemplate(): VideoTemplate {
  return {
    id: 'shot_video_test',
    displayName: 'Shot Video Test',
    description: 'shot_image, shot_motion_directive, shot_video — matching scopes',
    version: '1.0.0',
    defaultStyle: 'default',
    styles: [
      { id: 'default', displayName: 'Default', description: '', promptModifiers: [], negativePrompt: [] },
    ],
    inputTypes: [
      { id: 'idea', displayName: 'Idea', description: '', examples: [], skipsArtifacts: [], mapsToArtifact: 'story' },
    ],
    artifactTypes: {
      shot_image: {
        id: 'shot_image',
        displayName: 'Shot Images',
        category: 'visual_ref',
        description: '',
        isCollection: true,
        itemName: 'shot image',
        outputFormat: 'image',
        filePattern: 'assets/images/shots/{{name}}.png',
        agentType: 'image',
        promptFile: 'shot_image.md',
        isExpensive: true,
        requiresPerItemApproval: false,
        dependencies: [],
      },
      shot_motion_directive: {
        id: 'shot_motion_directive',
        displayName: 'Shot Motion Directives',
        category: 'concept',
        description: '',
        isCollection: true,
        itemName: 'shot motion directive',
        outputFormat: 'markdown',
        filePattern: 'prompts/videos/shots/{{name}}.md',
        agentType: 'content',
        promptFile: 'shot_motion_directive.md',
        isExpensive: false,
        requiresPerItemApproval: false,
        dependencies: [],
      },
      shot_video: {
        id: 'shot_video',
        displayName: 'Shot Videos',
        category: 'clip',
        description: '',
        isCollection: true,
        itemName: 'shot video',
        outputFormat: 'video',
        filePattern: 'assets/videos/shots/{{name}}.mp4',
        agentType: 'video',
        promptFile: 'shot_video.md',
        isExpensive: true,
        requiresPerItemApproval: true,
        dependencies: [
          { artifactTypeId: 'shot_image', required: true, usage: 'input', scope: 'matching' },
          { artifactTypeId: 'shot_motion_directive', required: true, usage: 'context', scope: 'matching' },
        ],
      },
    },
    contextVariables: {},
    orchestratorPrompt: 'orchestrator.md',
  };
}

function makeNode(partial: Partial<ExecutionNode> & Pick<ExecutionNode, 'id' | 'typeId'>): ExecutionNode {
  return {
    status: 'pending',
    displayName: partial.id,
    isExpensive: false,
    isCollection: false,
    dependencies: [],
    dependents: [],
    ...partial,
  } as ExecutionNode;
}

describe('shot_video expansion — sibling-dep pollution stripped (Ruby V3 bug)', () => {
  it('per-shot shot_video clones get only their matching motion + image deps, not all of scene 1\'s', () => {
    const tpl = shotVideoTemplate();

    // Manually construct the polluted pre-expansion state: shot_video:scene_1
    // is a collection-level node that has already absorbed all of scene 1's
    // per-shot motion-directive refs (the sibling-pollution scenario).
    const shots = [1, 2, 3];
    const nodes = new Map<string, ExecutionNode>();

    // Per-shot motion directives (already expanded by a prior cascade).
    for (const k of shots) {
      const id = `shot_motion_directive:scene_1_shot_${k}`;
      nodes.set(id, makeNode({
        id,
        typeId: 'shot_motion_directive',
        itemId: `scene_1_shot_${k}`,
        isCollection: false,
      }));
    }

    // Per-shot shot_image already exists (we want rewire to grab them).
    for (const k of shots) {
      const id = `shot_image:scene_1_shot_${k}`;
      nodes.set(id, makeNode({
        id,
        typeId: 'shot_image',
        itemId: `scene_1_shot_${k}`,
        isCollection: false,
      }));
    }

    // shot_video:scene_1 — collection-level, polluted with all 3 motion directives
    // (sibling refs) plus the bare 'shot_image' type-level dep that didn't get
    // rewired yet.
    nodes.set('shot_video:scene_1', makeNode({
      id: 'shot_video:scene_1',
      typeId: 'shot_video',
      itemId: 'scene_1',
      isCollection: true,
      dependencies: [
        'shot_image', // bare type-level
        ...shots.map(k => `shot_motion_directive:scene_1_shot_${k}`),
      ],
    }));

    // shot_motion_directive (type-level) — placeholder so the executor has
    // a node to call expandCollection on. Its dependents include shot_video.
    nodes.set('shot_motion_directive', makeNode({
      id: 'shot_motion_directive',
      typeId: 'shot_motion_directive',
      isCollection: true,
      dependents: ['shot_video:scene_1'],
    }));

    const nodesRecord: Record<string, ExecutionNode> = {};
    for (const [id, n] of nodes) nodesRecord[id] = n;

    const exec = DependencyGraphExecutor.fromState(
      {
        nodes: nodesRecord,
        targetArtifacts: ['shot_video'],
        goalDescription: 'shot_video dep test',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
      tpl,
    );

    // Now expand shot_video:scene_1 into per-shot. The bug reproduces if we
    // expand it directly (i.e. call expandCollection on the collection-level
    // shot_video:scene_1 with per-shot items). In production this happens
    // via the cascade. Either path uses expandMatchingDependent.
    const items = shots.map(k => ({ itemId: `scene_1_shot_${k}`, name: `Shot ${k}` }));
    exec.expandCollection('shot_video:scene_1', items);

    // Assertion: each per-shot clone has matching deps only.
    for (const k of shots) {
      const node = exec.getNode(`shot_video:scene_1_shot_${k}`);
      expect(node, `shot_video:scene_1_shot_${k} should exist`).toBeDefined();
      const deps = node!.dependencies;

      // Must include the matching motion directive
      expect(deps).toContain(`shot_motion_directive:scene_1_shot_${k}`);
      // Must include the matching shot_image
      expect(deps).toContain(`shot_image:scene_1_shot_${k}`);

      // Must NOT contain any other shot's motion directive or shot_image
      for (const other of shots) {
        if (other === k) continue;
        expect(deps).not.toContain(`shot_motion_directive:scene_1_shot_${other}`);
        expect(deps).not.toContain(`shot_image:scene_1_shot_${other}`);
      }
    }
  });
});
