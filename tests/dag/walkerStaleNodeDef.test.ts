/**
 * Stale-node-definition detection — dhee-core#171.
 *
 * `dhee run` is state-as-truth: it cache-skips any completed node whose
 * output file exists. Before this fix, editing a bundle file a node
 * references by path (promptTemplate / workflowPath / outputSchema /
 * manifestPath / scriptPath) or editing the node's inline config had NO
 * effect on resume — you had to wipe the whole project.
 *
 * The fix stamps a "node definition fingerprint" (config + referenced
 * file CONTENTS + wiring) at completion, and runs a pre-walk sweep that
 * re-runs any node whose fingerprint changed AND its downstream — while
 * leaving unchanged nodes cache-skipped.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { walkBundle } from '../../src/dag/walker.js';
import { computeNodeDefFingerprint } from '../../src/dag/nodeFingerprint.js';
import { openEventLog } from '../../src/dag/eventLog/EventLog.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner } from '../../src/dag/schema.js';

let projectDir: string;
let bundleDir: string;

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
    id: 'stale-def-test',
    version: '0.1.0',
    engineCompat: '>=0.1.0',
    goal: 'down',
    nodes: [
      {
        id: 'gen',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/gen.json' },
        // references a bundle file by path — editing the file must re-run this node
        runner: { tool: 'stub.echo', config: { promptTemplate: 'prompts/tpl.md' } },
      },
      {
        id: 'down',
        kind: 'stage',
        inputs: [{ from: 'gen', usage: 'input' }],
        outputs: { format: 'video', pattern: 'assets/down.mp4' },
        runner: { tool: 'stub.echo', config: {} },
      },
      {
        id: 'unrelated',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'json', pattern: 'plans/unrelated.json' },
        runner: { tool: 'stub.echo', config: {} },
      },
    ],
  } as unknown as DagBundle;
}

/** Seed three completed nodes with fingerprints computed from the ORIGINAL definition. */
function seed(): void {
  mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
  writeFileSync(join(bundleDir, 'prompts/tpl.md'), 'ORIGINAL TEMPLATE');

  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  writeFileSync(join(projectDir, 'plans/gen.json'), 'OLD-gen');
  writeFileSync(join(projectDir, 'assets/down.mp4'), 'OLD-down');
  writeFileSync(join(projectDir, 'plans/unrelated.json'), 'OLD-unrelated');

  const bundle = makeBundle();
  const fp = (id: string): string =>
    computeNodeDefFingerprint(bundle.nodes.find((n) => n.id === id)!, bundleDir);

  const project = {
    bundleSource: 'built-in:stale-def-test',
    walkState: {
      bundleSource: 'built-in:stale-def-test',
      bundleVersion: '0.1.0',
      engineVersion: '0.1.0',
      nodes: {
        gen: { status: 'completed', outputPath: 'plans/gen.json', defFingerprint: fp('gen') },
        down: { status: 'completed', outputPath: 'assets/down.mp4', defFingerprint: fp('down') },
        unrelated: {
          status: 'completed',
          outputPath: 'plans/unrelated.json',
          defFingerprint: fp('unrelated'),
        },
      },
      lastInvalidatedIds: [],
    },
  };
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));

  const log = openEventLog(projectDir);
  log.append({
    kind: 'node.completed', actor: 'runner', branchId: 'main',
    payload: { nodeId: 'gen', outputPath: 'plans/gen.json', versionId: 'g1' },
  });
  log.append({
    kind: 'node.completed', actor: 'runner', branchId: 'main',
    payload: {
      nodeId: 'down', outputPath: 'assets/down.mp4', versionId: 'd1',
      dependencies: [{ nodeId: 'gen' }],
    },
  });
  log.append({
    kind: 'node.completed', actor: 'runner', branchId: 'main',
    payload: { nodeId: 'unrelated', outputPath: 'plans/unrelated.json', versionId: 'x1' },
  });
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'walker-staledef-proj-'));
  bundleDir = mkdtempSync(join(tmpdir(), 'walker-staledef-bundle-'));
  __resetGlobalRegistryForTesting();
  getGlobalRegistry().register(
    { tool: 'stub.echo', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    makeStubRunner(),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(bundleDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

describe('walker: stale node-definition detection (#171)', () => {
  it('re-runs a node when its referenced template file content changes', async () => {
    seed();
    // Edit the prompt template — same path, new bytes.
    writeFileSync(join(bundleDir, 'prompts/tpl.md'), 'EDITED TEMPLATE');

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleDir,
      bundleSource: 'built-in:stale-def-test',
    });

    expect(readFileSync(join(projectDir, 'plans/gen.json'), 'utf8')).toBe('NEW-gen');
  });

  it('cascades the re-run to downstream nodes', async () => {
    seed();
    writeFileSync(join(bundleDir, 'prompts/tpl.md'), 'EDITED TEMPLATE');

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleDir,
      bundleSource: 'built-in:stale-def-test',
    });

    expect(readFileSync(join(projectDir, 'assets/down.mp4'), 'utf8')).toBe('NEW-down');
  });

  it('does NOT re-run unrelated unchanged nodes (still cache-skips)', async () => {
    seed();
    writeFileSync(join(bundleDir, 'prompts/tpl.md'), 'EDITED TEMPLATE');

    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleDir,
      bundleSource: 'built-in:stale-def-test',
    });

    expect(readFileSync(join(projectDir, 'plans/unrelated.json'), 'utf8')).toBe('OLD-unrelated');
  });

  it('re-runs a node when its inline config changes (no file involved)', async () => {
    seed();
    // Template unchanged; instead change the node's inline config.
    const bundle = makeBundle();
    bundle.nodes.find((n) => n.id === 'gen')!.runner.config = {
      promptTemplate: 'prompts/tpl.md',
      temperature: 0.99, // new field → fingerprint changes
    };

    await walkBundle({
      projectDir,
      bundle,
      bundleDir,
      bundleSource: 'built-in:stale-def-test',
    });

    expect(readFileSync(join(projectDir, 'plans/gen.json'), 'utf8')).toBe('NEW-gen');
  });

  it('does nothing when nothing changed (clean resume is a full cache-skip)', async () => {
    seed();
    // No edits at all.
    await walkBundle({
      projectDir,
      bundle: makeBundle(),
      bundleDir,
      bundleSource: 'built-in:stale-def-test',
    });

    expect(readFileSync(join(projectDir, 'plans/gen.json'), 'utf8')).toBe('OLD-gen');
    expect(readFileSync(join(projectDir, 'assets/down.mp4'), 'utf8')).toBe('OLD-down');
    expect(readFileSync(join(projectDir, 'plans/unrelated.json'), 'utf8')).toBe('OLD-unrelated');
  });
});

