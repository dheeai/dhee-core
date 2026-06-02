/**
 * Path-scope guard for dhee filesystem tools.
 *
 * `assertPathInProject(projectDir, candidate)` throws if `candidate`
 * is not under `projectDir`. Both inputs MUST be absolute. The check
 * uses `path.relative` semantics, not naive `startsWith` — so a
 * sibling like `/foo-other` doesn't get mistaken for `/foo`.
 *
 * Symlink-escape is intentionally NOT handled here (would require
 * `fs.realpath`). For v1 the textual scope check is enough to stop
 * the agent from wandering into `/Users/ganaraj/Projects/kshana-core`
 * to read engine source.
 */
import { isAbsolute, relative, resolve } from 'node:path';

export function assertPathInProject(projectDir: string, candidate: string): void {
  if (!isAbsolute(projectDir)) {
    throw new Error(`projectDir must be absolute, got: ${projectDir}`);
  }
  if (!isAbsolute(candidate)) {
    throw new Error(`path must be absolute, got: ${candidate}`);
  }
  const projAbs = resolve(projectDir);
  const candAbs = resolve(candidate);
  // Same path is fine.
  if (projAbs === candAbs) return;
  const rel = relative(projAbs, candAbs);
  // If `candidate` is inside `projAbs`, `relative` returns a path
  // that does NOT start with '..' and isn't absolute. Anything else
  // is out-of-scope (or on a different drive on Windows).
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `path '${candAbs}' is outside the project scope '${projAbs}' — dhee filesystem tools refuse paths outside the project directory.`,
    );
  }
}
