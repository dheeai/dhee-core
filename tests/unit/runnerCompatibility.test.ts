import { describe, expect, it } from 'vitest';
import {
  inferNodeRunnerCompatibility,
  previewBundleRunnerPlan,
} from '../../src/dag/runnerCompatibility.js';
import type { DagBundle } from '../../src/dag/schema.js';

const bundle: DagBundle = {
  id: 'runner_switch_test',
  version: '0.1.0',
  goal: 'segment_video',
  inputs: [{ id: 'videoModel', kind: 'project', field: 'videoModel' }],
  nodes: [
    {
      id: 'segment_motion_prompt',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'json', pattern: 'segment/prompt.json' },
      runner: { tool: 'llm.generate', config: {} },
    },
    {
      id: 'segment_image',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'image', pattern: 'segment/first.png' },
      runner: { tool: 'comfy.tti', config: {} },
    },
    {
      id: 'segment_video',
      kind: 'stage',
      inputs: [
        { from: 'segment_motion_prompt', usage: 'input' },
        { from: 'segment_image', usage: 'input' },
      ],
      outputs: { format: 'video', pattern: 'segment/video.mp4' },
      runner: {
        tool: 'openrouter.video',
        config: {
          promptInput: 'segment_motion_prompt',
          firstFrameInput: 'segment_image',
          modelInput: 'videoModel',
        },
      },
    },
  ],
};

describe('runner compatibility', () => {
  it('blocks a target runner when the node cannot provide a required last frame', () => {
    const node = bundle.nodes.find((candidate) => candidate.id === 'segment_video')!;
    const result = inferNodeRunnerCompatibility({
      bundle,
      node,
      toTool: 'comfy.fl2v',
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe('blocked');
    expect(result.reason).toContain('lastFrame');
  });

  it('keeps blocked defaults out of new-project runner overrides', async () => {
    const plan = await previewBundleRunnerPlan({
      bundle,
      runnerDefaults: { video: ['comfy.fl2v'] },
    });
    const videoNode = plan.nodes.find((node) => node.nodeId === 'segment_video')!;
    expect(videoNode.status).toBe('blocked');
    expect(plan.overrides).toEqual([]);
  });

  it('recognizes canonical Dhee Cloud video as a ready Comfy Cloud alias', () => {
    const node = bundle.nodes.find((candidate) => candidate.id === 'segment_video')!;
    const result = inferNodeRunnerCompatibility({
      bundle,
      node,
      toTool: 'dhee.cloud.video',
    });
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ready');
    expect(result.configOverride).toMatchObject({
      workflowId: 'ltx23_i2v_cloud',
      endpoint: '',
    });
    expect(result.configOverride?.['workflowPath']).toContain('ltx23_i2v_cloud.json');
    expect(result.configOverride?.['manifestPath']).toContain('ltx23_i2v_cloud.manifest.json');
    expect(result.runtimeBindings).toEqual(
      expect.arrayContaining([
        { configKey: 'prompt', fromInput: 'segment_motion_prompt' },
        { configKey: 'firstFrame', fromInput: 'segment_image' },
      ]),
    );
  });

  it('writes Dhee Cloud aliases into new-project runner overrides when compatible', async () => {
    const plan = await previewBundleRunnerPlan({
      bundle,
      runnerDefaults: { video: ['dhee.cloud.video'] },
    });
    const videoNode = plan.nodes.find((node) => node.nodeId === 'segment_video')!;
    expect(videoNode.status).toBe('ready');
    expect(videoNode.proposedTool).toBe('dhee.cloud.video');
    expect(plan.overrides).toHaveLength(1);
    expect(plan.overrides[0]).toMatchObject({
      nodeId: 'segment_video',
      toTool: 'dhee.cloud.video',
      generatedConfigOverride: {
        workflowId: 'ltx23_i2v_cloud',
        endpoint: '',
      },
    });
  });
});
