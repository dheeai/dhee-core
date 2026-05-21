/**
 * Integration-flavoured test for the executor's per-shot reconciliation
 * pass — verifies that when scene_shot_plan completes with a plan
 * containing fewer shots than the existing graph has, the orphan
 * per-shot chain (shot_breakdown:scene_N_shot_M and its 5 downstream
 * nodes) is removed.
 *
 * Drives the private `reconcilePerShotChildrenForScene` method through
 * a thin cast so the test exercises the same path the expand-loop fires
 * in production. Pure decision logic is covered separately in
 * tests/unit/reconcileShotPlan.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { ExecutorAgent } from '../../src/core/planner/ExecutorAgent.js';
import type { ExecutionNode, ExecutorState } from '../../src/core/planner/types.js';
import { PER_SHOT_NODE_TYPES } from '../../src/core/planner/reconcileShotPlan.js';

const template = {
  id: 'narrative',
  name: 'Narrative',
  version: '1.0',
  description: 'test',
  artifactTypes: {
    scene_shot_plan: {
      id: 'scene_shot_plan',
      displayName: 'Scene Shot Plan',
      category: 'structure',
      isCollection: true,
      isExpensive: false,
      dependencies: [],
    },
    shot_breakdown: {
      id: 'shot_breakdown',
      displayName: 'Shot Breakdown',
      category: 'structure',
      isCollection: true,
      isExpensive: false,
      dependencies: [],
    },
    shot_image_prompt: {
      id: 'shot_image_prompt',
      displayName: 'Shot Image Prompt',
      category: 'structure',
      isCollection: true,
      isExpensive: false,
      dependencies: [],
    },
    shot_image: {
      id: 'shot_image',
      displayName: 'Shot Image',
      category: 'visual_ref',
      isCollection: true,
      isExpensive: true,
      dependencies: [],
    },
    shot_image_last_frame: {
      id: 'shot_image_last_frame',
      displayName: 'Shot Last Frame',
      category: 'visual_ref',
      isCollection: true,
      isExpensive: true,
      dependencies: [],
    },
    shot_motion_directive: {
      id: 'shot_motion_directive',
      displayName: 'Shot Motion',
      category: 'structure',
      isCollection: true,
      isExpensive: false,
      dependencies: [],
    },
    shot_video: {
      id: 'shot_video',
      displayName: 'Shot Video',
      category: 'clip',
      isCollection: true,
      isExpensive: true,
      dependencies: [],
    },
  },
  phases: [],
  constraints: {},
  contextVariables: {},
} as any;

function makeState(nodes: Record<string, Partial<ExecutionNode>>): ExecutorState {
  const fullNodes: Record<string, ExecutionNode> = {};
  for (const [id, partial] of Object.entries(nodes)) {
    fullNodes[id] = {
      id,
      typeId: partial.typeId ?? id.split(':')[0]!,
      status: partial.status ?? 'pending',
      displayName: partial.displayName ?? id,
      isExpensive: false,
      isCollection: partial.isCollection ?? false,
      dependencies: partial.dependencies ?? [],
      dependents: partial.dependents ?? [],
      itemId: partial.itemId,
      ...partial,
    } as ExecutionNode;
  }
  return {
    nodes: fullNodes,
    targetArtifacts: ['final_video'],
    goalDescription: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as ExecutorState;
}

function buildExpandedSceneGraph(shotCount: number): Record<string, Partial<ExecutionNode>> {
  const nodes: Record<string, Partial<ExecutionNode>> = {
    'scene_shot_plan:scene_1': {
      typeId: 'scene_shot_plan',
      itemId: 'scene_1',
      status: 'completed',
      outputPath: 'prompts/videos/scenes/scene_1.plan.json',
      isCollection: false,
    },
  };
  for (let shot = 1; shot <= shotCount; shot += 1) {
    const itemId = `scene_1_shot_${shot}`;
    for (const typeId of PER_SHOT_NODE_TYPES) {
      nodes[`${typeId}:${itemId}`] = {
        typeId,
        itemId,
        status: 'pending',
        isCollection: false,
      };
    }
  }
  return nodes;
}

function createAgent(projectDir: string, nodes: Record<string, Partial<ExecutionNode>>) {
  return new ExecutorAgent({} as any, {
    template,
    project: {
      id: 'test-project',
      title: 'Test',
      executorState: makeState(nodes),
    } as any,
    projectDir,
    goal: {
      description: 'test goal',
      targetArtifacts: ['final_video'],
      preferences: { duration: 12 },
    } as any,
    name: 'test-executor',
    skipMediaGeneration: true,
  });
}

function writePlan(projectDir: string, shotCount: number): void {
  const dir = join(projectDir, 'prompts', 'videos', 'scenes');
  mkdirSync(dir, { recursive: true });
  const plan = {
    sceneNumber: 1,
    sceneTitle: 'Test scene',
    totalDuration: shotCount * 4,
    mainSubject: 'protagonist',
    shotPlan: Array.from({ length: shotCount }, (_, i) => ({
      shotNumber: i + 1,
      purpose: `purpose ${i + 1}`,
      duration: 4,
      oneLineSummary: `summary ${i + 1}`,
    })),
  };
  writeFileSync(join(dir, 'scene_1.plan.json'), JSON.stringify(plan, null, 2));
}

describe('ExecutorAgent.reconcilePerShotChildrenForScene', () => {
  it('prunes the full per-shot chain when the new plan has fewer shots than the graph', () => {
    // Plan shrunk from 8 shots → 7.
    const projectDir = mkdtempSync(join(tmpdir(), 'kshana-reconcile-prune-'));
    writePlan(projectDir, 7);
    const agent = createAgent(projectDir, buildExpandedSceneGraph(8));

    const planNode = (agent as any).executor.getNode('scene_shot_plan:scene_1');
    const mutated = (agent as any).reconcilePerShotChildrenForScene(planNode, 'scene_1');

    expect(mutated).toBe(true);
    // Shot 8's full chain is gone.
    for (const typeId of PER_SHOT_NODE_TYPES) {
      expect((agent as any).executor.getNode(`${typeId}:scene_1_shot_8`)).toBeUndefined();
    }
    // Shots 1-7's chains survive untouched.
    for (let shot = 1; shot <= 7; shot += 1) {
      for (const typeId of PER_SHOT_NODE_TYPES) {
        expect((agent as any).executor.getNode(`${typeId}:scene_1_shot_${shot}`)).toBeDefined();
      }
    }
  });

  it('is a no-op when graph and plan agree', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'kshana-reconcile-noop-'));
    writePlan(projectDir, 5);
    const agent = createAgent(projectDir, buildExpandedSceneGraph(5));

    const planNode = (agent as any).executor.getNode('scene_shot_plan:scene_1');
    const mutated = (agent as any).reconcilePerShotChildrenForScene(planNode, 'scene_1');

    expect(mutated).toBe(false);
    for (let shot = 1; shot <= 5; shot += 1) {
      for (const typeId of PER_SHOT_NODE_TYPES) {
        expect((agent as any).executor.getNode(`${typeId}:scene_1_shot_${shot}`)).toBeDefined();
      }
    }
  });

  it('is a no-op when the plan file is missing or malformed', () => {
    // No plan written — the file lookup fails and reconcile must
    // leave the graph alone rather than wiping every shot.
    const projectDir = mkdtempSync(join(tmpdir(), 'kshana-reconcile-malformed-'));
    const agent = createAgent(projectDir, buildExpandedSceneGraph(3));

    const planNode = (agent as any).executor.getNode('scene_shot_plan:scene_1');
    const mutated = (agent as any).reconcilePerShotChildrenForScene(planNode, 'scene_1');

    expect(mutated).toBe(false);
    for (let shot = 1; shot <= 3; shot += 1) {
      expect(
        (agent as any).executor.getNode(`shot_breakdown:scene_1_shot_${shot}`),
      ).toBeDefined();
    }
  });

  it('spawns the full per-shot chain for shots the new plan adds', () => {
    // Plan grew from 3 shots → 5. Graph already has chains for shots
    // 1-3; reconciliation must materialise the chain for 4 and 5.
    const projectDir = mkdtempSync(join(tmpdir(), 'kshana-reconcile-grow-'));
    writePlan(projectDir, 5);
    const graph = buildExpandedSceneGraph(3);
    // Seed the assembler in 'failed' state — that's what the runtime
    // looks like when the previous assembly rejected the inputs.
    graph['scene_video_prompt:scene_1'] = {
      typeId: 'scene_video_prompt',
      itemId: 'scene_1',
      status: 'failed',
      isCollection: false,
      dependencies: [
        'scene_shot_plan:scene_1',
        'shot_breakdown:scene_1_shot_1',
        'shot_breakdown:scene_1_shot_2',
        'shot_breakdown:scene_1_shot_3',
      ],
    };
    // Stub the world_style + character_image upstream nodes the
    // spawned chain wires onto. Without these, the wireUpstream
    // helper silently no-ops (parent missing) which is fine but
    // makes the test's behaviour fuzzier — pin them so the test
    // verifies the bidirectional wiring too.
    graph['world_style'] = {
      typeId: 'world_style',
      status: 'completed',
      isCollection: false,
    };
    const agent = createAgent(projectDir, graph);

    const planNode = (agent as any).executor.getNode('scene_shot_plan:scene_1');
    const mutated = (agent as any).reconcilePerShotChildrenForScene(planNode, 'scene_1');

    expect(mutated).toBe(true);
    // Shots 4 + 5: every per-shot type now in the graph.
    for (const shot of [4, 5]) {
      for (const typeId of PER_SHOT_NODE_TYPES) {
        const node = (agent as any).executor.getNode(`${typeId}:scene_1_shot_${shot}`);
        expect(node).toBeDefined();
        expect(node.status).toBe('pending');
      }
    }
    // scene_video_prompt: now depends on the new shot_breakdown nodes too.
    const svp = (agent as any).executor.getNode('scene_video_prompt:scene_1');
    expect(svp.dependencies).toContain('shot_breakdown:scene_1_shot_4');
    expect(svp.dependencies).toContain('shot_breakdown:scene_1_shot_5');
    // scene_video_prompt: was 'failed', should be reset to 'pending'
    // so the assembler retries once the new shot_breakdowns complete.
    expect(svp.status).toBe('pending');
    // world_style picked up the new shot_breakdown dependents.
    const ws = (agent as any).executor.getNode('world_style');
    expect(ws.dependents).toContain('shot_breakdown:scene_1_shot_4');
    expect(ws.dependents).toContain('shot_breakdown:scene_1_shot_5');
  });

  it('does not touch other scenes\' per-shot chains', () => {
    // Two scenes, scene_1 plan shrunk; scene_2 plan stays — its chain
    // must not get caught in scene_1's prune sweep.
    const projectDir = mkdtempSync(join(tmpdir(), 'kshana-reconcile-isolation-'));
    writePlan(projectDir, 4);
    const graph: Record<string, Partial<ExecutionNode>> = {
      ...buildExpandedSceneGraph(6), // scene_1: 6 shots in graph
    };
    // Add scene_2 with 3 shots.
    for (let shot = 1; shot <= 3; shot += 1) {
      const itemId = `scene_2_shot_${shot}`;
      for (const typeId of PER_SHOT_NODE_TYPES) {
        graph[`${typeId}:${itemId}`] = {
          typeId,
          itemId,
          status: 'pending',
          isCollection: false,
        };
      }
    }
    const agent = createAgent(projectDir, graph);

    const planNode = (agent as any).executor.getNode('scene_shot_plan:scene_1');
    (agent as any).reconcilePerShotChildrenForScene(planNode, 'scene_1');

    // scene_1 shots 5-6 pruned; 1-4 kept.
    for (let shot = 5; shot <= 6; shot += 1) {
      expect((agent as any).executor.getNode(`shot_breakdown:scene_1_shot_${shot}`)).toBeUndefined();
    }
    // scene_2 untouched.
    for (let shot = 1; shot <= 3; shot += 1) {
      for (const typeId of PER_SHOT_NODE_TYPES) {
        expect((agent as any).executor.getNode(`${typeId}:scene_2_shot_${shot}`)).toBeDefined();
      }
    }
  });
});
