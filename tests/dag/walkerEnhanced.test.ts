/**
 * Phase 4 — walker enhancements.
 *
 * The existing walker had skip-if-output-exists as implicit state and
 * no formal stop-at / runOnly support. Phase 4 makes the state
 * explicit (walkState in project.json) and adds stopAt + runOnly +
 * event stream.
 *
 * Test surface = the formal contract the agent calls into and what the
 * walker promises about resumability across crashes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  walkBundle,
  loadWalkState,
  saveWalkState,
  type WalkState,
} from '../../src/dag/walker.js';
import {
  RunnerRegistry,
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { DagBundle, Runner, RunnerResult } from '../../src/dag/schema.js';

// ── Test bundle: tiny 3-node DAG ───────────────────────────────────────

const TINY_BUNDLE: DagBundle = {
  id: 'tiny',
  version: '0.1.0',
  engineCompat: '>=0.1.0',
  goal: 'final',
  nodes: [
    {
      id: 'story',
      kind: 'stage',
      inputs: [],
      outputs: { format: 'md', pattern: 'plans/story.md' },
      runner: { tool: 'stub.runner', config: { name: 'story' } },
    },
    {
      id: 'beats',
      kind: 'stage',
      inputs: [{ from: 'story', usage: 'input' }],
      outputs: { format: 'json', pattern: 'plans/beats.json' },
      runner: { tool: 'stub.runner', config: { name: 'beats' } },
    },
    {
      id: 'final',
      kind: 'stage',
      inputs: [{ from: 'beats', usage: 'input' }],
      outputs: { format: 'video', pattern: 'final.mp4' },
      runner: { tool: 'stub.runner', config: { name: 'final' } },
    },
  ],
};

// ── Stub runner that records what it ran ───────────────────────────────

function makeStubRunner(opts: {
  failOn?: string[]; // node names that should fail
  ranNodes: string[]; // mutable accumulator
}): Runner {
  return {
    describe: () => ({
      id: 'stub.runner',
      displayName: 'stub',
      description: 'test stub',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx): Promise<RunnerResult> {
      const cfg = ctx.node.runner.config as { name: string };
      opts.ranNodes.push(cfg.name);
      if (opts.failOn?.includes(cfg.name)) {
        return { ok: false, error: `stub fail: ${cfg.name}` };
      }
      const outPath = ctx.node.outputs.pattern;
      const outAbs = join(ctx.projectDir, outPath);
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, `result of ${cfg.name}`);
      return { ok: true, outputPath: outPath };
    },
  };
}

// ── Per-test scratch + registry setup ─────────────────────────────────

let projectDir: string;
let ranNodes: string[];

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'walker-enh-'));
  ranNodes = [];
  __resetGlobalRegistryForTesting();
  const reg = getGlobalRegistry();
  reg.register(
    {
      tool: 'stub.runner',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
    },
    makeStubRunner({ ranNodes }),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
  // Re-import the built-in registrations.
  vi.resetModules();
});

// ── walkState persistence ──────────────────────────────────────────────

describe('walkState persistence', () => {
  it('loadWalkState returns null when no project.json exists', () => {
    expect(loadWalkState(projectDir)).toBeNull();
  });

  it('loadWalkState returns null when project.json has no walkState field', () => {
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ id: 'p' }));
    expect(loadWalkState(projectDir)).toBeNull();
  });

  it('saveWalkState writes to project.json without clobbering other fields', () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', title: 'My Project', otherStuff: { keep: true } }),
    );
    const state: WalkState = {
      bundleSource: 'built-in:tiny',
      bundleVersion: '0.1.0',
      engineVersion: '0.1.0',
      nodes: { story: { status: 'completed', outputPath: 'plans/story.md' } },
      lastInvalidatedIds: [],
    };
    saveWalkState(projectDir, state);

    const raw = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as Record<string, unknown>;
    expect(raw['id']).toBe('p');
    expect(raw['title']).toBe('My Project');
    expect(raw['otherStuff']).toEqual({ keep: true });
    expect(raw['walkState']).toEqual(state);
  });

  it('walkBundle persists walkState after each completed node', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(true);
    const state = loadWalkState(projectDir);
    expect(state).not.toBeNull();
    expect(state!.nodes['story']?.status).toBe('completed');
    expect(state!.nodes['beats']?.status).toBe('completed');
    expect(state!.nodes['final']?.status).toBe('completed');
  });

  it('walkBundle preserves walkState on failure (so resumes pick up where it left off)', async () => {
    __resetGlobalRegistryForTesting();
    const reg = getGlobalRegistry();
    reg.register(
      { tool: 'stub.runner', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
      makeStubRunner({ ranNodes, failOn: ['beats'] }),
    );

    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(false);

    const state = loadWalkState(projectDir);
    expect(state).not.toBeNull();
    expect(state!.nodes['story']?.status).toBe('completed');
    expect(state!.nodes['beats']?.status).toBe('failed');
    expect(state!.nodes['final']?.status).toBe('pending');
  });

  it('walkBundle treats malformed walkState as missing (re-initializes, all pending)', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', walkState: 'not an object, malformed' }),
    );
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(true);
    const state = loadWalkState(projectDir);
    expect(state!.nodes['story']?.status).toBe('completed');
  });
});

// ── Resume semantics ───────────────────────────────────────────────────

describe('resume from walkState', () => {
  it('skips nodes already marked completed with valid output', async () => {
    // Pre-seed walkState with story completed.
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/story.md'), 'pre-existing story');
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        walkState: {
          bundleSource: 'built-in:tiny',
          bundleVersion: '0.1.0',
          engineVersion: '0.1.0',
          nodes: {
            story: { status: 'completed', outputPath: 'plans/story.md' },
          },
          lastInvalidatedIds: [],
        } as WalkState,
      }),
    );

    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).not.toContain('story');     // skipped
    expect(ranNodes).toContain('beats');
    expect(ranNodes).toContain('final');
    // Original story content preserved.
    expect(readFileSync(join(projectDir, 'plans/story.md'), 'utf-8')).toBe('pre-existing story');
  });

  it('re-runs nodes whose recorded output file no longer exists on disk', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        walkState: {
          bundleSource: 'built-in:tiny',
          bundleVersion: '0.1.0',
          engineVersion: '0.1.0',
          nodes: {
            story: { status: 'completed', outputPath: 'plans/story.md' },
          },
          lastInvalidatedIds: [],
        } as WalkState,
      }),
    );
    // story.md doesn't exist on disk despite walkState saying completed.

    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toContain('story'); // re-run
  });

  it('treats walkState entries for nodes no longer in the bundle as stale (drops them)', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        walkState: {
          bundleSource: 'built-in:tiny',
          bundleVersion: '0.1.0',
          engineVersion: '0.1.0',
          nodes: {
            story: { status: 'completed', outputPath: 'plans/story.md' },
            zombie_node_from_old_bundle: { status: 'completed', outputPath: 'gone.txt' },
          },
          lastInvalidatedIds: [],
        } as WalkState,
      }),
    );
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/story.md'), 'kept');

    await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
    });
    const state = loadWalkState(projectDir);
    expect(state!.nodes['zombie_node_from_old_bundle']).toBeUndefined();
  });
});

// ── stopAt ─────────────────────────────────────────────────────────────

describe('stopAt', () => {
  it('runs everything up to and including the named node, then stops', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      stopAt: 'beats',
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual(['story', 'beats']);
    const state = loadWalkState(projectDir);
    expect(state!.nodes['beats']?.status).toBe('completed');
    expect(state!.nodes['final']?.status ?? 'pending').toBe('pending');
  });

  it('fails clearly when stopAt names a node not in the bundle', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      stopAt: 'no_such_node',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no_such_node|not in bundle|valid nodes/i);
    }
  });

  it('stopAt at the goal node is equivalent to no stopAt', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      stopAt: 'final',
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual(['story', 'beats', 'final']);
  });
});

// ── runOnly + cascade ──────────────────────────────────────────────────

describe('runOnly', () => {
  it('runs only the named node(s) and their direct dependents', async () => {
    // Seed all 3 as completed.
    mkdirSync(join(projectDir, 'plans'), { recursive: true });
    writeFileSync(join(projectDir, 'plans/story.md'), 's');
    writeFileSync(join(projectDir, 'plans/beats.json'), '{}');
    writeFileSync(join(projectDir, 'final.mp4'), 'v');
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({
        id: 'p',
        walkState: {
          bundleSource: 'built-in:tiny',
          bundleVersion: '0.1.0',
          engineVersion: '0.1.0',
          nodes: {
            story: { status: 'completed', outputPath: 'plans/story.md' },
            beats: { status: 'completed', outputPath: 'plans/beats.json' },
            final: { status: 'completed', outputPath: 'final.mp4' },
          },
          lastInvalidatedIds: [],
        } as WalkState,
      }),
    );

    // runOnly=['beats'] should re-run beats AND final (which depends on beats),
    // but NOT story (which is upstream of beats).
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      runOnly: ['beats'],
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual(['beats', 'final']);
  });

  it('runOnly with empty array runs nothing (explicit caller choice)', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      runOnly: [],
    });
    expect(result.ok).toBe(true);
    expect(ranNodes).toEqual([]);
  });

  it('runOnly node id that does not exist in the bundle fails clearly', async () => {
    const result = await walkBundle({
      projectDir,
      bundle: TINY_BUNDLE,
      bundleSource: 'built-in:tiny',
      runOnly: ['no_such_node'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/no_such_node|not in bundle/i);
    }
  });
});
