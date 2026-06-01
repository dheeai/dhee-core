/**
 * preserveAsVersion — rename an existing artifact at its canonical
 * path to a versioned sibling (`<base>.v<N>.<ext>`) BEFORE overwriting.
 *
 * Used as a pre-write step by:
 *   - invalidateNodes (regen flow): old artifact survives instead of
 *     getting `unlink`ed.
 *   - dhee_write_node_content (user override): the prior auto-rendered
 *     content moves aside before the user's bytes land at the canonical
 *     path.
 *
 * Versions accumulate alongside the canonical file:
 *   final_video.mp4         ← latest (always the "selected" version)
 *   final_video.v1.mp4      ← prior
 *   final_video.v2.mp4      ← prior-prior
 *
 * The canonical path stays canonical. Downstream consumers that read
 * the output by path see the latest without code changes. `dhee_list_
 * versions` reads the events log; `dhee_select_version` (when it grows
 * the file-swap step) will `cp <vN>` over the canonical to roll back.
 *
 * Version-number policy: MAX(existing) + 1, not COUNT + 1. If `.v1`
 * and `.v3` exist (e.g. because the user manually deleted `.v2`), the
 * next preservation becomes `.v4` — we never collide with an existing
 * versioned file.
 */
import { existsSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';

/**
 * If `absPath` exists, rename it to `<base>.v<N>.<ext>` where N is
 * one greater than the highest existing version number for the same
 * base. Returns the absolute path of the renamed (preserved) file.
 *
 * If `absPath` does not exist, returns null. (Caller treats this as
 * "nothing to preserve" — a fresh first-time write.)
 *
 * Hidden files and extension-less files are handled correctly:
 *   .foo        → .foo.v1
 *   README      → README.v1
 *   final.mp4   → final.v1.mp4
 *   a.b.png     → a.b.v1.png   (only the LAST dot is the boundary)
 */
export function preserveAsVersion(absPath: string): string | null {
  if (!isAbsolute(absPath)) {
    absPath = resolve(absPath);
  }
  if (!existsSync(absPath)) return null;

  const dir = dirname(absPath);
  const name = basename(absPath);

  // Extension boundary: the LAST dot, EXCEPT when the name starts with
  // a dot AND has no other dots (hidden file like `.foo` → no ext).
  let stem: string;
  let ext: string;
  const lastDot = name.lastIndexOf('.');
  if (lastDot <= 0) {
    // No extension (or hidden file with no other dots).
    stem = name;
    ext = '';
  } else {
    stem = name.slice(0, lastDot);
    ext = name.slice(lastDot); // includes the leading dot
  }

  // Find max version among siblings matching <stem>.v<N><ext>.
  const pattern = ext.length > 0
    ? new RegExp(`^${escapeRegex(stem)}\\.v(\\d+)${escapeRegex(ext)}$`)
    : new RegExp(`^${escapeRegex(stem)}\\.v(\\d+)$`);
  let maxN = 0;
  try {
    for (const entry of readdirSync(dir)) {
      const m = pattern.exec(entry);
      if (m) {
        const n = Number.parseInt(m[1]!, 10);
        if (Number.isFinite(n) && n > maxN) maxN = n;
      }
    }
  } catch {
    // Directory unreadable — fall through with maxN = 0.
  }

  const nextN = maxN + 1;
  const versionedName = ext.length > 0
    ? `${stem}.v${nextN}${ext}`
    : `${stem}.v${nextN}`;
  const versionedPath = resolve(dir, versionedName);
  renameSync(absPath, versionedPath);
  return versionedPath;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
