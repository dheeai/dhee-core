/**
 * RunnerRegistry — single source of truth for which Runner implementations
 * are available to the walker.
 *
 * Built-in runners (the ones that ship in src/dag/runners/) register at
 * import time via the global registry exported here. Custom runners
 * discovered at startup from `~/.kshana/runners/` (see discovery.ts)
 * register through the same API.
 *
 * The registry is also responsible for validating a bundle's declared
 * `dependencies.runners` against what's actually registered, BEFORE the
 * walker dispatches any work. Surfacing missing or wrong-versioned
 * runners early avoids the "ran half the pipeline then exploded on an
 * unknown tool name" failure mode.
 */
import semver from 'semver';
import type { DagBundle, Runner } from '../schema.js';

export type { Runner } from '../schema.js';

/**
 * Public runner manifest — what each runner package declares about
 * itself. Built-in runners pass a manifest object at register-time;
 * custom runners ship a `runner.json` with this same shape.
 *
 * This type is part of the public runner SDK surface — third-party
 * runner authors build against it. Breaking changes here are breaking
 * changes to that SDK and require an engine major-version bump.
 */
export interface RunnerManifest {
  /** Unique tool id, dot-namespaced (e.g. 'llm.generate', 'runway.gen3'). */
  tool: string;
  /** Semver version of the runner. */
  version: string;
  /**
   * Range of engine versions this runner is compatible with (semver
   * range). The engine compares its own version against this on
   * register; mismatched runners log a warning but are still loaded
   * (last-wins consistency).
   */
  engineCompat: string;
  /**
   * Env var names this runner needs to function (e.g. ['RUNWAY_API_KEY']).
   * Validated by `validateBundle` against `process.env` — bundles that
   * depend on a runner with unset credentials fail validation BEFORE
   * walking, with the missing var named.
   */
  credentials: string[];
  /** Optional human-friendly name for UIs / logs. */
  displayName?: string;
  /** Optional human-friendly one-liner description. */
  description?: string;
  /**
   * For custom-runner packages discovered from disk: the entry file
   * (relative to the package dir). Defaults to 'index.mjs' if absent.
   * Built-in runners don't use this — they register directly.
   */
  entry?: string;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export class RunnerRegistry {
  private entries = new Map<string, { manifest: RunnerManifest; runner: Runner }>();

  /**
   * Register a runner under its declared tool name. If the tool is
   * already registered, the previous entry is overwritten (last-wins)
   * and a warning is emitted. Silent overwrite would mask a real
   * configuration mistake — two custom-runner packages competing for
   * the same tool id, for example.
   */
  register(manifest: RunnerManifest, runner: Runner): void {
    const existing = this.entries.get(manifest.tool);
    if (existing) {
      console.warn(
        `RunnerRegistry: tool '${manifest.tool}' is being re-registered. ` +
          `Previous version: ${existing.manifest.version}, new version: ${manifest.version}. ` +
          `Last-loaded wins.`,
      );
    }
    this.entries.set(manifest.tool, { manifest, runner });
  }

  /** Get the registered Runner for a tool id, or undefined. */
  get(tool: string): Runner | undefined {
    return this.entries.get(tool)?.runner;
  }

  /** Get the manifest for a tool id, or undefined. */
  getManifest(tool: string): RunnerManifest | undefined {
    return this.entries.get(tool)?.manifest;
  }

  /** List manifests of all currently-registered runners. */
  list(): RunnerManifest[] {
    return Array.from(this.entries.values()).map((e) => e.manifest);
  }

  /**
   * Check a bundle's `dependencies.runners` against the registry.
   * Returns ok=true when every declared runner is registered, every
   * registered version satisfies the declared range, and every
   * runner's declared credential env vars are set.
   *
   * On failure, returns *all* errors (don't stop at the first) so the
   * caller can show the user every fix needed in one pass instead of
   * iterating "run → fix one → run → fix another."
   */
  validateBundle(bundle: DagBundle): ValidationResult {
    const errors: string[] = [];
    const deps = bundle.dependencies?.runners ?? {};
    for (const [tool, range] of Object.entries(deps)) {
      const entry = this.entries.get(tool);
      if (!entry) {
        errors.push(
          `Runner '${tool}' is not registered. ` +
            `Install it (e.g. clone the runner package into ~/.kshana/runners/<name>/) ` +
            `or check the bundle's dependencies declaration.`,
        );
        continue;
      }
      if (!semver.satisfies(entry.manifest.version, range, { includePrerelease: true })) {
        errors.push(
          `Runner '${tool}' version ${entry.manifest.version} does not satisfy ${range}. ` +
            `Update the runner or relax the bundle's version range.`,
        );
      }
      for (const cred of entry.manifest.credentials) {
        const val = process.env[cred];
        if (!val || val === '') {
          errors.push(
            `Runner '${tool}' requires credential env var '${cred}' but it is missing or empty. ` +
              `Set it in your environment (or in the desktop settings) before running this bundle.`,
          );
        }
      }
    }
    return errors.length === 0 ? { ok: true } : { ok: false, errors };
  }
}

/**
 * Process-global default registry. Built-in runners register here at
 * import time; the walker reads here. Tests construct their own
 * RunnerRegistry instance for isolation — they don't touch this global.
 */
let _global: RunnerRegistry | undefined;
export function getGlobalRegistry(): RunnerRegistry {
  if (!_global) _global = new RunnerRegistry();
  return _global;
}

/** Test-only — reset the global registry between test suites if needed. */
export function __resetGlobalRegistryForTesting(): void {
  _global = undefined;
}
