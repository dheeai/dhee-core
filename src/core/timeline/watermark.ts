/**
 * Watermark helpers extracted from the deleted FFmpegAssembler.
 * Only consumer in tree: dag/runners/ffmpegConcat.ts (the bundle's
 * concat-and-watermark runner).
 */
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WATERMARK_PNG_CANDIDATES: readonly string[] = [
  'assets/watermark_dhee.png',
  'assets/watermark_dhee_studio.png',
  'assets/watermark.png',
];

const CURRENT_DIR =
  typeof __dirname === 'string'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));

function findKshanaCoreRootFromSource(): string | null {
  let dir = CURRENT_DIR;
  for (let i = 0; i < 8; i += 1) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * In a packaged Electron app the resolved path lands inside `app.asar`
 * (Node's patched `fs` sees through the archive, so `existsSync` returns
 * true). But the watermark is consumed by the EXTERNAL ffmpeg binary via
 * `-i`, and ffmpeg has no idea what an asar is — it would try to open the
 * literal `app.asar/…/watermark.png` and fail. dhee-core is shipped in the
 * desktop's `asarUnpack` list, so the real bytes live at the
 * `app.asar.unpacked` sibling. Rewrite to that path — same trick ffmpegBin()
 * applies to the installer binaries. Guard against double-rewrite.
 */
function toUnpackedPath(p: string): string {
  if (p.includes('app.asar') && !p.includes('app.asar.unpacked')) {
    return p.replace('app.asar', 'app.asar.unpacked');
  }
  return p;
}

export function resolveWatermarkPath(cwd: string = process.cwd()): string | null {
  for (const rel of WATERMARK_PNG_CANDIDATES) {
    const abs = join(cwd, rel);
    if (existsSync(abs)) return toUnpackedPath(abs);
  }
  const repoRoot = findKshanaCoreRootFromSource();
  if (repoRoot) {
    for (const rel of WATERMARK_PNG_CANDIDATES) {
      const abs = resolve(repoRoot, rel);
      if (existsSync(abs)) return toUnpackedPath(abs);
    }
  }
  return null;
}

/** Default watermark opacity — slightly translucent so it reads as a mark, not a banner. */
export const DEFAULT_WATERMARK_OPACITY = 0.8;

export function buildWatermarkOverlayFilter(
  inputLabel: string,
  watermarkInputIdx: number,
  outputLabel: string,
  outputHeight: number = 720,
  opacity: number = DEFAULT_WATERMARK_OPACITY,
): string {
  const watermarkHeightPx = Math.max(16, Math.round(outputHeight * 0.0903));
  const clamped = Math.min(1, Math.max(0, opacity));
  // Scale the watermark's alpha channel to apply opacity. Skip the mixer
  // at full opacity so the filtergraph stays minimal.
  const alpha = clamped < 1 ? `colorchannelmixer=aa=${clamped},` : '';
  return (
    `[${watermarkInputIdx}:v]format=rgba,${alpha}` +
      `scale=-1:${watermarkHeightPx}:flags=lanczos[wm];` +
    `[${inputLabel}][wm]overlay=x=W-w-24:y=H-h-24:format=auto[${outputLabel}]`
  );
}
