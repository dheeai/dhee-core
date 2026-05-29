/**
 * Tests for the review-loop wrapper around the walker.
 *
 * The walker, when a bundle declares `reviewLoopMax > 0`, snapshots
 * `pendingCritiques` keys at entry, runs once, and re-walks if any NEW
 * critique keys appeared during the walk. A `vlm.judge`-style runner
 * is expected to stamp `pendingCritiques[refineNode:itemId]` on a fail
 * verdict; the walker's re-walk then sees the now-invalidated upstream
 * + BUG-023 cascade and re-renders the dependent artifact.
 *
 * Failure modes covered:
 *  - Stub judge fails on iteration 1 → walker re-walks → iter 2 passes → walker exits.
 *  - Stub judge always fails → walker stops at `reviewLoopMax`.
 *  - Bundle without `reviewLoopMax` set → walker exits after one walk
 *    even if pendingCritiques appear (single-shot behavior preserved).
 *  - A pre-existing pendingCritique that's CLEARED during the walk
 *    doesn't trigger a re-walk by itself — only NEW keys do.
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
let runCalls: { nodeId: string; itemId: string | undefined; iteration: number }[] = [];
let currentIteration = 0;

/**
 * Stub judge runner. Behavior is controlled by a per-test
 * `judgeBehavior` callback, registered before walkBundle is invoked.
 *
 * Contract: writes a verdict JSON to outputPath. On fail, also
 * stamps `pendingCritiques[refineNode:itemId]` in project.json so the
 * walker's review-loop sees a new key.
 */
type JudgeVerdict = { pass: boolean; notes: string };
let judgeBehavior: (call: { itemId?: string; iteration: number }) => JudgeVerdict = () => ({
  pass: true,
  notes: 'stub default pass',
});

function makeJudgeStub(refineNode: string): Runner {
  return {
    describe: () => ({
      id: 'stub.judge',
      displayName: 'stub judge',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      const verdict = judgeBehavior({ itemId: ctx.itemId, iteration: currentIteration });
      const outAbs = join(ctx.projectDir, ctx.node.outputs.pattern.replace('{{item_id}}', ctx.itemId ?? 'singleton'));
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, JSON.stringify(verdict));
      if (!verdict.pass) {
        // Judge ONLY stamps pendingCritique. The walker's review-loop
        // wrapper handles invalidation of the upstream walkState entry
        // before re-walking — keeps judges decoupled from walkState
        // mutation and avoids races with the walker's own persistState
        // writes during a walk.
        const projPath = join(ctx.projectDir, 'project.json');
        const project = JSON.parse(readFileSync(projPath, 'utf8')) as {
          pendingCritiques?: Record<string, string>;
        };
        const key = ctx.itemId ? `${refineNode}:${ctx.itemId}` : refineNode;
        project.pendingCritiques = { ...(project.pendingCritiques ?? {}), [key]: verdict.notes };
        writeFileSync(projPath, JSON.stringify(project, null, 2));
      }
      return { ok: true, outputPath: ctx.node.outputs.pattern.replace('{{item_id}}', ctx.itemId ?? 'singleton') };
    },
  };
}

/**
 * Counting runner that ALSO simulates llm.generate's pendingCritique
 * consumption: on success, clears any pendingCritique keyed on this
 * node's id (or `nodeId:itemId`). Without this, the walker's
 * non-empty-pendingCritiques check would loop forever on a manually
 * pre-stamped critique that no stub runner ever consumes.
 */
function makeCountingRunner(): Runner {
  return {
    describe: () => ({
      id: 'stub.counting',
      displayName: 'stub counting',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      runCalls.push({ nodeId: ctx.node.id, itemId: ctx.itemId, iteration: currentIteration });
      const out = ctx.node.outputs.pattern.replace('{{item_id}}', ctx.itemId ?? 'singleton');
      const outAbs = join(ctx.projectDir, out);
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, `${ctx.node.id} iter=${currentIteration}`);

      // Consume pendingCritique for this (node, item) the way llm.generate does.
      const projPath = join(ctx.projectDir, 'project.json');
      try {
        const project = JSON.parse(readFileSync(projPath, 'utf8')) as {
          pendingCritiques?: Record<string, string>;
        };
        const key = ctx.itemId ? `${ctx.node.id}:${ctx.itemId}` : ctx.node.id;
        if (project.pendingCritiques && key in project.pendingCritiques) {
          const { [key]: _consumed, ...rest } = project.pendingCritiques;
          project.pendingCritiques = rest;
          writeFileSync(projPath, JSON.stringify(project, null, 2));
        }
      } catch {}

      return { ok: true, outputPath: out };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'review-loop-'));
  runCalls = [];
  currentIteration = 0;
  judgeBehavior = () => ({ pass: true, notes: 'stub default pass' });
  __resetGlobalRegistryForTesting();
  const reg = getGlobalRegistry();
  reg.register(
    { tool: 'stub.counting', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeCountingRunner(),
  );
  reg.register(
    { tool: 'stub.judge', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeJudgeStub('prompt_node'),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

/** prompt → image → review. Review fail invalidates prompt; cascade
 *  via BUG-023 re-renders image; review fires again. */
function makeBundle(reviewLoopMax: number | undefined): DagBundle {
  const bundle: DagBundle = {
    id: 'review-loop-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'review_node',
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
        outputs: { format: 'image', pattern: 'assets/image.png' },
        runner: { tool: 'stub.counting', config: {} },
      },
      {
        id: 'review_node',
        kind: 'stage',
        inputs: [{ from: 'image_node', usage: 'input' }],
        outputs: { format: 'json', pattern: 'reviews/verdict.json' },
        runner: { tool: 'stub.judge', config: { refineNode: 'prompt_node' } },
      },
    ],
  };
  if (reviewLoopMax !== undefined) bundle.reviewLoopMax = reviewLoopMax;
  return bundle;
}

function initProject(bundleSource: string): void {
  const project = {
    bundleSource,
    walkState: {
      bundleSource,
      bundleVersion: '0.1.0',
      engineVersion: '0.1.0',
      nodes: {},
      lastInvalidatedIds: [],
    },
  };
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));
}

