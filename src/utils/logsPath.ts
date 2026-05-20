/**
 * Single source of truth for the logs directory.
 *
 * Each logger (LLMLogger, phaseLogger, ToolAnalytics, uiLogger,
 * ComfyUIClient.debugLog, ExecutorAgent's project-local file) used to
 * compute its own path against `process.cwd()` or `finddheeCoreRoot`.
 * That worked from a checkout but broke when dhee-core ran inside a
 * packaged Electron app (cwd = .app bundle, read-only on macOS) — every
 * append silently failed and end-users had no logs to send back.
 *
 * Resolution order (highest priority first):
 *   1. value set via `setLogsDir(absPath)` at runtime
 *   2. `dhee_LOGS_DIR` env var (the desktop sets this before importing
 *      dhee-core; tests/CI use it directly)
 *   3. `<dhee-core repo root>/logs` for dev — preserves today's
 *      behavior when running from a checkout
 *   4. `<cwd>/logs` as the ultimate fallback
 *
 * The directory is created on first read so loggers can `appendFileSync`
 * without having to ensure-dir themselves.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

let runtimeOverride: string | undefined;
let cached: string | undefined;

function expandTilde(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return homedir() + p.slice(1);
  return p;
}

/**
 * Walk up from this file's location to find dhee-core's package.json.
 * Mirrors `finddheeCoreRoot` in `agent/pi/paths.ts` but inlined here
 * to avoid importing that module just for the side-effect of evaluating
 * `REPO_ROOT` at load time (paths.ts blows up at import time when run
 * from outside a checkout, and we want logsPath to be safer than that).
 */
function findRepoRootSafe(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 64; i += 1) {
      const pkg = join(dir, 'package.json');
      if (existsSync(pkg)) {
        // We don't bother reading + parsing — for our purposes any
        // package.json the file lives under is "the project". The strict
        // `name === "dhee-core"` check is unnecessary here because we
        // only use this for a dev fallback, never for production logs.
        return dir;
      }
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  } catch {
    /* fileURLToPath fails in non-ESM contexts — fine, fall through */
  }
  return undefined;
}

function ensureDir(p: string): string {
  if (!existsSync(p)) {
    try {
      mkdirSync(p, { recursive: true });
    } catch {
      /* read-only fs (e.g. asar) — caller's append will surface the error */
    }
  }
  return p;
}

function compute(): string {
  if (runtimeOverride) return runtimeOverride;
  const fromEnv = process.env['dhee_LOGS_DIR'];
  if (fromEnv && fromEnv.trim()) {
    return resolve(expandTilde(fromEnv.trim()));
  }
  const repoRoot = findRepoRootSafe();
  if (repoRoot) return join(repoRoot, 'logs');
  return join(process.cwd(), 'logs');
}

/**
 * Returns the absolute path to the logs directory, creating it if
 * necessary. Loggers should call this lazily (per-write or per-init) so
 * a host that calls `setLogsDir` after import still wins.
 */
export function getLogsDir(): string {
  if (!cached) {
    cached = ensureDir(compute());
  }
  return cached;
}

/**
 * Override the logs dir at runtime. Wins over `dhee_LOGS_DIR`. Used by
 * dhee-desktop (main process) before initializing core to redirect logs
 * to `app.getPath('userData')/logs`.
 */
export function setLogsDir(absPath: string): void {
  if (!isAbsolute(absPath)) {
    throw new Error(
      `setLogsDir requires an absolute path, got: ${absPath}`,
    );
  }
  runtimeOverride = absPath;
  cached = undefined; // recompute on next getLogsDir
}

/** Test-only: clear cache + override so each test starts fresh. */
export function resetLogsDirForTest(): void {
  runtimeOverride = undefined;
  cached = undefined;
}
