/**
 * Read-only runner readiness helpers.
 *
 * These functions inspect bundle dependencies and runner.json manifests
 * without importing runner entry modules. They are safe for desktop UI
 * preflight checks where executable runner code must not run yet.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import semver from 'semver';
import type { DagBundle, RunnerManifest } from '@dhee/runner-sdk';
import {
  parseBundleSource,
  resolveBundleDir,
  BundleSourceError,
} from '../bundleSource.js';
import { REPO_ROOT } from '../../agent/pi/paths.js';
import { discoverRunners } from './discovery.js';
import { getGlobalRegistry, type RunnerRegistry } from './registry.js';
import { BUILTIN_RUNNER_MANIFESTS } from './builtinManifests.js';

export interface RunnerManifestSummary {
  tool: string;
  version: string;
  credentials: string[];
  displayName?: string;
  description?: string;
  packageDir: string;
  manifestPath: string;
}

export interface RequiredRunnerReadiness {
  tool: string;
  range: string;
  installed: boolean;
  version?: string;
  versionSatisfied: boolean;
  credentials: string[];
  missingCredentials: string[];
}

export interface BundleRunnerReadiness {
  ok: boolean;
  bundleId?: string;
  bundleSource?: string;
  requiredRunners: RequiredRunnerReadiness[];
  installedRunners: RunnerManifestSummary[];
  missingRunners: Array<{ tool: string; range: string }>;
  versionMismatches: Array<{ tool: string; range: string; version: string }>;
  requiredCredentials: string[];
  missingCredentials: string[];
  errors: string[];
}

export function getRunnerSearchRoots(): string[] {
  const roots: string[] = [];

  // Lowest precedence: source checkout runner packages, used by dev and tests.
  roots.push(resolve(REPO_ROOT, 'packages'));

  const appDir = process.env['DHEE_APP_RUNNERS_DIR']?.trim();
  if (appDir) roots.push(appDir);

  // Legacy user location. Kept lower than the desktop's explicit user root.
  roots.push(resolve(homedir(), '.kshana/runners'));

  const userDir = process.env['DHEE_USER_RUNNERS_DIR']?.trim();
  if (userDir) roots.push(userDir);

  return roots;
}

export function listRunnerManifests(
  searchDirs: string[] = getRunnerSearchRoots(),
): RunnerManifestSummary[] {
  const byTool = new Map<string, RunnerManifestSummary>();
  for (const manifest of BUILTIN_RUNNER_MANIFESTS) {
    byTool.set(manifest.tool, {
      tool: manifest.tool,
      version: manifest.version,
      credentials: manifest.credentials,
      ...(manifest.displayName ? { displayName: manifest.displayName } : {}),
      ...(manifest.description ? { description: manifest.description } : {}),
      packageDir: 'builtin',
      manifestPath: `builtin:${manifest.tool}`,
    });
  }
  for (const root of searchDirs) {
    if (!existsSync(root)) continue;
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      const packageDir = join(root, name);
      try {
        if (!statSync(packageDir).isDirectory()) continue;
      } catch {
        continue;
      }
      const manifest = readRunnerManifestSummary(packageDir);
      if (!manifest) continue;
      // Last scanned wins, matching RunnerRegistry.register overwrite policy.
      byTool.set(manifest.tool, manifest);
    }
  }
  return Array.from(byTool.values()).sort((a, b) => a.tool.localeCompare(b.tool));
}

export function checkBundleRunnerReadiness(
  bundle: DagBundle,
  opts: {
    bundleSource?: string;
    env?: NodeJS.ProcessEnv;
    searchDirs?: string[];
  } = {},
): BundleRunnerReadiness {
  const installedRunners = listRunnerManifests(opts.searchDirs);
  const byTool = new Map(installedRunners.map((m) => [m.tool, m]));
  const env = opts.env ?? process.env;
  const requiredRunners: RequiredRunnerReadiness[] = [];
  const missingRunners: Array<{ tool: string; range: string }> = [];
  const versionMismatches: Array<{ tool: string; range: string; version: string }> = [];
  const requiredCredentials = new Set<string>();
  const missingCredentials = new Set<string>();
  const errors: string[] = [];

  const deps = bundle.dependencies?.runners ?? {};
  for (const [tool, range] of Object.entries(deps)) {
    const manifest = byTool.get(tool);
    if (!manifest) {
      missingRunners.push({ tool, range });
      errors.push(`Runner '${tool}' is not installed.`);
      requiredRunners.push({
        tool,
        range,
        installed: false,
        versionSatisfied: false,
        credentials: [],
        missingCredentials: [],
      });
      continue;
    }

    const versionSatisfied = semver.satisfies(manifest.version, range, {
      includePrerelease: true,
    });
    if (!versionSatisfied) {
      versionMismatches.push({ tool, range, version: manifest.version });
      errors.push(
        `Runner '${tool}' version ${manifest.version} does not satisfy ${range}.`,
      );
    }

    const runnerMissingCredentials: string[] = [];
    for (const cred of manifest.credentials) {
      requiredCredentials.add(cred);
      const val = env[cred];
      if (!val || val.trim() === '') {
        missingCredentials.add(cred);
        runnerMissingCredentials.push(cred);
      }
    }

    requiredRunners.push({
      tool,
      range,
      installed: true,
      version: manifest.version,
      versionSatisfied,
      credentials: manifest.credentials,
      missingCredentials: runnerMissingCredentials,
    });
  }

  for (const cred of missingCredentials) {
    errors.push(`Required runner credential '${cred}' is missing.`);
  }

  return {
    ok: errors.length === 0,
    bundleId: bundle.id,
    ...(opts.bundleSource ? { bundleSource: opts.bundleSource } : {}),
    requiredRunners,
    installedRunners,
    missingRunners,
    versionMismatches,
    requiredCredentials: Array.from(requiredCredentials).sort(),
    missingCredentials: Array.from(missingCredentials).sort(),
    errors,
  };
}

export function checkBundleSourceRunnerReadiness(
  bundleSource: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    searchDirs?: string[];
  } = {},
): BundleRunnerReadiness {
  try {
    const source = parseBundleSource(bundleSource);
    const bundlePathOrDir = resolveBundleDir(source);
    const isDir = statSync(bundlePathOrDir).isDirectory();
    const bundleJsonPath = isDir ? join(bundlePathOrDir, 'bundle.json') : bundlePathOrDir;
    const bundle = JSON.parse(readFileSync(bundleJsonPath, 'utf-8')) as DagBundle;
    return checkBundleRunnerReadiness(bundle, {
      bundleSource,
      ...opts,
    });
  } catch (err) {
    const message =
      err instanceof BundleSourceError || err instanceof Error
        ? err.message
        : String(err);
    return {
      ok: false,
      bundleSource,
      requiredRunners: [],
      installedRunners: listRunnerManifests(opts.searchDirs),
      missingRunners: [],
      versionMismatches: [],
      requiredCredentials: [],
      missingCredentials: [],
      errors: [message],
    };
  }
}

let defaultDiscoveryComplete = false;

export async function ensureDefaultRunnersDiscovered(
  reg: RunnerRegistry = getGlobalRegistry(),
  opts: { force?: boolean; searchDirs?: string[] } = {},
): Promise<void> {
  if (defaultDiscoveryComplete && !opts.force) return;
  await discoverRunners(reg, opts.searchDirs ?? getRunnerSearchRoots());
  defaultDiscoveryComplete = true;
}

export function __resetDefaultRunnerDiscoveryForTesting(): void {
  defaultDiscoveryComplete = false;
}

function readRunnerManifestSummary(packageDir: string): RunnerManifestSummary | null {
  const manifestPath = join(packageDir, 'runner.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Partial<RunnerManifest>;
    if (typeof parsed.tool !== 'string' || !parsed.tool.trim()) return null;
    if (typeof parsed.version !== 'string' || !parsed.version.trim()) return null;
    const credentials = Array.isArray(parsed.credentials)
      ? parsed.credentials.filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      : [];
    return {
      tool: parsed.tool.trim(),
      version: parsed.version.trim(),
      credentials,
      ...(typeof parsed.displayName === 'string' ? { displayName: parsed.displayName } : {}),
      ...(typeof parsed.description === 'string' ? { description: parsed.description } : {}),
      packageDir,
      manifestPath,
    };
  } catch {
    return null;
  }
}
