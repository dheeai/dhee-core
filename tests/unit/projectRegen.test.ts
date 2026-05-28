/**
 * projectRegen — shared walker-driven invalidate + regenerate helpers.
 *
 * Replaces the dead ConversationManager.redoNode / invalidateNodes
 * facade. Both the pi-agent custom tool (`dhee_regenerate_node`) and
 * the desktop's IPC bridge call these as the single source of truth.
 *
 * `runProjectViaBundle` is dependency-injected so we don't actually
 * boot a bundle in tests; we assert the helper mutates walkState
 * correctly and dispatches with the right runOnly.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { invalidateNodes, regenerateNode } from '../../src/dag/projectRegen.js';

let projectDir: string;

function makeProject(
  nodes: Record<string, { status: string; outputPath?: string; itemId?: string; error?: string }>,
  bundleSource = 'built-in:narrative_qwen_chain_relay',
): string {
  const dir = mkdtempSync(join(tmpdir(), 'kshana-project-regen-'));
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({
      name: 'test',
      bundleSource,
      walkState: {
        bundleSource,
        bundleVersion: '1.0.0',
        engineVersion: '0.1.0',
        nodes,
        lastInvalidatedIds: [],
      },
    }),
    'utf8',
  );
  return dir;
}

afterEach(() => {
  if (projectDir && existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
});

describe('regenerateNode', () => {
  it('clears the node entry, marks it lastInvalidated, then dispatches runProjectViaBundle with runOnly=[nodeId]', async () => {
    projectDir = makeProject({
      story: { status: 'completed', outputPath: 'plans/story.md' },
    });
    const runSpy = vi.fn().mockResolvedValue({ ok: true });

    const result = await regenerateNode({
      projectDir,
      nodeId: 'story',
      runProjectViaBundle: runSpy,
    });

    expect(result.ok).toBe(true);
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ projectDir, runOnly: ['story'] }));

    const after = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(after.walkState.nodes.story).toBeUndefined();
    expect(after.walkState.lastInvalidatedIds).toContain('story');
  });

  it('handles a per-item invalidation by deleting only the matching nodeId:itemId entry', async () => {
    projectDir = makeProject({
      'shot_image:scene_1_shot_3': {
        status: 'completed',
        outputPath: 'assets/scene_1/shot_3.png',
        itemId: 'scene_1_shot_3',
      },
      'shot_image:scene_1_shot_4': {
        status: 'completed',
        outputPath: 'assets/scene_1/shot_4.png',
        itemId: 'scene_1_shot_4',
      },
    });
    const runSpy = vi.fn().mockResolvedValue({ ok: true });

    const result = await regenerateNode({
      projectDir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
      runProjectViaBundle: runSpy,
    });

    expect(result.ok).toBe(true);
    const after = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(after.walkState.nodes['shot_image:scene_1_shot_3']).toBeUndefined();
    expect(after.walkState.nodes['shot_image:scene_1_shot_4']).toBeDefined();
    expect(after.walkState.lastInvalidatedIds).toContain('shot_image');
  });

  it('errors clearly when project.json is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kshana-project-regen-missing-'));
    const ghost = join(dir, 'does-not-exist');
    const runSpy = vi.fn();

    const result = await regenerateNode({
      projectDir: ghost,
      nodeId: 'story',
      runProjectViaBundle: runSpy,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/project\.json not found/i);
    expect(runSpy).not.toHaveBeenCalled();
    rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the bundle runner error and still leaves invalidation persisted (so a retry picks up where we left off)', async () => {
    projectDir = makeProject({
      story: { status: 'completed', outputPath: 'plans/story.md' },
    });
    const runSpy = vi.fn().mockResolvedValue({ ok: false, error: 'comfy unreachable' });

    const result = await regenerateNode({
      projectDir,
      nodeId: 'story',
      runProjectViaBundle: runSpy,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/comfy unreachable/);
    const after = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(after.walkState.nodes.story).toBeUndefined();
    expect(after.walkState.lastInvalidatedIds).toContain('story');
  });

  it('propagates an AbortSignal through to the runner', async () => {
    projectDir = makeProject({ story: { status: 'completed', outputPath: 'plans/story.md' } });
    const controller = new AbortController();
    const runSpy = vi.fn().mockResolvedValue({ ok: true });

    await regenerateNode({
      projectDir,
      nodeId: 'story',
      runProjectViaBundle: runSpy,
      signal: controller.signal,
    });

    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
  });
});

describe('invalidateNodes', () => {
  beforeEach(() => {
    projectDir = makeProject({
      story: { status: 'completed', outputPath: 'plans/story.md' },
      'shot_image:scene_1_shot_3': {
        status: 'completed',
        outputPath: 'assets/scene_1/shot_3.png',
        itemId: 'scene_1_shot_3',
      },
    });
  });

  it('removes nodes from walkState + records them in lastInvalidatedIds without dispatching anything', async () => {
    const result = await invalidateNodes({ projectDir, nodeIds: ['story'] });

    expect(result.invalidated).toEqual(['story']);
    expect(result.notFound).toEqual([]);

    const after = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(after.walkState.nodes.story).toBeUndefined();
    expect(after.walkState.lastInvalidatedIds).toContain('story');
    // The other node was untouched.
    expect(after.walkState.nodes['shot_image:scene_1_shot_3']).toBeDefined();
  });

  it('classifies non-existent nodes as notFound but still processes the ones that exist', async () => {
    const result = await invalidateNodes({
      projectDir,
      nodeIds: ['story', 'totally_made_up_node'],
    });

    expect(result.invalidated).toEqual(['story']);
    expect(result.notFound).toEqual(['totally_made_up_node']);
  });

  it('is idempotent — calling twice with the same ids is fine and lastInvalidatedIds stays deduped', async () => {
    await invalidateNodes({ projectDir, nodeIds: ['story'] });
    const after1 = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(after1.walkState.lastInvalidatedIds.filter((x: string) => x === 'story').length).toBe(1);

    const r2 = await invalidateNodes({ projectDir, nodeIds: ['story'] });
    expect(r2.invalidated).toEqual([]); // already gone
    expect(r2.notFound).toEqual(['story']);

    const after2 = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(after2.walkState.lastInvalidatedIds.filter((x: string) => x === 'story').length).toBe(1);
  });

  it('handles a collection nodeId:itemId key — invalidates the specific item and preserves siblings', async () => {
    projectDir = makeProject({
      'shot_image:scene_1_shot_3': {
        status: 'completed',
        outputPath: 'assets/scene_1/shot_3.png',
        itemId: 'scene_1_shot_3',
      },
      'shot_image:scene_1_shot_4': {
        status: 'completed',
        outputPath: 'assets/scene_1/shot_4.png',
        itemId: 'scene_1_shot_4',
      },
    });

    const r = await invalidateNodes({
      projectDir,
      nodeIds: ['shot_image:scene_1_shot_3'],
    });
    expect(r.invalidated).toEqual(['shot_image:scene_1_shot_3']);

    const after = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(after.walkState.nodes['shot_image:scene_1_shot_3']).toBeUndefined();
    expect(after.walkState.nodes['shot_image:scene_1_shot_4']).toBeDefined();
  });

  it('errors clearly when project.json is missing', async () => {
    const ghost = join(tmpdir(), 'kshana-no-such-project-' + Date.now());
    const result = await invalidateNodes({ projectDir: ghost, nodeIds: ['x'] });
    expect(result.invalidated).toEqual([]);
    expect(result.notFound).toEqual([]);
    expect(result.error).toMatch(/project\.json not found/i);
  });
});
