/**
 * dhee_regenerate_node — the agent tool wrapper.
 *
 * The underlying regenerateNode() helper is well covered in
 * tests/unit/projectRegen.test.ts. This file covers the THIN TOOL
 * LAYER on top of it (zero prior direct coverage): success/failure
 * message shaping, itemId key formatting, and signal threading.
 *
 * The runProjectViaBundle dep is injected so we never boot a real walk.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeRegenerateNodeTool } from '../../src/agent/pi/tools/dheeRegenerateNode.js';

interface ToolLike {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

const made: string[] = [];
afterEach(() => {
  made.splice(0).forEach((d) => existsSync(d) && rmSync(d, { recursive: true, force: true }));
});

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'regen-tool-'));
  made.push(dir);
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({
      name: 'x',
      bundleSource: 'built-in:narrative_qwen_chain_relay',
      walkState: { nodes: { story: { status: 'completed', outputPath: 'plans/story.md' } } },
    }),
  );
  return dir;
}

describe('dhee_regenerate_node (tool wrapper)', () => {
  it('reports success and names the node on a clean regen', async () => {
    const dir = tmpProject();
    const runProjectViaBundle = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeRegenerateNodeTool({ runProjectViaBundle }) as unknown as ToolLike;

    const out = await tool.execute('t', { projectDir: dir, nodeId: 'story' });

    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/regenerated 'story'/i);
    expect(runProjectViaBundle).toHaveBeenCalledTimes(1);
  });

  it('formats the key as nodeId:itemId for a collection item', async () => {
    const dir = tmpProject();
    const runProjectViaBundle = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeRegenerateNodeTool({ runProjectViaBundle }) as unknown as ToolLike;

    const out = await tool.execute('t', {
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
    });

    expect(out.content[0].text).toContain('shot_image:scene_1_shot_3');
  });

  it('surfaces a runner failure as isError with the underlying message', async () => {
    const dir = tmpProject();
    const runProjectViaBundle = vi.fn().mockResolvedValue({ ok: false, error: 'comfy unreachable' });
    const tool = makeRegenerateNodeTool({ runProjectViaBundle }) as unknown as ToolLike;

    const out = await tool.execute('t', { projectDir: dir, nodeId: 'story' });

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/failed/i);
    expect(out.content[0].text).toMatch(/comfy unreachable/);
  });

  it('threads the AbortSignal through to the runner', async () => {
    const dir = tmpProject();
    const controller = new AbortController();
    const runProjectViaBundle = vi.fn().mockResolvedValue({ ok: true });
    const tool = makeRegenerateNodeTool({ runProjectViaBundle }) as unknown as ToolLike;

    await tool.execute('t', { projectDir: dir, nodeId: 'story' }, controller.signal);

    expect(runProjectViaBundle).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
    );
  });

  it('production path invalidates and dispatches the re-run in the background without using the chat AbortSignal', async () => {
    const dir = tmpProject();
    const controller = new AbortController();
    const dispatch = vi.fn().mockReturnValue({ status: 'started', taskId: 'task-bg-1' });
    const getActive = vi.fn().mockReturnValue(null);
    const tool = makeRegenerateNodeTool({
      getBackgroundTaskRunner: () => ({
        getActive,
        dispatch,
      }),
    }) as unknown as ToolLike;

    const out = await tool.execute('t', { projectDir: dir, nodeId: 'story' }, controller.signal);

    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/started in the background/i);
    expect(dispatch).toHaveBeenCalledWith({
      kind: 'run_to',
      projectName: expect.stringMatching(/^regen-tool-/),
      params: { projectDir: dir },
      sessionId: expect.stringMatching(/^dhee_regenerate_node:regen-tool-/),
    });

    const after = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'));
    expect(after.walkState.nodes.story).toBeUndefined();
    expect(after.walkState.lastInvalidatedIds).toContain('story');
  });
});
