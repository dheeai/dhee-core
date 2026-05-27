/**
 * Phase 5 — runProjectViaBundle: the bundle-architecture entry point
 * that executeRunTo dispatches into when the project declares a
 * bundleSource.
 *
 * Replaces the hybrid runProjectInProcess for bundle-enabled projects.
 * The legacy runExecutor path stays for now (projects without
 * bundleSource); Phase 6 will delete it once all projects migrate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runProjectViaBundle } from '../../src/server/runners/runProjectViaBundle.js';
import {
  __resetGlobalRegistryForTesting,
  getGlobalRegistry,
} from '../../src/dag/runners/registry.js';
import type { Runner } from '../../src/dag/schema.js';

// ── Test scaffolding ──────────────────────────────────────────────────

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'rpvb-proj-'));
  __resetGlobalRegistryForTesting();

  // Register a stub runner that produces a file at outputs.pattern.
  const stub: Runner = {
    describe: () => ({
      id: 'test.stub',
      displayName: 'stub',
      description: 'test',
      capabilities: [],
      modalities: { input: [], output: [] },
      configSchema: {},
    }),
    async run(ctx) {
      const outPath = ctx.node.outputs.pattern;
      const outAbs = join(ctx.projectDir, outPath);
      mkdirSync(join(outAbs, '..'), { recursive: true });
      writeFileSync(outAbs, 'stub-output');
      return { ok: true, outputPath: outPath };
    },
  };
  getGlobalRegistry().register(
    { tool: 'test.stub', version: '0.1.0', engineCompat: '>=0.1.0', credentials: [] },
    stub,
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  __resetGlobalRegistryForTesting();
});

// ── Helper: spin up a user-scheme bundle in ~/.kshana/bundles/<id>/ ────

function makeUserBundle(id: string, bundleJson: Record<string, unknown>): string {
  const home = process.env['HOME'];
  if (!home) throw new Error('HOME not set');
  const dir = join(home, '.kshana/bundles', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(bundleJson));
  return dir;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('runProjectViaBundle', () => {
  let tmpHome: string;
  let origHome: string | undefined;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'rpvb-home-'));
    origHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
  });
  afterEach(() => {
    if (origHome !== undefined) process.env['HOME'] = origHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('fails clearly when project.json has no bundleSource field', async () => {
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ id: 'p' }));
    const result = await runProjectViaBundle({ projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/bundleSource/);
    }
  });

  it('fails clearly when bundleSource is a malformed URI', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', bundleSource: 'not-a-valid-uri' }),
    );
    const result = await runProjectViaBundle({ projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/scheme|not-a-valid-uri/i);
    }
  });

  it('fails when the bundle source URI points to a missing bundle', async () => {
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', bundleSource: 'user:no_such_bundle' }),
    );
    const result = await runProjectViaBundle({ projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/not found|missing/i);
    }
  });

  it('runs the bundle end-to-end when bundleSource resolves cleanly', async () => {
    makeUserBundle('test_e2e', {
      id: 'test_e2e',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      goal: 'final',
      dependencies: { runners: { 'test.stub': '>=0.1.0' } },
      nodes: [
        {
          id: 'final',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'video', pattern: 'final.mp4' },
          runner: { tool: 'test.stub', config: {} },
        },
      ],
    });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', bundleSource: 'user:test_e2e' }),
    );

    const result = await runProjectViaBundle({ projectDir });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.finalVideoAbs).toBeDefined();
      expect(result.finalVideoAbs).toContain('final.mp4');
    }

    // walkState should be persisted.
    const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as Record<string, unknown>;
    expect(proj['walkState']).toBeDefined();
  });

  it('passes stopAt through to the walker', async () => {
    makeUserBundle('test_stopat', {
      id: 'test_stopat',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      goal: 'final',
      dependencies: { runners: { 'test.stub': '>=0.1.0' } },
      nodes: [
        {
          id: 'first',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'md', pattern: 'first.md' },
          runner: { tool: 'test.stub', config: {} },
        },
        {
          id: 'final',
          kind: 'stage',
          inputs: [{ from: 'first', usage: 'input' }],
          outputs: { format: 'video', pattern: 'final.mp4' },
          runner: { tool: 'test.stub', config: {} },
        },
      ],
    });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', bundleSource: 'user:test_stopat' }),
    );

    const result = await runProjectViaBundle({
      projectDir,
      stopAt: 'first',
    });
    expect(result.ok).toBe(true);
    // The goal didn't complete (we stopped before it). Result should
    // not claim a final video.
    expect(result.finalVideoAbs).toBeUndefined();

    // walkState reflects first=completed, final=pending.
    const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as { walkState: { nodes: Record<string, { status: string }> } };
    expect(proj.walkState.nodes['first']?.status).toBe('completed');
    expect(proj.walkState.nodes['final']?.status ?? 'pending').toBe('pending');
  });

  it('fails clearly when the bundle declares a runner that is not registered', async () => {
    makeUserBundle('test_missing_runner', {
      id: 'test_missing_runner',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      goal: 'final',
      dependencies: { runners: { 'runway.gen3': '>=1.0.0' } },
      nodes: [
        {
          id: 'final',
          kind: 'stage',
          inputs: [],
          outputs: { format: 'video', pattern: 'final.mp4' },
          runner: { tool: 'runway.gen3', config: {} },
        },
      ],
    });
    writeFileSync(
      join(projectDir, 'project.json'),
      JSON.stringify({ id: 'p', bundleSource: 'user:test_missing_runner' }),
    );

    const result = await runProjectViaBundle({ projectDir });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/runway\.gen3/);
      expect(result.error).toMatch(/not registered|install/i);
    }
  });
});
