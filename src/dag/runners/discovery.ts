/**
 * Custom-runner discovery — scans a list of search directories for
 * runner packages and registers each one into the supplied registry.
 *
 * A runner package is a directory containing:
 *   - `runner.json` — manifest (parsed as RunnerManifest)
 *   - `<entry>`     — JS module that `export const runner = { ... }`
 *                     (entry filename defaults to 'index.mjs')
 *
 * Robustness contract (each rule has a corresponding regression test):
 *
 *   - Missing search dir → silently skip (the user may not have created
 *     ~/.kshana/runners/ yet)
 *   - Subdirectory without runner.json → skip (not a runner package,
 *     e.g. a README dir or version-control folder)
 *   - Malformed runner.json → warn, skip this package, continue with
 *     others (one bad package must not poison discovery)
 *   - Manifest declares an entry file that doesn't exist → warn, skip
 *   - Entry module fails to import → warn, skip
 *   - Entry module doesn't export a `runner` shape → warn, skip
 *
 * Same intent as ComfyUI's custom_nodes/ discovery: the engine tries
 * its best to load whatever is there, names what failed, and keeps
 * going.
 */
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunnerRegistry, RunnerManifest } from './registry.js';
import type { Runner } from '../schema.js';

const loadedEntryPaths = new Set<string>();

/**
 * Scan each search dir for runner packages and register them into
 * `reg`. Async because each package's entry module is dynamic-imported.
 */
export async function discoverRunners(
  reg: RunnerRegistry,
  searchDirs: string[],
): Promise<void> {
  for (const dir of searchDirs) {
    if (!existsSync(dir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      console.warn(
        `discoverRunners: cannot read ${dir}: ${(err as Error).message}`,
      );
      continue;
    }
    for (const entry of entries) {
      const pkgDir = join(dir, entry);
      try {
        if (!statSync(pkgDir).isDirectory()) continue;
      } catch {
        continue;
      }
      await tryLoadRunnerPackage(reg, pkgDir);
    }
  }
}

async function tryLoadRunnerPackage(
  reg: RunnerRegistry,
  pkgDir: string,
): Promise<void> {
  const manifestPath = join(pkgDir, 'runner.json');
  if (!existsSync(manifestPath)) return; // not a runner package

  let manifest: RunnerManifest;
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    manifest = JSON.parse(raw) as RunnerManifest;
  } catch (err) {
    console.warn(
      `discoverRunners: malformed runner.json in ${pkgDir}: ${(err as Error).message}. Skipping.`,
    );
    return;
  }

  // Sanity check the manifest before we try to import anything.
  if (!manifest.tool || typeof manifest.tool !== 'string') {
    console.warn(
      `discoverRunners: ${pkgDir}/runner.json is missing 'tool' field. Skipping.`,
    );
    return;
  }
  if (!manifest.version || typeof manifest.version !== 'string') {
    console.warn(
      `discoverRunners: ${pkgDir}/runner.json (tool=${manifest.tool}) is missing 'version' field. Skipping.`,
    );
    return;
  }

  const entryFile = manifest.entry ?? 'index.mjs';
  const entryPath = resolve(pkgDir, entryFile);
  if (!existsSync(entryPath)) {
    console.warn(
      `discoverRunners: ${pkgDir}/runner.json declares entry '${entryFile}' but ${entryPath} does not exist. Skipping.`,
    );
    return;
  }
  if (loadedEntryPaths.has(entryPath)) return;

  let mod: { runner?: Runner };
  try {
    mod = (await import(pathToFileURL(entryPath).href)) as { runner?: Runner };
  } catch (err) {
    console.warn(
      `discoverRunners: failed to import ${entryPath}: ${(err as Error).message}. Skipping.`,
    );
    return;
  }

  if (!mod.runner || typeof mod.runner.run !== 'function') {
    console.warn(
      `discoverRunners: ${entryPath} does not export a Runner via 'export const runner = ...'. Skipping.`,
    );
    return;
  }

  reg.register(manifest, mod.runner);
  loadedEntryPaths.add(entryPath);
}
