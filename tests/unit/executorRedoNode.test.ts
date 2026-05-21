/**
 * Surgical-regeneration contracts for `DependencyGraphExecutor.invalidateNode`.
 *
 * These tests pin the behavior the desktop's per-asset regenerate buttons
 * (first_frame, last_frame, video, prompt) depend on. Each test names the
 * `ExecutorAgent.redoNode(...)` mode it corresponds to and asserts on the
 * resulting graph state.
 *
 * Why driven via the primitive (`DependencyGraphExecutor.invalidateNode`)
 * instead of `ExecutorAgent.redoNode`: the ExecutorAgent constructor runs
 * a graph-migration pass that prunes any node deps not declared in the
 * supplied template, then cascade-invalidates affected nodes. A
 * test-sized template would either have to mirror the whole real
 * narrative template's dep graph or accept that fixtures get rewritten
 * during construction. The primitive is what redoNode delegates to — the
 * option payloads asserted below match exactly what redoNode passes (see
 * ExecutorAgent.ts lines 1041-1130).
 *
 * Phase 1.5 (this branch): scope:'prompt' is changed from
 *   invalidateNode(shotImageNodeId, { cascade: false })
 * to
 *   invalidateNode(shotImageNodeId, { cascade: true, cascadeOnlyCompleted: true })
 * so that a prompt re-roll dirties the already-completed downstream
 * shot_video. The "prompt re-roll" test below asserts that post-change
 * shape and is intended to be Red until that line is updated.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DependencyGraphExecutor } from '../../src/core/planner/DependencyGraphExecutor.js';
import { ExecutorAgent } from '../../src/core/planner/ExecutorAgent.js';
import type { ExecutionNode, ExecutorState } from '../../src/core/planner/types.js';
import type { VideoTemplate } from '../../src/core/templates/types.js';

const minimalTemplate: VideoTemplate = {
  id: 'test-narrative',
  name: 'Test Narrative',
  version: '1.0',
  description: 'minimal template for redoNode contract tests',
  artifactTypes: {
    shot_image_prompt: {
      id: 'shot_image_prompt',
      displayName: 'Shot Image Prompt',
      category: 'structure',
      isCollection: false,
      isExpensive: false,
      dependencies: [],
    },
    shot_image: {
      id: 'shot_image',
      displayName: 'Shot Image',
      category: 'visual_ref',
      isCollection: false,
      isExpensive: true,
      dependencies: [
        { artifactTypeId: 'shot_image_prompt', required: true, usage: 'input', scope: 'matching' },
      ],
    },
    shot_video: {
      id: 'shot_video',
      displayName: 'Shot Video',
      category: 'clip',
      isCollection: false,
      isExpensive: true,
      dependencies: [
        { artifactTypeId: 'shot_image', required: true, usage: 'input', scope: 'matching' },
      ],
    },
    final_video: {
      id: 'final_video',
      displayName: 'Final Video',
      category: 'output',
      isCollection: false,
      isExpensive: true,
      dependencies: [
        { artifactTypeId: 'shot_video', required: true, usage: 'input', scope: 'matching' },
      ],
    },
  },
  phases: [],
  constraints: {},
  contextVariables: {},
} as unknown as VideoTemplate;

function node(partial: Partial<ExecutionNode> & Pick<ExecutionNode, 'id' | 'typeId'>): ExecutionNode {
  return {
    status: 'completed',
    displayName: partial.id,
    isExpensive: false,
    isCollection: false,
    dependencies: [],
    dependents: [],
    completedAt: 1000,
    ...partial,
  } as ExecutionNode;
}

/**
 * Build a fixture graph rooted at shot X (scene_2_shot_4):
 *
 *   shot_image_prompt:X ──▶ shot_image:X ──▶ shot_video:X ──▶ final_video
 *                                                    ▲
 *                            shot_image:Y ──▶ shot_video:Y ──┘
 *                                                    ▲
 *                                            shot_video:Z (pending — sibling
 *                                            included to exercise cascadeOnlyCompleted)
 *
 * All nodes start `completed` except shot_video:Z which is `pending`.
 */
