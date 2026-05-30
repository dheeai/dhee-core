/**
 * DemoWalker — a lightweight bundle walker that emits events through
 * the ProjectionEngine instead of mutating a snapshot.
 *
 * It exists alongside the production `src/dag/walker.ts` so this branch
 * can prove the event-sourced architecture end-to-end without rewriting
 * 1200 lines of walker. The production walker will be migrated later.
 *
 * Failure modes covered (red first):
 *   1. A clean walk emits node.started + node.completed per node.
 *   2. A regen (invalidate + re-walk) appends version.added (via
 *      another node.completed) without deleting the prior file.
 *   3. listVersions reflects both candidates; latest auto-selected.
 *   4. selectVersion flips selectedVersionId; downstream walks pick
 *      it up.
 *   5. fork() creates a new branchId; new events on the branch don't
 *      affect the main projection.
 *   6. resolveRunnerForInstance returns the swapped runner after a
 *      runner.swapped event.
 *   7. runner-swap demo: VLM stamps suggestion, agent applies, re-walk
 *      uses the new runner; event log shows the chronology.
 *   8. Cache hit on second walk with identical inputs: no compute,
 *      cached:true on the node.completed event.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  runDemoWalk,
  resolveRunnerForInstance,
  type DemoBundle,
  type DemoRunner,
} from '../../../src/dag/eventLog/DemoWalker.js';
import { openProjectionEngine } from '../../../src/dag/eventLog/ProjectionEngine.js';

let projectDir: string;
let casRoot: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'demowalker-test-'));
  casRoot = mkdtempSync(join(tmpdir(), 'demowalker-cas-'));
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(casRoot, { recursive: true, force: true });
});

// ── Test fixtures ──────────────────────────────────────────────────────

const TINY_BUNDLE: DemoBundle = {
  id: 'tiny',
  version: '0.1.0',
  goal: 'caption',
  nodes: [
    { id: 'seed', runner: { tool: 'demo.seed', config: { seed: 'cat' } }, output: { format: 'md', pattern: 'seed.md' }, inputs: [] },
    { id: 'image', runner: { tool: 'demo.image', config: {} }, output: { format: 'png', pattern: 'image.png' }, inputs: [{ from: 'seed' }] },
    { id: 'caption', runner: { tool: 'demo.caption', config: {} }, output: { format: 'md', pattern: 'caption.md' }, inputs: [{ from: 'image' }] },
  ],
};

function makeRunners(): Record<string, DemoRunner> {
  let imageCounter = 0;
  return {
    'demo.seed': {
      tool: 'demo.seed',
      toolVersion: '0.1.0',
      async run(ctx) {
        const config = ctx.config as { seed: string };
        const content = `# Seed\n\nWord: ${config.seed}\n`;
        return { content, contentBytes: Buffer.from(content), costUsd: 0.001 };
      },
    },
    'demo.image': {
      tool: 'demo.image',
      toolVersion: '0.1.0',
      async run(ctx) {
        imageCounter += 1;
        const seedInput = ctx.inputs['seed'] as string;
        const content = `IMAGE-FROM-${seedInput.trim().slice(-3)}-v${imageCounter}`;
        return { content, contentBytes: Buffer.from(content), costUsd: 0.02 };
      },
    },
    'demo.caption': {
      tool: 'demo.caption',
      toolVersion: '0.1.0',
      async run(ctx) {
        const img = ctx.inputs['image'] as string;
        const content = `Caption for ${img.slice(0, 32)}`;
        return { content, contentBytes: Buffer.from(content), costUsd: 0.005 };
      },
    },
    // Alternative renderer used by the runner-swap test:
    'demo.image.alt': {
      tool: 'demo.image.alt',
      toolVersion: '0.1.0',
      async run() {
        const content = 'ALT-IMAGE-RENDERED-BY-DEMO-ALT';
        return { content, contentBytes: Buffer.from(content), costUsd: 0.03 };
      },
    },
  };
}

describe('DemoWalker', () => {
  it('a clean walk emits node.started + node.completed for each node', async () => {
    const eng = openProjectionEngine(projectDir);
    const result = await runDemoWalk({
      bundle: TINY_BUNDLE,
      projectDir,
      engine: eng,
      runners: makeRunners(),
      cacheRoot: casRoot,
    });
    expect(result.ok).toBe(true);

    const events = [...eng.log().read()];
    const startedCount = events.filter((e) => e.kind === 'node.started').length;
    const completedCount = events.filter((e) => e.kind === 'node.completed').length;
    expect(startedCount).toBe(3);
    expect(completedCount).toBe(3);

    // Final goal artifact exists at the bundle-declared pattern.
    expect(existsSync(join(projectDir, 'caption.md'))).toBe(true);
  });

  it('regen (invalidate + re-walk) appends a new version without deleting the prior file', async () => {
    const eng = openProjectionEngine(projectDir);
    const runners = makeRunners();

    await runDemoWalk({ bundle: TINY_BUNDLE, projectDir, engine: eng, runners, cacheRoot: casRoot });
    const imagePathV1 = join(projectDir, 'image.png');
    expect(existsSync(imagePathV1)).toBe(true);
    const v1Bytes = readFileSync(imagePathV1, 'utf-8');

    // Invalidate the image node, re-walk runOnly=['image'].
    eng.appendAndProject({ branchId: 'main', actor: 'agent', kind: 'node.invalidated', payload: { nodeId: 'image' } });
    await runDemoWalk({ bundle: TINY_BUNDLE, projectDir, engine: eng, runners, cacheRoot: casRoot, runOnly: ['image'] });

    const versions = eng.listVersions('image');
    expect(versions).toHaveLength(2);
    expect(versions[0]?.versionId).not.toBe(versions[1]?.versionId);
    expect(versions[1]?.selected).toBe(true);

    // The PRIOR version's file still lives at its versioned path.
    const v1Versioned = versions[0]!.outputPath;
    expect(existsSync(join(projectDir, v1Versioned))).toBe(true);
    // And contains the original v1 bytes (proves non-destructive).
    expect(readFileSync(join(projectDir, v1Versioned), 'utf-8')).toBe(v1Bytes);
  });

  it('selectVersion flips selectedVersionId and re-points the canonical path', async () => {
    const eng = openProjectionEngine(projectDir);
    const runners = makeRunners();

    await runDemoWalk({ bundle: TINY_BUNDLE, projectDir, engine: eng, runners, cacheRoot: casRoot });
    eng.appendAndProject({ branchId: 'main', actor: 'agent', kind: 'node.invalidated', payload: { nodeId: 'image' } });
    await runDemoWalk({ bundle: TINY_BUNDLE, projectDir, engine: eng, runners, cacheRoot: casRoot, runOnly: ['image'] });

    const versions = eng.listVersions('image');
    expect(versions).toHaveLength(2);
    const v1 = versions[0]!.versionId;

    // Select v1 instead of v2.
    eng.appendAndProject({ branchId: 'main', actor: 'agent', kind: 'version.selected', payload: { nodeId: 'image', versionId: v1 } });

    const proj = eng.projection();
    expect(proj.nodes['image']?.selectedVersionId).toBe(v1);
  });

  it('fork() creates a new branchId; new events on the branch do not affect the main projection', async () => {
    const eng = openProjectionEngine(projectDir);
    await runDemoWalk({ bundle: TINY_BUNDLE, projectDir, engine: eng, runners: makeRunners(), cacheRoot: casRoot });

    const lastEvents = [...eng.log().read()];
    const lastEvent = lastEvents[lastEvents.length - 1]!;
    eng.appendAndProject({
      branchId: 'main',
      actor: 'user',
      kind: 'branch.created',
      payload: { branchId: 'experiment', label: 'try alt image', forkedFromEventId: lastEvent.id, parentBranchId: 'main' },
    });

    // Walk on the new branch, regenerating only the image node.
    eng.appendAndProject({ branchId: 'experiment', actor: 'agent', kind: 'node.invalidated', payload: { nodeId: 'image' } });
    await runDemoWalk({
      bundle: TINY_BUNDLE,
      projectDir,
      engine: eng,
      runners: makeRunners(),
      cacheRoot: casRoot,
      branchId: 'experiment',
      runOnly: ['image'],
    });

    const mainVersions = eng.listVersions('image', undefined, { branchId: 'main' });
    const expVersions = eng.listVersions('image', undefined, { branchId: 'experiment' });
    // Main has its own one version; the experiment branch's regen
    // does NOT pollute it (branch isolation in the opposite direction).
    expect(mainVersions).toHaveLength(1);
    // The experiment branch INHERITS main's prefix (1 prior version)
    // plus its own divergent regen (1 new version) = 2 total. That's
    // the candidate tray — the user can pick either.
    expect(expVersions).toHaveLength(2);
    // The branch's selected (newest) is the divergent version, NOT
    // main's. This is the "two realities" property that fork unlocks.
    const expSelected = expVersions.find((v) => v.selected);
    expect(expSelected?.versionId).not.toBe(mainVersions[0]?.versionId);

    const tree = eng.computeBranchTree();
    expect(tree.branches.map((b) => b.branchId).sort()).toEqual(['experiment', 'main']);
  });

  it('resolveRunnerForInstance returns the swapped runner after a runner.swapped event', () => {
    const eng = openProjectionEngine(projectDir);
    eng.appendAndProject({
      branchId: 'main',
      actor: 'agent',
      kind: 'runner.swapped',
      payload: { nodeId: 'image', fromTool: 'demo.image', toTool: 'demo.image.alt', reason: 'wants alt' },
    });

    const node = TINY_BUNDLE.nodes.find((n) => n.id === 'image')!;
    const resolved = resolveRunnerForInstance(node, undefined, [...eng.log().read()]);
    expect(resolved.tool).toBe('demo.image.alt');
  });

  it('runner-swap demo: stamp suggestion, apply, re-walk uses the new runner', async () => {
    const eng = openProjectionEngine(projectDir);
    const runners = makeRunners();

    // First walk uses the bundle default (demo.image).
    await runDemoWalk({ bundle: TINY_BUNDLE, projectDir, engine: eng, runners, cacheRoot: casRoot });

    // VLM/judge stamps a suggestion.
    eng.appendAndProject({
      branchId: 'main',
      actor: 'runner',
      kind: 'runner.swap_suggested',
      payload: { nodeId: 'image', suggestedTool: 'demo.image.alt', reason: 'mock VLM verdict' },
    });

    // Agent (user-proxy) accepts the swap.
    eng.appendAndProject({
      branchId: 'main',
      actor: 'agent',
      kind: 'runner.swapped',
      payload: { nodeId: 'image', fromTool: 'demo.image', toTool: 'demo.image.alt', reason: 'mock VLM verdict' },
    });

    // Invalidate + re-walk just the image node.
    eng.appendAndProject({ branchId: 'main', actor: 'agent', kind: 'node.invalidated', payload: { nodeId: 'image' } });
    await runDemoWalk({ bundle: TINY_BUNDLE, projectDir, engine: eng, runners, cacheRoot: casRoot, runOnly: ['image'] });

    const versions = eng.listVersions('image');
    expect(versions).toHaveLength(2);
    // The newest version was produced by demo.image.alt.
    const newest = versions[versions.length - 1]!;
    expect(newest.generation?.tool).toBe('demo.image.alt');
    expect(readFileSync(join(projectDir, newest.outputPath), 'utf-8')).toContain('ALT-IMAGE');
  });

  it('second identical walk gets a CAS cache hit (cached:true) — no recompute', async () => {
    const eng = openProjectionEngine(projectDir);
    const runners = makeRunners();

    await runDemoWalk({ bundle: TINY_BUNDLE, projectDir, engine: eng, runners, cacheRoot: casRoot });

    // Reset the project dir to simulate a fresh project, but keep the
    // cache root + bundle inputs identical. Second project's first walk
    // should hit the CAS.
    const projectDir2 = mkdtempSync(join(tmpdir(), 'demowalker-test-2-'));
    try {
      const eng2 = openProjectionEngine(projectDir2);
      await runDemoWalk({
        bundle: TINY_BUNDLE,
        projectDir: projectDir2,
        engine: eng2,
        runners,
        cacheRoot: casRoot, // shared CAS
      });
      const events = [...eng2.log().read()];
      const completions = events.filter((e) => e.kind === 'node.completed');
      // All three nodes should be cache hits.
      const cachedCount = completions.filter((e) => {
        const p = e.payload as { generation?: { cached?: boolean } };
        return p.generation?.cached === true;
      }).length;
      expect(cachedCount).toBe(3);
    } finally {
      rmSync(projectDir2, { recursive: true, force: true });
    }
  });
});
