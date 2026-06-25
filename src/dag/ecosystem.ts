/**
 * Ecosystem package discovery — loads runners and resolves bundles from
 * npm packages that follow the `dhee-runner-*` / `dhee-bundle-*`
 * convention (see docs/ecosystem-package-conventions.md).
 *
 * ESLint-plugin-style: enumerate node_modules entries whose NAME matches
 * the convention regex, then require a `keywords` guard (`dhee-runner` /
 * `dhee-bundle`) before trusting the package — so an unrelated
 * `dhee-runner-utils` helper lib is never auto-loaded. Entry points come
 * from the package.json `dhee` field:
 *   { "dhee": { "runners": "./dist/runners.js", "bundles": "./bundles" } }
 *
 * Robustness mirrors runners/discovery.ts: skip/warn, never poison — one
 * bad package must not break discovery for the rest.
 *
 * NOTE: the integration is intentionally minimal. Bundle resolution is
 * lazy (no global state — `resolveNpmBundleDir` scans on demand). Runner
 * discovery actively imports + registers, gated by `ensureNpmRunnersLoaded`
 * so it runs once per process.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RunnerRegistry, getGlobalRegistry, type RunnerManifest } from './runners/registry.js';
import type { Runner } from './schema.js';

/**
 * Matches ecosystem package names in two conventions:
 *  - prefix form (scoped or not): `dhee-runner`, `dhee-runner-foo`,
 *    `@scope/dhee-bundle-bar`
 *  - scoped-short form: `@scope/runner-foo`, `@dhee_ai/bundle-upsc-explainer`
 *    (the scope already namespaces "dhee", so the `dhee-` prefix is dropped).
 *
 * The keyword guard (`dhee-runner` / `dhee-bundle`) in `maybeAdd` still gates
 * trust, so a generic `@scope/runner-utils` lib without the keyword is skipped.
 */
export const ECOSYSTEM_PKG_RE =
  /^(?:@[^/]+\/)?dhee-(?:runner|bundle)(?:-.+)?$|^@[^/]+\/(?:runner|bundle)(?:-.+)?$/;

interface DheeField {
  runners?: string;
  bundles?: string;
}
interface EcoPkgJson {
  name?: string;
  version?: string;
  keywords?: string[];
  dhee?: DheeField;
}
export interface EcoPkg {
  name: string;
  dir: string;
  pkg: EcoPkgJson;
  isRunner: boolean;
  isBundle: boolean;
}

/**
 * node_modules directories to scan. `DHEE_NODE_MODULES_DIRS` (colon- or
 * comma-separated) overrides — used by tests and non-standard layouts.
 * Default: every `node_modules` from cwd up to the filesystem root
 * (covers workspaces / hoisted installs).
 */
export function getNodeModulesRoots(): string[] {
  const env = process.env['DHEE_NODE_MODULES_DIRS']?.trim();
  if (env) return env.split(/[:,]/).map((s) => s.trim()).filter(Boolean);
  const roots: string[] = [];
  let dir = process.cwd();
  for (;;) {
    const nm = join(dir, 'node_modules');
    if (existsSync(nm)) roots.push(nm);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return roots;
}

function maybeAdd(dir: string, name: string, out: EcoPkg[], seen: Set<string>): void {
  if (seen.has(name)) return; // first root wins
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch {
    return;
  }
  if (!st.isDirectory()) return;
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return;
  let pkg: EcoPkgJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as EcoPkgJson;
  } catch {
    console.warn(`ecosystem: malformed package.json in ${dir}. Skipping.`);
    return;
  }
  const kw = Array.isArray(pkg.keywords) ? pkg.keywords : [];
  const isRunner = kw.includes('dhee-runner');
  const isBundle = kw.includes('dhee-bundle');
  if (!isRunner && !isBundle) {
    console.warn(
      `ecosystem: '${name}' matches the dhee-runner/dhee-bundle name pattern but is missing the ` +
        `required keyword ('dhee-runner' or 'dhee-bundle'). Skipping (add the keyword to opt in).`,
    );
    return;
  }
  seen.add(name);
  out.push({ name, dir, pkg, isRunner, isBundle });
}

/** Enumerate matching, keyword-guarded ecosystem packages across roots. */
export function findEcosystemPackages(roots: string[] = getNodeModulesRoots()): EcoPkg[] {
  const out: EcoPkg[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith('@')) {
        // Scope directory — descend one level.
        const scopeDir = join(root, entry);
        let scoped: string[];
        try {
          scoped = readdirSync(scopeDir);
        } catch {
          continue;
        }
        for (const sub of scoped) {
          const full = `${entry}/${sub}`;
          if (ECOSYSTEM_PKG_RE.test(full)) maybeAdd(join(scopeDir, sub), full, out, seen);
        }
      } else if (ECOSYSTEM_PKG_RE.test(entry)) {
        maybeAdd(join(root, entry), entry, out, seen);
      }
    }
  }
  return out;
}