function buildFixtureState(): ExecutorState {
  const X = 'scene_2_shot_4';
  const Y = 'scene_2_shot_5';
  const Z = 'scene_2_shot_6';

  const nodes: Record<string, ExecutionNode> = {
    [`shot_image_prompt:${X}`]: node({
      id: `shot_image_prompt:${X}`,
      typeId: 'shot_image_prompt',
      itemId: X,
      outputPath: `assets/prompts/shot_image_prompt-${X}.json`,
      dependents: [`shot_image:${X}`],
    }),
    [`shot_image:${X}`]: node({
      id: `shot_image:${X}`,
      typeId: 'shot_image',
      itemId: X,
      outputPath: `assets/images/shots/scene-2-shot-4.png`,
      outputPaths: {
        first_frame: `assets/images/shots/scene-2-shot-4.png`,
        last_frame: `assets/images/shots/scene-2-shot-4_last.png`,
      },
      dependencies: [`shot_image_prompt:${X}`],
      dependents: [`shot_video:${X}`],
    }),
    [`shot_video:${X}`]: node({
      id: `shot_video:${X}`,
      typeId: 'shot_video',
      itemId: X,
      outputPath: `assets/videos/shots/scene-2-shot-4.mp4`,
      dependencies: [`shot_image:${X}`],
      dependents: ['final_video'],
    }),
    [`shot_image:${Y}`]: node({
      id: `shot_image:${Y}`,
      typeId: 'shot_image',
      itemId: Y,
      outputPath: `assets/images/shots/scene-2-shot-5.png`,
      outputPaths: {
        first_frame: `assets/images/shots/scene-2-shot-5.png`,
        last_frame: `assets/images/shots/scene-2-shot-5_last.png`,
      },
      dependents: [`shot_video:${Y}`],
    }),
    [`shot_video:${Y}`]: node({
      id: `shot_video:${Y}`,
      typeId: 'shot_video',
      itemId: Y,
      outputPath: `assets/videos/shots/scene-2-shot-5.mp4`,
      dependencies: [`shot_image:${Y}`],
      dependents: ['final_video'],
    }),
    [`shot_video:${Z}`]: node({
      id: `shot_video:${Z}`,
      typeId: 'shot_video',
      itemId: Z,
      status: 'pending',
      completedAt: undefined,
      dependents: ['final_video'],
    }),
    final_video: node({
      id: 'final_video',
      typeId: 'final_video',
      outputPath: 'assets/videos/final/final.mp4',
      dependencies: [`shot_video:${X}`, `shot_video:${Y}`, `shot_video:${Z}`],
    }),
  };

  return {
    nodes,
    targetArtifacts: ['final_video'],
    goalDescription: 'test',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as ExecutorState;
}

const X = 'scene_2_shot_4';
const Y = 'scene_2_shot_5';
const Z = 'scene_2_shot_6';

let executor: DependencyGraphExecutor;

beforeEach(() => {
  executor = DependencyGraphExecutor.fromState(buildFixtureState(), minimalTemplate);
});

describe("Last-frame regen — redoNode('shot_image:X', { scope: 'image_only', frame: 'last_frame' })", () => {
  it("drops only outputPaths.last_frame, preserves first_frame, cascades to completed downstream", () => {
    // Option payload that ExecutorAgent.redoNode produces for this mode
    // (ExecutorAgent.ts:1055-1062): cascade with cascadeOnlyCompleted=true,
    // preserveFramesOther=true so first_frame is retained.
    executor.invalidateNode(`shot_image:${X}`, {
      cascade: true,
      cascadeOnlyCompleted: true,
      preserveFramesOther: true,
      singleFrame: 'last_frame',
    });

    const img = executor.getNode(`shot_image:${X}`)!;
    expect(img.status).toBe('pending');
    expect(img.outputPaths).toEqual({
      first_frame: `assets/images/shots/scene-2-shot-4.png`,
    });

    // Upstream prompt is NOT walked by cascade (cascade walks dependents only).
    const prompt = executor.getNode(`shot_image_prompt:${X}`)!;
    expect(prompt.status).toBe('completed');
    expect(prompt.outputPath).toBe(`assets/prompts/shot_image_prompt-${X}.json`);

    // Already-completed downstream video flips pending — stale because the
    // new last_frame won't match the rendered motion.
    const vid = executor.getNode(`shot_video:${X}`)!;
    expect(vid.status).toBe('pending');
    expect(vid.outputPath).toBeUndefined();

    // Transitive cascade to final_video.
    const fv = executor.getNode('final_video')!;
    expect(fv.status).toBe('pending');
    expect(fv.outputPath).toBeUndefined();
  });

  it("does NOT cascade through unrelated shot Y", () => {
    executor.invalidateNode(`shot_image:${X}`, {
      cascade: true,
      cascadeOnlyCompleted: true,
      preserveFramesOther: true,
      singleFrame: 'last_frame',
    });

    const imgY = executor.getNode(`shot_image:${Y}`)!;
    expect(imgY.status).toBe('completed');
    expect(imgY.outputPaths).toEqual({
      first_frame: `assets/images/shots/scene-2-shot-5.png`,
      last_frame: `assets/images/shots/scene-2-shot-5_last.png`,
    });

    const vidY = executor.getNode(`shot_video:${Y}`)!;
    expect(vidY.status).toBe('completed');
    expect(vidY.outputPath).toBe(`assets/videos/shots/scene-2-shot-5.mp4`);
  });

  it("leaves pre-pending sibling shot_video:Z alone (cascadeOnlyCompleted semantic)", () => {
    executor.invalidateNode(`shot_image:${X}`, {
      cascade: true,
      cascadeOnlyCompleted: true,
      preserveFramesOther: true,
      singleFrame: 'last_frame',
    });

    // shot_video:Z was already pending and is not in the cascade path from
    // shot_image:X anyway — verify it stays pending (no double-reset, no
    // surprise mutation).
    const vidZ = executor.getNode(`shot_video:${Z}`)!;
    expect(vidZ.status).toBe('pending');
  });
});

describe("First-frame regen — redoNode('shot_image:X', { scope: 'image_only', frame: 'first_frame' })", () => {
  it("clears outputPaths entirely (mid/last derive from first) and cascades", () => {
    // Option payload for first_frame: ExecutorAgent.redoNode sets
    // preserveOthers=false because the recipe is
    //   `frame === 'last_frame' || frame === 'mid_frame'`
    // — first_frame is intentionally NOT in that list. The result is a
    // full outputPaths clear.
    executor.invalidateNode(`shot_image:${X}`, {
      cascade: true,
      cascadeOnlyCompleted: true,
      preserveFramesOther: false,
      singleFrame: undefined,
    });

    const img = executor.getNode(`shot_image:${X}`)!;
    expect(img.status).toBe('pending');
    expect(img.outputPath).toBeUndefined();
    expect(img.outputPaths).toBeUndefined();

    expect(executor.getNode(`shot_video:${X}`)!.status).toBe('pending');
    expect(executor.getNode('final_video')!.status).toBe('pending');
  });
});

describe("Video regen — redoNode('shot_video:X')", () => {
  it("dirties shot_video and final_video, leaves upstream image and its outputPaths intact", () => {
    // Default redoNode (no opts) — cascade:true, all dependents marked pending.
    executor.invalidateNode(`shot_video:${X}`);

    const vid = executor.getNode(`shot_video:${X}`)!;
    expect(vid.status).toBe('pending');
    expect(vid.outputPath).toBeUndefined();

    const fv = executor.getNode('final_video')!;
    expect(fv.status).toBe('pending');
    expect(fv.outputPath).toBeUndefined();

    // Upstream image must NOT be touched — the existing frames are still valid;
    // only the motion needs to be re-rendered.
    const img = executor.getNode(`shot_image:${X}`)!;
    expect(img.status).toBe('completed');
    expect(img.outputPath).toBe(`assets/images/shots/scene-2-shot-4.png`);
    expect(img.outputPaths).toEqual({
      first_frame: `assets/images/shots/scene-2-shot-4.png`,
      last_frame: `assets/images/shots/scene-2-shot-4_last.png`,
    });
  });
});

/**
 * Dispatch-level test: drive ExecutorAgent.redoNode end-to-end for the
 * prompt-reroll mode and verify the resulting graph state. This catches
 * regressions where someone changes the option payload redoNode passes
 * to invalidateNode (e.g., removes the cascade flag added in Phase 1.5).
 *
 * Constructs a real ExecutorAgent against the minimal template above —
 * the template's dep declarations match the fixture's deps so the
 * constructor's migrateGraphToTemplate pass is a no-op.
 */
describe("ExecutorAgent.redoNode dispatch — scope:'prompt' cascade contract", () => {
  it("scope:'prompt' invalidates prompt + image AND cascades completed shot_video to pending", () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'kshana-redo-prompt-'));
    const agent = new ExecutorAgent({} as never, {
      template: minimalTemplate,
      project: {
        id: 'test-project',
        title: 'Test',
        executorState: buildFixtureState(),
      } as never,
      projectDir,
      goal: {
        description: 'test goal',
        targetArtifacts: ['final_video'],
        preferences: {},
      } as never,
      name: 'test-executor',
      skipMediaGeneration: true,
    } as never);

    agent.redoNode(`shot_image_prompt:${X}`, { scope: 'prompt' });

    const agentExecutor = (agent as unknown as { executor: DependencyGraphExecutor }).executor;

    expect(agentExecutor.getNode(`shot_image_prompt:${X}`)!.status).toBe('pending');
    expect(agentExecutor.getNode(`shot_image:${X}`)!.status).toBe('pending');
    // The contract Phase 1.5 introduces: a prompt re-roll must also
    // dirty the completed downstream video. Without the cascade, the
    // new image gets generated but the existing shot_video MP4 (baked
    // from the OLD image) silently stays in `completed` and the next
    // run_to skips it — exactly the staleness bug the surgical UI
    // buttons would otherwise inherit.
    expect(agentExecutor.getNode(`shot_video:${X}`)!.status).toBe('pending');
    expect(agentExecutor.getNode('final_video')!.status).toBe('pending');
  });
});

