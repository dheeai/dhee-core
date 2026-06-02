/**
 * Walker + user-version pin — post-cascade contract.
 *
 * Pre-cascade, the walker had a special `isUserPinned` branch that
 * preserved `generation.tool='user'` artifacts through an
 * upstream-rerun-in-this-walk. That worked because cascade
 * invalidation didn't exist — the walker had to detect upstream
 * changes itself.
 *
 * Post-cascade (cascadeInvalidationKeys + invalidateNodes), the
 * walker is pure state-as-truth: completed + file on disk → skip,
 * pending or missing → run. There is NO pin-specific branch. The
 * user feedback that drove this refactor:
 *
 *   "user pinned nodes will also have to be invalidated when
 *    upstream changes. Even though user explicitly pinned a shot if
 *    later the user changes character ref image, it should cascade
 *    right? Else the downstream fixes will all be with wrong
 *    character."
 *
 * → pins do NOT survive cascade. invalidateNodes clears every
 * transitive consumer (whether `generation.tool='user'` or not),
 * matching user intent.
 *
 * Tests below assert the new contract.
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
import { invalidateNodes } from '../../src/dag/projectRegen.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
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
 *
 * Also seeds the event log with node.completed events so cascade-
 * invalidation has a per-instance dep graph to walk.
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
      lastInvalidatedIds: [],
    },
  };
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));

  // Seed events so cascadeInvalidationKeys has a dep graph: downstream
  // consumes upstream. Without these, cascade falls back to the
  // requested keys only.
  const log = openEventLog(projectDir);
  log.append({
    kind: 'node.completed',
    actor: 'runner',
    branchId: 'main',
    payload: {
      nodeId: 'upstream',
      outputPath: 'plans/upstream.json',
      versionId: 'upstream-v1',
    },
  });
  log.append({
    kind: 'node.completed',
    actor: 'runner',
    branchId: 'main',
    payload: {
      nodeId: 'downstream',
      outputPath: 'plans/downstream.md',
      versionId: 'downstream-v1',
      dependencies: [{ nodeId: 'upstream' }],
    },
  });
}

describe('walker: state-as-truth (no special pin branch)', () => {
  it('1. pin survives an upstream re-run when cascade is NOT used (raw walkState mutation)', async () => {
    // This documents what state-as-truth gives you for free: if
    // walkState says downstream is completed + the file is on disk,
    // walker skips it. The pin is incidental — any completed entry
    // would skip. Test 2 shows what happens when cascade IS used.
    seedProject({ pinDownstream: true });
    // Caller clears ONLY upstream's walkState entry (skipping cascade
    // via invalidateNodes). Walker re-runs upstream, leaves
    // downstream alone (completed + file on disk).
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

    expect(runCalls.find((c) => c.nodeId === 'upstream')).toBeTruthy();
    expect(runCalls.find((c) => c.nodeId === 'downstream')).toBeUndefined();
    expect(readFileSync(join(projectDir, 'plans/downstream.md'), 'utf8')).toBe('USER hand-edited');
  });

  it('2. cascade-invalidation clears the pinned downstream — pins do NOT survive cascade', async () => {
    // User feedback: changing the character ref must cascade to
    // every shot that consumes it, even shots the user pinned.
    // invalidateNodes(upstream) now clears downstream too via the
    // event-derived dep graph.
    seedProject({ pinDownstream: true });

    await invalidateNodes({ projectDir, nodeIds: ['upstream'] });

    // Now walk — both should re-fire (cascade cleared both walkState
    // entries; walker is state-as-truth).
    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:pin-test',
    });

    expect(runCalls.find((c) => c.nodeId === 'upstream')).toBeTruthy();
    expect(runCalls.find((c) => c.nodeId === 'downstream')).toBeTruthy();
    // Pin was overwritten — the new auto-generated content sits in
    // its place. This matches user intent: "downstream fixes will
    // all be with wrong character" if pin survived cascade.
    expect(readFileSync(join(projectDir, 'plans/downstream.md'), 'utf8')).toMatch(/runner-output downstream/);
  });

  it('3. pinned but file missing → walker re-fires (nothing to preserve)', async () => {
    seedProject({ pinDownstream: true });
    unlinkSync(join(projectDir, 'plans/downstream.md'));

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:pin-test',
    });
    expect(runCalls.find((c) => c.nodeId === 'downstream')).toBeTruthy();
  });

  it('4. non-pinned downstream behaves identically — there is no pin-specific code path', async () => {
    // The walker no longer reads generation.tool. Pin and auto are
    // indistinguishable to the resume logic — state + file presence
    // is the entire contract.
    seedProject({ pinDownstream: false });

    await invalidateNodes({ projectDir, nodeIds: ['upstream'] });

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:pin-test',
    });

    expect(runCalls.find((c) => c.nodeId === 'upstream')).toBeTruthy();
    expect(runCalls.find((c) => c.nodeId === 'downstream')).toBeTruthy();
    expect(existsSync(join(projectDir, 'plans/downstream.md'))).toBe(true);
  });
});
