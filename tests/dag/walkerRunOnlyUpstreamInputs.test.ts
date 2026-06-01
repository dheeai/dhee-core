/**
 * Regression: BUG-021 — when only the downstream node needs to be
 * re-run (its walkState entry was cleared), the walker must still
 * hydrate UPSTREAM completed instances from walkState so the
 * downstream runner can read their outputs as inputs.
 *
 * Pre-cascade flow: caller passed `runOnly: [downstream]` and a
 * cascadeSet filter inside the walker skipped upstream entirely while
 * hydrating its outputPath for downstream consumption.
 *
 * Post-cascade flow: caller invalidates the downstream node (clearing
 * only its walkState entry, leaving upstream completed). Walker is
 * state-as-truth — upstream skips via the resume short-circuit which
 * also hydrates its outputPath onto the instance — and downstream
 * re-runs with the upstream input populated.
 *
 * The hydration path itself is the regression surface: a future
 * refactor that drops the in-loop hydration would silently break
 * downstream inputs again.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import { invalidateNodes } from '../../src/dag/projectRegen.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner } from '../../src/dag/schema.js';

let projectDir: string;
let inputsByNodeId: Record<string, Record<string, unknown>> = {};

function makeCapturingRunner(): Runner {
  return {
    describe: () => ({
      id: 'stub.capture',
      displayName: 'stub',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      inputsByNodeId[ctx.node.id] = { ...ctx.inputs };
      const outPath = ctx.node.outputs.pattern;
      const outAbs = join(ctx.projectDir, outPath);
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, `output of ${ctx.node.id}`);
      return { ok: true, outputPath: outPath };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'bug-021-'));
  inputsByNodeId = {};
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.capture', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeCapturingRunner(),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

function makeBundle(): DagBundle {
  return {
    id: 'bug-021-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'shot_prompt',
    nodes: [
      {
        id: 'story',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'md', pattern: 'plans/story.md' },
        runner: { tool: 'stub.capture', config: {} },
      },
      {
        id: 'shot_prompt',
        kind: 'stage',
        inputs: [{ from: 'story', usage: 'context' }],
        outputs: { format: 'json', pattern: 'prompts/shot.json' },
        runner: { tool: 'stub.capture', config: {} },
      },
    ],
  };
}

describe('BUG-021 — downstream re-run after invalidate hydrates upstream inputs', () => {
  it('completes a fresh run, invalidates downstream only, re-walks; downstream sees upstream outputs', async () => {
    // Pass 1: end-to-end. Populates walkState for both nodes.
    const r1 = await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:bug-021-test',
    });
    expect(r1.ok).toBe(true);
    // Sanity: shot_prompt saw story's output on the fresh run.
    expect(inputsByNodeId['shot_prompt']?.['story']).toBe('output of story');

    inputsByNodeId = {};

    // Invalidate downstream only. Cascade has no downstream-of-
    // shot_prompt nodes to clear; upstream's walkState entry stays
    // completed.
    await invalidateNodes({ projectDir, nodeIds: ['shot_prompt'] });

    // Pass 2: re-walk. State-as-truth — story is completed + file on
    // disk → skip via short-circuit (which hydrates its outputPath
    // onto the instance). shot_prompt is pending → run, with story's
    // output populated via ctx.inputs.story.
    const r2 = await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:bug-021-test',
    });
    expect(r2.ok).toBe(true);
    expect(inputsByNodeId['story']).toBeUndefined(); // story was NOT re-run
    expect(inputsByNodeId['shot_prompt']?.['story']).toBe('output of story');
  });
});
