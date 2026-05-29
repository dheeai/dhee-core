/**
 * Regression: BUG-023 — when an upstream LLM node is invalidated +
 * re-run via the `pendingCritiques` mechanism, the downstream
 * non-text artifact (image / video) MUST also be re-rendered. The
 * walker was treating a present file at the downstream node's
 * outputPath as a cache-hit and skipping the runner, even though the
 * upstream re-run produced a new prompt.
 *
 * Real-world repro: 22 broken `shot_image_prompt` entries critiqued
 * in batch via `applyOnly:true`, then `dhee_run_bundle` called. The
 * LLM phase ran (new prompt JSONs landed on disk), but the Qwen
 * `shot_image` phase was silently skipped because the cloned PNGs
 * were still sitting at their expected outputPaths. The downstream
 * LTX `scene_clip` cascade then fired against the OLD images,
 * producing scene videos with the unchanged broken shots.
 *
 * Failure modes covered:
 *  - Stage upstream → collection downstream: stamping a critique on
 *    the upstream stage MUST invalidate every collection-item
 *    downstream so the runner is re-invoked.
 *  - Per-item: a critique on `node:item` must re-render
 *    `downstream:item` ONLY (not `downstream:other_item`).
 *  - Regression-guard: an untouched downstream (no upstream change)
 *    is still cache-skipped via the file-exists check — the fix is
 *    "force re-render when upstream re-ran in this walk", not
 *    "always re-render".
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner } from '../../src/dag/schema.js';

let projectDir: string;
let runCalls: { nodeId: string; itemId: string | undefined }[] = [];

function makeCountingRunner(): Runner {
  return {
    describe: () => ({
      id: 'stub.counting',
      displayName: 'stub',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      runCalls.push({ nodeId: ctx.node.id, itemId: ctx.itemId });
      const out = ctx.itemId
        ? ctx.node.outputs.pattern.replace('{{item_id}}', ctx.itemId)
        : ctx.node.outputs.pattern;
      const outAbs = join(ctx.projectDir, out);
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, `output of ${ctx.node.id}${ctx.itemId ? ':' + ctx.itemId : ''}`);
      return { ok: true, outputPath: out };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'bug-023-'));
  runCalls = [];
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.counting', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeCountingRunner(),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

/**
 * Bundle shape — minimal stage→stage to isolate the cascade-cache bug
 * from collection-materialization complexity. The real-world bug
 * manifests on a stage→collection topology, but the cache-skip
 * mechanism is identical: walker sees file at outputPath, marks
 * completed without invoking runner.
 */
function makeBundle(): DagBundle {
  return {
    id: 'bug-023-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'image_node',
    nodes: [
      {
        id: 'prompt_node',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'prompts/prompt.json' },
        runner: { tool: 'stub.counting', config: {} },
      },
      {
        id: 'image_node',
        kind: 'stage',
        inputs: [{ from: 'prompt_node', usage: 'input' }],
        outputs: { format: 'image', pattern: 'assets/images/single.png' },
        runner: { tool: 'stub.counting', config: {} },
      },
    ],
  };
}

/** Seed walkState + on-disk artifacts to simulate a project that
 *  has already been rendered once.
 *  `items` param is kept for API symmetry with the original
 *  collection test, but in stage→stage we only use the first one. */
function seedCompletedProject(items: string[]): void {
  void items;
  // Upstream prompt artifact (any content is fine — downstream is
  // also a stage, no materialization parse).
  const promptAbs = join(projectDir, 'prompts/prompt.json');
  mkdirSync(join(promptAbs, '..'), { recursive: true });
  writeFileSync(promptAbs, JSON.stringify({ prompt: 'OLD prompt text' }));

  // Downstream image artifact — pre-existing file, the cache-hit trap.
  const imgAbs = join(projectDir, 'assets/images/single.png');
  mkdirSync(join(imgAbs, '..'), { recursive: true });
  writeFileSync(imgAbs, 'OLD-IMAGE');

  // project.json with walkState describing "everything completed".
  // walkState.bundleSource MUST match the walkBundle({bundleSource})
  // arg — the walker reinitializes (wipes) the state on a mismatch.
  const project = {
    bundleSource: 'built-in:bug-023-test',
    walkState: {
      bundleSource: 'built-in:bug-023-test',
      bundleVersion: '0.1.0',
      engineVersion: '0.1.0',
      nodes: {
        prompt_node: {
          status: 'completed',
          outputPath: 'prompts/prompt.json',
          completedAt: 1_000_000,
        },
        image_node: {
          status: 'completed',
          outputPath: 'assets/images/single.png',
          completedAt: 1_000_000,
        },
      },
      lastInvalidatedIds: [],
    },
  };
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));
}

function readProject(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('BUG-023 — pendingCritique on upstream forces downstream non-text re-render', () => {
  it('downstream image_node is re-invoked when upstream prompt_node is invalidated by a critique', async () => {
    seedCompletedProject([]);

    // Simulate dhee_critique_node(applyOnly:true) — stamp the
    // critique + invalidate ONLY the upstream prompt_node. The
    // walker is responsible for cascading.
    const project = readProject();
    project['pendingCritiques'] = { prompt_node: 'restructure for full character anchoring' };
    (project['walkState'] as { nodes: Record<string, unknown> }).nodes['prompt_node'] = {
      status: 'invalidated',
    };
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));

    const result = await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:bug-023-test',
    });
    expect(result.ok).toBe(true);

    // Upstream MUST have re-run (the critique demands it).
    expect(runCalls.find((c) => c.nodeId === 'prompt_node')).toBeDefined();

    // Downstream image_node MUST have been re-invoked — this is the
    // bug. Pre-fix: zero image_node runs because the PNG file already
    // existed at outputPath.
    expect(runCalls.find((c) => c.nodeId === 'image_node')).toBeDefined();

    // And the on-disk file should reflect the new run, not the
    // OLD-IMAGE placeholder we seeded.
    const content = readFileSync(join(projectDir, 'assets/images/single.png'), 'utf8');
    expect(content).toBe('output of image_node');
  });

  it('regression-guard: untouched downstream (no upstream change) is still cache-skipped', async () => {
    // Same seed, but NO pendingCritique and NO invalidation.
    // Re-running the walker over a fully-completed project should
    // skip everything — re-rendering on every walk would be a
    // performance regression.
    seedCompletedProject([]);
    const result = await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:bug-023-test',
    });
    expect(result.ok).toBe(true);
    expect(runCalls).toEqual([]);
    // The seeded OLD-IMAGE file is preserved.
    const content = readFileSync(join(projectDir, 'assets/images/single.png'), 'utf8');
    expect(content).toBe('OLD-IMAGE');
  });

  it.todo('per-item cascade: critique on prompt_node:item_A only re-renders image_node:item_A downstream (collection→collection topology)');
});

