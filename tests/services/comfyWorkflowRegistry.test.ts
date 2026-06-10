/**
 * Unit tests for the ComfyUI service support modules:
 *   - src/services/comfyui/WorkflowRegistry.ts — register / lookup /
 *     type-filter / task-based selection of workflow metadata.
 *   - src/services/comfyui/ComfyUIProgressBus.ts — pub/sub bus for
 *     generation progress events.
 *
 * Both are pure in-memory (the registry seeds a set of built-in
 * workflows in its constructor; the bus wraps eventemitter3).
 */
import { describe, expect, it, vi } from 'vitest';

import {
  WorkflowRegistry,
  WorkflowType,
  getRegistry,
  type WorkflowMetadata,
} from '../../src/services/comfyui/WorkflowRegistry.js';

import {
  comfyProgressBus,
  type ComfyProgressEvent,
  type ComfyProgressHandler,
} from '../../src/services/comfyui/ComfyUIProgressBus.js';

function makeWorkflow(over: Partial<WorkflowMetadata> = {}): WorkflowMetadata {
  return {
    name: 'custom_wf',
    filename: 'custom.json',
    workflowType: WorkflowType.IMAGE_GENERATION,
    description: 'A custom workflow',
    capabilities: ['text-to-image'],
    displayName: 'Custom',
    requiresBaseImage: false,
    supportsTextPrompts: true,
    supportsImageToImage: false,
    outputFormat: 'image',
    estimatedTimeSeconds: 20,
    qualityLevel: 'standard',
    ...over,
  };
}

describe('WorkflowRegistry', () => {
  it('seeds the built-in workflows in its constructor', () => {
    const reg = new WorkflowRegistry();
    const all = reg.listAll();
    expect(all.length).toBeGreaterThanOrEqual(5);
    const names = all.map((w) => w.name);
    expect(names).toContain('zimage');
    expect(names).toContain('qwen_edit');
    expect(names).toContain('ltx23');
  });

  it('looks up a workflow by name', () => {
    const reg = new WorkflowRegistry();
    expect(reg.get('zimage')?.displayName).toBe('Z-Image Turbo');
  });

  it('returns undefined for a missing key', () => {
    const reg = new WorkflowRegistry();
    expect(reg.get('does_not_exist')).toBeUndefined();
  });

  it('registers a new workflow and makes it retrievable', () => {
    const reg = new WorkflowRegistry();
    const before = reg.listAll().length;
    reg.register(makeWorkflow({ name: 'my_new_wf' }));
    expect(reg.listAll().length).toBe(before + 1);
    expect(reg.get('my_new_wf')?.displayName).toBe('Custom');
  });

  it('overwrites an existing workflow registered under the same name', () => {
    const reg = new WorkflowRegistry();
    const before = reg.listAll().length;
    reg.register(makeWorkflow({ name: 'zimage', displayName: 'Replaced' }));
    expect(reg.listAll().length).toBe(before); // no net growth
    expect(reg.get('zimage')?.displayName).toBe('Replaced');
  });

  it('filters by workflow type', () => {
    const reg = new WorkflowRegistry();
    const videos = reg.listByType(WorkflowType.VIDEO_GENERATION);
    expect(videos.length).toBeGreaterThanOrEqual(1);
    expect(videos.every((w) => w.workflowType === WorkflowType.VIDEO_GENERATION)).toBe(true);

    const editors = reg.listByType(WorkflowType.IMAGE_EDITING);
    expect(editors.every((w) => w.workflowType === WorkflowType.IMAGE_EDITING)).toBe(true);
  });

  describe('selectWorkflow', () => {
    it('routes video tasks to a video workflow', () => {
      const reg = new WorkflowRegistry();
      const sel = reg.selectWorkflow('animate this into a movie');
      expect(sel?.workflowType).toBe(WorkflowType.VIDEO_GENERATION);
    });

    it('routes edit tasks to an editing workflow when a base image is present', () => {
      const reg = new WorkflowRegistry();
      const sel = reg.selectWorkflow('refine and modify the image', true);
      expect(sel?.workflowType).toBe(WorkflowType.IMAGE_EDITING);
    });

    it('falls back to image-generation for edit tasks when no base image', () => {
      const reg = new WorkflowRegistry();
      const sel = reg.selectWorkflow('edit the picture', false);
      expect(sel?.workflowType).toBe(WorkflowType.IMAGE_GENERATION);
    });

    it('defaults to image generation for a plain prompt', () => {
      const reg = new WorkflowRegistry();
      const sel = reg.selectWorkflow('a castle on a hill');
      expect(sel?.workflowType).toBe(WorkflowType.IMAGE_GENERATION);
    });

    it('prefers the fastest candidate when preferSpeed is set', () => {
      const reg = new WorkflowRegistry();
      const fast = reg.selectWorkflow('edit the image', true, true);
      const candidates = reg.listByType(WorkflowType.IMAGE_EDITING);
      const minTime = Math.min(...candidates.map((c) => c.estimatedTimeSeconds));
      expect(fast?.estimatedTimeSeconds).toBe(minTime);
    });

    it('prefers the highest quality candidate by default', () => {
      const reg = new WorkflowRegistry();
      const best = reg.selectWorkflow('edit the image', true, false);
      // qwen_edit_hq is the only "ultra" editing workflow.
      expect(best?.qualityLevel).toBe('ultra');
    });

    it('returns undefined when no candidate of the resolved type exists', () => {
      const reg = new WorkflowRegistry();
      // Strip every video workflow, then ask for a video task.
      for (const wf of reg.listByType(WorkflowType.VIDEO_GENERATION)) {
        // Re-register as a non-video type to remove it from the video bucket.
        reg.register(makeWorkflow({ ...wf, workflowType: WorkflowType.IMAGE_GENERATION }));
      }
      expect(reg.selectWorkflow('make a movie')).toBeUndefined();
    });
  });

  describe('getWorkflowForScene', () => {
    it('uses base generation for the first scene', () => {
      const reg = new WorkflowRegistry();
      expect(reg.getWorkflowForScene(1).name).toBe('zimage');
    });

    it('uses base generation when there is no previous scene', () => {
      const reg = new WorkflowRegistry();
      expect(reg.getWorkflowForScene(3, false).name).toBe('zimage');
    });

    it('uses the editor for later scenes when consistency is preferred', () => {
      const reg = new WorkflowRegistry();
      expect(reg.getWorkflowForScene(2, true, true).name).toBe('qwen_edit');
    });

    it('uses base generation for later scenes when consistency is not preferred', () => {
      const reg = new WorkflowRegistry();
      expect(reg.getWorkflowForScene(2, true, false).name).toBe('zimage');
    });
  });

  it('toDict exports a serializable summary of all workflows', () => {
    const reg = new WorkflowRegistry();
    const dict = reg.toDict();
    expect(Array.isArray(dict.workflows)).toBe(true);
    expect(dict.workflows.length).toBe(reg.listAll().length);
    const z = dict.workflows.find((w) => w.name === 'zimage');
    expect(z).toMatchObject({ output_format: 'image', estimated_time: '15s' });
  });

  it('getRegistry returns a shared singleton', () => {
    expect(getRegistry()).toBe(getRegistry());
  });
});

