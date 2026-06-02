/**
 * applyAspect — pure dimension transformer for bundle runner configs.
 *
 * Failure modes:
 *   1. Unknown aspect → returns input unchanged.
 *   2. Undefined aspect → returns input unchanged.
 *   3. Square input → returns unchanged regardless of aspect.
 *   4. 16:9 → 9:16 (HD) swaps to portrait: 1920x1080 → 1080x1920.
 *   5. 9:16 → 16:9 (HD): 1080x1920 → 1920x1080.
 *   6. 16:9 → 21:9: keeps long edge, shrinks short to nearest 8.
 *   7. 1:1 from a rectangle: produces a square sized to the long edge.
 *   8. LTX-shape dims (854x480) swap correctly to 480x854 on 9:16.
 *   9. applyAspectToConfig rewrites width+height in place.
 *  10. applyAspectToConfig leaves config untouched if width/height
 *      not present or not numbers.
 */
import { describe, it, expect } from 'vitest';
import { applyAspect, applyAspectToConfig } from '../../src/dag/aspect.js';

describe('applyAspect', () => {
  it('1. unknown aspect returns input unchanged', () => {
    expect(applyAspect('17:11', 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it('2. undefined aspect returns input unchanged', () => {
    expect(applyAspect(undefined, 1920, 1080)).toEqual({ width: 1920, height: 1080 });
  });

  it('3. square input stays square regardless of aspect', () => {
    expect(applyAspect('9:16', 1024, 1024)).toEqual({ width: 1024, height: 1024 });
    expect(applyAspect('21:9', 1024, 1024)).toEqual({ width: 1024, height: 1024 });
    expect(applyAspect('16:9', 1024, 1024)).toEqual({ width: 1024, height: 1024 });
  });

  it('4. 1920x1080 with 9:16 → 1080x1920 (portrait swap)', () => {
    expect(applyAspect('9:16', 1920, 1080)).toEqual({ width: 1080, height: 1920 });
  });

  it('5. 1080x1920 with 16:9 → 1920x1080 (landscape swap)', () => {
    expect(applyAspect('16:9', 1080, 1920)).toEqual({ width: 1920, height: 1080 });
  });

  it('6. 1920x1080 with 21:9 keeps long edge, shrinks short to 824 (mult of 8)', () => {
    // 1920 * 9 / 21 = 822.857... rounds to 824 (nearest mult of 8).
    expect(applyAspect('21:9', 1920, 1080)).toEqual({ width: 1920, height: 824 });
  });

  it('7. 1920x1080 with 1:1 → square at long edge (1920x1920)', () => {
    expect(applyAspect('1:1', 1920, 1080)).toEqual({ width: 1920, height: 1920 });
  });

  it('8. LTX-shape 854x480 with 9:16 → 480x854', () => {
    expect(applyAspect('9:16', 854, 480)).toEqual({ width: 480, height: 854 });
  });

  it('8b. LTX-shape 854x480 with 16:9 → unchanged', () => {
    expect(applyAspect('16:9', 854, 480)).toEqual({ width: 854, height: 480 });
  });

  it('9. applyAspectToConfig rewrites width+height in place', () => {
    const cfg: Record<string, unknown> = {
      workflowPath: 'foo.json',
      width: 1920,
      height: 1080,
    };
    applyAspectToConfig(cfg, '9:16');
    expect(cfg['width']).toBe(1080);
    expect(cfg['height']).toBe(1920);
    expect(cfg['workflowPath']).toBe('foo.json');
  });

  it('10a. applyAspectToConfig no-op when width missing', () => {
    const cfg: Record<string, unknown> = { workflowPath: 'foo.json' };
    applyAspectToConfig(cfg, '9:16');
    expect(cfg).toEqual({ workflowPath: 'foo.json' });
  });

  it('10b. applyAspectToConfig no-op when width is a string', () => {
    const cfg: Record<string, unknown> = { width: 'auto', height: 1080 };
    applyAspectToConfig(cfg, '9:16');
    expect(cfg['width']).toBe('auto');
    expect(cfg['height']).toBe(1080);
  });

  it('10c. applyAspectToConfig no-op when aspect is unknown', () => {
    const cfg: Record<string, unknown> = { width: 1920, height: 1080 };
    applyAspectToConfig(cfg, undefined);
    expect(cfg['width']).toBe(1920);
    expect(cfg['height']).toBe(1080);
  });

  // ── Resolution overrides the long edge ─────────────────────────────

  it('11. 16:9 + resolution=720 shrinks 1920x1080 to 720x408', () => {
    // 720 * 9 / 16 = 405 → rounds to 408
    expect(applyAspect('16:9', 1920, 1080, 720)).toEqual({ width: 720, height: 408 });
  });

  it('12. 9:16 + resolution=720 → 408x720 (portrait at 720p long edge)', () => {
    expect(applyAspect('9:16', 1920, 1080, 720)).toEqual({ width: 408, height: 720 });
  });

  it('13. resolution caps at bundle baseline (no upscale)', () => {
    // bundle says 1920 max → user picks 4K (2160), should NOT exceed bundle baseline
    expect(applyAspect('16:9', 1920, 1080, 2160)).toEqual({ width: 1920, height: 1080 });
  });

  it('14. LTX-shape 854x480 + resolution=720 → 720x408 (capped to 720)', () => {
    expect(applyAspect('16:9', 854, 480, 720)).toEqual({ width: 720, height: 408 });
  });

  it('15. LTX-shape 854x480 + resolution=1080 → 854x480 (capped to bundle baseline)', () => {
    expect(applyAspect('16:9', 854, 480, 1080)).toEqual({ width: 854, height: 480 });
  });

  it('16. resolution=0 or negative is ignored (treated as undefined)', () => {
    expect(applyAspect('16:9', 1920, 1080, 0)).toEqual({ width: 1920, height: 1080 });
    expect(applyAspect('16:9', 1920, 1080, -5)).toEqual({ width: 1920, height: 1080 });
  });

  it('17. applyAspectToConfig threads resolution through', () => {
    const cfg: Record<string, unknown> = { width: 1920, height: 1080 };
    applyAspectToConfig(cfg, '9:16', 720);
    expect(cfg['width']).toBe(408);
    expect(cfg['height']).toBe(720);
  });

  it('18. square inputs ignore resolution', () => {
    expect(applyAspect('9:16', 1024, 1024, 720)).toEqual({ width: 1024, height: 1024 });
  });
});
