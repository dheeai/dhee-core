/**
 * bundleResolution — the per-endpoint/per-bundle "configured?" stamp.
 * Real behavior: write a stamp to a temp dir, read it back, and verify
 * version-bump + non-ready invalidation. Stamps for different
 * endpoints/bundles live in separate files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readBundleResolution,
  writeBundleResolution,
  isBundleResolved,
  type BundleResolution,
} from '../../src/dag/bundleResolution.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'resolv-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const stamp = (over: Partial<BundleResolution> = {}): BundleResolution => ({
  bundleId: 'narrative_prompt_relay',
  bundleVersion: '0.1.0',
  endpoint: 'http://127.0.0.1:8188',
  status: 'ready',
  modelsMissing: 0,
  nodesMissing: 0,
  resolvedAt: 1700000000000,
  ...over,
});

describe('bundleResolution', () => {
  it('round-trips a stamp through the per-endpoint store', () => {
    expect(readBundleResolution(dir, 'http://127.0.0.1:8188', 'narrative_prompt_relay')).toBeNull();
    writeBundleResolution(dir, stamp());
    const got = readBundleResolution(dir, 'http://127.0.0.1:8188', 'narrative_prompt_relay');
    expect(got).toEqual(stamp());
  });

  it('isBundleResolved is true only for a ready stamp with a matching version', () => {
    writeBundleResolution(dir, stamp());
    expect(isBundleResolved(dir, 'http://127.0.0.1:8188', 'narrative_prompt_relay', '0.1.0')).toBe(true);
    // version bump invalidates
    expect(isBundleResolved(dir, 'http://127.0.0.1:8188', 'narrative_prompt_relay', '0.2.0')).toBe(false);
  });

  it('a non-ready stamp is never considered resolved', () => {
    writeBundleResolution(dir, stamp({ status: 'incomplete', nodesMissing: 1 }));
    expect(isBundleResolved(dir, 'http://127.0.0.1:8188', 'narrative_prompt_relay', '0.1.0')).toBe(false);
  });

  it('stamps for different endpoints do not collide', () => {
    writeBundleResolution(dir, stamp({ endpoint: 'http://127.0.0.1:8188' }));
    writeBundleResolution(dir, stamp({ endpoint: 'https://cloud.comfy.org/api', status: 'incomplete', modelsMissing: 2 }));
    expect(isBundleResolved(dir, 'http://127.0.0.1:8188', 'narrative_prompt_relay', '0.1.0')).toBe(true);
    expect(isBundleResolved(dir, 'https://cloud.comfy.org/api', 'narrative_prompt_relay', '0.1.0')).toBe(false);
  });

  it('missing/corrupt stamp reads as null, not a throw', () => {
    expect(readBundleResolution(dir, 'http://nope/', 'absent')).toBeNull();
    // a stamp written then its dir wiped → still null
    writeBundleResolution(dir, stamp());
    expect(existsSync(join(dir))).toBe(true);
  });
});
