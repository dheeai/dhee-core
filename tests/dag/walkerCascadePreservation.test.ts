/**
 * Walker cascade preservation — TDD.
 *
 * When a downstream node re-runs because an upstream changed (BUG-023's
 * cache-bypass-on-upstream-rerun path), the walker MUST preserve the
 * old canonical artifact as a `.v<N>.<ext>` sibling before the runner
 * writes the new bytes. Without this, regenerating one shot wipes out
 * every downstream artifact (scene clips, final video) without leaving
 * an audit trail or rollback path.
 *
 * Failure modes:
 *  1. Downstream re-render preserves the old canonical as .v1.<ext>.
 *  2. The new canonical holds the fresh runner output.
 *  3. The version event log records the preserved path.
 *  4. Regression-guard: a node that ISN'T re-run (no upstream change,
 *     file present) still cache-skips — no preservation churn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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

function makeStubRunner(): Runner {
  return {
    describe: () => ({
      id: 'stub.echo',
      displayName: 'stub',
      description: '',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      const out = ctx.itemId
        ? ctx.node.outputs.pattern.replace('{{item_id}}', ctx.itemId)
        : ctx.node.outputs.pattern;
      const outAbs = join(ctx.projectDir, out);
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, `NEW-${ctx.node.id}`);
      return { ok: true, outputPath: out };
    },
  };
}

function makeBundle(): DagBundle {
  return {
    id: 'cascade-preserve-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'final',
    nodes: [
      {
        id: 'upstream',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/upstream.json' },
        runner: { tool: 'stub.echo', config: {} },
      },
      {
        id: 'middle',
        kind: 'stage',
        inputs: [{ from: 'upstream', usage: 'input' }],
        outputs: { format: 'md', pattern: 'plans/middle.md' },
        runner: { tool: 'stub.echo', config: {} },
      },
      {
        id: 'final',
        kind: 'stage',
        inputs: [{ from: 'middle', usage: 'input' }],
        outputs: { format: 'video', pattern: 'assets/final.mp4' },
        runner: { tool: 'stub.echo', config: {} },
      },
    ],
  };
}

function seed(): void {
  // All three completed; upstream then invalidated to drive cascade.
  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  writeFileSync(join(projectDir, 'plans/upstream.json'), 'OLD-upstream');
  writeFileSync(join(projectDir, 'plans/middle.md'), 'OLD-middle');
  writeFileSync(join(projectDir, 'assets/final.mp4'), 'OLD-final');
  const project = {
    bundleSource: 'built-in:cascade-preserve-test',
    walkState: {
      bundleSource: 'built-in:cascade-preserve-test',
      bundleVersion: '0.1.0',
      engineVersion: '0.1.0',
      nodes: {
        upstream: { status: 'completed', outputPath: 'plans/upstream.json' },
        middle: { status: 'completed', outputPath: 'plans/middle.md' },
        final: { status: 'completed', outputPath: 'assets/final.mp4' },
      },
      lastInvalidatedIds: [],
    },
  };
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'walker-cp-'));
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.echo', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeStubRunner(),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

describe('walker: cascade preservation', () => {
  it('1. downstream re-render preserves old canonical as .v1.<ext>', async () => {
    seed();
    // Invalidate upstream to drive cascade.
    const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    delete proj.walkState.nodes.upstream;
    proj.walkState.lastInvalidatedIds = ['upstream'];
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(proj));
    unlinkSync(join(projectDir, 'plans/upstream.json'));

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:cascade-preserve-test',
    });

    // Old downstream artifacts survive as .v1 siblings.
    expect(existsSync(join(projectDir, 'plans/middle.v1.md'))).toBe(true);
    expect(readFileSync(join(projectDir, 'plans/middle.v1.md'), 'utf8')).toBe('OLD-middle');
    expect(existsSync(join(projectDir, 'assets/final.v1.mp4'))).toBe(true);
    expect(readFileSync(join(projectDir, 'assets/final.v1.mp4'), 'utf8')).toBe('OLD-final');
  });

  it('2. new canonical holds the fresh runner output', async () => {
    seed();
    const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    delete proj.walkState.nodes.upstream;
    proj.walkState.lastInvalidatedIds = ['upstream'];
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(proj));
    unlinkSync(join(projectDir, 'plans/upstream.json'));

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:cascade-preserve-test',
    });

    expect(readFileSync(join(projectDir, 'plans/middle.md'), 'utf8')).toBe('NEW-middle');
    expect(readFileSync(join(projectDir, 'assets/final.mp4'), 'utf8')).toBe('NEW-final');
  });

  it('3. version.added events recorded for each cascade preservation', async () => {
    seed();
    const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    delete proj.walkState.nodes.upstream;
    proj.walkState.lastInvalidatedIds = ['upstream'];
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(proj));
    unlinkSync(join(projectDir, 'plans/upstream.json'));

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:cascade-preserve-test',
    });

    const events = readFileSync(join(projectDir, '.dhee/events.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { kind: string; payload: { nodeId?: string; outputPath?: string } });
    const added = events.filter((e) => e.kind === 'version.added');
    const middlePreserve = added.find((e) => e.payload.outputPath?.endsWith('plans/middle.v1.md'));
    const finalPreserve = added.find((e) => e.payload.outputPath?.endsWith('assets/final.v1.mp4'));
    expect(middlePreserve).toBeDefined();
    expect(middlePreserve?.payload.nodeId).toBe('middle');
    expect(finalPreserve).toBeDefined();
    expect(finalPreserve?.payload.nodeId).toBe('final');
  });

  it('4. regression-guard: nothing re-runs when no upstream change → no preservation', async () => {
    seed();
    // No invalidation. Walker runs against fully completed walkState.

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleSource: 'built-in:cascade-preserve-test',
    });

    // No .v1 files created.
    expect(existsSync(join(projectDir, 'plans/middle.v1.md'))).toBe(false);
    expect(existsSync(join(projectDir, 'assets/final.v1.mp4'))).toBe(false);
    // No version.added events.
    const eventsPath = join(projectDir, '.dhee/events.jsonl');
    if (existsSync(eventsPath)) {
      const events = readFileSync(eventsPath, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as { kind: string });
      expect(events.filter((e) => e.kind === 'version.added')).toHaveLength(0);
    }
  });
});
