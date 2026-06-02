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
 * Apply an aspect-ratio + resolution transform to a baseline
 * width/height pair.
 *
 * - Unknown / undefined aspect → returns the input unchanged.
 * - Square input (w === h) → returns the input unchanged.
 * - Otherwise: the long-edge of the output is min(userResolution,
 *   bundleBaseline). The short edge is derived from the aspect ratio
 *   and rounded to the nearest multiple of 8.
 *
 * Capping to the bundle's baseline matters because video runners like
 * LTX-2 have hard model-level caps; a user picking "4K" can't push a
 * 854px-baseline LTX node above 854. For image runners with higher
 * baselines (Klein at 1920) the user's lower picks (720p/1080p) work
 * unconstrained.
 */
export function applyAspect(
  aspect: string | undefined,
  width: number,
  height: number,
  resolution?: number,
): { width: number; height: number } {
  if (!isSupportedAspect(aspect)) return { width, height };
  if (width === height) return { width, height };
  const baseLong = Math.max(width, height);
  const longEdge =
    typeof resolution === 'number' && resolution > 0
      ? Math.min(resolution, baseLong)
      : baseLong;
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
 * Apply aspect (+ optional resolution cap) to a runner config in
 * place. Only touches the config if both `width` and `height` are
 * numbers; otherwise it's a no-op. The walker calls this once per
 * node, right before constructing the RunnerContext.
 */
export function applyAspectToConfig(
  config: Record<string, unknown>,
  aspect: string | undefined,
  resolution?: number,
): void {
  const w = config['width'];
  const h = config['height'];
  if (typeof w !== 'number' || typeof h !== 'number') return;
  const out = applyAspect(aspect, w, h, resolution);
  config['width'] = out.width;
  config['height'] = out.height;
}
