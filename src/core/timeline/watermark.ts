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

export function resolveWatermarkPath(cwd: string = process.cwd()): string | null {
  for (const rel of WATERMARK_PNG_CANDIDATES) {
    const abs = join(cwd, rel);
    if (existsSync(abs)) return abs;
  }
  const repoRoot = findKshanaCoreRootFromSource();
  if (repoRoot) {
    for (const rel of WATERMARK_PNG_CANDIDATES) {
      const abs = resolve(repoRoot, rel);
      if (existsSync(abs)) return abs;
    }
  }
  return null;
}

export function buildWatermarkOverlayFilter(
  inputLabel: string,
  watermarkInputIdx: number,
  outputLabel: string,
  outputHeight: number = 720,
): string {
  const watermarkHeightPx = Math.max(16, Math.round(outputHeight * 0.0903));
  return (
    `[${watermarkInputIdx}:v]format=rgba,` +
      `scale=-1:${watermarkHeightPx}:flags=lanczos[wm];` +
    `[${inputLabel}][wm]overlay=x=W-w-24:y=H-h-24:format=auto[${outputLabel}]`
  );
}