describe('ComfyUIProgressBus', () => {
  function event(over: Partial<ComfyProgressEvent> = {}): ComfyProgressEvent {
    return {
      jobId: 'job-1',
      percentage: 50,
      message: 'rendering',
      done: false,
      ...over,
    };
  }

  it('delivers emitted events to a subscribed handler', () => {
    const received: ComfyProgressEvent[] = [];
    const handler: ComfyProgressHandler = (e) => received.push(e);
    comfyProgressBus.onProgress(handler);
    try {
      comfyProgressBus.emitProgress(event({ percentage: 25 }));
      expect(received).toHaveLength(1);
      expect(received[0]!.percentage).toBe(25);
    } finally {
      comfyProgressBus.offProgress(handler);
    }
  });

  it('stops delivering after unsubscribe', () => {
    const received: ComfyProgressEvent[] = [];
    const handler: ComfyProgressHandler = (e) => received.push(e);
    comfyProgressBus.onProgress(handler);
    comfyProgressBus.emitProgress(event());
    comfyProgressBus.offProgress(handler);
    comfyProgressBus.emitProgress(event({ message: 'after unsubscribe' }));
    expect(received).toHaveLength(1);
    expect(received[0]!.message).toBe('rendering');
  });

  it('fans out to multiple subscribers', () => {
    const a = vi.fn();
    const b = vi.fn();
    comfyProgressBus.onProgress(a);
    comfyProgressBus.onProgress(b);
    try {
      comfyProgressBus.emitProgress(event({ done: true }));
      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
      expect(a.mock.calls[0]![0]).toMatchObject({ done: true });
    } finally {
      comfyProgressBus.offProgress(a);
      comfyProgressBus.offProgress(b);
    }
  });

  it('emitting with no subscribers is a no-op (does not throw)', () => {
    expect(() => comfyProgressBus.emitProgress(event())).not.toThrow();
  });
});