// ── Runner discovery ───────────────────────────────────────────────────

export interface NpmRunnerLoadResult {
  registered: string[];
  skipped: string[];
  errors: string[];
}

/**
 * Import every `dhee-runner-*` package's `dhee.runners` entry and register
 * each exported `{ manifest, runner }` into `reg`. Idempotent: a tool
 * already registered (built-in, or an earlier package) is skipped, never
 * re-registered. Best-effort: failures are collected + warned, never thrown.
 */
export async function discoverNpmRunners(
  reg: RunnerRegistry = getGlobalRegistry(),
  roots: string[] = getNodeModulesRoots(),
): Promise<NpmRunnerLoadResult> {
  const res: NpmRunnerLoadResult = { registered: [], skipped: [], errors: [] };
  for (const p of findEcosystemPackages(roots)) {
    if (!p.isRunner) continue;
    const entry = p.pkg.dhee?.runners;
    if (!entry) {
      res.errors.push(`${p.name}: has keyword 'dhee-runner' but no package.json 'dhee.runners' entry point.`);
      continue;
    }
    const entryPath = resolve(p.dir, entry);
    if (!existsSync(entryPath)) {
      res.errors.push(`${p.name}: dhee.runners entry '${entry}' not found at ${entryPath}.`);
      continue;
    }
    let mod: { runners?: Array<{ manifest: RunnerManifest; runner: Runner }> };
    try {
      mod = (await import(pathToFileURL(entryPath).href)) as typeof mod;
    } catch (err) {
      res.errors.push(`${p.name}: import of ${entryPath} failed: ${(err as Error).message}.`);
      continue;
    }
    if (!Array.isArray(mod.runners)) {
      res.errors.push(`${p.name}: ${entry} must \`export const runners = [{ manifest, runner }, …]\`.`);
      continue;
    }
    for (const item of mod.runners) {
      const tool = item?.manifest?.tool;
      if (!tool || typeof item.runner?.run !== 'function') {
        res.errors.push(`${p.name}: an entry in 'runners' is not a valid { manifest, runner } pair.`);
        continue;
      }
      if (reg.get(tool)) {
        res.skipped.push(tool); // already registered → idempotent
        continue;
      }
      try {
        reg.register(item.manifest, item.runner);
        res.registered.push(tool);
      } catch (err) {
        res.errors.push(`${p.name}: register '${tool}' failed: ${(err as Error).message}.`);
      }
    }
  }
  for (const e of res.errors) console.warn(`discoverNpmRunners: ${e}`);
  return res;
}

// ── Bundle → runner dependency / install hints ──────────────────────────

export interface MissingRunner {
  /** The required tool id that is not registered. */
  tool: string;
  /** The semver range the bundle declared for it. */
  range: string;
  /** npm package that provides it (declared `runnerPackages`, else a
   *  `dhee-runner-<namespace>` convention guess). Undefined if unknown. */
  package?: string;
  /** Whether `package` is an authoritative declaration or a convention guess. */
  packageSource?: 'declared' | 'convention';
  /** Ready-to-run install command, when a package is known. */
  install?: string;
}

interface DepsShape {
  dependencies?: { runners?: Record<string, string>; runnerPackages?: Record<string, string> };
}

/**
 * Given a bundle's declared dependencies and the current registry, return
 * the required runners that are NOT registered, each with an install hint
 * (the declared `runnerPackages` entry, else the `dhee-runner-<namespace>`
 * convention guess). Pure + synchronous — the CALLER should
 * `await ensureNpmRunnersLoaded()` first so npm-discovered runners count
 * as present. An empty array means every required runner is available.
 */
export function checkBundleRunners(
  bundle: DepsShape,
  reg: RunnerRegistry = getGlobalRegistry(),
): MissingRunner[] {
  const runners = bundle.dependencies?.runners ?? {};
  const declared = bundle.dependencies?.runnerPackages ?? {};
  const missing: MissingRunner[] = [];
  for (const [tool, range] of Object.entries(runners)) {
    if (reg.get(tool)) continue; // built-in or already npm-discovered
    let pkg: string | undefined;
    let packageSource: 'declared' | 'convention' | undefined;
    if (declared[tool]) {
      pkg = declared[tool];
      packageSource = 'declared';
    } else {
      const ns = tool.split('.')[0];
      if (ns) {
        pkg = `dhee-runner-${ns}`;
        packageSource = 'convention';
      }
    }
    missing.push({
      tool,
      range,
      ...(pkg ? { package: pkg, packageSource: packageSource!, install: `npm i ${pkg}` } : {}),
    });
  }
  return missing;
}

