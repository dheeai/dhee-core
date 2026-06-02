/**
 * preserveAsVersion — TDD coverage.
 *
 * The "non-destructive overwrite" primitive: before a regen / user-write
 * overwrites an artifact at its canonical path, rename the existing
 * file to `<base>.v<N>.<ext>`. The walker, regenerate, and write tools
 * all route their pre-overwrite step through here.
 *
 * Failure modes:
 *   1. Target file missing → returns null, nothing renamed.
 *   2. First preservation → renames to <base>.v1.<ext>; returns the
 *      new absolute path.
 *   3. .v1 already exists → next version is .v2.
 *   4. Gaps in the version sequence (.v1, .v3 present) → uses MAX + 1
 *      so we never collide with an existing .vN.
 *   5. No file extension → suffix is `.v<N>` (no extra dot).
 *   6. Multi-dot filename (a.b.png) → only the LAST dot is the
 *      extension boundary: result is `a.b.v1.png`.
 *   7. Hidden files (e.g. `.foo`) preserve the leading dot:
 *      `.foo` → `.foo.v1` (no extension).
 *   8. Returns the new path as absolute, not relative.
 *   9. Original file is gone after preserve (renamed, not copied).
 *  10. Cwd-style relative path argument still works (resolved via
 *      caller; tool itself takes absolute).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { preserveAsVersion } from '../../src/dag/preserveAsVersion.js';

describe('preserveAsVersion', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });
  function tmp(): string {
    const d = mkdtempSync(join(tmpdir(), 'pav-test-'));
    dirs.push(d);
    return d;
  }

  it('1. missing file → returns null', () => {
    const dir = tmp();
    expect(preserveAsVersion(join(dir, 'no_such.png'))).toBeNull();
  });

  it('2. first preservation → .v1.<ext>', () => {
    const dir = tmp();
    const orig = join(dir, 'plot.md');
    writeFileSync(orig, 'old plot');
    const r = preserveAsVersion(orig);
    expect(r).toBe(join(dir, 'plot.v1.md'));
    expect(readFileSync(r!, 'utf8')).toBe('old plot');
    expect(existsSync(orig)).toBe(false);
  });

  it('3. .v1 exists → next is .v2', () => {
    const dir = tmp();
    const orig = join(dir, 'plot.md');
    writeFileSync(orig, 'v1');
    preserveAsVersion(orig);
    writeFileSync(orig, 'v2');
    const r = preserveAsVersion(orig);
    expect(r).toBe(join(dir, 'plot.v2.md'));
    expect(readFileSync(r!, 'utf8')).toBe('v2');
  });

  it('4. gap in version sequence → MAX + 1', () => {
    const dir = tmp();
    const orig = join(dir, 'plot.md');
    writeFileSync(orig, 'current');
    writeFileSync(join(dir, 'plot.v1.md'), 'one');
    writeFileSync(join(dir, 'plot.v3.md'), 'three');
    // .v2 is missing; preserve picks 4 (max+1), not 2.
    const r = preserveAsVersion(orig);
    expect(r).toBe(join(dir, 'plot.v4.md'));
  });

  it('5. no extension → suffix is .v<N>', () => {
    const dir = tmp();
    const orig = join(dir, 'README');
    writeFileSync(orig, 'x');
    const r = preserveAsVersion(orig);
    expect(r).toBe(join(dir, 'README.v1'));
  });

  it('6. multi-dot filename → only last dot is extension boundary', () => {
    const dir = tmp();
    const orig = join(dir, 'a.b.png');
    writeFileSync(orig, 'x');
    const r = preserveAsVersion(orig);
    expect(r).toBe(join(dir, 'a.b.v1.png'));
  });

  it('7. hidden file → no extension', () => {
    const dir = tmp();
    const orig = join(dir, '.foo');
    writeFileSync(orig, 'x');
    const r = preserveAsVersion(orig);
    expect(r).toBe(join(dir, '.foo.v1'));
  });

  it('8. returns absolute path', () => {
    const dir = tmp();
    const orig = join(dir, 'a.txt');
    writeFileSync(orig, 'x');
    const r = preserveAsVersion(orig);
    expect(isAbsolute(r!)).toBe(true);
  });

  it('9. original file is gone after preserve (renamed, not copied)', () => {
    const dir = tmp();
    const orig = join(dir, 'plot.md');
    writeFileSync(orig, 'x');
    preserveAsVersion(orig);
    expect(existsSync(orig)).toBe(false);
  });

  it('10. version count returned correctly', () => {
    const dir = tmp();
    const orig = join(dir, 'final.mp4');
    writeFileSync(orig, 'v1bytes');
    expect(preserveAsVersion(orig)).toBe(join(dir, 'final.v1.mp4'));
    writeFileSync(orig, 'v2bytes');
    expect(preserveAsVersion(orig)).toBe(join(dir, 'final.v2.mp4'));
    writeFileSync(orig, 'v3bytes');
    expect(preserveAsVersion(orig)).toBe(join(dir, 'final.v3.mp4'));
    // All three versioned files survive.
    expect(readFileSync(join(dir, 'final.v1.mp4'), 'utf8')).toBe('v1bytes');
    expect(readFileSync(join(dir, 'final.v2.mp4'), 'utf8')).toBe('v2bytes');
    expect(readFileSync(join(dir, 'final.v3.mp4'), 'utf8')).toBe('v3bytes');
  });
});
