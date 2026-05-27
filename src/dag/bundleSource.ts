/**
 * BundleSource — parser + resolver for the `bundleSource` URI field that
 * `project.json` carries to identify which bundle a project uses.
 *
 * Three schemes, each with its own resolution policy:
 *   - `built-in:<id>`           → shipped with kshana-core, lives in
 *                                  <REPO_ROOT>/src/dag/bundles/<id>/
 *   - `user:<id>`               → user-authored, lives in
 *                                  ~/.kshana/bundles/<id>/
 *   - `registry:<scope>/<name>@<version>` → future bundle registry
 *                                  (parser accepts, resolver rejects
 *                                  with "not yet implemented")
 *
 * Parse and resolve are deliberately separate functions: the parser
 * never touches the filesystem (pure, can run in tests without any
 * setup), while the resolver makes filesystem calls and may throw on
 * missing-on-disk bundles.
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
    // 'scope/name@version' — version pin is required (lockable
    // references are non-negotiable for reproducibility).
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
 * Resolve a BundleSource to an absolute filesystem path. The path may
 * be either a directory (modern bundle layout) or a single JSON file
 * (legacy single-file bundle). Callers (the walker / loader) detect
 * which by checking statSync(...).isDirectory().
 *
 * Throws BundleSourceError when:
 *   - built-in bundle id doesn't exist on disk
 *   - user bundle id doesn't exist on disk
 *   - registry scheme (always — not implemented yet)
 */
export function resolveBundleDir(source: BundleSource): string {
  if (source.scheme === 'built-in') {
    const asDir = resolve(REPO_ROOT, 'src/dag/bundles', source.id);
    if (existsSync(asDir) && statSync(asDir).isDirectory()) return asDir;
    const asJson = resolve(REPO_ROOT, 'src/dag/bundles', `${source.id}.json`);
    if (existsSync(asJson)) return asJson;
    throw new BundleSourceError(
      `Built-in bundle '${source.id}' not found. ` +
        `Looked for directory at ${asDir} and single-file at ${asJson}.`,
    );
  }
  if (source.scheme === 'user') {
    const dir = resolve(homedir(), '.kshana/bundles', source.id);
    if (existsSync(dir) && statSync(dir).isDirectory()) return dir;
    throw new BundleSourceError(
      `User bundle '${source.id}' not found at ${dir}. ` +
        `Create the bundle directory there or fix the bundleSource in project.json.`,
    );
  }
  if (source.scheme === 'registry') {
    throw new BundleSourceError(
      `registry: scheme is not yet implemented. ` +
        `It is reserved for a future bundle registry feature; for now use built-in: or user:.`,
    );
  }
  // Exhaustiveness — TypeScript should catch this, but be defensive.
  throw new BundleSourceError(`Unhandled bundle source scheme.`);
}
