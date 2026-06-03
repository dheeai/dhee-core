/**
 * resolutionStaleness — is an already-rendered artifact's size still
 * right for the project's target aspect+resolution?
 *
 * The walker derives every render's dimensions from
 * applyAspect(aspect, baseline, resolution) (see aspect.ts). A
 * `completed` artifact whose ACTUAL dimensions no longer match that
 * target is stale — it was rendered under a different resolution, a
 * different aspect, or (the case that bit us) before the aspect-edge
 * semantics changed, so "720p" used to mean long-edge 720 (720×408)
 * and now means short-edge 720 (1280×720). The agent needs this signal
 * because `completed` alone looks fine to it. See BUG-028.
 *
 * Compared on the SHORT edge + orientation, with tolerance, so that a
 * runner's own rounding (e.g. the LTX node snapping 720→704) is NOT
 * mistaken for staleness, but a real size mismatch (408 vs 720) is.
 */

import { openSync, readSync, closeSync } from 'node:fs';

interface Dims {
  width: number;
  height: number;
}

const DEFAULT_TOLERANCE_PX = 16;
const RELATIVE_TOLERANCE = 0.05;

/**
 * True when `actual` no longer matches the `expected` render size.
 *
 * - Square `expected` (aspect-agnostic reference images) is never
 *   considered stale on size — those don't track the project aspect.
 * - Orientation flip (expected landscape, actual portrait or vice
 *   versa) is always stale.
 * - Otherwise stale when the short edge differs by more than
 *   max(tolerancePx, 5% of the expected short edge) — absorbs a runner's
 *   alignment rounding (LTX 720→704) without missing a real mismatch.
 */
export function isResolutionStale(
  expected: Dims,
  actual: Dims,
  tolerancePx: number = DEFAULT_TOLERANCE_PX,
): boolean {
  if (expected.width === expected.height) return false; // square ref — aspect-agnostic
  const expPortrait = expected.height > expected.width;
  const actPortrait = actual.height > actual.width;
  if (expPortrait !== actPortrait) return true; // orientation changed
  const expShort = Math.min(expected.width, expected.height);
  const actShort = Math.min(actual.width, actual.height);
  const tol = Math.max(tolerancePx, expShort * RELATIVE_TOLERANCE);
  return Math.abs(actShort - expShort) > tol;
}

/**
 * Read a PNG's pixel dimensions from its IHDR header without any image
 * library. Returns null if the file is missing, unreadable, or not a
 * PNG (callers skip — "size unknown" is not "stale").
 *
 * PNG layout: 8-byte signature, then the first chunk is IHDR —
 *   bytes 8–11 : chunk length, 12–15 : "IHDR",
 *   16–19 : width  (uint32 BE), 20–23 : height (uint32 BE).
 */
export function readPngDims(absPath: string): Dims | null {
  let fd: number | undefined;
  try {
    fd = openSync(absPath, 'r');
    const buf = Buffer.alloc(24);
    const read = readSync(fd, buf, 0, 24, 0);
    if (read < 24) return null;
    const sigOk =
      buf[0] === 137 && buf[1] === 80 && buf[2] === 78 && buf[3] === 71;
    if (!sigOk) return null;
    if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    if (width <= 0 || height <= 0) return null;
    return { width, height };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}
