/**
 * Agent tools that read/write the event-sourced projection directly:
 * dhee_fork, dhee_swap_runner, dhee_select_version, dhee_list_versions.
 *
 * These four had ZERO direct test coverage (the review's crown-jewel
 * gap) even though they mutate project history. We exercise them against
 * a REAL ProjectionEngine on a temp project dir — no mock theater — so a
 * regression in the event payloads, branch filtering, or version-tray
 * fold is actually caught.
 *
 * Pattern mirrors dheeStartStopRun.test.ts: factory → cast to ToolLike →
 * execute() → assert on content text + on the on-disk event log.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { makeForkTool } from '../../src/agent/pi/tools/dheeFork.js';
import { makeSwapRunnerTool } from '../../src/agent/pi/tools/dheeSwapRunner.js';
import { makeSelectVersionTool } from '../../src/agent/pi/tools/dheeSelectVersion.js';
import { makeListVersionsTool } from '../../src/agent/pi/tools/dheeListVersions.js';
import { openProjectionEngine } from '../../src/dag/eventLog/ProjectionEngine.js';

interface ToolLike {
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean; details?: Record<string, unknown> }>;
}

const made: string[] = [];
afterEach(() => {
  made.splice(0).forEach((d) => existsSync(d) && rmSync(d, { recursive: true, force: true }));
});

function tmpProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'proj-tools-'));
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ name: 'x', bundleSource: 'built-in:b' }));
  made.push(dir);
  return dir;
}

/** Seed a completed node version on a branch via the real engine. */
function seedVersion(
  dir: string,
  nodeId: string,
  versionId: string,
  opts: { itemId?: string; branchId?: string; outputPath?: string } = {},
) {
  openProjectionEngine(dir).appendAndProject({
    branchId: opts.branchId ?? 'main',
    actor: 'walker',
    kind: 'node.completed',
    payload: {
      nodeId,
      versionId,
      outputPath: opts.outputPath ?? `out/${nodeId}.${versionId}.md`,
      ...(opts.itemId ? { itemId: opts.itemId } : {}),
    },
  } as never);
}

