/**
 * Walker user-version pin — TDD coverage.
 *
 * When a node's walkState entry has `generation.tool === 'user'`, the
 * walker MUST NOT re-fire the runner — even if an upstream was re-run
 * in the same walk. The user's hand-edited content is pinned. The only
 * way to clear the pin is an explicit invalidate (dhee_regenerate_node).
 *
 * Without this, dhee_write_node_content's effect is lost as soon as
 * any upstream changes: the BUG-023 cache-bypass-on-upstream-rerun
 * fires and clobbers the user-supplied artifact.
 *
 * Failure modes:
 *  1. Pinned + upstream re-run → walker SKIPS the pinned node.
 *  2. Pinned + explicitly listed in runOnly → walker re-fires (the
 *     user is consciously asking to regen, pin breaks).
 *  3. Pinned but file gone from disk → walker re-fires (no artifact
 *     to preserve).
 *  4. Regression-guard: non-pinned completed downstream + upstream
 *     re-run → still re-fires (BUG-023 behavior preserved).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  unlinkSync,
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
      writeFileSync(outAbs, `runner-output ${ctx.node.id}${ctx.itemId ? ':' + ctx.itemId : ''}`);
      return { ok: true, outputPath: out };
    },
  };
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'walker-pinned-'));
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

function makeBundle(): DagBundle {
  return {
    id: 'pin-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'downstream',
    nodes: [
      {
        id: 'upstream',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/upstream.json' },
        runner: { tool: 'stub.counting', config: {} },
      },
      {
        id: 'downstream',
        kind: 'stage',
        inputs: [{ from: 'upstream', usage: 'input' }],
        outputs: { format: 'md', pattern: 'plans/downstream.md' },
        runner: { tool: 'stub.counting', config: {} },
      },
    ],
  };
}

/**
 * Seed: upstream + downstream completed, both files on disk.
 * downstream optionally marked as user-pinned.
 */
function seedProject(opts: { pinDownstream: boolean }): void {
  const upPath = join(projectDir, 'plans/upstream.json');
  mkdirSync(join(upPath, '..'), { recursive: true });
  writeFileSync(upPath, '{"v":1}');
  const downPath = join(projectDir, 'plans/downstream.md');
  writeFileSync(downPath, opts.pinDownstream ? 'USER hand-edited' : 'AUTO generated');

  const project = {
    bundleSource: 'built-in:pin-test',
    walkState: {
      bundleSource: 'built-in:pin-test',
      bundleVersion: '0.1.0',
      engineVersion: '0.1.0',
      nodes: {
        upstream: {
          status: 'completed',
          outputPath: 'plans/upstream.json',
          completedAt: 1_000_000,
          generation: { tool: 'stub.counting', toolVersion: '0.1.0' },
        },
        downstream: {
          status: 'completed',
          outputPath: 'plans/downstream.md',
          completedAt: 1_000_001,
          generation: opts.pinDownstream
            ? { tool: 'user', toolVersion: '0.1.0' }
            : { tool: 'stub.counting', toolVersion: '0.1.0' },
        },
      },
      lastInvalidatedIds: ['upstream'],
    },
  };
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));
}

describe('walker: user-version pinned nodes are not re-fired by upstream cascade', () => {
  it('1. pinned downstream + upstream re-run → walker SKIPS pinned node', async () => {
    seedProject({ pinDownstream: true });
    // Invalidate upstream so the next walk re-fires it. Walker's
    // upstream-rerun detection then triggers the cache bypass for
    // downstream — but pin should override.
    const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    delete proj.walkState.nodes.upstream;
    proj.walkState.lastInvalidatedIds = ['upstream'];
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(proj));
    // Remove upstream artifact too so it definitely re-runs.
    unlinkSync(join(projectDir, 'plans/upstream.json'));

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:pin-test',
    });

    // Upstream re-fired.
    expect(runCalls.find((c) => c.nodeId === 'upstream')).toBeTruthy();
    // Downstream did NOT re-fire (pinned).
    expect(runCalls.find((c) => c.nodeId === 'downstream')).toBeUndefined();
    // Pinned content preserved on disk.
    expect(readFileSync(join(projectDir, 'plans/downstream.md'), 'utf8')).toBe('USER hand-edited');
  });

  it('2. pinned + listed in runOnly → walker RE-FIRES (explicit override)', async () => {
    seedProject({ pinDownstream: true });

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:pin-test',
      runOnly: ['downstream'],
    });

    // Downstream DID re-fire even though pinned — explicit ask.
    expect(runCalls.find((c) => c.nodeId === 'downstream')).toBeTruthy();
  });

  it('3. pinned but file missing → walker re-fires (nothing to preserve)', async () => {
    seedProject({ pinDownstream: true });
    // Pull the pinned file from disk.
    unlinkSync(join(projectDir, 'plans/downstream.md'));

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:pin-test',
    });
    expect(runCalls.find((c) => c.nodeId === 'downstream')).toBeTruthy();
  });

  it('4. regression-guard: non-pinned downstream + upstream re-run → re-fires (BUG-023)', async () => {
    seedProject({ pinDownstream: false });
    // Invalidate upstream.
    const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    delete proj.walkState.nodes.upstream;
    proj.walkState.lastInvalidatedIds = ['upstream'];
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(proj));
    unlinkSync(join(projectDir, 'plans/upstream.json'));

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:pin-test',
    });

    // Non-pinned: upstream re-run BYPASSES downstream cache (BUG-023
    // fix). Downstream MUST re-fire.
    expect(runCalls.find((c) => c.nodeId === 'downstream')).toBeTruthy();
    // And the new auto output replaces the prior auto output.
    expect(existsSync(join(projectDir, 'plans/downstream.md'))).toBe(true);
  });
});
