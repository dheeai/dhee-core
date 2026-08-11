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

  // REMOVED: 'resolves built-in:<id> to <REPO_ROOT>/src/dag/bundles/<id>/'.
  // That search root is gone (#200) — no bundle lives in the engine any more, so
  // there is nothing for it to resolve. The root-chain behaviour that remains is
  // covered by the DHEE_USER_BUNDLES_DIR / DHEE_APP_BUNDLES_DIR / ~/.kshana
  // precedence tests above.

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

describe('resolveBundleDir — multi-root search (externalized bundles)', () => {
  // Externalized bundle resolution: the resolver searches roots in
  // precedence order so the same bundle id can exist in multiple
  // locations and the most-specific wins.
  //
  // Search order (high → low precedence):
  //   1. DHEE_USER_BUNDLES_DIR — user forks, community installs (writable)
  //   2. DHEE_APP_BUNDLES_DIR  — shipped defaults inside .app (read-only)
  //   3. ~/.kshana/bundles     — legacy `user:` location (back-compat)
  //   4. <REPO_ROOT>/src/dag/bundles — dev/source fallback
  //
  // Both `built-in:` and `user:` schemes resolve through the SAME chain.
  // The scheme is a semantic hint (UI label), not a resolution policy.
  // This lets a user fork `built-in:narrative_prompt_relay` by dropping
  // a same-named dir into DHEE_USER_BUNDLES_DIR; the fork wins.

  let tmpHome: string;
  let tmpUser: string;
  let tmpApp: string;
  let original: Record<string, string | undefined>;

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'bs-home-'));
    tmpUser = mkdtempSync(join(tmpdir(), 'bs-user-'));
    tmpApp = mkdtempSync(join(tmpdir(), 'bs-app-'));
    original = {
      HOME: process.env['HOME'],
      DHEE_USER_BUNDLES_DIR: process.env['DHEE_USER_BUNDLES_DIR'],
      DHEE_APP_BUNDLES_DIR: process.env['DHEE_APP_BUNDLES_DIR'],
    };
    process.env['HOME'] = tmpHome;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(original)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const d of [tmpHome, tmpUser, tmpApp]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  });

  function seedBundle(rootDir: string, id: string, marker: string): void {
    const bundleDir = join(rootDir, id);
    mkdirSync(bundleDir, { recursive: true });
    writeFileSync(
      join(bundleDir, 'bundle.json'),
      JSON.stringify({ id, marker, goal: 'final', nodes: [] }),
    );
  }

  it('resolves built-in:<id> from DHEE_APP_BUNDLES_DIR when set', () => {
    process.env['DHEE_APP_BUNDLES_DIR'] = tmpApp;
    seedBundle(tmpApp, 'shipped_bundle', 'app');
    const dir = resolveBundleDir({ scheme: 'built-in', id: 'shipped_bundle' });
    expect(dir).toBe(join(tmpApp, 'shipped_bundle'));
  });

  it('user fork in DHEE_USER_BUNDLES_DIR overrides the built-in shipped under DHEE_APP_BUNDLES_DIR', () => {
    process.env['DHEE_USER_BUNDLES_DIR'] = tmpUser;
    process.env['DHEE_APP_BUNDLES_DIR'] = tmpApp;
    seedBundle(tmpApp, 'narrative_prompt_relay', 'app-shipped');
    seedBundle(tmpUser, 'narrative_prompt_relay', 'user-forked');

    // Even though the project.json says `built-in:narrative_prompt_relay`,
    // the user's fork wins because USER has higher precedence than APP.
    const dir = resolveBundleDir({
      scheme: 'built-in',
      id: 'narrative_prompt_relay',
    });
    expect(dir).toBe(join(tmpUser, 'narrative_prompt_relay'));
  });

  it('user:<id> also resolves through the multi-root chain (USER → APP → HOME → REPO_ROOT)', () => {
    process.env['DHEE_USER_BUNDLES_DIR'] = tmpUser;
    seedBundle(tmpUser, 'my_custom', 'user');
    const dir = resolveBundleDir({ scheme: 'user', id: 'my_custom' });
    expect(dir).toBe(join(tmpUser, 'my_custom'));
  });

  it('back-compat: user:<id> still resolves to ~/.kshana/bundles when no env vars are set', () => {
    delete process.env['DHEE_USER_BUNDLES_DIR'];
    delete process.env['DHEE_APP_BUNDLES_DIR'];
    const legacyDir = join(tmpHome, '.kshana', 'bundles', 'legacy');
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, 'bundle.json'), '{}');
    const dir = resolveBundleDir({ scheme: 'user', id: 'legacy' });
    expect(dir).toBe(legacyDir);
  });

  it('falls through DHEE_USER_BUNDLES_DIR → DHEE_APP_BUNDLES_DIR when the id is in APP only', () => {
    process.env['DHEE_USER_BUNDLES_DIR'] = tmpUser; // empty user dir
    process.env['DHEE_APP_BUNDLES_DIR'] = tmpApp;
    seedBundle(tmpApp, 'only_in_app', 'app');
    const dir = resolveBundleDir({ scheme: 'built-in', id: 'only_in_app' });
    expect(dir).toBe(join(tmpApp, 'only_in_app'));
  });

  it('error message names every root searched when the bundle is missing everywhere', () => {
    process.env['DHEE_USER_BUNDLES_DIR'] = tmpUser;
    process.env['DHEE_APP_BUNDLES_DIR'] = tmpApp;
    try {
      resolveBundleDir({ scheme: 'built-in', id: 'no_such_bundle' });
      throw new Error('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/no_such_bundle/);
      expect(msg).toMatch(tmpUser);
      expect(msg).toMatch(tmpApp);
    }
  });

  it('legacy single-file bundle (<id>.json) still resolves from any root', () => {
    process.env['DHEE_APP_BUNDLES_DIR'] = tmpApp;
    writeFileSync(join(tmpApp, 'ltx_prompt_relay.json'), '{}');
    const path = resolveBundleDir({ scheme: 'built-in', id: 'ltx_prompt_relay' });
    expect(path).toBe(join(tmpApp, 'ltx_prompt_relay.json'));
  });
});
