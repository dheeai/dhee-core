import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DagBundle } from '../../src/dag/schema.js';
import {
  checkBundleRunnerReadiness,
  listRunnerManifests,
} from '../../src/dag/runners/readiness.js';

function writeRunnerPackage(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
): void {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runner.json'), JSON.stringify(manifest));
  writeFileSync(
    join(dir, 'index.mjs'),
    'throw new Error("entry module must not be imported by readiness");',
  );
}

const falBundle: DagBundle = {
  id: 'fal_short',
  version: '0.1.0',
  goal: 'image',
  dependencies: {
    runners: {
      'fal.image': '>=0.1.0',
    },
  },
  nodes: [],
};

describe('runner readiness', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dhee-runners-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports a missing declared runner without importing runner code', () => {
    const readiness = checkBundleRunnerReadiness(falBundle, {
      searchDirs: [tmpDir],
      env: {},
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.missingRunners).toEqual([
      { tool: 'fal.image', range: '>=0.1.0' },
    ]);
  });

  it('reports missing credentials from installed runner manifests', () => {
    writeRunnerPackage(tmpDir, 'fal-image', {
      tool: 'fal.image',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: ['FAL_KEY'],
      entry: 'index.mjs',
    });

    const readiness = checkBundleRunnerReadiness(falBundle, {
      searchDirs: [tmpDir],
      env: {},
    });

    expect(readiness.ok).toBe(false);
    expect(readiness.missingRunners).toEqual([]);
    expect(readiness.missingCredentials).toEqual(['FAL_KEY']);
    expect(readiness.requiredRunners[0]?.missingCredentials).toEqual([
      'FAL_KEY',
    ]);
  });

  it('passes when required runner and credential are available', () => {
    writeRunnerPackage(tmpDir, 'fal-image', {
      tool: 'fal.image',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: ['FAL_KEY'],
      entry: 'index.mjs',
    });

    const readiness = checkBundleRunnerReadiness(falBundle, {
      searchDirs: [tmpDir],
      env: { FAL_KEY: 'fal-secret' },
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.missingCredentials).toEqual([]);
  });

  it('treats built-in core runners as installed without runner roots', () => {
    const bundle: DagBundle = {
      id: 'builtins_only',
      version: '0.1.0',
      goal: 'final',
      dependencies: {
        runners: {
          'llm.generate': '>=0.1.0',
          'ffmpeg.concat': '>=0.1.0',
        },
      },
      nodes: [],
    };

    const readiness = checkBundleRunnerReadiness(bundle, {
      searchDirs: [tmpDir],
      env: {},
    });

    expect(readiness.ok).toBe(true);
    expect(readiness.missingRunners).toEqual([]);
    expect(readiness.requiredRunners.map((r) => r.tool).sort()).toEqual([
      'ffmpeg.concat',
      'llm.generate',
    ]);
  });

  it('lists runner manifests without importing entry modules', () => {
    writeRunnerPackage(tmpDir, 'bad-entry', {
      tool: 'bad.entry',
      version: '0.1.0',
      engineCompat: '>=0.1.0',
      credentials: [],
      entry: 'index.mjs',
    });

    expect(listRunnerManifests([tmpDir]).map((m) => m.tool)).toContain(
      'bad.entry',
    );
  });
});
