import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { ExecutorAgent } from '../src/core/planner/ExecutorAgent.js';
import type { ExecutionNode, ExecutorState } from '../src/core/planner/types.js';
import {
  createTimelineSkeleton,
  splitSegmentIntoShots,
  updateSegmentLayers,
} from '../src/core/timeline/TimelineManager.js';

const template = {
  id: 'narrative',
  name: 'Narrative',
  version: '1.0',
  description: 'test',
  artifactTypes: {
    scene: {
      id: 'scene',
      displayName: 'Scene',
      category: 'segment',
      isCollection: true,
      isExpensive: false,
      dependencies: [],
    },
    scene_video_prompt: {
      id: 'scene_video_prompt',
      displayName: 'Scene Video Prompt',
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
    final_video: {
      id: 'final_video',
      displayName: 'Final Video',
      category: 'final',
      isCollection: false,
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

describe('Executor timeline lifecycle', () => {
  it('initializes and persists a scene timeline as soon as scenes exist', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dhee-executor-timeline-'));
    const agent = createAgent(projectDir, {
      'scene:scene_1': {
        typeId: 'scene',
        itemId: 'scene_1',
        displayName: 'Scene 1',
        status: 'completed',
      },
    });

    (agent as any).ensureTimelineInitialized();

    const timelinePath = join(projectDir, 'timeline.json');
    expect(existsSync(timelinePath)).toBe(true);
    const timeline = JSON.parse(readFileSync(timelinePath, 'utf-8'));
    expect(timeline.segments).toEqual([
      expect.objectContaining({ id: 'scene_1', label: 'Scene 1' }),
    ]);
  });

  it('splits a scene into shot segments and fills the matching shot segment on completion', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dhee-executor-timeline-'));
    mkdirSync(join(projectDir, 'prompts', 'videos', 'scenes'), { recursive: true });
    const promptPath = join(projectDir, 'prompts', 'videos', 'scenes', 'scene-1.motion.json');
    writeFileSync(promptPath, JSON.stringify({
      shots: [
        { shotNumber: 1, shotType: 'wide', duration: 5 },
        { shotNumber: 2, shotType: 'close', duration: 7, transition: 'crossfade' },
      ],
    }), 'utf-8');

    const agent = createAgent(projectDir, {
      'scene:scene_1': {
        typeId: 'scene',
        itemId: 'scene_1',
        displayName: 'Scene 1',
        status: 'completed',
      },
      'scene_video_prompt:scene_1': {
        typeId: 'scene_video_prompt',
        itemId: 'scene_1',
        displayName: 'Scene Prompt 1',
        status: 'completed',
        outputPath: 'prompts/videos/scenes/scene-1.motion.json',
      },
    });

    const result = (agent as any).ensureSceneShotSegments('scene_1');
    (agent as any).updateTimelineForShotImage({
      itemId: 'scene_1_shot_2',
      displayName: 'Scene 1 Shot 2',
    }, 'assets/images/scene-1-shot-2.png');

    let timeline = (agent as any).timeline;
    expect(timeline.segments.find((segment: { id: string }) => segment.id === 'scene_1_shot_2')).toEqual(
      expect.objectContaining({
        fillStatus: 'planned',
        transition: expect.objectContaining({ type: 'crossfade' }),
        layers: [
          expect.objectContaining({ filePath: 'assets/images/scene-1-shot-2.png' }),
        ],
      })
    );

    (agent as any).updateTimelineForShotVideo({
      itemId: 'scene_1_shot_2',
      displayName: 'Scene 1 Shot 2',
    }, 'assets/videos/scene-1-shot-2.mp4');

    timeline = (agent as any).timeline;
    expect(result).toEqual(expect.objectContaining({
      success: true,
      extractedShotCount: 2,
      expectedSegmentIds: ['scene_1_shot_1', 'scene_1_shot_2'],
      actualSegmentIds: ['scene_1_shot_1', 'scene_1_shot_2'],
      rewriteAttempted: true,
    }));
    expect(timeline.segments.map((segment: { id: string }) => segment.id)).toEqual([
      'scene_1_shot_1',
      'scene_1_shot_2',
    ]);
    expect(timeline.segments.find((segment: { id: string }) => segment.id === 'scene_1_shot_2')).toEqual(
      expect.objectContaining({
        fillStatus: 'filled',
        transition: expect.objectContaining({ type: 'crossfade' }),
        layers: [
          expect.objectContaining({ filePath: 'assets/videos/scene-1-shot-2.mp4' }),
        ],
      })
    );
  });

  it('does not replace an existing timeline video with a later image preview update', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dhee-executor-timeline-'));
    const agent = createAgent(projectDir, {});

    let timeline = createTimelineSkeleton(6, [{ id: 'scene_1', label: 'Scene 1' }]);
    timeline = splitSegmentIntoShots(timeline, 'scene_1', [{ label: 'Shot 1', duration: 6 }]);
    timeline = updateSegmentLayers(timeline, 'scene_1_shot_1', [{
      type: 'visual',
      filePath: 'assets/videos/scene-1-shot-1.mp4',
      label: 'Shot 1 video',
      source: 'generated',
    }], 'filled');
    (agent as any).timeline = timeline;

    (agent as any).updateTimelineForShotImage({
      itemId: 'scene_1_shot_1',
      displayName: 'Scene 1 Shot 1',
    }, 'assets/images/scene-1-shot-1.png');

    const updatedTimeline = (agent as any).timeline;
    expect(updatedTimeline.segments.find((segment: { id: string }) => segment.id === 'scene_1_shot_1')).toEqual(
      expect.objectContaining({
        fillStatus: 'filled',
        layers: [
          expect.objectContaining({ filePath: 'assets/videos/scene-1-shot-1.mp4' }),
        ],
      })
    );
  });

  it('uses the freshly written scene breakdown path before node state is marked completed', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dhee-executor-timeline-'));
    mkdirSync(join(projectDir, 'prompts', 'videos', 'scenes'), { recursive: true });
    const relPath = 'prompts/videos/scenes/scene-1.motion.json';
    writeFileSync(join(projectDir, relPath), JSON.stringify({
      shots: [
        { shotNumber: 1, shotType: 'wide', duration: 5 },
        { shotNumber: 2, shotType: 'close', duration: 7, transition: 'crossfade' },
      ],
    }), 'utf-8');

    const agent = createAgent(projectDir, {
      'scene:scene_1': {
        typeId: 'scene',
        itemId: 'scene_1',
        displayName: 'Scene 1',
        status: 'completed',
      },
      'scene_video_prompt:scene_1': {
        typeId: 'scene_video_prompt',
        itemId: 'scene_1',
        displayName: 'Scene Prompt 1',
        status: 'in_progress',
      },
    });

    const result = (agent as any).ensureSceneShotSegments('scene_1', undefined, {
      sceneVideoPromptOutputPath: relPath,
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      extractedShotCount: 2,
      expectedSegmentIds: ['scene_1_shot_1', 'scene_1_shot_2'],
      actualSegmentIds: ['scene_1_shot_1', 'scene_1_shot_2'],
      rewriteAttempted: true,
    }));
  });

  it('throws when timeline sync still fails after deterministic repair', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dhee-executor-timeline-'));
    const agent = createAgent(projectDir, {});

    let attempts = 0;
    (agent as any).materializeSceneBreakdown = () => {
      attempts += 1;
      return {
        sceneId: 'scene_1',
        shotCount: 2,
        shotItems: [
          { itemId: 'scene_1_shot_1', name: 'S1 Shot 1: shot_1' },
          { itemId: 'scene_1_shot_2', name: 'S1 Shot 2: shot_2' },
        ],
        expectedTimelineSegmentIds: ['scene_1_shot_1', 'scene_1_shot_2'],
        actualTimelineSegmentIds: attempts === 1 ? ['scene_1'] : ['scene_1'],
        graphSatisfied: true,
        timelineSatisfied: false,
        success: false,
        failureReason: 'missing_expected_segments:scene_1_shot_1,scene_1_shot_2',
      };
    };

    expect(() => (agent as any).ensureSceneShotSegmentsStrict('scene_1')).toThrow(
      /Timeline sync failed for scene_1/
    );
    expect(attempts).toBe(1);
  });

  it('repairs timeline sync on second deterministic attempt', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dhee-executor-timeline-'));
    const agent = createAgent(projectDir, {});

    let attempts = 0;
    (agent as any).materializeSceneBreakdown = () => {
      attempts += 1;
      return {
        sceneId: 'scene_1',
        shotCount: 2,
        shotItems: [
          { itemId: 'scene_1_shot_1', name: 'S1 Shot 1: shot_1' },
          { itemId: 'scene_1_shot_2', name: 'S1 Shot 2: shot_2' },
        ],
        expectedTimelineSegmentIds: ['scene_1_shot_1', 'scene_1_shot_2'],
        actualTimelineSegmentIds: ['scene_1_shot_1', 'scene_1_shot_2'],
        graphSatisfied: true,
        timelineSatisfied: true,
        success: true,
      };
    };

    expect(() => (agent as any).ensureSceneShotSegmentsStrict('scene_1')).not.toThrow();
    expect(attempts).toBe(1);
  });

  it('reconciles a completed scene prompt against a stale scene-only timeline on resume', () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dhee-executor-timeline-'));
    mkdirSync(join(projectDir, 'prompts', 'videos', 'scenes'), { recursive: true });
    const promptPath = join(projectDir, 'prompts', 'videos', 'scenes', 'scene-1.motion.json');
    writeFileSync(promptPath, JSON.stringify({
      shots: [
        { shotNumber: 1, shotType: 'wide', duration: 5 },
        { shotNumber: 2, shotType: 'close', duration: 7 },
      ],
    }), 'utf-8');

    const agent = createAgent(projectDir, {
      'scene:scene_1': {
        typeId: 'scene',
        itemId: 'scene_1',
        displayName: 'Scene 1',
        status: 'completed',
      },
      'scene_video_prompt:scene_1': {
        typeId: 'scene_video_prompt',
        itemId: 'scene_1',
        displayName: 'Scene Prompt 1',
        status: 'completed',
        outputPath: 'prompts/videos/scenes/scene-1.motion.json',
      },
    });

    const staleTimeline = createTimelineSkeleton(12, [{ id: 'scene_1', label: 'Scene 1' }]);
    writeFileSync(join(projectDir, 'timeline.json'), JSON.stringify(staleTimeline, null, 2), 'utf-8');
    (agent as any).timeline = staleTimeline;

    (agent as any).reconcileCompletedSceneTimelineSegments();

    const timeline = JSON.parse(readFileSync(join(projectDir, 'timeline.json'), 'utf-8'));
    expect(timeline.segments.map((segment: { id: string }) => segment.id)).toEqual([
      'scene_1_shot_1',
      'scene_1_shot_2',
    ]);
  });

  it('does not fall back to node-based assembly when timeline exists but is unresolved', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'dhee-executor-timeline-'));
    const agent = createAgent(projectDir, {
      'scene:scene_1': {
        typeId: 'scene',
        itemId: 'scene_1',
        displayName: 'Scene 1',
        status: 'completed',
      },
      'shot_video:scene_1_shot_1': {
        typeId: 'shot_video',
        itemId: 'scene_1_shot_1',
        displayName: 'Shot Video 1',
        status: 'completed',
        outputPath: 'assets/videos/fallback-would-have-existed.mp4',
      },
    });

    let timeline = createTimelineSkeleton(6, [{ id: 'scene_1', label: 'Scene 1' }]);
    timeline = splitSegmentIntoShots(timeline, 'scene_1', [{ label: 'Shot 1', duration: 6 }]);
    timeline = updateSegmentLayers(timeline, 'scene_1_shot_1', [{
      type: 'visual',
      label: 'unresolved timeline layer',
      source: 'generated',
    }], 'filled');
    (agent as any).timeline = timeline;

    const result = await (agent as any).executeFinalAssembly(
      { id: 'final_video', displayName: 'Final Video' },
      'test-tool-call',
    );

    expect(result).toBeNull();
  });
});
