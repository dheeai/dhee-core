/**
 * Watermark resolution + overlay sizing — behavioral.
 *
 * Regression guard: commit d6f11bd ("full legacy deletion") renamed the
 * lookup constant to `watermark_dhee_studio.png` while the real shipped
 * asset stayed `watermark_dhee.png`. resolveWatermarkPath() then returned
 * null and EVERY assembled final video shipped un-branded — silently,
 * with only a log WARNING. These tests exercise the resolver and the
 * overlay-filter builder directly, so they fail the moment the candidate
 * list drifts away from the real asset again.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveWatermarkPath,
  buildWatermarkOverlayFilter,
} from '../../../src/core/timeline/watermark.js';

describe('resolveWatermarkPath', () => {
  it('finds the real branded asset shipped in the repo (the d6f11bd filename-drift regression)', () => {
    const resolved = resolveWatermarkPath();
    expect(resolved).not.toBeNull();
    // The whole bug was that this returned null; assert the file is real.
    expect(existsSync(resolved!)).toBe(true);
    expect(resolved!.endsWith('.png')).toBe(true);
  });

  it('prefers a watermark asset in the supplied cwd over the repo fallback', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-cwd-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    const local = join(dir, 'assets', 'watermark.png');
    writeFileSync(local, 'stub'); // existsSync only — contents are irrelevant
    expect(resolveWatermarkPath(dir)).toBe(local);
  });

  it('falls back to the repo asset when the cwd has no watermark', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-empty-'));
    const resolved = resolveWatermarkPath(dir);
    expect(resolved).not.toBeNull();
    expect(existsSync(resolved!)).toBe(true);
  });
});

describe('buildWatermarkOverlayFilter', () => {
  it('sizes the watermark to ~9% of output height and pins it bottom-right with a 24px inset', () => {
    const filter = buildWatermarkOverlayFilter('0:v', 1, 'outv', 720);
    expect(filter).toContain('scale=-1:65'); // round(720 * 0.0903) === 65
    expect(filter).toContain('overlay=x=W-w-24:y=H-h-24');
    expect(filter).toContain('[outv]');
  });

  it('clamps the watermark height to a 16px floor for tiny outputs', () => {
    const filter = buildWatermarkOverlayFilter('0:v', 1, 'outv', 100);
    expect(filter).toContain('scale=-1:16'); // round(100 * 0.0903)=9 -> max(16, …)
  });

  it('applies a default 0.8 alpha (translucent watermark) via colorchannelmixer', () => {
    const filter = buildWatermarkOverlayFilter('0:v', 1, 'outv', 720);
    expect(filter).toContain('colorchannelmixer=aa=0.8');
  });

  it('honors an explicit opacity argument', () => {
    expect(buildWatermarkOverlayFilter('0:v', 1, 'outv', 720, 0.5)).toContain('colorchannelmixer=aa=0.5');
  });

  it('omits the alpha mixer at full opacity (1.0) so the filtergraph stays minimal', () => {
    const filter = buildWatermarkOverlayFilter('0:v', 1, 'outv', 720, 1);
    expect(filter).not.toContain('colorchannelmixer');
  });

  it('clamps out-of-range opacity into [0,1]', () => {
    expect(buildWatermarkOverlayFilter('0:v', 1, 'outv', 720, 5)).not.toContain('colorchannelmixer'); // >1 → 1 → omitted
    expect(buildWatermarkOverlayFilter('0:v', 1, 'outv', 720, -2)).toContain('colorchannelmixer=aa=0'); // <0 → 0
  });
});
