/**
 * Phase 0 — Custom runner discovery.
 *
 * Test failures map to plan §3 Phase 0 failure modes 6, 7.
 *
 * Discovery scans `~/.dhee/runners/` (or dhee_RUNNER_PATH-listed
 * dirs). Each subdirectory containing a `runner.json` manifest +
 * `index.js` is loaded and its exported runner is registered.
 *
 * Robustness rules (the test surface):
 *   - One malformed runner doesn't kill discovery for the others.
 *   - Missing runner.json → directory is skipped (not a runner package).
 *   - Multiple discovery dirs are scanned in order.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverRunners } from '../../src/dag/runners/discovery.js';
import { RunnerRegistry } from '../../src/dag/runners/registry.js';

function writeRunnerPackage(
  rootDir: string,
  pkgName: string,
  manifest: Record<string, unknown>,
  indexJs: string,
): string {
  const dir = join(rootDir, pkgName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runner.json'), JSON.stringify(manifest));
  writeFileSync(join(dir, 'index.mjs'), indexJs);
  return dir;
}

const VALID_RUNNER_JS = `
export const runner = {
  describe: () => ({
    id: 'test.custom',
    displayName: 'test',
    description: 'test',
    capabilities: [],
    modalities: { input: [], output: [] },
    configSchema: {},
  }),
  run: async () => ({ ok: true, outputPath: '/tmp/x' }),
};
`;

describe('discoverRunners', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'dhee-runners-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('registers a runner from a directory containing runner.json + index.mjs', async () => {
    writeRunnerPackage(
      tmpDir,
      'my-runner',
      { tool: 'test.custom', version: '1.0.0', engineCompat: '>=0.0.0', entry: 'index.mjs' },
      VALID_RUNNER_JS,
    );
    const reg = new RunnerRegistry();
    await discoverRunners(reg, [tmpDir]);
    expect(reg.get('test.custom')).toBeDefined();
  });

  it('skips directories without runner.json', async () => {
    // A stray directory in ~/.dhee/runners/ that isn't a runner package
    // (no manifest) must not cause discovery to fail.
    mkdirSync(join(tmpDir, 'just-a-dir'), { recursive: true });
    writeFileSync(join(tmpDir, 'just-a-dir', 'README.md'), 'not a runner');

    writeRunnerPackage(
      tmpDir,
      'real-runner',
      { tool: 'test.real', version: '1.0.0', engineCompat: '>=0.0.0', entry: 'index.mjs' },
      VALID_RUNNER_JS.replace('test.custom', 'test.real'),
    );

    const reg = new RunnerRegistry();
    await discoverRunners(reg, [tmpDir]);
    expect(reg.get('test.real')).toBeDefined();
  });

  it('logs warning and continues when runner.json is malformed JSON', async () => {
    const dir = join(tmpDir, 'broken');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'runner.json'), '{ not valid json');
    writeFileSync(join(dir, 'index.mjs'), VALID_RUNNER_JS);

    writeRunnerPackage(
      tmpDir,
      'good',
      { tool: 'test.good', version: '1.0.0', engineCompat: '>=0.0.0', entry: 'index.mjs' },
      VALID_RUNNER_JS.replace('test.custom', 'test.good'),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reg = new RunnerRegistry();
      await discoverRunners(reg, [tmpDir]);
      // Bad package skipped, good package still loaded:
      expect(reg.get('test.good')).toBeDefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('logs warning and continues when the runner module fails to import', async () => {
    const dir = join(tmpDir, 'broken-import');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'runner.json'),
      JSON.stringify({ tool: 'test.broken', version: '1.0.0', engineCompat: '>=0.0.0', entry: 'index.mjs' }),
    );
    writeFileSync(join(dir, 'index.mjs'), 'this is not valid javascript {{{');

    writeRunnerPackage(
      tmpDir,
      'good2',
      { tool: 'test.good2', version: '1.0.0', engineCompat: '>=0.0.0', entry: 'index.mjs' },
      VALID_RUNNER_JS.replace('test.custom', 'test.good2'),
    );

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const reg = new RunnerRegistry();
      await discoverRunners(reg, [tmpDir]);
      expect(reg.get('test.good2')).toBeDefined();
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('handles missing discovery directory gracefully (no throw)', async () => {
    const missingDir = join(tmpDir, 'does-not-exist');
    const reg = new RunnerRegistry();
    await expect(discoverRunners(reg, [missingDir])).resolves.toBeUndefined();
  });
});
