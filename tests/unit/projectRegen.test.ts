/**
 * projectRegen — shared walker-driven invalidate + regenerate helpers.
 *
 * Replaces the dead ConversationManager.redoNode / invalidateNodes
 * facade. Both the pi-agent custom tool (`dhee_regenerate_node`) and
 * the desktop's IPC bridge call these as the single source of truth.
 *
 * `runProjectViaBundle` is dependency-injected so we don't actually
 * boot a bundle in tests; we assert the helper mutates walkState
 * correctly and dispatches the bundle. Post-cascade-refactor: dispatch
 * carries no `runOnly` — invalidateNodes does the per-instance cascade
 * BEFORE dispatch and the walker is state-as-truth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { invalidateNodes, regenerateNode } from '../../src/dag/projectRegen.js';
import type { DagBundle } from '../../src/dag/schema.js';

// Minimal 3-node chain bundle: prompt -> image -> clip, wired via inputs[].from.
// Only `nodes[].id` and `nodes[].inputs[].from` are read by the structural cascade.
function chainBundle(): DagBundle {
  return {
    id: 'chain', version: '1.0.0', goal: 'a_clip',
    nodes: [
      { id: 'a_prompt', inputs: [], runner: { tool: 'llm.generate', config: {} }, outputs: { format: 'json', pattern: 'p.json' } },
      { id: 'a_image', inputs: [{ from: 'a_prompt', usage: 'input' }], runner: { tool: 'comfy.klein', config: {} }, outputs: { format: 'image', pattern: 'i.png' } },
      { id: 'a_clip', inputs: [{ from: 'a_image', usage: 'input' }], runner: { tool: 'comfy.ltx_director', config: {} }, outputs: { format: 'video', pattern: 'c.mp4' } },
    ],
  } as unknown as DagBundle;
}

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
  it('clears the node entry, marks it lastInvalidated, then dispatches runProjectViaBundle (no runOnly — cascade did the work)', async () => {
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
    // Dispatch carries projectDir but NO runOnly — cascade-invalidation
    // already cleared the target + downstream, walker is state-as-truth.
    expect(runSpy).toHaveBeenCalledWith(expect.objectContaining({ projectDir }));
    expect(runSpy).toHaveBeenCalledWith(expect.not.objectContaining({ runOnly: expect.anything() }));

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

  // issue #158: the event-derived cascade goes blind when a runner recorded a
  // wrong/stale upstream dep (e.g. comfy.klein's phantom 'shot_image_prompt').
  // Passing the bundle makes invalidateNodes follow the authoritative static
  // inputs[] graph, so a prompt invalidation reliably reaches its image + clip.
  it('cascades over the bundle inputs[] graph when a bundle is passed (issue #158)', async () => {
    projectDir = makeProject({
      a_prompt: { status: 'completed' },
      a_image: { status: 'completed' },
      a_clip: { status: 'completed' },
    });
    // No event log here, so the event-derived cascade alone would only clear a_prompt.
    await invalidateNodes({ projectDir, nodeIds: ['a_prompt'], bundle: chainBundle() });
    const after = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(after.walkState.nodes.a_prompt).toBeUndefined();
    expect(after.walkState.nodes.a_image).toBeUndefined(); // structural downstream reached
    expect(after.walkState.nodes.a_clip).toBeUndefined(); // transitively reached
  });

  it('WITHOUT a bundle, the cascade leaves structural downstream stale (the #158 bug, counter-test)', async () => {
    projectDir = makeProject({
      a_prompt: { status: 'completed' },
      a_image: { status: 'completed' },
    });
    await invalidateNodes({ projectDir, nodeIds: ['a_prompt'] });
    const after = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(after.walkState.nodes.a_prompt).toBeUndefined(); // target cleared
    // With no bundle AND no recorded event dep, the downstream image survives —
    // exactly the silent failure that left the ghost-hand image un-regenerated.
    expect(after.walkState.nodes.a_image).toBeDefined();
  });

  it('errors clearly when project.json is missing', async () => {
    const ghost = join(tmpdir(), 'kshana-no-such-project-' + Date.now());
    const result = await invalidateNodes({ projectDir: ghost, nodeIds: ['x'] });
    expect(result.invalidated).toEqual([]);
    expect(result.notFound).toEqual([]);
    expect(result.error).toMatch(/project\.json not found/i);
  });

  it('preserves the on-disk artifact as a versioned sibling instead of unlinking', async () => {
    // Seed an on-disk artifact + walkState entry pointing at it.
    const artifactRel = 'assets/scene_1/shot_3.png';
    const artifactAbs = join(projectDir, artifactRel);
    mkdirSync(join(projectDir, 'assets/scene_1'), { recursive: true });
    writeFileSync(artifactAbs, 'original-bytes');
    const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    proj.walkState.nodes['shot_image:scene_1_shot_3'] = {
      status: 'completed',
      outputPath: artifactRel,
      itemId: 'scene_1_shot_3',
    };
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(proj));

    await invalidateNodes({ projectDir, nodeIds: ['shot_image:scene_1_shot_3'] });

    // The canonical path is gone (renamed, not unlinked).
    expect(existsSync(artifactAbs)).toBe(false);
    // The .v1 sibling holds the original bytes.
    const v1 = join(projectDir, 'assets/scene_1/shot_3.v1.png');
    expect(existsSync(v1)).toBe(true);
    expect(readFileSync(v1, 'utf8')).toBe('original-bytes');
  });

  it('emits a version.added event naming the preserved path', async () => {
    // Seed an artifact.
    const artifactRel = 'assets/scene_1/shot_4.png';
    mkdirSync(join(projectDir, 'assets/scene_1'), { recursive: true });
    writeFileSync(join(projectDir, artifactRel), 'old-bytes');
    const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    proj.walkState.nodes['shot_image:scene_1_shot_4'] = {
      status: 'completed',
      outputPath: artifactRel,
      itemId: 'scene_1_shot_4',
    };
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(proj));

    await invalidateNodes({ projectDir, nodeIds: ['shot_image:scene_1_shot_4'] });

    const eventsPath = join(projectDir, '.dhee/events.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; payload: Record<string, unknown> });
    const added = events.filter((e) => e.kind === 'version.added');
    const named = added.find((e) =>
      typeof e.payload.outputPath === 'string'
      && (e.payload.outputPath as string).endsWith('assets/scene_1/shot_4.v1.png'),
    );
    expect(named).toBeDefined();
    // Payload identifies the node + item.
    expect(named?.payload.nodeId).toBe('shot_image');
    expect(named?.payload.itemId).toBe('scene_1_shot_4');
  });

  // Regression: the Cards / Inspector view reads `.dhee/events.jsonl`
  // (projectInstanceGraph), NOT walkState. Before this fix invalidate
  // cleared walkState but emitted NO node.invalidated event, so the
  // cascade was invisible in the UI — marking a node stale left its
  // downstream still showing 'completed'.
  it('emits a node.invalidated event for each invalidated key (so the events-based Cards view shows the cascade)', async () => {
    const result = await invalidateNodes({ projectDir, nodeIds: ['story'] });
    expect(result.invalidated).toContain('story');

    const eventsPath = join(projectDir, '.dhee/events.jsonl');
    expect(existsSync(eventsPath)).toBe(true);
    const events = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; payload: { nodeId?: string; itemId?: string } });
    const inval = events.filter((e) => e.kind === 'node.invalidated');
    expect(inval.some((e) => e.payload.nodeId === 'story')).toBe(true);
  });

  it('emits node.invalidated for a collection item with the right nodeId + itemId', async () => {
    await invalidateNodes({ projectDir, nodeIds: ['shot_image:scene_1_shot_3'] });
    const events = readFileSync(join(projectDir, '.dhee/events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; payload: { nodeId?: string; itemId?: string } });
    const inval = events.filter((e) => e.kind === 'node.invalidated');
    expect(
      inval.some((e) => e.payload.nodeId === 'shot_image' && e.payload.itemId === 'scene_1_shot_3'),
    ).toBe(true);
  });
});
