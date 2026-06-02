/**
 * GenerationCache — content-addressed store for runner outputs.
 *
 * Failure modes:
 *   1. get() on a never-put hash returns null.
 *   2. put() then get() round-trips bytes correctly.
 *   3. linkInto(destPath) copies/links the cached file to dest.
 *   4. Cache survives reopening the cache handle.
 *   5. CAS dir auto-creates on first put.
 *   6. Two different runners with same inputs key independently
 *      (the tool name is part of the key).
 *   7. ext is preserved (image hits return .png, md hits return .md).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openGenerationCache } from '../../../src/dag/cas/GenerationCache.js';

let cacheRoot: string;
let workDir: string;

beforeEach(() => {
  cacheRoot = mkdtempSync(join(tmpdir(), 'cas-root-'));
  workDir = mkdtempSync(join(tmpdir(), 'cas-work-'));
});

afterEach(() => {
  rmSync(cacheRoot, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

describe('GenerationCache', () => {
  it('get on miss returns null', () => {
    const cache = openGenerationCache({ cacheRoot });
    expect(cache.get({ tool: 'x', toolVersion: '1', inputs: {}, config: {} })).toBeNull();
  });

  it('put then get round-trips', () => {
    const cache = openGenerationCache({ cacheRoot });
    const src = join(workDir, 'src.md');
    writeFileSync(src, 'hello cache');
    const entry = cache.put({
      key: { tool: 'llm.generate', toolVersion: '1', inputs: { story: 'x' }, config: {} },
      sourcePath: src,
      ext: 'md',
      metadata: { cost: 0.01 },
    });
    expect(existsSync(entry.storePath)).toBe(true);
    const hit = cache.get({ tool: 'llm.generate', toolVersion: '1', inputs: { story: 'x' }, config: {} });
    expect(hit).not.toBeNull();
    expect(hit?.storePath).toBe(entry.storePath);
    expect(readFileSync(hit!.storePath, 'utf-8')).toBe('hello cache');
    expect(hit?.metadata?.['cost']).toBe(0.01);
  });

  it('linkInto copies the cached file to dest', () => {
    const cache = openGenerationCache({ cacheRoot });
    const src = join(workDir, 'src.png');
    writeFileSync(src, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    cache.put({
      key: { tool: 'comfy.image', toolVersion: '1', inputs: {}, config: {} },
      sourcePath: src,
      ext: 'png',
    });
    const dest = join(workDir, 'output', 'shot.png');
    cache.linkInto({ tool: 'comfy.image', toolVersion: '1', inputs: {}, config: {} }, dest);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest)[0]).toBe(0x89);
  });

  it('cache survives re-open on the same root', () => {
    const cache1 = openGenerationCache({ cacheRoot });
    const src = join(workDir, 'src.md');
    writeFileSync(src, 'persist me');
    cache1.put({
      key: { tool: 't', toolVersion: '1', inputs: { x: 1 }, config: {} },
      sourcePath: src,
      ext: 'md',
    });
    const cache2 = openGenerationCache({ cacheRoot });
    const hit = cache2.get({ tool: 't', toolVersion: '1', inputs: { x: 1 }, config: {} });
    expect(hit).not.toBeNull();
  });

  it('CAS root is auto-created on first put', () => {
    const root = join(cacheRoot, 'nested', 'cache');
    expect(existsSync(root)).toBe(false);
    const cache = openGenerationCache({ cacheRoot: root });
    const src = join(workDir, 'src.md');
    writeFileSync(src, 'x');
    cache.put({ key: { tool: 't', toolVersion: '1', inputs: {}, config: {} }, sourcePath: src, ext: 'md' });
    expect(existsSync(root)).toBe(true);
  });

  it('BUG: ext=json must not collide with metadata sidecar file (both used to write <hash>.json)', () => {
    // Regression: original impl wrote <hash>.<ext> as content and
    // <hash>.json as metadata. When ext='json' the metadata write
    // overwrote the content. This test pins the fix.
    const cache = openGenerationCache({ cacheRoot });
    const src = join(workDir, 'src.json');
    writeFileSync(src, '{"realContent":true,"shots":[1,2,3]}');
    cache.put({
      key: { tool: 'llm', toolVersion: '1', inputs: {}, config: {} },
      sourcePath: src,
      ext: 'json',
      metadata: { costUsd: 0.05 },
    });
    const hit = cache.get({ tool: 'llm', toolVersion: '1', inputs: {}, config: {} });
    expect(hit).not.toBeNull();
    const got = JSON.parse(readFileSync(hit!.storePath, 'utf-8')) as { realContent?: boolean; shots?: number[] };
    expect(got.realContent).toBe(true);
    expect(got.shots).toEqual([1, 2, 3]);
  });

  it('same inputs, different tool → independent cache entries', () => {
    const cache = openGenerationCache({ cacheRoot });
    const src1 = join(workDir, 'a.md');
    const src2 = join(workDir, 'b.md');
    writeFileSync(src1, 'from llm');
    writeFileSync(src2, 'from comfy');
    cache.put({ key: { tool: 'llm.generate', toolVersion: '1', inputs: {}, config: {} }, sourcePath: src1, ext: 'md' });
    cache.put({ key: { tool: 'comfy.image', toolVersion: '1', inputs: {}, config: {} }, sourcePath: src2, ext: 'md' });
    const llm = cache.get({ tool: 'llm.generate', toolVersion: '1', inputs: {}, config: {} });
    const comfy = cache.get({ tool: 'comfy.image', toolVersion: '1', inputs: {}, config: {} });
    expect(llm?.storePath).not.toBe(comfy?.storePath);
    expect(readFileSync(llm!.storePath, 'utf-8')).toBe('from llm');
    expect(readFileSync(comfy!.storePath, 'utf-8')).toBe('from comfy');
  });
});