describe('walker: legacy backfill (#171)', () => {
  /** Seed completed nodes WITHOUT any fingerprint (as if completed by the old engine). */
  function seedNoFingerprint(): void {
    mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
    writeFileSync(join(bundleDir, 'prompts/tpl.md'), 'ORIGINAL TEMPLATE');
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    mkdirSync(join(projectDir, 'assets'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/gen.json'), 'OLD-gen');
    writeFileSync(join(projectDir, 'assets/down.mp4'), 'OLD-down');
    writeFileSync(join(projectDir, 'plans/unrelated.json'), 'OLD-unrelated');
    const project = {
      bundleSource: 'built-in:stale-def-test',
      walkState: {
        bundleSource: 'built-in:stale-def-test',
        bundleVersion: '0.1.0',
        engineVersion: '0.1.0',
        nodes: {
          gen: { status: 'completed', outputPath: 'plans/gen.json' },
          down: { status: 'completed', outputPath: 'assets/down.mp4' },
          unrelated: { status: 'completed', outputPath: 'plans/unrelated.json' },
        },
        lastInvalidatedIds: [],
      },
    };
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));
  }

  it('first run backfills fingerprints (no re-run), then a later edit is detected', async () => {
    seedNoFingerprint();

    // First run under the new engine: no stored fingerprints → nothing
    // detected as stale → everything cache-skips, but fingerprints get
    // backfilled onto the walkState entries.
    await walkBundle({
      projectDir, bundle: makeBundle(), bundleDir, bundleSource: 'built-in:stale-def-test',
    });
    expect(readFileSync(join(projectDir, 'plans/gen.json'), 'utf8')).toBe('OLD-gen');
    const afterFirst = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8'));
    expect(typeof afterFirst.walkState.nodes.gen.defFingerprint).toBe('string');

    // Now edit the template and run again — the backfilled fingerprint
    // makes the edit detectable.
    writeFileSync(join(bundleDir, 'prompts/tpl.md'), 'EDITED TEMPLATE');
    await walkBundle({
      projectDir, bundle: makeBundle(), bundleDir, bundleSource: 'built-in:stale-def-test',
    });
    expect(readFileSync(join(projectDir, 'plans/gen.json'), 'utf8')).toBe('NEW-gen');
    expect(readFileSync(join(projectDir, 'assets/down.mp4'), 'utf8')).toBe('NEW-down');
  });
});

describe('computeNodeDefFingerprint', () => {
  it('changes when the referenced file content changes', () => {
    mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
    const node = makeBundle().nodes.find((n) => n.id === 'gen')!;
    writeFileSync(join(bundleDir, 'prompts/tpl.md'), 'A');
    const a = computeNodeDefFingerprint(node, bundleDir);
    writeFileSync(join(bundleDir, 'prompts/tpl.md'), 'B');
    const b = computeNodeDefFingerprint(node, bundleDir);
    expect(a).not.toBe(b);
  });

  it('is stable when nothing changes', () => {
    mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
    writeFileSync(join(bundleDir, 'prompts/tpl.md'), 'A');
    const node = makeBundle().nodes.find((n) => n.id === 'gen')!;
    expect(computeNodeDefFingerprint(node, bundleDir)).toBe(
      computeNodeDefFingerprint(node, bundleDir),
    );
  });

  it('changes when inline config changes', () => {
    const node = makeBundle().nodes.find((n) => n.id === 'unrelated')!;
    const before = computeNodeDefFingerprint(node, bundleDir);
    node.runner.config = { foo: 'bar' };
    const after = computeNodeDefFingerprint(node, bundleDir);
    expect(before).not.toBe(after);
  });
});
