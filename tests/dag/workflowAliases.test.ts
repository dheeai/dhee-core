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
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homedir } from 'node:os';
import {
  endpointSlug,
  aliasEndpointKey,
  defaultAliasesDir,
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

describe('defaultAliasesDir (cross-platform home resolution)', () => {
  const saved = process.env['DHEE_WORKFLOW_ALIASES_DIR'];
  afterEach(() => {
    if (saved === undefined) delete process.env['DHEE_WORKFLOW_ALIASES_DIR'];
    else process.env['DHEE_WORKFLOW_ALIASES_DIR'] = saved;
  });

  it('honors DHEE_WORKFLOW_ALIASES_DIR when set', () => {
    process.env['DHEE_WORKFLOW_ALIASES_DIR'] = '/tmp/custom-aliases';
    expect(defaultAliasesDir()).toBe('/tmp/custom-aliases');
  });

  it('falls back to <homedir>/.dhee/workflow-aliases — an ABSOLUTE path under home, never cwd-relative', () => {
    delete process.env['DHEE_WORKFLOW_ALIASES_DIR'];
    const dir = defaultAliasesDir();
    expect(dir).toBe(join(homedir(), '.dhee', 'workflow-aliases'));
    // Regression: the old `process.env.HOME ?? ''` fallback produced a
    // cwd-relative path on Windows (HOME unset). The dir must be absolute and
    // rooted at the real home dir, not the process cwd.
    expect(dir.startsWith(homedir())).toBe(true);
    expect(dir.startsWith(process.cwd())).toBe(homedir().startsWith(process.cwd()));
  });
});

describe('aliasEndpointKey (stable per-box keying)', () => {
  it('collapses every non-cloud (local) endpoint to self.local', () => {
    expect(aliasEndpointKey('https://comfyui.share.zrok.io')).toBe('self.local');
    expect(aliasEndpointKey('http://100.93.149.119:8188')).toBe('self.local');
    expect(aliasEndpointKey('http://127.0.0.1:8188')).toBe('self.local');
    expect(aliasEndpointKey('http://192.168.1.50:8188')).toBe('self.local');
    expect(aliasEndpointKey('unknown')).toBe('self.local');
  });
  it('keeps cloud endpoints keyed per-host', () => {
    expect(aliasEndpointKey('https://cloud.comfy.org/api')).toBe('https://cloud.comfy.org/api');
    expect(aliasEndpointKey('https://my.site/comfy/api')).toBe('https://my.site/comfy/api');
  });
});

describe('readAliases / writeAliases', () => {
  it('THE FIX: aliases survive a local-box URL change (zrok → tailnet → DHCP)', () => {
    const dir = makeTmp();
    // User picks a substitute while their box is behind a zrok tunnel.
    writeAliases(dir, 'https://comfyui.share.zrok.io', {
      name_aliases: { 'flux-2.safetensors': 'flux-2-klein-full.safetensors' },
    });
    // Later the box is addressed via Tailscale IP, then a new DHCP IP.
    // The substitution must still resolve — same physical box.
    expect(readAliases(dir, 'http://100.93.149.119:8188').name_aliases).toEqual({
      'flux-2.safetensors': 'flux-2-klein-full.safetensors',
    });
    expect(readAliases(dir, 'http://192.168.1.77:8188').name_aliases).toEqual({
      'flux-2.safetensors': 'flux-2-klein-full.safetensors',
    });
  });

  it('a local-box alias does NOT leak into a cloud endpoint namespace', () => {
    const dir = makeTmp();
    writeAliases(dir, 'http://127.0.0.1:8188', {
      name_aliases: { 'x.safetensors': 'local.safetensors' },
    });
    expect(readAliases(dir, 'https://cloud.comfy.org/api')).toEqual({});
  });

  it('folds in LEGACY per-URL local alias dirs (pre-stable-keying) so picks are not orphaned', () => {
    const dir = makeTmp();
    // Simulate aliases written before stable keying: raw per-URL slug
    // dirs, NOT the self_local key. (Bypass writeAliases, which now
    // normalizes, to reproduce the on-disk legacy layout.)
    mkdirSync(join(dir, 'comfyui_share_zrok_io'), { recursive: true });
    writeFileSync(
      join(dir, 'comfyui_share_zrok_io', 'aliases.json'),
      JSON.stringify({ name_aliases: { 'flux-2-klein-9b.safetensors': 'flux-2-klein-9b-kv-fp8.safetensors' } }),
    );
    mkdirSync(join(dir, '100_93_149_119_8188'), { recursive: true });
    writeFileSync(
      join(dir, '100_93_149_119_8188', 'aliases.json'),
      JSON.stringify({ name_aliases: { 'ltx2.3-transition.safetensors': 'Ltx2.3-VBVR.safetensors' } }),
    );
    // Reading the canonical local box folds BOTH legacy dirs in.
    const got = readAliases(dir, 'http://100.93.149.119:8188').name_aliases;
    expect(got).toEqual({
      'flux-2-klein-9b.safetensors': 'flux-2-klein-9b-kv-fp8.safetensors',
      'ltx2.3-transition.safetensors': 'Ltx2.3-VBVR.safetensors',
    });
  });

  it('the self_local file wins over a legacy dir on conflict', () => {
    const dir = makeTmp();
    // Legacy says A→OLD; current self_local pick says A→NEW.
    mkdirSync(join(dir, 'old_lan_ip_8188'), { recursive: true });
    writeFileSync(
      join(dir, 'old_lan_ip_8188', 'aliases.json'),
      JSON.stringify({ name_aliases: { 'a.safetensors': 'OLD.safetensors' } }),
    );
    writeAliases(dir, 'http://100.93.149.119:8188', {
      name_aliases: { 'a.safetensors': 'NEW.safetensors' },
    });
    expect(readAliases(dir, 'http://100.93.149.119:8188').name_aliases!['a.safetensors']).toBe(
      'NEW.safetensors',
    );
  });

  it('does NOT fold a cloud dir into the local namespace', () => {
    const dir = makeTmp();
    mkdirSync(join(dir, endpointSlug('https://cloud.comfy.org/api')), { recursive: true });
    writeFileSync(
      join(dir, endpointSlug('https://cloud.comfy.org/api'), 'aliases.json'),
      JSON.stringify({ name_aliases: { 'cloudonly.safetensors': 'x.safetensors' } }),
    );
    // self.local must not inherit a cloud box's substitutions.
    expect(readAliases(dir, 'http://127.0.0.1:8188')).toEqual({});
  });

  it('readAliases returns an empty object when the file does not exist', () => {
    const dir = makeTmp();
    expect(readAliases(dir, 'https://x/')).toEqual({});
  });

  it('writeAliases collapses a local endpoint to the stable self_local subdir', () => {
    const dir = makeTmp();
    const aliases: WorkflowAliases = {
      name_aliases: { 'old.safetensors': 'new.safetensors' },
    };
    writeAliases(dir, 'http://100.93.149.119:8188', aliases);
    // Non-cloud (local) box → keyed by the stable `self.local`, not the
    // raw URL slug — so the file survives URL changes.
    const path = join(dir, 'self_local', 'aliases.json');
    const text = readFileSync(path, 'utf8');
    expect(JSON.parse(text)).toEqual(aliases);
  });

  it('writeAliases keeps a cloud endpoint keyed per-host', () => {
    const dir = makeTmp();
    writeAliases(dir, 'https://cloud.comfy.org/api', {
      name_aliases: { 'a.safetensors': 'b.safetensors' },
    });
    // Cloud stays per-host (distinct boxes, distinct model libraries).
    expect(existsSync(join(dir, endpointSlug('https://cloud.comfy.org/api'), 'aliases.json'))).toBe(true);
    // ...and NOT under the local namespace.
    expect(existsSync(join(dir, 'self_local', 'aliases.json'))).toBe(false);
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

  it('name_aliases swaps numbered *_name fields (DualCLIPLoader gemma → clip_name1)', () => {
    // Regression: gemma is the only aliased model that sits on a numbered
    // field (clip_name1), so the old `endsWith('_name')` filter skipped it
    // while every plain-`_name` alias applied — "always failing for gemma".
    const out = applyAliases(
      wf({
        CLIP: {
          class_type: 'DualCLIPLoader',
          inputs: {
            clip_name1: 'gemma_3_12B_it_fp8_scaled.safetensors',
            clip_name2: 'ltx-2.3_text_projection_bf16.safetensors',
          },
        },
      }),
      {
        workflowKey: 'ltx_director_local.json',
        aliases: {
          name_aliases: {
            'gemma_3_12B_it_fp8_scaled.safetensors':
              'gemma_3_12B_it_heretic_fp8_e4m3fn.safetensors',
          },
        },
      },
    );
    expect((out.CLIP!.inputs as { clip_name1: string }).clip_name1).toBe(
      'gemma_3_12B_it_heretic_fp8_e4m3fn.safetensors',
    );
    // clip_name2 has no alias entry → untouched.
    expect((out.CLIP!.inputs as { clip_name2: string }).clip_name2).toBe(
      'ltx-2.3_text_projection_bf16.safetensors',
    );
  });

  it('name_aliases swap by exact value, regardless of field name (no _name needed)', () => {
    const out = applyAliases(
      wf({
        ENC: {
          class_type: 'SomeCustomEncoderLoader',
          inputs: { text_encoder: 'old.safetensors', strength: 1, latent: ['VAE', 0] },
        },
      }),
      {
        workflowKey: 'x.json',
        aliases: { name_aliases: { 'old.safetensors': 'new.safetensors' } },
      },
    );
    const inputs = out.ENC!.inputs as { text_encoder: string; strength: number; latent: unknown };
    expect(inputs.text_encoder).toBe('new.safetensors'); // rewritten despite non-`_name` field
    expect(inputs.strength).toBe(1); // numbers untouched
    expect(inputs.latent).toEqual(['VAE', 0]); // wire-arrays untouched
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

  it('class_swaps match across path-separator skew (Windows backslash store ↔ fwd-slash lookup)', () => {
    // Regression: the store is keyed with backslashes on Windows
    // (`workflows\ltx_director_local.json`) but runners look up with forward
    // slashes — a raw object lookup missed, so the swap silently never applied.
    const out = applyAliases(
      wf({ '57': { class_type: 'LatentUpscaleModelLoader', inputs: {} } }),
      {
        workflowKey: 'workflows/ltx_director_local.json',
        aliases: {
          class_swaps: {
            'workflows\\ltx_director_local.json': { '57': 'LowVRAMLatentUpscaleModelLoader' },
          },
        },
      },
    );
    expect(out['57']!.class_type).toBe('LowVRAMLatentUpscaleModelLoader');
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