let npmRunnersLoaded = false;
/** Run npm-runner discovery once per process (best-effort). Safe to call repeatedly. */
export async function ensureNpmRunnersLoaded(reg: RunnerRegistry = getGlobalRegistry()): Promise<void> {
  if (npmRunnersLoaded) return;
  npmRunnersLoaded = true;
  try {
    const r = await discoverNpmRunners(reg);
    if (r.registered.length > 0) {
      console.log(`ecosystem: registered npm runners → ${r.registered.join(', ')}`);
    }
  } catch (err) {
    console.warn(`ensureNpmRunnersLoaded: ${(err as Error).message}`);
  }
}

/** Test-only: reset the once-guard so discovery can run again. */
export function __resetNpmRunnersLoadedForTesting(): void {
  npmRunnersLoaded = false;
}

// ── Bundle resolution ────────────────────────────────────────────────────

export interface NpmBundle {
  pkg: string;
  id: string;
  dir: string;
}

function readBundleId(bundleJsonPath: string): string | null {
  try {
    const j = JSON.parse(readFileSync(bundleJsonPath, 'utf-8')) as { id?: string };
    return typeof j.id === 'string' && j.id ? j.id : null;
  } catch {
    return null;
  }
}

/**
 * Enumerate every bundle exposed by installed `dhee-bundle-*` packages.
 * `dhee.bundles` may point at a single bundle dir (a `bundle.json` lives
 * directly inside) OR a directory of bundle dirs.
 */
export function findNpmBundles(roots: string[] = getNodeModulesRoots()): NpmBundle[] {
  const out: NpmBundle[] = [];
  for (const p of findEcosystemPackages(roots)) {
    if (!p.isBundle) continue;
    const entry = p.pkg.dhee?.bundles;
    if (!entry) {
      console.warn(`findNpmBundles: ${p.name} has keyword 'dhee-bundle' but no 'dhee.bundles' entry point.`);
      continue;
    }
    const bundlesPath = resolve(p.dir, entry);
    if (!existsSync(bundlesPath)) {
      console.warn(`findNpmBundles: ${p.name} dhee.bundles '${entry}' not found at ${bundlesPath}.`);
      continue;
    }
    // Single-bundle layout: bundle.json directly inside.
    if (existsSync(join(bundlesPath, 'bundle.json'))) {
      const id = readBundleId(join(bundlesPath, 'bundle.json')) ?? p.name;
      out.push({ pkg: p.name, id, dir: bundlesPath });
      continue;
    }
    // Multi-bundle layout: one subdir per bundle.
    let subs: string[];
    try {
      subs = readdirSync(bundlesPath);
    } catch {
      continue;
    }
    for (const sub of subs) {
      const subDir = join(bundlesPath, sub);
      const bj = join(subDir, 'bundle.json');
      try {
        if (!statSync(subDir).isDirectory() || !existsSync(bj)) continue;
      } catch {
        continue;
      }
      out.push({ pkg: p.name, id: readBundleId(bj) ?? sub, dir: subDir });
    }
  }
  return out;
}

/**
 * Resolve `npm:<pkg>[#<bundleId>]` to a bundle directory. Throws (plain
 * Error — caller wraps) on miss or ambiguity, naming the available ids.
 */
export function resolveNpmBundleDir(
  pkgName: string,
  bundleId: string | undefined,
  roots: string[] = getNodeModulesRoots(),
): string {
  const all = findNpmBundles(roots).filter((b) => b.pkg === pkgName);
  if (all.length === 0) {
    throw new Error(
      `npm bundle package '${pkgName}' not found, or it exposes no bundles ` +
        `(needs a matching name, a 'dhee-bundle' keyword, and a 'dhee.bundles' entry point).`,
    );
  }
  if (bundleId) {
    const hit = all.find((b) => b.id === bundleId);
    if (!hit) {
      throw new Error(
        `npm package '${pkgName}' has no bundle '${bundleId}'. Available: ${all.map((b) => b.id).join(', ')}.`,
      );
    }
    return hit.dir;
  }
  if (all.length === 1) return all[0]!.dir;
  throw new Error(
    `npm package '${pkgName}' exposes ${all.length} bundles; pick one as 'npm:${pkgName}#<id>'. ` +
      `Available: ${all.map((b) => b.id).join(', ')}.`,
  );
}
