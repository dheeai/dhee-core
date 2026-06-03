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
 * Math, two cases:
 *   - NO resolution given → treat the bundle's LONG edge as the canvas
 *     size and derive the short edge from the aspect. Bundles authored
 *     for 16:9 at 1920x1080 produce 16:9→1920x1080, 9:16→1080x1920,
 *     21:9→1920x824.
 *   - resolution given → it is the SHORT edge (the universal "720p =
 *     720 tall" / "1080p = 1080 tall" convention). 16:9 @ 720 ⇒
 *     1280x720, 9:16 @ 720 ⇒ 720x1280, 21:9 @ 720 ⇒ 1680x720. The
 *     short edge is capped at the node's baseline short edge, and the
 *     long edge is clamped at the baseline long edge — so a node can't
 *     be pushed past the resolution it was tuned/able to render (an LTX
 *     node baselined at 854x480 stays ≤480 short even if the user picks
 *     1080p; raise its baseline in the bundle to allow more).
 *
 * Edges are rounded to the nearest multiple of 8 because most ComfyUI
 * workflows reject non-aligned dims (latent space stride).
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
 * - resolution given → it is the SHORT edge target (720p ⇒ short edge
 *   720). The short edge is capped at the baseline's short edge, and
 *   the resulting long edge is clamped at the baseline's long edge, so
 *   a node is never pushed past what it was tuned to render.
 * - resolution absent → the long edge is the baseline's long edge and
 *   the short edge is derived from the aspect (back-compat).
 *
 * Capping matters because video runners like LTX-2 have model-level
 * caps; a user picking "1080p" can't push a 854x480-baseline LTX node
 * above 480 short. Raise the node's baseline in the bundle to allow a
 * higher ceiling.
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
  const baseShort = Math.min(width, height);
  const targetRatio = ASPECT_RATIOS[aspect];
  // Long-edge : short-edge ratio for this aspect (orientation-agnostic).
  const longPerShort = targetRatio >= 1 ? targetRatio : 1 / targetRatio;
  const isPortrait = targetRatio < 1;

  if (typeof resolution === 'number' && resolution > 0) {
    // SHORT-EDGE semantics: "720p" ⇒ the short edge is 720.
    let shortEdge = Math.min(resolution, baseShort); // never exceed the node's max short edge
    let longEdge = roundToMultiple(shortEdge * longPerShort, ALIGN);
    if (longEdge > baseLong) {
      // The aspect would push the long edge past the node's ceiling
      // (e.g. ultrawide) — clamp the long edge and back off the short.
      longEdge = baseLong;
      shortEdge = roundToMultiple(baseLong / longPerShort, ALIGN);
    } else {
      shortEdge = roundToMultiple(shortEdge, ALIGN);
    }
    return isPortrait ? { width: shortEdge, height: longEdge } : { width: longEdge, height: shortEdge };
  }

  // No resolution → keep the baseline's long edge, derive the short.
  const longEdge = baseLong;
  const shortEdge = roundToMultiple(longEdge / longPerShort, ALIGN);
  return isPortrait ? { width: shortEdge, height: longEdge } : { width: longEdge, height: shortEdge };
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
