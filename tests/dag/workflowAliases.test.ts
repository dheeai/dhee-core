/**
 * Tests for the workflow alias store + applyAliases.
 *
 * Storage shape:
 *   <aliasesDir>/<endpoint-slug>/aliases.json
 *   {
 *     "name_aliases": { "bundle_name.safetensors": "local_name.safetensors" },
 *     "class_swaps":  { "<workflowKey>": { "<nodeId>": "NewClass" } }
 *   }
 *
 * applyAliases is pure: returns a NEW workflow object with substitutions
 * applied; never mutates input. It only touches:
 *   - inputs.<*_name> string values (name swaps)
 *   - nodes' class_type (class swaps, scoped to this workflowKey)
 *
 * It never adds/removes nodes, never reorders, never edits non-name inputs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  endpointSlug,
  readAliases,
  writeAliases,
  applyAliases,
  type WorkflowAliases,
} from '../../src/dag/workflowAliases.js';
import type { ComfyWorkflow } from '../../src/dag/workflowVerify.js';

const tmpDirs: string[] = [];
function makeTmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'wfaliases-'));
  tmpDirs.push(d);
  return d;
}
afterEach(() => {
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {}
  }
});

function wf(nodes: Record<string, { class_type: string; inputs: Record<string, unknown> }>): ComfyWorkflow {
  return JSON.parse(JSON.stringify(nodes)) as ComfyWorkflow;
}

describe('endpointSlug', () => {
  it('normalizes URLs to a filesystem-safe identifier', () => {
    expect(endpointSlug('https://comfyui.share.zrok.io')).toBe('comfyui_share_zrok_io');
    expect(endpointSlug('http://192.168.68.103:8188')).toBe('192_168_68_103_8188');
    expect(endpointSlug('http://localhost:8188/')).toBe('localhost_8188');
  });
});

describe('readAliases / writeAliases', () => {
  it('readAliases returns an empty object when the file does not exist', () => {
    const dir = makeTmp();
    expect(readAliases(dir, 'https://x/')).toEqual({});
  });

  it('writeAliases creates the endpoint subdir and writes JSON', () => {
    const dir = makeTmp();
    const aliases: WorkflowAliases = {
      name_aliases: { 'old.safetensors': 'new.safetensors' },
    };
    writeAliases(dir, 'https://comfy/', aliases);
    const path = join(dir, 'comfy', 'aliases.json');
    const text = readFileSync(path, 'utf8');
    expect(JSON.parse(text)).toEqual(aliases);
  });

  it('write then read round-trips', () => {
    const dir = makeTmp();
    const aliases: WorkflowAliases = {
      name_aliases: { 'a.safetensors': 'b.safetensors' },
      class_swaps: { 'qwen.json': { UNET: 'UnetLoaderGGUF' } },
    };
    writeAliases(dir, 'http://x/', aliases);
    expect(readAliases(dir, 'http://x/')).toEqual(aliases);
  });

  it('writeAliases merges into existing aliases (does not clobber unrelated keys)', () => {
    const dir = makeTmp();
    writeAliases(dir, 'http://x/', {
      name_aliases: { 'a.safetensors': 'A.safetensors' },
    });
    writeAliases(dir, 'http://x/', {
      name_aliases: { 'b.safetensors': 'B.safetensors' },
    });
    const merged = readAliases(dir, 'http://x/');
    expect(merged.name_aliases).toEqual({
      'a.safetensors': 'A.safetensors',
      'b.safetensors': 'B.safetensors',
    });
  });

  it('writeAliases class_swaps merges per-workflow', () => {
    const dir = makeTmp();
    writeAliases(dir, 'http://x/', {
      class_swaps: { 'qwen.json': { UNET: 'UnetLoaderGGUF' } },
    });
    writeAliases(dir, 'http://x/', {
      class_swaps: { 'ltx.json': { CLIP: 'CLIPLoaderGGUF' } },
    });
    const merged = readAliases(dir, 'http://x/');
    expect(merged.class_swaps).toEqual({
      'qwen.json': { UNET: 'UnetLoaderGGUF' },
      'ltx.json': { CLIP: 'CLIPLoaderGGUF' },
    });
  });

  it('writeAliases per-workflow class_swaps merge at node level', () => {
    const dir = makeTmp();
    writeAliases(dir, 'http://x/', {
      class_swaps: { 'qwen.json': { UNET: 'UnetLoaderGGUF' } },
    });
    writeAliases(dir, 'http://x/', {
      class_swaps: { 'qwen.json': { CLIP: 'CLIPLoaderGGUF' } },
    });
    const merged = readAliases(dir, 'http://x/');
    expect(merged.class_swaps!['qwen.json']).toEqual({
      UNET: 'UnetLoaderGGUF',
      CLIP: 'CLIPLoaderGGUF',
    });
  });
});

describe('applyAliases', () => {
  it('returns the workflow unchanged when no aliases apply', () => {
    const input = wf({
      UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.safetensors' } },
    });
    const out = applyAliases(input, { workflowKey: 'qwen.json', aliases: {} });
    expect(out).toEqual(input);
  });

  it('does NOT mutate the input workflow', () => {
    const input = wf({
      UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'old.safetensors' } },
    });
    const snapshot = JSON.parse(JSON.stringify(input));
    applyAliases(input, {
      workflowKey: 'q.json',
      aliases: { name_aliases: { 'old.safetensors': 'new.safetensors' } },
    });
    expect(input).toEqual(snapshot);
  });

  it('name_aliases swaps inputs.*_name values that match', () => {
    const out = applyAliases(
      wf({
        UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'old.safetensors' } },
        OTHER: { class_type: 'KSampler', inputs: { seed: 1234, model: ['UNET', 0] } },
      }),
      {
        workflowKey: 'x.json',
        aliases: { name_aliases: { 'old.safetensors': 'new.safetensors' } },
      },
    );
    expect((out.UNET!.inputs as { unet_name: string }).unet_name).toBe('new.safetensors');
    // Untouched node.
    expect(out.OTHER!.inputs).toEqual({ seed: 1234, model: ['UNET', 0] });
  });

  it('name_aliases targeting a name not in the workflow is a no-op', () => {
    const input = wf({
      UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.safetensors' } },
    });
    const out = applyAliases(input, {
      workflowKey: 'x.json',
      aliases: { name_aliases: { 'nothere.safetensors': 'whatever.safetensors' } },
    });
    expect(out).toEqual(input);
  });

  it('class_swaps changes class_type for matching (workflowKey, nodeId)', () => {
    const out = applyAliases(
      wf({
        UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen.gguf' } },
      }),
      {
        workflowKey: 'qwen.json',
        aliases: { class_swaps: { 'qwen.json': { UNET: 'UnetLoaderGGUF' } } },
      },
    );
    expect(out.UNET!.class_type).toBe('UnetLoaderGGUF');
    // Inputs preserved verbatim — only class_type changes.
    expect((out.UNET!.inputs as { unet_name: string }).unet_name).toBe('qwen.gguf');
  });

  it('class_swaps under a different workflowKey are ignored', () => {
    const out = applyAliases(
      wf({
        UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'q.safetensors' } },
      }),
      {
        workflowKey: 'qwen.json',
        aliases: { class_swaps: { 'ltx.json': { UNET: 'UnetLoaderGGUF' } } },
      },
    );
    expect(out.UNET!.class_type).toBe('UNETLoader');
  });

  it('class_swaps for a nonexistent nodeId is a no-op (no error)', () => {
    const out = applyAliases(
      wf({ UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'q.safetensors' } } }),
      {
        workflowKey: 'qwen.json',
        aliases: { class_swaps: { 'qwen.json': { NO_SUCH_NODE: 'NewClass' } } },
      },
    );
    expect(out.UNET!.class_type).toBe('UNETLoader');
  });

  it('preserves node count + ids + non-*_name input values', () => {
    const input = wf({
      UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'a.safetensors', weight_dtype: 'default' } },
      KS:   { class_type: 'KSampler', inputs: { seed: 4242, steps: 28, cfg: 5.5 } },
    });
    const out = applyAliases(input, {
      workflowKey: 'x.json',
      aliases: {
        name_aliases: { 'a.safetensors': 'b.safetensors' },
      },
    });
    expect(Object.keys(out).sort()).toEqual(['KS', 'UNET']);
    expect(out.KS!.inputs).toEqual({ seed: 4242, steps: 28, cfg: 5.5 });
    expect((out.UNET!.inputs as { weight_dtype: string }).weight_dtype).toBe('default');
  });

  it('combined name + class swap on the same node works', () => {
    const out = applyAliases(
      wf({
        UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'bundle.safetensors' } },
      }),
      {
        workflowKey: 'q.json',
        aliases: {
          name_aliases: { 'bundle.safetensors': 'local.gguf' },
          class_swaps: { 'q.json': { UNET: 'UnetLoaderGGUF' } },
        },
      },
    );
    expect(out.UNET!.class_type).toBe('UnetLoaderGGUF');
    expect((out.UNET!.inputs as { unet_name: string }).unet_name).toBe('local.gguf');
  });
});