function readEvents(dir: string): Array<{ kind: string; branchId: string; payload: Record<string, unknown> }> {
  const path = join(dir, '.dhee/events.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// ── dhee_fork ─────────────────────────────────────────────────────────

describe('dhee_fork', () => {
  it('forks from the latest event on the parent and records a branch.created event', async () => {
    const dir = tmpProject();
    seedVersion(dir, 'story', 'v1');
    const fork = makeForkTool() as unknown as ToolLike;

    const out = await fork.execute('t', { projectDir: dir, branchId: 'noir', label: 'noir grade' });

    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/noir/);
    const created = readEvents(dir).filter((e) => e.kind === 'branch.created');
    expect(created).toHaveLength(1);
    expect(created[0]!.payload.branchId).toBe('noir');
    expect(created[0]!.payload.parentBranchId).toBe('main');
    expect(created[0]!.payload.label).toBe('noir grade');
  });

  it('refuses to fork a parent branch with no events', async () => {
    const dir = tmpProject();
    const fork = makeForkTool() as unknown as ToolLike;
    const out = await fork.execute('t', { projectDir: dir, branchId: 'noir' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/no events yet/i);
  });

  it('refuses a duplicate branch id', async () => {
    const dir = tmpProject();
    seedVersion(dir, 'story', 'v1');
    const fork = makeForkTool() as unknown as ToolLike;
    await fork.execute('t', { projectDir: dir, branchId: 'noir' });
    const out = await fork.execute('t', { projectDir: dir, branchId: 'noir' });
    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/already exists/i);
  });
});

// ── dhee_swap_runner ────────────────────────────────────────────────────

describe('dhee_swap_runner', () => {
  it('records a runner.swapped event with the reason for audit', async () => {
    const dir = tmpProject();
    const swap = makeSwapRunnerTool() as unknown as ToolLike;

    const out = await swap.execute('t', {
      projectDir: dir,
      nodeId: 'shot_image',
      itemId: 'scene_1_shot_3',
      toTool: 'comfy.qwen_edit_chain',
      reason: 'style mismatch flagged by VLM judge',
    });

    expect(out.isError).toBeFalsy();
    expect(out.content[0].text).toMatch(/comfy\.qwen_edit_chain/);
    const swapped = readEvents(dir).filter((e) => e.kind === 'runner.swapped');
    expect(swapped).toHaveLength(1);
    expect(swapped[0]!.payload.nodeId).toBe('shot_image');
    expect(swapped[0]!.payload.itemId).toBe('scene_1_shot_3');
    expect(swapped[0]!.payload.toTool).toBe('comfy.qwen_edit_chain');
    expect(swapped[0]!.payload.reason).toMatch(/style mismatch/);
  });

  it('records the swap on the requested branch, not main', async () => {
    const dir = tmpProject();
    const swap = makeSwapRunnerTool() as unknown as ToolLike;
    await swap.execute('t', {
      projectDir: dir,
      nodeId: 'shot_image',
      toTool: 'comfy.klein',
      reason: 'r',
      branchId: 'noir',
    });
    const swapped = readEvents(dir).filter((e) => e.kind === 'runner.swapped');
    expect(swapped[0]!.branchId).toBe('noir');
  });
});

// ── dhee_select_version ─────────────────────────────────────────────────

describe('dhee_select_version', () => {
  it('selects an existing version and the tray reflects the choice', async () => {
    const dir = tmpProject();
    seedVersion(dir, 'story', 'v1');
    seedVersion(dir, 'story', 'v2'); // latest → selected by default
    const select = makeSelectVersionTool() as unknown as ToolLike;

    const out = await select.execute('t', { projectDir: dir, nodeId: 'story', versionId: 'v1' });

    expect(out.isError).toBeFalsy();
    const tray = openProjectionEngine(dir).listVersions('story');
    expect(tray.find((v) => v.selected)?.versionId).toBe('v1');
  });

  it('errors and lists the available versions when the versionId does not exist', async () => {
    const dir = tmpProject();
    seedVersion(dir, 'story', 'v1');
    const select = makeSelectVersionTool() as unknown as ToolLike;

    const out = await select.execute('t', { projectDir: dir, nodeId: 'story', versionId: 'v999' });

    expect(out.isError).toBe(true);
    expect(out.content[0].text).toMatch(/no such version/i);
    expect(out.content[0].text).toMatch(/v1/); // shows what IS available
  });
});

// ── dhee_list_versions ──────────────────────────────────────────────────

describe('dhee_list_versions', () => {
  it('reports "no versions yet" for an unrun node', async () => {
    const dir = tmpProject();
    const list = makeListVersionsTool() as unknown as ToolLike;
    const out = await list.execute('t', { projectDir: dir, nodeId: 'story' });
    expect(out.content[0].text).toMatch(/no versions yet/i);
  });

  it('lists candidates and marks the selected one with a star', async () => {
    const dir = tmpProject();
    seedVersion(dir, 'shot_image', 'v1', { itemId: 'scene_1_shot_1', outputPath: 'out/1.png' });
    seedVersion(dir, 'shot_image', 'v2', { itemId: 'scene_1_shot_1', outputPath: 'out/1.v2.png' });
    const list = makeListVersionsTool() as unknown as ToolLike;

    const out = await list.execute('t', { projectDir: dir, nodeId: 'shot_image', itemId: 'scene_1_shot_1' });

    expect(out.content[0].text).toMatch(/2 candidates/);
    expect(out.content[0].text).toContain('v1');
    expect(out.content[0].text).toContain('v2');
    expect(out.content[0].text).toContain('★'); // the selected marker
  });

  it('scopes by itemId — a different item has its own tray', async () => {
    const dir = tmpProject();
    seedVersion(dir, 'shot_image', 'v1', { itemId: 'scene_1_shot_1', outputPath: 'out/1.png' });
    const list = makeListVersionsTool() as unknown as ToolLike;
    const out = await list.execute('t', { projectDir: dir, nodeId: 'shot_image', itemId: 'scene_1_shot_2' });
    expect(out.content[0].text).toMatch(/no versions yet/i);
  });
});
