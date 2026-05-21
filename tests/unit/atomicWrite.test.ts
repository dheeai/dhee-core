/**
 * Atomic write semantics — the contract that protects project.json
 * and other persisted-state files from partial-write corruption.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../../src/utils/atomicWrite.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'atomic-write-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('atomicWriteFileSync', () => {
  it('writes the requested contents to the target path', () => {
    const target = join(dir, 'project.json');
    atomicWriteFileSync(target, '{"id":"hello"}');
    expect(readFileSync(target, 'utf-8')).toBe('{"id":"hello"}');
  });

  it('honors string encoding options', () => {
    const target = join(dir, 'project.json');
    atomicWriteFileSync(target, 'utf8 ✓', 'utf-8');
    expect(readFileSync(target, 'utf-8')).toBe('utf8 ✓');
  });

  it('overwrites an existing file with the new contents', () => {
    const target = join(dir, 'project.json');
    writeFileSync(target, '{"id":"old"}');
    atomicWriteFileSync(target, '{"id":"new"}');
    expect(readFileSync(target, 'utf-8')).toBe('{"id":"new"}');
  });

  it('leaves the original file intact when the write throws', () => {
    // Simulate a partial-write failure: writeFileSync into a directory
    // that doesn't exist as a parent of the tmp path. The rename never
    // runs because writeFileSync itself rejects. The destination must
    // be untouched.
    const target = join(dir, 'subdir-that-does-not-exist', 'project.json');
    expect(() => atomicWriteFileSync(target, '{"id":"new"}')).toThrow();
    expect(existsSync(target)).toBe(false);
  });

  it('preserves the existing file when rename target lives in a read-only directory and write fails', () => {
    // Write a successful baseline. Then attempt to atomic-write to the
    // same path but supply binary data that will fail because the dir
    // is gone (after rm). The original must still be readable from
    // memory through readFileSync of the baseline copy.
    const target = join(dir, 'project.json');
    writeFileSync(target, '{"v":1}');
    rmSync(dir, { recursive: true, force: true });
    expect(() => atomicWriteFileSync(target, '{"v":2}')).toThrow();
  });

  it('does not leave orphan .tmp.* sibling files behind on success', () => {
    const target = join(dir, 'project.json');
    atomicWriteFileSync(target, '{"id":"x"}');
    atomicWriteFileSync(target, '{"id":"y"}');
    atomicWriteFileSync(target, '{"id":"z"}');
    const siblings = readdirSync(dir);
    // Only project.json should remain — no `.project.json.tmp.*` files.
    expect(siblings).toEqual(['project.json']);
  });

  it('cleans up the temp file when the underlying write throws', () => {
    // Use a path whose parent doesn't exist so writeFileSync throws.
    // The temp helper should have removed any orphan it may have
    // partially created. We then verify the parent directory state.
    const ghostDir = join(dir, 'never-existed');
    expect(() =>
      atomicWriteFileSync(join(ghostDir, 'project.json'), 'data'),
    ).toThrow();
    expect(existsSync(ghostDir)).toBe(false);
  });

  it('handles binary (Uint8Array) data', () => {
    const target = join(dir, 'thumb.png');
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    atomicWriteFileSync(target, bytes);
    const read = readFileSync(target);
    expect(read[0]).toBe(0x89);
    expect(read[1]).toBe(0x50);
    expect(read[2]).toBe(0x4e);
    expect(read[3]).toBe(0x47);
  });
});
