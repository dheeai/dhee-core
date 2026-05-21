/**
 * Atomic file writes via temp-file-and-rename.
 *
 * `writeFileSync(path, data)` is not crash-safe: if the process dies
 * mid-write (power loss, SIGKILL, OOM, etc.) the destination file is
 * left truncated, and any reader that opens it on next launch sees
 * garbage. For project.json, prompt JSON, asset manifests, and other
 * load-bearing state files, that's a data-corruption bug — a partial
 * project.json silently breaks the next session, and the user has no
 * way back.
 *
 * `atomicWriteFileSync` writes to a sibling `.tmp.<rand>` file, then
 * renames it over the destination. `rename(2)` is atomic on a single
 * filesystem on POSIX and on NTFS-via-MoveFileEx on Windows, so a
 * reader at any moment sees either the OLD complete file or the NEW
 * complete file — never a half-written one.
 *
 * Caveats:
 *   - Atomicity is only guaranteed within a single filesystem (same
 *     mount). For typical kshana use (writes to the project folder,
 *     never crossing mounts) this holds.
 *   - We don't fsync — that's a performance trade. A power loss
 *     between rename + fsync could lose the new write but won't
 *     corrupt the file. Acceptable for our use cases.
 *
 * Use it for: project.json, prompt JSON files, asset manifests, scene
 * summaries / durations, anything where partial state is worse than
 * no state.
 *
 * Don't bother for: append-only logs (truncation is fine, file
 * remains parseable line-by-line), lock files (single-byte writes),
 * intermediate downloads (re-fetchable).
 */
import { writeFileSync, renameSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

/** Suffix used for the sibling temp file. Random so concurrent writers don't collide. */
function tempPath(target: string): string {
  const dir = dirname(target);
  const base = basename(target);
  const rand = Math.random().toString(36).slice(2, 10);
  return join(dir, `.${base}.tmp.${rand}`);
}

/**
 * Atomically write `data` to `target`. On error, the target file is
 * left untouched. The temp file is best-effort-cleaned-up.
 *
 * Honors the same overloads as `writeFileSync(path, data, options?)`.
 */
export function atomicWriteFileSync(
  target: string,
  data: string | Uint8Array,
  options?: Parameters<typeof writeFileSync>[2],
): void {
  const tmp = tempPath(target);
  try {
    if (options !== undefined) {
      writeFileSync(tmp, data, options);
    } else {
      writeFileSync(tmp, data);
    }
    renameSync(tmp, target);
  } catch (err) {
    // Clean up the orphan temp file if rename failed mid-flight.
    // Don't shadow the original error if cleanup also fails.
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}
