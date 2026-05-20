/**
 * Surface a dhee-core `.env` file into `process.env` at runtime.
 * Used by embedded hosts (dhee-desktop's Electron main process)
 * in development so the user's existing dev keys, ComfyUI URL, and
 * tier-routing config are picked up without copying anything.
 *
 * Behavior:
 *   - Reads `.env` from the dhee-core package root (auto-detected
 *     via `finddheeCoreRoot`, or pass an explicit `root` for
 *     testing).
 *   - Skips keys that are already present in `process.env`. Callers
 *     who want explicit overrides set the env var BEFORE calling.
 *   - Returns `vars` with only the keys that were actually written.
 *   - Returns `loaded: false` when the file doesn't exist (not an
 *     error — packaged builds and CI don't carry .env).
 *
 * NOT for production: the packaged desktop bundle ships without a
 * dev `.env` and shouldn't trigger this path. The desktop guards
 * the call behind `app.isPackaged === false`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseDotenv } from "dotenv";
import { finddheeCoreRoot, getProjectsDir } from "../agent/pi/paths.js";

export interface LoadDevEnvResult {
  loaded: boolean;
  /** Absolute path to the .env file that was read, or null if none. */
  path: string | null;
  /** Keys this call wrote to process.env (excludes pre-existing keys). */
  vars: string[];
  /**
   * The dhee-core package root — i.e. where this very module lives.
   * Static resources (prompts, schemas) hang off here. Returned for
   * debugging; embedded hosts usually don't need it because the
   * prompt loader resolves it independently via `finddheeCoreRoot`.
   */
  root: string;
  /**
   * The directory dhee-core expects projects to live under. Resolves
   * to:
   *   - `dhee_PROJECTS_DIR` env override, if set
   *   - `~/dhee` when running packaged (dhee_PACKAGED=1)
   *   - the dhee-core repo root, otherwise (dev mode)
   *
   * Embedded hosts (dhee-desktop) chdir to this so dhee-core's
   * filesystem helpers — which default `basePath` to `process.cwd()`
   * — find the right projects on both dev machines and packaged
   * end-user machines.
   */
  projectsDir: string;
}

export function loadDevEnv(root?: string): LoadDevEnvResult {
  const r = root ?? finddheeCoreRoot(import.meta.url);
  const projectsDir = getProjectsDir();
  const envPath = join(r, ".env");
  if (!existsSync(envPath)) {
    return { loaded: false, path: null, vars: [], root: r, projectsDir };
  }
  const parsed = parseDotenv(readFileSync(envPath));
  const written: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
      written.push(k);
    }
  }
  return { loaded: true, path: envPath, vars: written, root: r, projectsDir };
}