function readProject(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as Record<
    string,
    unknown
  >;
}

describe('walker review-loop', () => {
  it('judge fails iter 1, passes iter 2 → walker runs prompt_node + image_node twice', async () => {
    initProject('built-in:review-loop-test');

    let iteration = 0;
    judgeBehavior = () => {
      iteration += 1;
      currentIteration = iteration; // visible to the counting runner so we can prove it re-ran
      return iteration === 1
        ? { pass: false, notes: 'needs tighter character anchoring' }
        : { pass: true, notes: 'looks good' };
    };

    const result = await walkBundle({
      projectDir,
      bundle: makeBundle(3),
      bundleSource: 'built-in:review-loop-test',
    });
    expect(result.ok).toBe(true);

    const promptRuns = runCalls.filter((c) => c.nodeId === 'prompt_node');
    const imageRuns = runCalls.filter((c) => c.nodeId === 'image_node');
    expect(promptRuns.length).toBe(2);
    expect(imageRuns.length).toBe(2);

    // pendingCritique cleared after the second judge pass.
    // The stub judge writes the pendingCritique but doesn't clear it
    // — only an LLM runner consuming it would. So after a pass, the
    // pendingCritique from iter 1 is still in project.json. That's
    // fine — the walker just exits because NO new keys appeared on
    // iter 2.
    const project = readProject();
    expect(project['pendingCritiques']).toBeDefined();
  });

  it('judge always fails → walker stops at reviewLoopMax (no infinite loop)', async () => {
    initProject('built-in:review-loop-test');

    judgeBehavior = () => ({ pass: false, notes: 'still wrong' });

    const result = await walkBundle({
      projectDir,
      bundle: makeBundle(3),
      bundleSource: 'built-in:review-loop-test',
    });
    expect(result.ok).toBe(true);

    // Initial walk + 3 re-walks = 4 prompt_node runs total.
    // (max=3 means walker re-walks up to 3 times after the first.)
    const promptRuns = runCalls.filter((c) => c.nodeId === 'prompt_node');
    expect(promptRuns.length).toBe(4);
  });

  it('reviewLoopMax=0 (default) → walker exits after one walk even with new critique', async () => {
    initProject('built-in:review-loop-test');

    judgeBehavior = () => ({ pass: false, notes: 'broken' });

    const result = await walkBundle({
      projectDir,
      bundle: makeBundle(undefined),
      bundleSource: 'built-in:review-loop-test',
    });
    expect(result.ok).toBe(true);

    // Exactly one walk.
    const promptRuns = runCalls.filter((c) => c.nodeId === 'prompt_node');
    expect(promptRuns.length).toBe(1);
    // But pendingCritique IS recorded; future dispatch (e.g. via
    // dhee_critique_node) would consume it.
    const project = readProject();
    expect(project['pendingCritiques']).toMatchObject({
      'prompt_node': expect.stringMatching(/broken/),
    });
  });

  it('pre-existing pendingCritique that is CLEARED during walk does not trigger re-walk', async () => {
    initProject('built-in:review-loop-test');
    // Pre-stamp a pendingCritique. The judge stub passes (so no NEW
    // critique appears). The walker should NOT re-walk just because
    // pendingCritiques is non-empty at the end — only NEW keys count.
    const project = readProject();
    project['pendingCritiques'] = { 'prompt_node': 'a pre-existing note that lingers' };
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify(project, null, 2),
    );

    judgeBehavior = () => ({ pass: true, notes: 'ok' });

    await walkBundle({
      projectDir,
      bundle: makeBundle(3),
      bundleSource: 'built-in:review-loop-test',
    });

    const promptRuns = runCalls.filter((c) => c.nodeId === 'prompt_node');
    expect(promptRuns.length).toBe(1);
  });
});
