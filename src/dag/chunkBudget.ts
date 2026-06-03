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

/** Default VRAM the bundle budgets are measured against — 12 GiB (RTX 3060). */
const DEFAULT_REFERENCE_VRAM_BYTES = 12 * 1024 ** 3;

/**
 * Scale a px·frame budget by the actual GPU's VRAM relative to the VRAM
 * the budget was measured on. A budget tuned at 12 GiB doubles on a
 * 24 GiB card (longer chunks, fewer relay seams) and shrinks on an 8 GiB
 * card (still fits). The scaling is proportional to total VRAM — a
 * deliberate simplification: model weights take a fixed slab and only
 * the latent scales, so this is slightly conservative on big cards (it
 * under-counts the headroom freed once weights are resident), which is
 * the safe direction. `gpuVramBytes` null/0 (probe failed, cloud,
 * headless) → budget unchanged. See BUG-026.
 */
export function scaleBudgetForGpu(
  budget: number,
  gpuVramBytes: number | null | undefined,
  referenceVramBytes?: number,
): number {
  if (typeof gpuVramBytes !== 'number' || gpuVramBytes <= 0) return budget;
  const ref =
    typeof referenceVramBytes === 'number' && referenceVramBytes > 0
      ? referenceVramBytes
      : DEFAULT_REFERENCE_VRAM_BYTES;
  return Math.max(1, Math.floor((budget * gpuVramBytes) / ref));
}

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
