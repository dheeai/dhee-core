/**
 * bundleRequirements — derive a stub from a bundle's workflows, read a
 * declared manifest, and enrich a checkBundle() result with curated
 * hints. Real behavior: temp-dir bundles + a constructed BundleFit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  deriveBundleRequirements,
  loadBundleRequirements,
  enrichBundleFit,
} from '../../src/dag/bundleRequirements.js';
import type { BundleFit } from '../../src/dag/checkBundle.js';

let tmps: string[] = [];
function makeBundle(bundleJson: unknown, workflows: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'req-'));
  tmps.push(dir);
  writeFileSync(join(dir, 'bundle.json'), JSON.stringify(bundleJson));
  const wfDir = join(dir, 'workflows');
  mkdirSync(wfDir, { recursive: true });
  for (const [name, json] of Object.entries(workflows)) {
    writeFileSync(join(wfDir, name), JSON.stringify(json));
  }
  return dir;
}

beforeEach(() => { tmps = []; });
afterEach(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

describe('deriveBundleRequirements', () => {
  it('derives models (filename + classField + inferred type) and excludes core node classes', () => {
    const dir = makeBundle({ id: 'b', version: '0.1.0' }, {
      'img.json': {
        UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'flux-dev.safetensors' } },
        VAE: { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
        ENC: { class_type: 'CLIPTextEncode', inputs: { text: 'hi' } }, // core → excluded
        DIR: { class_type: 'LTXVDirector', inputs: {} },               // custom → kept
      },
    });
    const d = deriveBundleRequirements(dir);
    expect(d.models).toEqual([
      { classField: 'VAELoader.vae_name', canonicalFilename: 'ae.safetensors', type: 'vae', downloadUrl: '', sizeGb: 0, optional: false },
      { classField: 'UNETLoader.unet_name', canonicalFilename: 'flux-dev.safetensors', type: 'unet', downloadUrl: '', sizeGb: 0, optional: false },
    ]);
    expect(d.customNodes!.map((c) => c.classType)).toEqual(['LTXVDirector']);
    expect(d.allNodeClasses).toEqual(['CLIPTextEncode', 'LTXVDirector', 'UNETLoader', 'VAELoader']);
  });

  it('honors an explicit core-class set (e.g. a vanilla comfy /object_info)', () => {
    const dir = makeBundle({ id: 'b', version: '0.1.0' }, {
      'a.json': { D: { class_type: 'LTXVDirector', inputs: {} }, S: { class_type: 'MyNode', inputs: {} } },
    });
    const d = deriveBundleRequirements(dir, { coreClasses: new Set(['LTXVDirector']) });
    expect(d.customNodes!.map((c) => c.classType)).toEqual(['MyNode']);
  });

  it('dedups a model referenced by multiple workflows', () => {
    const dir = makeBundle({ id: 'b', version: '0.1.0' }, {
      'a.json': { U: { class_type: 'UNETLoader', inputs: { unet_name: 'shared.safetensors' } } },
      'b.json': { U: { class_type: 'UNETLoader', inputs: { unet_name: 'shared.safetensors' } } },
    });
    expect(deriveBundleRequirements(dir).models).toHaveLength(1);
  });
});

describe('loadBundleRequirements', () => {
  it('reads a declared requirements block', () => {
    const dir = makeBundle(
      { id: 'b', version: '0.1.0', requirements: { models: [{ classField: 'UNETLoader.unet_name', canonicalFilename: 'x.safetensors' }] } },
      {},
    );
    expect(loadBundleRequirements(dir)?.models?.[0]?.canonicalFilename).toBe('x.safetensors');
  });

  it('returns null when the bundle declares none', () => {
    const dir = makeBundle({ id: 'b', version: '0.1.0' }, {});
    expect(loadBundleRequirements(dir)).toBeNull();
  });
});

describe('enrichBundleFit', () => {
  const fit: BundleFit = {
    bundleDir: '/x',
    endpoint: 'http://c/',
    status: 'incomplete',
    modelsMissing: 1,
    nodesMissing: 1,
    workflows: [
      {
        workflowKey: 'workflows/a.json',
        ok: false,
        available_by_class: {},
        missing_refs: [{ nodeType: 'UNETLoader', nodeId: 'U', inputField: 'unet_name', current_value: 'flux-dev.safetensors' }],
        missing_node_classes: [{ nodeId: 'D', class_type: 'LTXVDirector' }],
      },
    ],
  };

  it('attaches curated requirement entries to matching gaps', () => {
    const enriched = enrichBundleFit(fit, {
      models: [{ classField: 'UNETLoader.unet_name', canonicalFilename: 'flux-dev.safetensors', type: 'unet', downloadUrl: 'https://hf/flux', sizeGb: 24 }],
      customNodes: [{ classType: 'LTXVDirector', pack: 'ComfyUI-LTXVideo', installVia: 'manager' }],
    });
    const w = enriched.workflows[0]!;
    expect(w.missing_refs[0]!.requirement?.sizeGb).toBe(24);
    expect(w.missing_refs[0]!.requirement?.downloadUrl).toBe('https://hf/flux');
    expect(w.missing_node_classes[0]!.requirement?.pack).toBe('ComfyUI-LTXVideo');
  });

  it('leaves a gap with no manifest entry passthrough (requirement undefined)', () => {
    const enriched = enrichBundleFit(fit, null);
    expect(enriched.workflows[0]!.missing_refs[0]!.requirement).toBeUndefined();
    expect(enriched.workflows[0]!.missing_node_classes[0]!.requirement).toBeUndefined();
  });
});
