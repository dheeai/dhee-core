/**
 * resolutionStaleness — decide whether an already-rendered artifact's
 * dimensions still match the project's target aspect+resolution, and a
 * tiny dependency-free PNG dimension reader to get the actual dims.
 *
 * Motivation (BUG-028): the agent, asked to take a project to 720p, only
 * re-ran the video and left the images at their old size (720×408 from
 * before the aspect-semantics fix) because "completed" looked fine. It
 * had no signal the images were stale. This gives it one: compare the
 * artifact's real dimensions against what the target resolution would
 * produce.
 *
 * Failure modes:
 *   1. Exact match → not stale.
 *   2. Old long-edge "720p" (720×408) vs true 720p (1280×720) → stale.
 *   3. LTX node rounding (704×1280 vs 720×1280) → within tolerance, NOT stale.
 *   4. Orientation flip (landscape vs portrait at same res) → stale.
 *   5. Small (<5%) short-edge drift → not stale.
 *   6. Square expected (aspect-agnostic refs) → never stale.
 *   7. readPngDims parses a real PNG IHDR header.
 *   8. readPngDims returns null for a non-PNG file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isResolutionStale, readPngDims } from '../../src/dag/resolutionStaleness.js';

describe('isResolutionStale', () => {
  it('1. exact match → not stale', () => {
    expect(isResolutionStale({ width: 1280, height: 720 }, { width: 1280, height: 720 })).toBe(false);
  });

  it('2. old long-edge 720×408 vs true 720p 1280×720 → stale', () => {
    expect(isResolutionStale({ width: 1280, height: 720 }, { width: 720, height: 408 })).toBe(true);
  });

  it('3. LTX node rounding 704×1280 vs 720×1280 → within tolerance, NOT stale', () => {
    expect(isResolutionStale({ width: 720, height: 1280 }, { width: 704, height: 1280 })).toBe(false);
  });

  it('4. orientation flip (1280×720 landscape vs 720×1280 portrait) → stale', () => {
    expect(isResolutionStale({ width: 1280, height: 720 }, { width: 720, height: 1280 })).toBe(true);
  });

  it('5. small short-edge drift (<5%) → not stale', () => {
    // expected short 720, actual short 712 → diff 8, under tolerance.
    expect(isResolutionStale({ width: 1280, height: 720 }, { width: 1280, height: 712 })).toBe(false);
  });

  it('6. square expected (aspect-agnostic ref) → never stale', () => {
    expect(isResolutionStale({ width: 1024, height: 1024 }, { width: 1024, height: 1024 })).toBe(false);
    // even a portrait actual against a square expected isn't "resolution stale"
    expect(isResolutionStale({ width: 1024, height: 1024 }, { width: 768, height: 1024 })).toBe(false);
  });
});

describe('readPngDims', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pngdims-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writePng(path: string, width: number, height: number): void {
    // 8-byte signature + IHDR chunk (length, 'IHDR', width BE, height BE, …)
    const buf = Buffer.alloc(33);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buf, 0);
    buf.writeUInt32BE(13, 8); // IHDR data length
    buf.write('IHDR', 12, 'ascii');
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
    writeFileSync(path, buf);
  }

  it('7. parses a real PNG IHDR header', () => {
    const p = join(dir, 'shot.png');
    writePng(p, 1280, 720);
    expect(readPngDims(p)).toEqual({ width: 1280, height: 720 });
  });

  it('7b. parses portrait dims', () => {
    const p = join(dir, 'shot9x16.png');
    writePng(p, 720, 1280);
    expect(readPngDims(p)).toEqual({ width: 720, height: 1280 });
  });

  it('8. returns null for a non-PNG file', () => {
    const p = join(dir, 'notapng.png');
    writeFileSync(p, 'this is not a png');
    expect(readPngDims(p)).toBeNull();
  });

  it('8b. returns null for a missing file', () => {
    expect(readPngDims(join(dir, 'nope.png'))).toBeNull();
  });
});
