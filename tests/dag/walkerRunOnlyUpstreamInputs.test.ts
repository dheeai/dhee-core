/**
 * Regression: BUG-021 — walker with `runOnly: [downstream-node]`
 * must still hydrate UPSTREAM completed instances from walkState so
 * the targeted downstream node can read their outputs as inputs.
 *
 * Repro: bundle with story → shot_prompt. First, run end-to-end so
 * walkState records story=completed with outputPath. Then run with
 * runOnly=['shot_prompt']. The walker should:
 *  - skip the upstream story node (no re-run)
 *  - BUT make story's outputPath available to shot_prompt's runner
 *    via ctx.inputs.
 *
 * Before the fix, shot_prompt saw `inputs = {}` because the walker
 * `continue`-d over the upstream skip and never hydrated
 * instancesById['story'] from walkState. The downstream LLM runner
 * then complained "prompt template references variable(s) that were
 * not provided: story".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
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

describe('BUG-021 — runOnly hydrates upstream completed instances for downstream inputs', () => {
  it('completes a fresh run then re-runs with runOnly=[downstream]; downstream sees upstream outputs', async () => {
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

    // Pass 2: runOnly the downstream. The walker should hydrate
    // story's completed state from walkState and pass its output to
    // shot_prompt as ctx.inputs.story — even though story itself is
    // outside the cascade and won't be re-run.
    const r2 = await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:bug-021-test',
      runOnly: ['shot_prompt'],
    });
    expect(r2.ok).toBe(true);
    expect(inputsByNodeId['story']).toBeUndefined(); // story was NOT re-run
    expect(inputsByNodeId['shot_prompt']?.['story']).toBe('output of story');
  });
});
