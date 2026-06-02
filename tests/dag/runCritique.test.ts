/**
 * Tests for runCritique — the helper that stamps a pending critique
 * onto project.json's walkState, invalidates the target node, and
 * leaves the actual LLM re-fire to the next walker pass.
 *
 * Decoupled from runProjectViaBundle: tests inject a stub runner so
 * the helper's contract is verified without booting an LLM client.
 *
 * Failure modes enumerated:
 *  - Non-LLM node target → rejects with a clear error message; no
 *    state change.
 *  - Unknown nodeId → rejects with 'unknown node'.
 *  - Project.json missing → rejects with a clear path.
 *  - Happy path (singleton): writes pendingCritiques[nodeId] and
 *    invalidates the node's walkState entry.
 *  - Happy path (collection w/ itemId): writes pendingCritiques key
 *    as `nodeId:itemId` and invalidates that item only.
 *  - Idempotency: calling twice with the same critique just overwrites.
 *  - The runner dispatch is invoked with NO runOnly argument —
 *    cascade-invalidation does all the work before dispatch, walker
 *    is state-as-truth. (Pre-cascade walker required runOnly as a
 *    force-rerun hint; that's a no-op now.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCritique } from '../../src/dag/runCritique.js';
import type { DagBundle } from '../../src/dag/schema.js';

function makeBundle(): DagBundle {
  return {
    id: 'critique-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'shot_image',
    nodes: [
      {
        id: 'characters_plan',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/characters_plan.json' },
        runner: { tool: 'llm.generate', config: {} },
      },
      {
        id: 'shot_image_prompt',
        kind: 'collection',
        inputs: [{ from: 'characters_plan', usage: 'context' }],
        outputs: { format: 'json', pattern: 'prompts/shot_image/{{item_id}}.json' },
        runner: { tool: 'llm.generate', config: {} },
      },
      {
        id: 'shot_image',
        kind: 'collection',
        inputs: [{ from: 'shot_image_prompt', usage: 'input' }],
        outputs: { format: 'image', pattern: 'assets/images/shots/{{item_id}}.png' },
        runner: { tool: 'comfy.image', config: {} },
      },
    ],
  };
}

function makeProjectDir(walkState: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'critique-test-'));
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(
    join(dir, 'project.json'),
    JSON.stringify({ name: 'TestProj', walkState }, null, 2),
    'utf8',
  );
  return dir;
}

function readProject(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8')) as Record<string, unknown>;
}

const cleanupDirs: string[] = [];
afterEach(() => {
  while (cleanupDirs.length) {
    try {
      rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
    } catch {}
  }
});

describe('runCritique', () => {
  it('rejects when target node uses a non-LLM runner', async () => {
    const dir = makeProjectDir({
      nodes: { 'shot_image:s1_1': { status: 'completed', outputPath: 'x.png' } },
    });
    cleanupDirs.push(dir);
    const dispatch = vi.fn();
    const result = await runCritique({
      projectDir: dir,
      bundle: makeBundle(),
      nodeId: 'shot_image',
      itemId: 's1_1',
      critique: 'too dark',
      runProjectViaBundle: dispatch as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/only llm\.\* runners.*critique/i);
    expect(dispatch).not.toHaveBeenCalled();
    expect(readProject(dir)['pendingCritiques']).toBeUndefined();
  });

  it('rejects unknown nodeId', async () => {
    const dir = makeProjectDir({ nodes: {} });
    cleanupDirs.push(dir);
    const result = await runCritique({
      projectDir: dir,
      bundle: makeBundle(),
      nodeId: 'no_such_node',
      critique: 'whatever',
      runProjectViaBundle: vi.fn() as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/unknown node/i);
  });

  it('rejects when project.json is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'critique-test-'));
    cleanupDirs.push(dir);
    const result = await runCritique({
      projectDir: dir,
      bundle: makeBundle(),
      nodeId: 'characters_plan',
      critique: 'fix names',
      runProjectViaBundle: vi.fn() as never,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/project\.json/i);
  });

  it('happy path singleton: writes pendingCritiques + invalidates + dispatches (no runOnly — cascade did the work)', async () => {
    const dir = makeProjectDir({
      nodes: {
        characters_plan: { status: 'completed', outputPath: 'plans/characters_plan.json' },
        'shot_image_prompt:s1_1': { status: 'completed', outputPath: 'prompts/shot_image/s1_1.json' },
      },
    });
    cleanupDirs.push(dir);
    const dispatch = vi.fn(async (_args: { projectDir: string; runOnly?: string[] }) => ({ ok: true }) as never);
    const result = await runCritique({
      projectDir: dir,
      bundle: makeBundle(),
      nodeId: 'characters_plan',
      critique: 'Pawn shop owner is rendered as a thin young man; description must lock in bald + overweight + 50s.',
      runProjectViaBundle: dispatch as never,
    });
    expect(result.ok).toBe(true);

    const project = readProject(dir);
    expect((project['pendingCritiques'] as Record<string, string>)['characters_plan']).toMatch(/bald \+ overweight/);
    const ws = project['walkState'] as { nodes: Record<string, unknown>; lastInvalidatedIds?: string[] };
    expect(ws.nodes['characters_plan']).toBeUndefined();
    expect(ws.lastInvalidatedIds).toContain('characters_plan');

    expect(dispatch).toHaveBeenCalledTimes(1);
    const dispatchArg = dispatch.mock.calls[0]![0];
    // Post-cascade: dispatch carries projectDir only. invalidateNodes
    // already cleared characters_plan + all transitive consumers; the
    // walker re-runs everything pending without a runOnly hint.
    expect(dispatchArg.runOnly).toBeUndefined();
    expect(dispatchArg.projectDir).toBe(dir);
  });

  it('happy path with itemId: writes pendingCritiques[nodeId:itemId], invalidates that item only', async () => {
    const dir = makeProjectDir({
      nodes: {
        'shot_image_prompt:scene_1_shot_3': { status: 'completed', outputPath: 'prompts/shot_image/scene_1_shot_3.json' },
        'shot_image_prompt:scene_1_shot_4': { status: 'completed', outputPath: 'prompts/shot_image/scene_1_shot_4.json' },
      },
    });
    cleanupDirs.push(dir);
    const dispatch = vi.fn(async (_args: { projectDir: string; runOnly?: string[] }) => ({ ok: true }) as never);
    const result = await runCritique({
      projectDir: dir,
      bundle: makeBundle(),
      nodeId: 'shot_image_prompt',
      itemId: 'scene_1_shot_3',
      critique: 'Add depot lighting + setting tokens; freeze on the kiss moment instead of sequencing 6 actions.',
      runProjectViaBundle: dispatch as never,
    });
    expect(result.ok).toBe(true);

    const project = readProject(dir);
    expect((project['pendingCritiques'] as Record<string, string>)['shot_image_prompt:scene_1_shot_3']).toMatch(/depot lighting/);
    const ws = project['walkState'] as { nodes: Record<string, unknown> };
    expect(ws.nodes['shot_image_prompt:scene_1_shot_3']).toBeUndefined();
    // The other item is untouched.
    expect(ws.nodes['shot_image_prompt:scene_1_shot_4']).toBeDefined();

    // Post-cascade: no runOnly on dispatch. invalidateNodes cascaded
    // the per-item dep graph; walker re-runs whatever's pending.
    const dispatchArg = dispatch.mock.calls[0]![0];
    expect(dispatchArg.runOnly).toBeUndefined();
  });

  it('overwrites a prior critique for the same key (idempotent re-call)', async () => {
    const dir = makeProjectDir({
      nodes: { characters_plan: { status: 'completed', outputPath: 'plans/characters_plan.json' } },
      pendingCritiques: { characters_plan: 'old critique' },
    });
    cleanupDirs.push(dir);
    const dispatch = vi.fn(async () => ({ ok: true }) as never);
    await runCritique({
      projectDir: dir,
      bundle: makeBundle(),
      nodeId: 'characters_plan',
      critique: 'new critique',
      runProjectViaBundle: dispatch as never,
    });
    const project = readProject(dir);
    expect((project['pendingCritiques'] as Record<string, string>)['characters_plan']).toBe('new critique');
  });

  it('returns the dispatch result as runResult on the response envelope', async () => {
    const dir = makeProjectDir({
      nodes: { characters_plan: { status: 'completed', outputPath: 'plans/characters_plan.json' } },
    });
    cleanupDirs.push(dir);
    const dispatchResult = { ok: true, finalVideoAbs: undefined };
    const dispatch = vi.fn(async () => dispatchResult as never);
    const result = await runCritique({
      projectDir: dir,
      bundle: makeBundle(),
      nodeId: 'characters_plan',
      critique: 'fix it',
      runProjectViaBundle: dispatch as never,
    });
    expect(result.ok).toBe(true);
    expect(result.runResult).toBe(dispatchResult);
  });

  describe('applyOnly mode', () => {
    it('applyOnly=true: stamps + invalidates but skips dispatch entirely', async () => {
      const dir = makeProjectDir({
        nodes: {
          'shot_image_prompt:scene_1_shot_4': {
            status: 'completed',
            outputPath: 'prompts/shot_image/scene_1_shot_4.json',
          },
        },
      });
      cleanupDirs.push(dir);
      const dispatch = vi.fn();
      const result = await runCritique({
        projectDir: dir,
        bundle: makeBundle(),
        nodeId: 'shot_image_prompt',
        itemId: 'scene_1_shot_4',
        critique: 'freeze on the kiss',
        applyOnly: true,
        runProjectViaBundle: dispatch as never,
      });
      expect(result.ok).toBe(true);
      expect(dispatch).not.toHaveBeenCalled();

      const project = readProject(dir);
      expect((project['pendingCritiques'] as Record<string, string>)[
        'shot_image_prompt:scene_1_shot_4'
      ]).toBe('freeze on the kiss');
      const ws = project['walkState'] as {
        nodes: Record<string, unknown>;
        lastInvalidatedIds?: string[];
      };
      expect(ws.nodes['shot_image_prompt:scene_1_shot_4']).toBeUndefined();
      // lastInvalidatedIds is keyed by bare nodeId, not the item-qualified key.
      expect(ws.lastInvalidatedIds).toContain('shot_image_prompt');
    });

    it('applyOnly=true: many critiques in a row accumulate pendingCritiques without dispatching', async () => {
      const dir = makeProjectDir({
        nodes: Object.fromEntries(
          ['scene_1_shot_4', 'scene_1_shot_5', 'scene_1_shot_6'].map((id) => [
            `shot_image_prompt:${id}`,
            { status: 'completed', outputPath: `prompts/shot_image/${id}.json` },
          ]),
        ),
      });
      cleanupDirs.push(dir);
      const dispatch = vi.fn();
      for (const item of ['scene_1_shot_4', 'scene_1_shot_5', 'scene_1_shot_6']) {
        await runCritique({
          projectDir: dir,
          bundle: makeBundle(),
          nodeId: 'shot_image_prompt',
          itemId: item,
          critique: `critique for ${item}`,
          applyOnly: true,
          runProjectViaBundle: dispatch as never,
        });
      }
      expect(dispatch).toHaveBeenCalledTimes(0);

      const project = readProject(dir);
      const pending = project['pendingCritiques'] as Record<string, string>;
      expect(Object.keys(pending).sort()).toEqual([
        'shot_image_prompt:scene_1_shot_4',
        'shot_image_prompt:scene_1_shot_5',
        'shot_image_prompt:scene_1_shot_6',
      ]);
      const ws = project['walkState'] as { nodes: Record<string, unknown> };
      for (const item of ['scene_1_shot_4', 'scene_1_shot_5', 'scene_1_shot_6']) {
        expect(ws.nodes[`shot_image_prompt:${item}`]).toBeUndefined();
      }
    });

    it('applyOnly=false / omitted preserves dispatch (back-compat)', async () => {
      const dir = makeProjectDir({
        nodes: { characters_plan: { status: 'completed', outputPath: 'plans/characters_plan.json' } },
      });
      cleanupDirs.push(dir);
      const dispatch = vi.fn(async () => ({ ok: true }) as never);
      await runCritique({
        projectDir: dir,
        bundle: makeBundle(),
        nodeId: 'characters_plan',
        critique: 'fix it',
        applyOnly: false,
        runProjectViaBundle: dispatch as never,
      });
      expect(dispatch).toHaveBeenCalledTimes(1);
    });
  });
});
