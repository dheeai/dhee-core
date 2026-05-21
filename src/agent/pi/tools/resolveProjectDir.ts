/**
 * Resolve a kshana/dhee project's on-disk folder.
 *
 * Three conventions exist in the wild:
 *   1. `<name>.kshana` — the post-rename canonical convention (every
 *      project the current kshana-desktop creates).
 *   2. `<name>.dhee`   — the legacy convention from dhee-core era;
 *      still supported for older projects on disk.
 *   3. `<name>` — what early dhee-desktop NewProjectDialog created
 *      (workspace folder + project name, no suffix).
 *
 * Earlier versions hardcoded `.dhee`, which made pi-agent's tools
 * fail on desktop-created projects. The LLM's fallback was to `mv`
 * the folder — destructive and surprising. This resolver replaces
 * that with a deterministic existence probe, plus an explicit
 * `projectDir` override for callers that already know the absolute
 * path (e.g. the desktop wizard's kickoff message).
 */
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface ResolveProjectDirOpts {
  /** Project name as the user/agent passed it (no suffix needed). */
  name: string;
  /** Where projects live by default (typically `getProjectsDir()`). */
  basePath: string;
  /**
   * Optional explicit absolute path. When provided AND it exists, it
   * wins — no probing, no convention fallback. The desktop passes
   * this so a workspace folder outside the default projects dir
   * still resolves correctly.
   */
  projectDir?: string | undefined;
}

export class ProjectDirNotFoundError extends Error {
  constructor(public readonly attempted: string[]) {
    super(
      `Project not found. Tried: ${attempted.map((p) => `'${p}'`).join(", ")}`,
    );
    this.name = "ProjectDirNotFoundError";
  }
}

/**
 * Returns the absolute path of the project's folder on disk. Throws
 * `ProjectDirNotFoundError` listing every path tried when nothing
 * matches.
 *
 * Probe order:
 *   1. Explicit `projectDir` (must be absolute and exist)
 *   2. `<basePath>/<name>.kshana`
 *   3. `<basePath>/<name>.dhee`   (legacy)
 *   4. `<basePath>/<name>`        (suffix-less)
 *
 * Suffixed forms are tried before the bare form so existing projects
 * keep their behavior unchanged when a sibling folder happens to share
 * the bare name.
 */
export function resolveProjectDir(opts: ResolveProjectDirOpts): string {
  const attempted: string[] = [];

  if (opts.projectDir) {
    const abs = isAbsolute(opts.projectDir)
      ? opts.projectDir
      : resolve(opts.basePath, opts.projectDir);
    attempted.push(abs);
    if (existsSync(abs)) return abs;
  }

  const kshana = resolve(opts.basePath, `${opts.name}.kshana`);
  attempted.push(kshana);
  if (existsSync(kshana)) return kshana;

  const dhee = resolve(opts.basePath, `${opts.name}.dhee`);
  attempted.push(dhee);
  if (existsSync(dhee)) return dhee;

  const bare = resolve(opts.basePath, opts.name);
  attempted.push(bare);
  if (existsSync(bare)) return bare;

  throw new ProjectDirNotFoundError(attempted);
}
