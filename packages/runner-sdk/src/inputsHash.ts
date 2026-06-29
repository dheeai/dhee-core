/**
 * inputsHash — content-stable hash of a runner invocation's resolved
 * inputs. The key for the content-addressed store.
 *
 * Critical correctness rules (from todos/content-addressed-generation-cache.md):
 *   - **Hash file CONTENTS, not paths.** Two different paths with the
 *     same bytes must hit the same cache entry. A file input is
 *     declared as `{ kind: 'file', path: '...' }`; this module reads
 *     the file and folds its content hash in.
 *   - **Pin the seed.** Seed in the key → reproducibility. A runner
 *     that doesn't pin its seed cannot have its outputs cached.
 *   - **Version-bust on toolVersion.** Upgrading a runner that changes
 *     output shape must miss the cache.
 *   - **Stable stringify.** Key order in the inputs object must not
 *     change the hash — implement with sorted keys.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

export interface FileInputRef {
  kind: 'file';
  path: string;
}

export interface InputsHashKey {
  tool: string;
  toolVersion: string;
  inputs: Record<string, unknown>;
  config: Record<string, unknown>;
  seed?: number | string;
}

/**
 * Recursively replace `{ kind: 'file', path }` markers with the
 * sha256 of the file's bytes. Other values pass through unchanged.
 */
function resolveFileInputs(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(resolveFileInputs);
  const obj = value as Record<string, unknown>;
  if (obj['kind'] === 'file' && typeof obj['path'] === 'string') {
    const p = obj['path'];
    if (!existsSync(p)) {
      throw new Error(`inputsHash: file input not found on disk: ${p}`);
    }
    const bytes = readFileSync(p);
    const fileHash = createHash('sha256').update(bytes).digest('hex');
    return { __fileHash: fileHash };
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    out[k] = resolveFileInputs(obj[k]);
  }
  return out;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value);
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + stableStringify((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

export function computeInputsHash(key: InputsHashKey): string {
  const normalized = {
    tool: key.tool,
    toolVersion: key.toolVersion,
    inputs: resolveFileInputs(key.inputs),
    config: resolveFileInputs(key.config),
    ...(key.seed !== undefined ? { seed: key.seed } : {}),
  };
  return createHash('sha256').update(stableStringify(normalized)).digest('hex');
}
