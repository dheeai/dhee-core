/**
 * Aspect — pure dimension transformer applied by the walker before
 * each runner receives its config. Lets the user pick "9:16" once on
 * the Production Slate and have it flow through every comfy/ltx node
 * downstream without each runner having to know about aspect.
 *
 * Contract:
 *   - The bundle's bundle.json declares baseline width/height per
 *     node (typically tuned for 16:9 — the historical default).
 *   - At walk time, the walker calls `applyAspect(projectAspect, w, h)`
 *     and substitutes the returned pair into the runner's config.
 *   - Square dimensions (w === h) are returned unchanged — character
 *     reference images are aspect-agnostic.
 *
 * Math: we treat the LONG edge of the input as the canvas size and
 * compute the short edge from the target aspect ratio. So bundles
 * authored for 16:9 at 1920x1080 produce:
 *     16:9 → 1920x1080
 *     9:16 → 1080x1920  (swap)
 *     21:9 → 1920x824   (wider; keep long edge, shrink short)
 *
 * Short edge is rounded to the nearest multiple of 8 because most
 * ComfyUI workflows reject non-aligned dims (latent space stride).
 */

export const SUPPORTED_ASPECTS = ['16:9', '9:16', '21:9', '1:1'] as const;
export type SupportedAspect = (typeof SUPPORTED_ASPECTS)[number];

const ASPECT_RATIOS: Record<SupportedAspect, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '21:9': 21 / 9,
  '1:1': 1,
};

const ALIGN = 8;

function roundToMultiple(n: number, mult: number): number {
  return Math.max(mult, Math.round(n / mult) * mult);
}

export function isSupportedAspect(aspect: string | undefined): aspect is SupportedAspect {
  return typeof aspect === 'string' && (SUPPORTED_ASPECTS as readonly string[]).includes(aspect);
}

/**
 * Apply an aspect-ratio transform to a baseline width/height pair.
 *
 * - Unknown / undefined aspect → returns the input unchanged.
 * - Square input (w === h) → returns the input unchanged.
 * - Otherwise: uses the input's longer edge as the canvas size and
 *   recomputes the short edge from the target ratio. Short edge is
 *   rounded to the nearest multiple of 8.
 */
export function applyAspect(
  aspect: string | undefined,
  width: number,
  height: number,
): { width: number; height: number } {
  if (!isSupportedAspect(aspect)) return { width, height };
  if (width === height) return { width, height };
  const longEdge = Math.max(width, height);
  const targetRatio = ASPECT_RATIOS[aspect];
  // Portrait ratios produce a tall canvas (height > width).
  if (targetRatio < 1) {
    const shortEdge = roundToMultiple(longEdge * targetRatio, ALIGN);
    return { width: shortEdge, height: longEdge };
  }
  // Landscape (≥ 1).
  const shortEdge = roundToMultiple(longEdge / targetRatio, ALIGN);
  return { width: longEdge, height: shortEdge };
}

/**
 * Apply aspect to a runner config in place. Only touches the config
 * if both `width` and `height` are numbers; otherwise it's a no-op.
 * The walker calls this once per node, right before constructing the
 * RunnerContext.
 */
export function applyAspectToConfig(
  config: Record<string, unknown>,
  aspect: string | undefined,
): void {
  const w = config['width'];
  const h = config['height'];
  if (typeof w !== 'number' || typeof h !== 'number') return;
  const out = applyAspect(aspect, w, h);
  config['width'] = out.width;
  config['height'] = out.height;
}
