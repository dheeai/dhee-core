/**
 * installBundle — validate + install a community bundle from a folder.
 * Real behavior: temp-dir source bundles + a temp target dir; no
 * network/zip (the folder path is the testable core; zip/git reuse the
 * same validate+copy once materialized).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  validateBundleStructure,
  findBundleRoot,
  installBundle,
} from '../../src/dag/installBundle.js';

let tmps: string[] = [];
function tmp(p: string): string {
  const d = mkdtempSync(join(tmpdir(), p));
  tmps.push(d);
  return d;
}

/** A structurally-valid bundle dir with one workflow the nodes reference. */
function validBundle(id = 'community_pack'): string {
  const dir = tmp('src-');
  mkdirSync(join(dir, 'workflows'), { recursive: true });
  writeFileSync(join(dir, 'workflows', 'img.json'), JSON.stringify({ N: { class_type: 'KSampler', inputs: {} } }));
  writeFileSync(
    join(dir, 'bundle.json'),
    JSON.stringify({
      id,
      version: '0.1.0',
      goal: 'final',
      nodes: [{ id: 'image', runner: { config: { workflowPath: 'workflows/img.json' } } }],
    }),
  );
  return dir;
}

beforeEach(() => { tmps = []; });
afterEach(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

describe('validateBundleStructure', () => {
  it('accepts a well-formed bundle and returns id + version', () => {
    const v = validateBundleStructure(validBundle());
    expect(v.ok).toBe(true);
    expect(v.bundleId).toBe('community_pack');
    expect(v.version).toBe('0.1.0');
  });

  it('rejects when bundle.json is absent', () => {
    expect(validateBundleStructure(tmp('empty-')).ok).toBe(false);
  });

  it('flags missing required fields', () => {
    const dir = tmp('bad-');
    writeFileSync(join(dir, 'bundle.json'), JSON.stringify({ id: 'x' })); // no version/goal/nodes
    const v = validateBundleStructure(dir);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/version/);
    expect(v.errors.join(' ')).toMatch(/goal/);
    expect(v.errors.join(' ')).toMatch(/nodes/);
  });

  it('flags a referenced workflowPath that does not exist', () => {
    const dir = tmp('bad-ref-');
    writeFileSync(
      join(dir, 'bundle.json'),
      JSON.stringify({ id: 'x', version: '1', goal: 'g', nodes: [{ runner: { config: { workflowPath: 'workflows/missing.json' } } }] }),
    );
    const v = validateBundleStructure(dir);
    expect(v.ok).toBe(false);
    expect(v.errors.join(' ')).toMatch(/workflowPath not found/);
  });
});

describe('findBundleRoot', () => {
  it('returns the dir itself when it holds bundle.json', () => {
    const dir = validBundle();
    expect(findBundleRoot(dir)).toBe(dir);
  });

  it('descends into a single nested dir (zip/repo with a top folder)', () => {
    const outer = tmp('outer-');
    const inner = join(outer, 'community_pack-main');
    mkdirSync(join(inner, 'workflows'), { recursive: true });
    writeFileSync(join(inner, 'bundle.json'), JSON.stringify({ id: 'x', version: '1', goal: 'g', nodes: [{}] }));
    expect(findBundleRoot(outer)).toBe(inner);
  });

  it('returns null when no bundle.json is reachable', () => {
    expect(findBundleRoot(tmp('none-'))).toBeNull();
  });
});

describe('installBundle (folder)', () => {
  it('copies a valid bundle into the target dir under its id', async () => {
    const target = tmp('target-');
    const r = await installBundle({ kind: 'folder', path: validBundle() }, { targetDir: target });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.bundleId).toBe('community_pack');
      expect(existsSync(join(target, 'community_pack', 'bundle.json'))).toBe(true);
      expect(existsSync(join(target, 'community_pack', 'workflows', 'img.json'))).toBe(true);
    }
  });

  it('refuses to overwrite an installed bundle unless force', async () => {
    const target = tmp('target-');
    await installBundle({ kind: 'folder', path: validBundle() }, { targetDir: target });
    const again = await installBundle({ kind: 'folder', path: validBundle() }, { targetDir: target });
    expect(again.ok).toBe(false);
    const forced = await installBundle({ kind: 'folder', path: validBundle() }, { targetDir: target, force: true });
    expect(forced.ok).toBe(true);
  });

  it('rejects an invalid source bundle', async () => {
    const target = tmp('target-');
    const badSrc = tmp('badsrc-');
    writeFileSync(join(badSrc, 'bundle.json'), JSON.stringify({ id: 'x' }));
    const r = await installBundle({ kind: 'folder', path: badSrc }, { targetDir: target });
    expect(r.ok).toBe(false);
  });
});
