/**
 * chunkBudget — scale the per-chunk frame cap by render resolution.
 *
 * LTX-2 video chunks are sampled as a single latent of
 * (frames × width × height). The bundle's `chunkBy.limit` is the
 * AUDIO-LATENT model cap — a frame count (~1000) that is independent of
 * resolution. But VRAM is bounded by the latent VOLUME, which grows with
 * resolution: a 1000-frame chunk that fits comfortably at 854×480 OOMs
 * the sampler at 1280×720 (2.25× the pixels per frame).
 *
 * `maxFramePixels` expresses the GPU's safe latent volume as a maximum
 * (frames × pixels) product. It is measured once at the proven baseline
 * (1000 frames × 854 × 480 = 409,920,000) and lives on the bundle's
 * `chunkBy`. The effective per-chunk frame cap is then
 *
 *     min(limit, floor(maxFramePixels / renderArea))
 *
 * aligned down to the LTX 8-frame latent stride. So higher resolutions
 * automatically produce shorter chunks that still fit in GPU memory,
 * while the audio-latent model cap (`limit`) stays the ceiling at low
 * resolutions. When `maxFramePixels` is absent the cap is `limit`
 * unchanged (back-compat with bundles authored before this existed).
 */

const ALIGN = 8;

export function effectiveFrameCap(
  limit: number,
  renderWidth: number,
  renderHeight: number,
  maxFramePixels?: number,
): number {
  if (typeof maxFramePixels !== 'number' || maxFramePixels <= 0) return limit;
  const area = renderWidth * renderHeight;
  if (!Number.isFinite(area) || area <= 0) return limit;
  const vramCap = Math.floor(maxFramePixels / area);
  // Align down to the 8-frame latent stride; never below one stride.
  const aligned = Math.max(ALIGN, Math.floor(vramCap / ALIGN) * ALIGN);
  return Math.min(limit, aligned);
}
