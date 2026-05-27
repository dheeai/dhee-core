/**
 * Phase 0 — bundleSource URI parser + resolver.
 *
 * Test failures map to plan §3 Phase 0 failure modes 3, 4, 5.
 *
 * A bundleSource URI is the project.json's pointer to which bundle the
 * project uses. Three schemes:
 *   - built-in:<id>   → ships with kshana-core (src/dag/bundles/<id>/)
 *   - user:<id>       → user-authored, lives in ~/.kshana/bundles/<id>/
 *   - registry:<scope>/<name>@<version>  → future registry; parser only
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseBundleSource,
  resolveBundleDir,
  BundleSourceError,
} from '../../src/dag/bundleSource.js';

describe('parseBundleSource', () => {
  it('parses built-in:<id>', () => {
    expect(parseBundleSource('built-in:narrative_relay')).toEqual({
      scheme: 'built-in',
      id: 'narrative_relay',
    });
  });

  it('parses user:<id>', () => {
    expect(parseBundleSource('user:my_doc')).toEqual({
      scheme: 'user',
      id: 'my_doc',
    });
  });

  it('parses registry:<scope>/<name>@<version>', () => {
    expect(parseBundleSource('registry:studio42/explainer@1.2.0')).toEqual({
      scheme: 'registry',
      id: 'studio42/explainer',
      version: '1.2.0',
    });
  });

  it('throws on malformed scheme "builtin:foo" (must be "built-in")', () => {
    // Common typo. The hyphen is load-bearing — without it, the parser
    // would silently misroute to a non-existent scheme. Better to fail
    // loudly at parse time with the actual valid schemes named.
    expect(() => parseBundleSource('builtin:narrative_relay')).toThrow(
      BundleSourceError,
    );
    expect(() => parseBundleSource('builtin:narrative_relay')).toThrow(
      /unknown scheme|built-in/i,
    );
  });

  it('throws on URI with no scheme', () => {
    expect(() => parseBundleSource('narrative_relay')).toThrow(BundleSourceError);
  });

  it('throws on built-in: with empty id', () => {
    expect(() => parseBundleSource('built-in:')).toThrow(BundleSourceError);
  });

  it('throws on registry: without a version', () => {
    // Registry references MUST be version-pinned for reproducibility.
    expect(() => parseBundleSource('registry:studio42/explainer')).toThrow(
      BundleSourceError,
    );
  });

  it('throws on empty string', () => {
    expect(() => parseBundleSource('')).toThrow(BundleSourceError);
  });
});

describe('resolveBundleDir', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    // Isolate ~/.kshana/ for user: scheme tests
    tmpHome = mkdtempSync(join(tmpdir(), 'kshana-home-'));
    originalHome = process.env['HOME'];
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
    else delete process.env['HOME'];
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('resolves built-in:<id> to <REPO_ROOT>/src/dag/bundles/<id>/ when present', () => {
    // We use ltx_prompt_relay because it's the only built-in bundle today
    // that exists on disk as a single JSON file. The resolver should accept
    // both single-file (legacy) and directory (new) layouts.
    const dir = resolveBundleDir({ scheme: 'built-in', id: 'ltx_prompt_relay' });
    expect(dir.endsWith('src/dag/bundles/ltx_prompt_relay') || dir.endsWith('src/dag/bundles/ltx_prompt_relay.json')).toBe(true);
  });

  it('throws when built-in:<id> bundle is missing on disk', () => {
    expect(() => resolveBundleDir({ scheme: 'built-in', id: 'totally_not_a_bundle' }))
      .toThrow(BundleSourceError);
    expect(() => resolveBundleDir({ scheme: 'built-in', id: 'totally_not_a_bundle' }))
      .toThrow(/not found|missing/i);
  });

  it('resolves user:<id> to ~/.kshana/bundles/<id>/ when present', () => {
    const userBundles = join(tmpHome, '.kshana', 'bundles', 'my_doc');
    mkdirSync(userBundles, { recursive: true });
    writeFileSync(join(userBundles, 'bundle.json'), JSON.stringify({ id: 'my_doc', goal: 'final', nodes: [] }));

    const dir = resolveBundleDir({ scheme: 'user', id: 'my_doc' });
    expect(dir).toBe(userBundles);
  });

  it('throws when user:<id> bundle is missing on disk', () => {
    expect(() => resolveBundleDir({ scheme: 'user', id: 'no_such_bundle' }))
      .toThrow(BundleSourceError);
  });

  it('throws BundleSourceError (not generic) for registry: until implemented', () => {
    // Registry scheme is reserved but not yet implemented. Parser accepts
    // it; resolver explicitly rejects so callers know it's a future feature.
    expect(() =>
      resolveBundleDir({ scheme: 'registry', id: 'studio42/explainer', version: '1.2.0' }),
    ).toThrow(BundleSourceError);
    expect(() =>
      resolveBundleDir({ scheme: 'registry', id: 'studio42/explainer', version: '1.2.0' }),
    ).toThrow(/not yet implemented|not supported/i);
  });
});
