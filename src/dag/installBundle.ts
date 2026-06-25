/**
 * installBundle — bring a community/3rd-party bundle into the user's
 * bundle dir so listBundles() picks it up. Sources: a folder, a .zip,
 * or a git repo. Validates the bundle.json + that every workflow/
 * manifest it references actually exists before copying — a broken
 * bundle never lands in the discoverable set.
 *
 * After install, the desktop runs the SAME checkBundle()/Configurator
 * flow it runs at first-run — install and first-run converge there.
 *
 * Install target = the first writable user root: DHEE_USER_BUNDLES_DIR,
 * else ~/.dhee/bundles (both are on the listBundles() search chain,
 * so an installed bundle is discoverable out of the box).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';

export interface BundleValidation {
  ok: boolean;
  bundleId?: string;
  version?: string;
  errors: string[];
}

export type BundleInstallSource =
  | { kind: 'folder'; path: string }
  | { kind: 'zip'; path: string }
  | { kind: 'git'; url: string; ref?: string };

export type InstallResult =
  | { ok: true; bundleId: string; dir: string }
  | { ok: false; error: string };

export function userBundlesDir(): string {
  const env = process.env['DHEE_USER_BUNDLES_DIR']?.trim();
  return env && env.length > 0 ? env : resolve(homedir(), '.dhee/bundles');
}

interface MinimalNode {
  runner?: { config?: Record<string, unknown> } | undefined;
}

/**
 * Validate a bundle directory: bundle.json parses, has the required
 * top-level fields, and every workflowPath/manifestPath referenced by
 * a node resolves to a real file inside the bundle.
 */
export function validateBundleStructure(bundleDir: string): BundleValidation {
  const errors: string[] = [];
  const file = join(bundleDir, 'bundle.json');
  if (!existsSync(file)) {
    return { ok: false, errors: [`no bundle.json in ${bundleDir}`] };
  }
  let bundle: Record<string, unknown>;
  try {
    bundle = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch (err) {
    return { ok: false, errors: [`bundle.json malformed: ${(err as Error).message}`] };
  }

  const id = bundle['id'];
  const version = bundle['version'];
  if (typeof id !== 'string' || !id) errors.push('bundle.json: missing/empty "id"');
  if (typeof version !== 'string' || !version) errors.push('bundle.json: missing/empty "version"');
  if (typeof bundle['goal'] !== 'string' || !bundle['goal']) errors.push('bundle.json: missing/empty "goal"');
  const nodes = bundle['nodes'];
  if (!Array.isArray(nodes) || nodes.length === 0) {
    errors.push('bundle.json: "nodes" must be a non-empty array');
  } else {
    // Referenced workflow + manifest files must exist inside the bundle.
    for (const node of nodes as MinimalNode[]) {
      const config = node?.runner?.config;
      if (!config) continue;
      for (const field of ['workflowPath', 'manifestPath']) {
        const ref = config[field];
        if (typeof ref !== 'string' || ref.length === 0) continue;
        const abs = isAbsolute(ref) ? ref : join(bundleDir, ref);
        if (!existsSync(abs)) errors.push(`referenced ${field} not found: ${ref}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    ...(typeof id === 'string' ? { bundleId: id } : {}),
    ...(typeof version === 'string' ? { version } : {}),
    errors,
  };
}

/**
 * The directory that actually contains bundle.json: either `dir`
 * itself, or its single child dir (zips/repos often nest the bundle
 * one level down). Returns null when neither holds.
 */
export function findBundleRoot(dir: string): string | null {
  if (existsSync(join(dir, 'bundle.json'))) return dir;
  let children: string[];
  try {
    children = readdirSync(dir).filter((n) => {
      try {
        return statSync(join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return null;
  }
  if (children.length === 1) {
    const nested = join(dir, children[0]!);
    if (existsSync(join(nested, 'bundle.json'))) return nested;
  }
  return null;
}

export interface InstallOpts {
  /** Override the install target (defaults to userBundlesDir()). */
  targetDir?: string;
  /** Overwrite an already-installed bundle of the same id. */
  force?: boolean;
}

export async function installBundle(
  src: BundleInstallSource,
  opts: InstallOpts = {},
): Promise<InstallResult> {
  let sourceDir: string;
  try {
    sourceDir = await materialize(src);
  } catch (err) {
    return { ok: false, error: `could not obtain bundle: ${(err as Error).message}` };
  }

  const root = findBundleRoot(sourceDir);
  if (!root) return { ok: false, error: 'no bundle.json found in the provided source' };

  const validation = validateBundleStructure(root);
  if (!validation.ok || !validation.bundleId) {
    return { ok: false, error: `invalid bundle: ${validation.errors.join('; ')}` };
  }

  const target = opts.targetDir ?? userBundlesDir();
  const dest = join(target, validation.bundleId);
  if (existsSync(dest) && !opts.force) {
    return { ok: false, error: `bundle "${validation.bundleId}" is already installed at ${dest} (pass force to overwrite)` };
  }
  mkdirSync(target, { recursive: true });
  cpSync(root, dest, { recursive: true });
  return { ok: true, bundleId: validation.bundleId, dir: dest };
}

/** Resolve any source kind to a local directory to validate + copy from. */
async function materialize(src: BundleInstallSource): Promise<string> {
  if (src.kind === 'folder') {
    if (!existsSync(src.path) || !statSync(src.path).isDirectory()) {
      throw new Error(`not a directory: ${src.path}`);
    }
    return src.path;
  }
  if (src.kind === 'zip') {
    const out = mkdtempSync(join(tmpdir(), 'dhee-bundle-zip-'));
    // `unzip` is present on macOS/Linux; desktop ships on those targets.
    execFileSync('unzip', ['-o', '-q', src.path, '-d', out], { stdio: 'ignore' });
    return out;
  }
  // git
  const out = mkdtempSync(join(tmpdir(), 'dhee-bundle-git-'));
  const args = ['clone', '--depth', '1'];
  if (src.ref) args.push('--branch', src.ref);
  args.push(src.url, out);
  execFileSync('git', args, { stdio: 'ignore' });
  return out;
}
