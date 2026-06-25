/**
 * GenerationCache — content-addressed store for runner outputs.
 *
 * Layout: <cacheRoot>/<hash[0:2]>/<full-hash>.<ext> + a sibling
 * `<full-hash>.json` with metadata (model, seed, cost, timing). Entries
 * are immutable — content-addressed implies safe to share + concurrent-
 * read across projects.
 *
 * The cache key is `(tool, toolVersion, inputs, config, seed)` — see
 * `inputsHash.ts`. Two runners called with the same resolved inputs
 * produce the same hash and hit the same entry.
 *
 * Default cacheRoot is `~/.dhee/cache` (shared across projects).
 * Tests pass an isolated tmpdir.
 *
 * On hit: `linkInto(key, destPath)` writes the artifact at the
 * caller's expected location. We `copyFileSync` to keep the file
 * independent — hardlinks would couple eviction to project deletion;
 * defer that optimization.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

import { computeInputsHash, type InputsHashKey } from './inputsHash.js';

export interface CacheEntry {
  hash: string;
  storePath: string;
  ext: string;
  metadata?: Record<string, unknown>;
}

export interface PutOpts {
  key: InputsHashKey;
  sourcePath: string;
  ext: string;
  metadata?: Record<string, unknown>;
}

export interface GenerationCache {
  /** Returns the cache entry for a key, or null if not present. */
  get(key: InputsHashKey): CacheEntry | null;
  /**
   * Store a file from `sourcePath` under the key's hash. Returns the
   * canonical cache entry.
   */
  put(opts: PutOpts): CacheEntry;
  /**
   * Resolve the cached file for `key` and write a copy to `destPath`.
   * Returns the CacheEntry on hit, null on miss.
   */
  linkInto(key: InputsHashKey, destPath: string): CacheEntry | null;
  /** Root of the CAS. */
  root(): string;
}

export function defaultCacheRoot(): string {
  return join(homedir(), '.dhee', 'cache');
}

export function openGenerationCache(opts?: { cacheRoot?: string }): GenerationCache {
  const cacheRoot = opts?.cacheRoot ?? defaultCacheRoot();

  function ensureRoot(): void {
    if (!existsSync(cacheRoot)) mkdirSync(cacheRoot, { recursive: true });
  }

  function shardDir(hash: string): string {
    return join(cacheRoot, hash.slice(0, 2));
  }

  function entryPath(hash: string, ext: string): string {
    return join(shardDir(hash), `${hash}.${ext}`);
  }

  function metadataPath(hash: string): string {
    // NOTE: must NOT collide with the content file when the content's
    // ext is 'json'. Original impl used '.json' here and silently
    // overwrote the content. Use a sidecar extension that can't
    // appear as a runner output format.
    return join(shardDir(hash), `${hash}.meta`);
  }

  function readMetadata(hash: string): { ext: string; metadata?: Record<string, unknown> } | null {
    const p = metadataPath(hash);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as { ext: string; metadata?: Record<string, unknown> };
    } catch {
      return null;
    }
  }

  function get(key: InputsHashKey): CacheEntry | null {
    const hash = computeInputsHash(key);
    const meta = readMetadata(hash);
    if (!meta) return null;
    const storePath = entryPath(hash, meta.ext);
    if (!existsSync(storePath)) return null;
    return { hash, storePath, ext: meta.ext, ...(meta.metadata ? { metadata: meta.metadata } : {}) };
  }

  function put({ key, sourcePath, ext, metadata }: PutOpts): CacheEntry {
    ensureRoot();
    const hash = computeInputsHash(key);
    const shard = shardDir(hash);
    if (!existsSync(shard)) mkdirSync(shard, { recursive: true });
    const storePath = entryPath(hash, ext);
    copyFileSync(sourcePath, storePath);
    writeFileSync(
      metadataPath(hash),
      JSON.stringify({ ext, metadata: metadata ?? {}, key: { tool: key.tool, toolVersion: key.toolVersion } }, null, 2),
    );
    return { hash, storePath, ext, ...(metadata ? { metadata } : {}) };
  }

  function linkInto(key: InputsHashKey, destPath: string): CacheEntry | null {
    const hit = get(key);
    if (!hit) return null;
    const dir = dirname(destPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    copyFileSync(hit.storePath, destPath);
    return hit;
  }

  return { get, put, linkInto, root: () => cacheRoot };
}