describe("Prompt re-roll — redoNode('shot_image_prompt:X', { scope: 'prompt' })", () => {
  /**
   * Phase 1.5 contract: scope:'prompt' must invalidate prompt + image
   * AND cascade to already-completed downstream video. Without the
   * cascade, regenerating the prompt produces a new image but the
   * shot_video stays stale, baked from the old image.
   *
   * Today (pre-fix), ExecutorAgent.redoNode's scope:'prompt' branch
   * calls invalidateNode for both targets with `cascade: false`. The
   * fix flips the SECOND call (shot_image) to
   * `{ cascade: true, cascadeOnlyCompleted: true }`. This test asserts
   * the post-fix shape.
   */
  it("invalidates prompt + image and cascades to completed downstream video", () => {
    // Simulate the post-fix dispatch: two invalidations as redoNode does.
    executor.invalidateNode(`shot_image_prompt:${X}`, { cascade: false });
    executor.invalidateNode(`shot_image:${X}`, {
      cascade: true,
      cascadeOnlyCompleted: true,
    });

    expect(executor.getNode(`shot_image_prompt:${X}`)!.status).toBe('pending');
    expect(executor.getNode(`shot_image:${X}`)!.status).toBe('pending');
    expect(executor.getNode(`shot_image:${X}`)!.outputPaths).toBeUndefined();
    expect(executor.getNode(`shot_video:${X}`)!.status).toBe('pending');
    expect(executor.getNode('final_video')!.status).toBe('pending');

    // Sibling untouched.
    expect(executor.getNode(`shot_image:${Y}`)!.status).toBe('completed');
    expect(executor.getNode(`shot_video:${Y}`)!.status).toBe('completed');
  });
});
