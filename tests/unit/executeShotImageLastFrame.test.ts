/**
 * Phase 2 (Pattern B): the `shot_image_last_frame:X` node generates its
 * own artifact independently of `shot_image:X`. Phase 1 only mirrored
 * an artifact already produced by `executeShotImage`; Phase 2 makes the
 * bridge node a real producer that runs `edit_first_frame` against the
 * upstream first frame.
 *
 * Why this matters: a regen of last_frame must not require re-running
 * first_frame, AND the last_frame artifact must always live on the
 * bridge node so PromptsView / shot_video read a single source of
 * truth. Phase 1's mirror could go stale when shot_image:X was
 * invalidated without cascading to the bridge — Phase 2 closes that.
 *
 * Test surface: a pure helper `executeShotImageLastFrame` with all
 * I/O injected, mirroring the existing pure-helper pattern used by
 * addShotImageNodes / bridgeLastFrameNode. ExecutorAgent wires the
 * helper into the bridge node's branch in its execute loop.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ExecutionNode } from '../../src/core/planner/types.js';
import {
  executeShotImageLastFrame,
  type ExecuteShotImageLastFrameDeps,
} from '../../src/core/planner/executeShotImageLastFrame.js';

function makeNode(over: Partial<ExecutionNode> & Pick<ExecutionNode, 'id' | 'typeId'>): ExecutionNode {
  return {
    status: 'pending',
    displayName: over.id,
    dependencies: [],
    dependents: [],
    isCollection: false,
    isExpensive: false,
    ...over,
  } as ExecutionNode;
}

interface FakeFs {
  files: Map<string, string>;
  existsSync: (p: string) => boolean;
  readFileSync: (p: string, _enc: 'utf-8') => string;
  mkdirSync: (p: string, opts: { recursive: true }) => void;
}

function makeFakeFs(seed: Record<string, string> = {}): FakeFs {
  const files = new Map<string, string>(Object.entries(seed));
  return {
    files,
    existsSync: (p: string) => files.has(p),
    readFileSync: (p: string, _enc) => {
      const v = files.get(p);
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
    mkdirSync: () => {},
  };
}

interface BuildArgs {
  itemId?: string;
  upstreamFirstFrame?: string;
  upstreamFrames?: Record<string, string>;
  promptJson?: string | null;
  resolveRefIds?: (refs: Array<{ refId?: string; type?: string }>) => string[];
  editImageLayered?: ExecuteShotImageLastFrameDeps['editImageLayered'];
  preExistingOutputPath?: string;
  preExistingOutputOnDisk?: boolean;
}

function build(args: BuildArgs = {}) {
  const itemId = args.itemId ?? 'scene_1_shot_1';
  const projectDir = '/proj';

  const upstream = makeNode({
    id: `shot_image:${itemId}`,
    typeId: 'shot_image',
    itemId,
    status: 'completed',
    outputPath: args.upstreamFirstFrame,
    outputPaths: args.upstreamFrames,
  });
  const promptNode = makeNode({
    id: `shot_image_prompt:${itemId}`,
    typeId: 'shot_image_prompt',
    itemId,
    status: 'completed',
    outputPath: args.promptJson === null ? undefined : `prompts/images/shots/${itemId}.json`,
  });
  const lastFrame = makeNode({
    id: `shot_image_last_frame:${itemId}`,
    typeId: 'shot_image_last_frame',
    itemId,
    dependencies: [`shot_image:${itemId}`],
  });
  if (args.preExistingOutputPath) {
    lastFrame.outputPath = args.preExistingOutputPath;
  }

  const nodes = new Map<string, ExecutionNode>();
  nodes.set(upstream.id, upstream);
  nodes.set(promptNode.id, promptNode);
  nodes.set(lastFrame.id, lastFrame);

  const fsSeed: Record<string, string> = {};
  if (args.promptJson) {
    fsSeed[`${projectDir}/prompts/images/shots/${itemId}.json`] = args.promptJson;
  }
  if (args.preExistingOutputPath && args.preExistingOutputOnDisk) {
    fsSeed[`${projectDir}/${args.preExistingOutputPath}`] = 'png-bytes';
  }
  const fs = makeFakeFs(fsSeed);

  const editImageLayered =
    args.editImageLayered ??
    vi.fn(async ({ filenamePrefix, outputDir }: { filenamePrefix: string; outputDir: string }) =>
      `${outputDir}/${filenamePrefix}_OUT.png`,
    );

  const deps: ExecuteShotImageLastFrameDeps = {
    executor: { getNode: (id) => nodes.get(id) },
    projectDir,
    fs,
    editImageLayered,
    resolveRefIds: args.resolveRefIds ?? ((refs) => refs.map((r) => `/refs/${r.refId}.png`)),
  };

  return { deps, lastFrame, upstream, promptNode, fs, editImageLayered };
}

const STANDARD_PROMPT_JSON = JSON.stringify({
  aspectRatio: '16:9',
  negativePrompt: 'blurry',
  frames: {
    first_frame: {
      imagePrompt: 'wide shot of a desert at dawn',
      generationMode: 'image_text_to_image',
      references: [{ refId: 'character:cowboy', type: 'character' }],
    },
    last_frame: {
      imagePrompt: 'cowboy now closer, sun fully risen',
      generationMode: 'edit_first_frame',
      references: [{ refId: 'character:cowboy', type: 'character' }],
    },
  },
});

describe('executeShotImageLastFrame (Phase 2 — bridge node owns the artifact)', () => {
  it('runs edit_first_frame against the upstream first_frame and writes its own outputPath', async () => {
    const { deps, lastFrame, editImageLayered } = build({
      upstreamFrames: { first_frame: 'assets/images/s1shot1_first.png' },
      promptJson: STANDARD_PROMPT_JSON,
    });

    const result = await executeShotImageLastFrame(lastFrame, deps);

    expect(result.action).toBe('complete');
    if (result.action === 'complete') {
      expect(result.outputPath).toBeDefined();
      // Path is relative to projectDir.
      expect(result.outputPath).not.toMatch(/^\//);
      // Filename embeds itemId + last_frame so it's scannable in Finder.
      expect(result.outputPath).toMatch(/scene_1_shot_1.*last_frame/);
    }
    expect(lastFrame.outputPath).toBe(result.action === 'complete' ? result.outputPath : undefined);
    // Bridge node OWNS the artifact — must not write to the upstream.
    expect(editImageLayered).toHaveBeenCalledOnce();
    const call = (editImageLayered as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.prompt).toBe('cowboy now closer, sun fully risen');
    expect(call.sourceImagePath).toBe('/proj/assets/images/s1shot1_first.png');
    expect(call.refPaths).toEqual(['/refs/character:cowboy.png']);
  });

  it('falls back to first_frame.references when last_frame has no refs', async () => {
    const promptJson = JSON.stringify({
      frames: {
        first_frame: {
          imagePrompt: 'first',
          references: [
            { refId: 'character:cowboy', type: 'character' },
            { refId: 'setting:desert', type: 'setting' },
          ],
        },
        last_frame: {
          imagePrompt: 'last',
          generationMode: 'edit_first_frame',
          references: [],
        },
      },
    });
    const { deps, editImageLayered, lastFrame } = build({
      upstreamFrames: { first_frame: 'assets/images/ff.png' },
      promptJson,
    });

    const result = await executeShotImageLastFrame(lastFrame, deps);
    expect(result.action).toBe('complete');
    const call = (editImageLayered as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.refPaths).toEqual([
      '/refs/character:cowboy.png',
      '/refs/setting:desert.png',
    ]);
  });

  it('completes as a no-op when the prompt JSON has no last_frame block', async () => {
    const promptJson = JSON.stringify({
      frames: {
        first_frame: { imagePrompt: 'only first', references: [] },
      },
    });
    const { deps, editImageLayered, lastFrame } = build({
      upstreamFrames: { first_frame: 'assets/images/ff.png' },
      promptJson,
    });

    const result = await executeShotImageLastFrame(lastFrame, deps);

    expect(result.action).toBe('complete');
    expect(editImageLayered).not.toHaveBeenCalled();
    expect(lastFrame.outputPath).toBeUndefined();
  });

  it('incremental retry: skips edit when its own outputPath already exists on disk', async () => {
    const { deps, editImageLayered, lastFrame } = build({
      upstreamFrames: { first_frame: 'assets/images/ff.png' },
      promptJson: STANDARD_PROMPT_JSON,
      preExistingOutputPath: 'assets/images/scene_1_shot_1_last_frame_existing.png',
      preExistingOutputOnDisk: true,
    });

    const result = await executeShotImageLastFrame(lastFrame, deps);

    expect(result.action).toBe('complete');
    if (result.action === 'complete') {
      expect(result.outputPath).toBe('assets/images/scene_1_shot_1_last_frame_existing.png');
    }
    expect(editImageLayered).not.toHaveBeenCalled();
  });

  it('regenerates when outputPath is set but the file is gone (stale state)', async () => {
    const { deps, editImageLayered, lastFrame } = build({
      upstreamFrames: { first_frame: 'assets/images/ff.png' },
      promptJson: STANDARD_PROMPT_JSON,
      preExistingOutputPath: 'assets/images/stale.png',
      preExistingOutputOnDisk: false,
    });

    const result = await executeShotImageLastFrame(lastFrame, deps);

    expect(result.action).toBe('complete');
    expect(editImageLayered).toHaveBeenCalledOnce();
    if (result.action === 'complete') {
      expect(result.outputPath).not.toBe('assets/images/stale.png');
    }
  });

  it('fails when the upstream shot_image node is missing', async () => {
    const { deps, lastFrame } = build({
      upstreamFrames: { first_frame: 'assets/images/ff.png' },
      promptJson: STANDARD_PROMPT_JSON,
    });
    // Simulate the upstream node disappearing.
    (deps.executor.getNode as (id: string) => ExecutionNode | undefined) = (id: string) => {
      if (id === 'shot_image:scene_1_shot_1') return undefined;
      if (id === 'shot_image_prompt:scene_1_shot_1') {
        return makeNode({
          id,
          typeId: 'shot_image_prompt',
          itemId: 'scene_1_shot_1',
          status: 'completed',
          outputPath: 'prompts/images/shots/scene_1_shot_1.json',
        });
      }
      return undefined;
    };

    const result = await executeShotImageLastFrame(lastFrame, deps);

    expect(result.action).toBe('fail');
    if (result.action === 'fail') {
      expect(result.error).toMatch(/shot_image:.*not found|first.*frame/i);
    }
  });

  it('fails when the upstream first_frame is missing', async () => {
    // Upstream node exists but has no outputPath / outputPaths.first_frame.
    const { deps, lastFrame } = build({
      upstreamFrames: undefined,
      upstreamFirstFrame: undefined,
      promptJson: STANDARD_PROMPT_JSON,
    });

    const result = await executeShotImageLastFrame(lastFrame, deps);

    expect(result.action).toBe('fail');
  });

  it('reads first_frame from outputPaths.first_frame OR outputPath (legacy single-output)', async () => {
    // Legacy projects may have first_frame on outputPath, not outputPaths.
    const { deps, lastFrame, editImageLayered } = build({
      upstreamFirstFrame: 'assets/images/legacy_first.png',
      upstreamFrames: undefined,
      promptJson: STANDARD_PROMPT_JSON,
    });

    const result = await executeShotImageLastFrame(lastFrame, deps);

    expect(result.action).toBe('complete');
    const call = (editImageLayered as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.sourceImagePath).toBe('/proj/assets/images/legacy_first.png');
  });
});
