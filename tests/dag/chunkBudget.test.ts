/**
 * effectiveFrameCap — scale the per-chunk frame cap by render resolution.
 *
 * LTX-2 video chunks are sampled as a single latent of
 * (frames × width × height). The bundle's chunkBy.limit is the AUDIO-
 * LATENT model cap (a frame count, ~1000, resolution-independent). VRAM
 * is bounded by the latent VOLUME, which grows with resolution — so a
 * 1000-frame chunk that fits at 854×480 OOMs the sampler at 1280×720.
 *
 * maxFramePixels expresses the GPU's safe latent volume as a max
 * (frames × pixels) product, measured at the proven baseline
 * (1000 × 854 × 480 = 409,920,000). The effective per-chunk frame cap is
 * min(limit, floor(maxFramePixels / renderArea)) aligned down to 8.
 *
 * Failure modes:
 *   1. No budget → limit unchanged (back-compat).
 *   2. Zero / negative budget → limit unchanged.
 *   3. Proven baseline (854×480, budget, limit 1000) → 1000 (no change).
 *   4. 720p (1280×720) → ~440 (scaled down so it fits VRAM).
 *   5. Orientation-agnostic: 720×1280 == 1280×720.
 *   6. 1080p (1920×1080) → ~192 (even shorter).
 *   7. Result aligned down to a multiple of 8.
 *   8. Budget so large the cap would exceed limit → returns limit.
 *   9. Degenerate area (width 0) → limit unchanged.
 */
import { describe, it, expect } from 'vitest';
import { effectiveFrameCap, scaleBudgetForGpu } from '../../src/dag/chunkBudget.js';

// 1000 frames × 854 × 480 — the proven-safe latent volume at 480p.
const BUDGET = 409_920_000;
// 12 GiB — the GPU the BUDGET was measured on (RTX 3060).
const REF_VRAM = 12 * 1024 ** 3;

describe('effectiveFrameCap', () => {
  it('1. no budget → returns limit unchanged', () => {
    expect(effectiveFrameCap(1000, 1280, 720)).toBe(1000);
    expect(effectiveFrameCap(1000, 1280, 720, undefined)).toBe(1000);
  });

  it('2. zero / negative budget → returns limit unchanged', () => {
    expect(effectiveFrameCap(1000, 1280, 720, 0)).toBe(1000);
    expect(effectiveFrameCap(1000, 1280, 720, -5)).toBe(1000);
  });

  it('3. proven baseline 854x480 + budget → 1000 (no change)', () => {
    expect(effectiveFrameCap(1000, 854, 480, BUDGET)).toBe(1000);
  });

  it('4. 720p 1280x720 + budget → 440 (scaled down to fit VRAM)', () => {
    // 409,920,000 / 921,600 = 444.79 → floor 444 → align down 8 → 440.
    expect(effectiveFrameCap(1000, 1280, 720, BUDGET)).toBe(440);
  });

  it('5. orientation-agnostic: portrait 720x1280 == landscape 1280x720', () => {
    expect(effectiveFrameCap(1000, 720, 1280, BUDGET)).toBe(
      effectiveFrameCap(1000, 1280, 720, BUDGET),
    );
    expect(effectiveFrameCap(1000, 720, 1280, BUDGET)).toBe(440);
  });

  it('6. 1080p 1920x1080 + budget → 192 (even shorter chunks)', () => {
    // 409,920,000 / 2,073,600 = 197.68 → floor 197 → align down 8 → 192.
    expect(effectiveFrameCap(1000, 1920, 1080, BUDGET)).toBe(192);
  });

  it('7. result is always a multiple of 8 (LTX latent stride)', () => {
    for (const [w, h] of [[1280, 720], [1920, 1080], [960, 540], [854, 480]]) {
      expect(effectiveFrameCap(1000, w!, h!, BUDGET) % 8).toBe(0);
    }
  });

  it('8. budget large enough that the cap would exceed limit → returns limit', () => {
    // Tiny render area, huge budget: floor(budget/area) >> limit, so the
    // model frame cap (limit) stays the binding constraint.
    expect(effectiveFrameCap(1000, 256, 256, BUDGET)).toBe(1000);
  });

  it('9. degenerate area (zero width) → returns limit unchanged', () => {
    expect(effectiveFrameCap(1000, 0, 720, BUDGET)).toBe(1000);
  });

  it('10. never returns below 8 frames', () => {
    // Absurdly small budget would floor to 0; clamp at the 8-frame floor.
    expect(effectiveFrameCap(1000, 1920, 1080, 100)).toBe(8);
  });
});

describe('scaleBudgetForGpu', () => {
  it('1. unknown GPU (null/0) → budget unchanged', () => {
    expect(scaleBudgetForGpu(BUDGET, null, REF_VRAM)).toBe(BUDGET);
    expect(scaleBudgetForGpu(BUDGET, 0, REF_VRAM)).toBe(BUDGET);
    expect(scaleBudgetForGpu(BUDGET, undefined, REF_VRAM)).toBe(BUDGET);
  });

  it('2. same GPU as the reference → budget unchanged', () => {
    expect(scaleBudgetForGpu(BUDGET, REF_VRAM, REF_VRAM)).toBe(BUDGET);
  });

  it('3. 24 GiB GPU → budget ~doubles', () => {
    expect(scaleBudgetForGpu(BUDGET, 24 * 1024 ** 3, REF_VRAM)).toBe(BUDGET * 2);
  });

  it('4. 8 GiB GPU → budget shrinks proportionally', () => {
    // 8/12 = 0.666… → floor(409,920,000 × 8/12) = 273,280,000.
    expect(scaleBudgetForGpu(BUDGET, 8 * 1024 ** 3, REF_VRAM)).toBe(Math.floor((BUDGET * 8) / 12));
  });

  it('5. absent reference defaults to 12 GiB', () => {
    expect(scaleBudgetForGpu(BUDGET, 24 * 1024 ** 3, undefined)).toBe(
      scaleBudgetForGpu(BUDGET, 24 * 1024 ** 3, REF_VRAM),
    );
  });

  it('6. composes with effectiveFrameCap: 12 GiB → cap 440, 24 GiB → cap 888 @720p', () => {
    const at12 = scaleBudgetForGpu(BUDGET, 12 * 1024 ** 3, REF_VRAM);
    const at24 = scaleBudgetForGpu(BUDGET, 24 * 1024 ** 3, REF_VRAM);
    expect(effectiveFrameCap(1000, 1280, 720, at12)).toBe(440);
    expect(effectiveFrameCap(1000, 1280, 720, at24)).toBe(888);
  });

  it('7. this 3060 reports 11.999 GiB → 12 GiB reference keeps the cap at 440 (no drift)', () => {
    const actual3060 = 12_884_246_528; // measured via /system_stats
    const scaled = scaleBudgetForGpu(BUDGET, actual3060, REF_VRAM);
    expect(effectiveFrameCap(1000, 1280, 720, scaled)).toBe(440);
  });
});
