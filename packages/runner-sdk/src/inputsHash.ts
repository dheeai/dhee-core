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
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

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
