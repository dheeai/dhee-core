/**
 * BundleSource — parser + resolver for the `bundleSource` URI field that
 * `project.json` carries to identify which bundle a project uses.
 *
 * Three schemes (parser):
 *   - `built-in:<id>` → ships with the app
 *   - `user:<id>`     → user-authored / community / forked
 *   - `registry:<scope>/<name>@<version>` → future bundle registry
 *
 * Resolution is multi-root: both `built-in:` and `user:` schemes search
 * the SAME chain of roots, in precedence order. The scheme is a
 * semantic hint (UI label), not a routing policy. This lets a user
 * fork a built-in by dropping a same-named directory into the user
 * bundles dir — the fork wins.
 *
 * Search order (high → low precedence):
 *   1. DHEE_USER_BUNDLES_DIR — user forks + community installs
 *      (the desktop sets this to `<studiosDir>/bundles/`).
 *   2. DHEE_APP_BUNDLES_DIR  — first-party defaults shipped inside
 *      the packaged app (electron-builder extraResources lifts
 *      kshana-core/dist/bundles → <app>/Resources/bundles).
 *   3. ~/.kshana/bundles     — legacy `user:` location, kept for
 *      back-compat with projects created before externalization.
 *   4. <REPO_ROOT>/src/dag/bundles — dev/source fallback (the path
 *      that worked pre-externalization). Lets vitest + headless
 *      scripts keep running without env vars.
 *
 * Parse and resolve are deliberately separate functions: the parser
 * never touches the filesystem (pure, runs in tests without setup);
 * the resolver makes filesystem calls and throws on missing bundles
 * with every searched root named in the error.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { REPO_ROOT } from '../agent/pi/paths.js';

export type BundleSource =
  | { scheme: 'built-in'; id: string }
  | { scheme: 'user'; id: string }
  | { scheme: 'registry'; id: string; version: string };

export class BundleSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleSourceError';
  }
}

const VALID_SCHEMES = ['built-in', 'user', 'registry'] as const;

/**
 * Parse a `bundleSource` URI string into a structured BundleSource.
 * Never touches the filesystem. Throws BundleSourceError on malformed
 * URIs — with the list of valid schemes named in the error to keep the
 * UX self-documenting.
 */
export function parseBundleSource(uri: string): BundleSource {
  if (!uri || !uri.trim()) {
    throw new BundleSourceError('Bundle source URI is empty.');
  }
  const colonIdx = uri.indexOf(':');
  if (colonIdx < 0) {
    throw new BundleSourceError(
      `Bundle source URI '${uri}' has no scheme. ` +
        `Expected one of: built-in:<id>, user:<id>, registry:<scope>/<name>@<version>.`,
    );
  }
  const scheme = uri.slice(0, colonIdx);
  const rest = uri.slice(colonIdx + 1);

  if (scheme === 'built-in') {
    if (!rest) {
      throw new BundleSourceError(`built-in: requires an id, got empty string.`);
    }
    return { scheme: 'built-in', id: rest };
  }
  if (scheme === 'user') {
    if (!rest) {
      throw new BundleSourceError(`user: requires an id, got empty string.`);
    }
    return { scheme: 'user', id: rest };
  }
  if (scheme === 'registry') {
    const atIdx = rest.lastIndexOf('@');
    if (atIdx < 0) {
      throw new BundleSourceError(
        `registry: requires a version pin (e.g. 'registry:scope/name@1.2.0'), got '${rest}'.`,
      );
    }
    const id = rest.slice(0, atIdx);
    const version = rest.slice(atIdx + 1);
    if (!id || !version) {
      throw new BundleSourceError(`registry: id or version is empty in '${uri}'.`);
    }
    return { scheme: 'registry', id, version };
  }
  throw new BundleSourceError(
    `Unknown scheme '${scheme}' in URI '${uri}'. ` +
      `Expected one of: ${VALID_SCHEMES.join(', ')}. ` +
      `(Common mistake: 'builtin' should be 'built-in' with a hyphen.)`,
  );
}

/**
 * The ordered list of root directories the resolver searches for a
 * bundle id. Exported so list-bundles can enumerate the same set.
 *
 * Env vars take precedence over defaults so the desktop can point
 * them at packaged paths (`<app>/Resources/bundles`) and user paths
 * (`<studiosDir>/bundles`) without recompiling kshana-core.
 */
export function getBundleSearchRoots(): string[] {
  const roots: string[] = [];
  const userDir = process.env['DHEE_USER_BUNDLES_DIR']?.trim();
  if (userDir) roots.push(userDir);
  const appDir = process.env['DHEE_APP_BUNDLES_DIR']?.trim();
  if (appDir) roots.push(appDir);
  // Legacy `user:` location — back-compat for projects that predate
  // the env-driven layout.
  roots.push(resolve(homedir(), '.kshana/bundles'));
  // Dev / source fallback — the in-repo source tree. Keeps vitest +
  // headless scripts working without setting env vars.
  roots.push(resolve(REPO_ROOT, 'src/dag/bundles'));
  return roots;
}

/**
 * Resolve a BundleSource to an absolute filesystem path. The path may
 * be either a directory (modern bundle layout: `<root>/<id>/`) or a
 * single JSON file (legacy: `<root>/<id>.json`). Callers detect which
 * via `statSync(...).isDirectory()`.
 *
 * Both `built-in:` and `user:` schemes resolve through the same search
 * chain — see `getBundleSearchRoots()`. The first match wins; if no
 * root contains the id, throws BundleSourceError naming every searched
 * path so the user can see where to drop the bundle.
 */
export function resolveBundleDir(source: BundleSource): string {
  if (source.scheme === 'registry') {
    throw new BundleSourceError(
      `registry: scheme is not yet implemented. ` +
        `It is reserved for a future bundle registry feature; for now use built-in: or user:.`,
    );
  }

  const roots = getBundleSearchRoots();
  const tried: string[] = [];
  for (const root of roots) {
    const asDir = resolve(root, source.id);
    tried.push(asDir);
    if (existsSync(asDir) && statSync(asDir).isDirectory()) return asDir;
    const asJson = resolve(root, `${source.id}.json`);
    tried.push(asJson);
    if (existsSync(asJson)) return asJson;
  }
  throw new BundleSourceError(
    `${source.scheme} bundle '${source.id}' not found. ` +
      `Searched:\n  - ${tried.join('\n  - ')}`,
  );
}
