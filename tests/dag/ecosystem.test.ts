/**
 * Ecosystem npm-package discovery — runners + bundles published as
 * dhee-runner-* / dhee-bundle-* packages (docs/ecosystem-package-conventions.md).
 *
 * Builds a fake node_modules tree in a temp dir and points
 * DHEE_NODE_MODULES_DIRS at it, so discovery runs hermetically against
 * real package.json + real ESM entry modules (no mocking of fs/import).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  findEcosystemPackages,
  discoverNpmRunners,
  findNpmBundles,
  resolveNpmBundleDir,
  checkBundleRunners,
} from '../../src/dag/ecosystem.js';
import { RunnerRegistry } from '../../src/dag/runners/registry.js';
import { parseBundleSource, resolveBundleDir } from '../../src/dag/bundleSource.js';

let nm: string; // the fake node_modules dir
let savedEnv: string | undefined;

function pkg(name: string, pkgJson: Record<string, unknown>, files: Record<string, string> = {}): void {
  const dir = join(nm, ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...pkgJson }));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
}

const RUNNER_MODULE = (tool: string) => `
export const runners = [{
  manifest: { tool: '${tool}', version: '1.0.0', engineCompat: '>=0.1.0', credentials: [] },
  runner: {
    describe: () => ({ id: '${tool}', displayName: '${tool}', description: '', capabilities: [], modalities: { input: [], output: [] }, configSchema: {} }),
    run: async () => ({ ok: true, outputPath: 'out.png' }),
  },
}];
`;

beforeEach(() => {
  nm = mkdtempSync(join(tmpdir(), 'eco-nm-'));
  // A runner package.
  pkg('dhee-runner-foo', { keywords: ['dhee-runner'], dhee: { runners: './runners.mjs' } },
    { 'runners.mjs': RUNNER_MODULE('foo.bar') });
  // A scoped runner package.
  pkg('@acme/dhee-runner', { keywords: ['dhee-runner'], dhee: { runners: './r.mjs' } },
    { 'r.mjs': RUNNER_MODULE('acme.x') });
  // A bundle package (multi-bundle layout: subdir per bundle).
  pkg('dhee-bundle-baz', { keywords: ['dhee-bundle'], dhee: { bundles: './bundles' } },
    { 'bundles/baz_pipeline/bundle.json': JSON.stringify({ id: 'baz_pipeline', version: '0.1.0', displayName: 'Baz', summary: 'A baz.', goal: 'n', nodes: [] }) });
  // Name matches but NO keyword → must be skipped by the guard.
  pkg('dhee-runner-nokeyword', { dhee: { runners: './x.mjs' } }, { 'x.mjs': RUNNER_MODULE('no.key') });
  // Keyword present but entry file missing → error, must not poison others.
  pkg('dhee-runner-broken', { keywords: ['dhee-runner'], dhee: { runners: './missing.mjs' } });
  // Unrelated package → ignored entirely.
  pkg('react', {});

  savedEnv = process.env['DHEE_NODE_MODULES_DIRS'];
  process.env['DHEE_NODE_MODULES_DIRS'] = nm;
});
afterEach(() => {
  rmSync(nm, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env['DHEE_NODE_MODULES_DIRS'];
  else process.env['DHEE_NODE_MODULES_DIRS'] = savedEnv;
});

describe('findEcosystemPackages', () => {
  it('finds keyword-guarded dhee-runner-* / dhee-bundle-* (incl. scoped), skips others', () => {
    const names = findEcosystemPackages().map((p) => p.name).sort();
    expect(names).toContain('dhee-runner-foo');
    expect(names).toContain('@acme/dhee-runner');
    expect(names).toContain('dhee-bundle-baz');
    expect(names).toContain('dhee-runner-broken'); // matched + keyworded; fails later at load
    expect(names).not.toContain('dhee-runner-nokeyword'); // keyword guard
    expect(names).not.toContain('react'); // name doesn't match
  });
});

describe('discoverNpmRunners', () => {
  it('registers runners from matching packages, including scoped', async () => {
    const reg = new RunnerRegistry();
    const res = await discoverNpmRunners(reg);
    expect(res.registered.sort()).toEqual(['acme.x', 'foo.bar']);
    expect(reg.get('foo.bar')).toBeDefined();
    expect(reg.get('acme.x')).toBeDefined();
  });

  it('does not throw on a broken package — collects the error and registers the rest', async () => {
    const reg = new RunnerRegistry();
    const res = await discoverNpmRunners(reg);
    expect(res.registered).toContain('foo.bar');
    expect(res.errors.some((e) => e.includes('dhee-runner-broken'))).toBe(true);
  });

  it('is idempotent — skips a tool already registered (no duplicate-register throw)', async () => {
    const reg = new RunnerRegistry();
    await discoverNpmRunners(reg);
    const second = await discoverNpmRunners(reg);
    expect(second.registered).toEqual([]);
    expect(second.skipped.sort()).toEqual(['acme.x', 'foo.bar']);
  });
});

describe('npm bundle resolution', () => {
  it('findNpmBundles enumerates bundle dirs by their bundle.json id', () => {
    const bundles = findNpmBundles();
    const baz = bundles.find((b) => b.pkg === 'dhee-bundle-baz');
    expect(baz).toBeDefined();
    expect(baz!.id).toBe('baz_pipeline');
  });

  it('resolveNpmBundleDir resolves a named bundle and rejects an unknown one', () => {
    const dir = resolveNpmBundleDir('dhee-bundle-baz', 'baz_pipeline');
    expect(dir).toContain('baz_pipeline');
    expect(() => resolveNpmBundleDir('dhee-bundle-baz', 'nope')).toThrow(/no bundle 'nope'/);
  });

  it('parseBundleSource + resolveBundleDir handle the npm: scheme', () => {
    const src = parseBundleSource('npm:dhee-bundle-baz#baz_pipeline');
    expect(src).toEqual({ scheme: 'npm', pkg: 'dhee-bundle-baz', bundleId: 'baz_pipeline' });
    expect(resolveBundleDir(src)).toContain('baz_pipeline');
    // scoped, no bundle id parses too
    expect(parseBundleSource('npm:@acme/dhee-bundle')).toEqual({ scheme: 'npm', pkg: '@acme/dhee-bundle' });
  });
});

describe('checkBundleRunners — install hints for missing runners', () => {
  it('reports only unregistered runners, with a declared or convention install package', async () => {
    const reg = new RunnerRegistry();
    await discoverNpmRunners(reg); // registers foo.bar

    const missing = checkBundleRunners(
      {
        dependencies: {
          runners: { 'foo.bar': '>=1.0.0', 'runway.gen3': '>=1.0.0', 'acme.special': '>=1.0.0' },
          runnerPackages: { 'runway.gen3': 'dhee-runner-runway@^1.2.0' },
        },
      },
      reg,
    );

    const byTool = Object.fromEntries(missing.map((m) => [m.tool, m]));
    expect(byTool['foo.bar']).toBeUndefined(); // registered → not missing
    // declared package wins
    expect(byTool['runway.gen3']).toMatchObject({
      package: 'dhee-runner-runway@^1.2.0',
      packageSource: 'declared',
      install: 'npm i dhee-runner-runway@^1.2.0',
    });
    // undeclared → dhee-runner-<namespace> convention guess
    expect(byTool['acme.special']).toMatchObject({
      package: 'dhee-runner-acme',
      packageSource: 'convention',
      install: 'npm i dhee-runner-acme',
    });
  });
});
