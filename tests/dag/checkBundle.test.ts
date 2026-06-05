/**
 * checkBundle — aggregate model + custom-node fit across a bundle's
 * ComfyUI workflows. Exercises real behavior: writes workflow JSONs to
 * a temp bundle dir, stubs /object_info, and asserts the rolled-up
 * verdict + per-workflow detail. Also verifies the single shared
 * /object_info read and the saved-alias integration (name_aliases +
 * per-workflow class_swaps).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBundle, listBundleWorkflows } from '../../src/dag/checkBundle.js';
import { writeAliases } from '../../src/dag/workflowAliases.js';
import type { ObjectInfo } from '../../src/dag/workflowVerify.js';

let tmps: string[] = [];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(d);
  return d;
}

/** Build a temp bundle dir with workflows/ files. Values: object → JSON; string → written verbatim (for malformed-JSON tests). */
function makeBundle(files: Record<string, unknown>): string {
  const dir = tmp('bundle-');
  const wfDir = join(dir, 'workflows');
  mkdirSync(wfDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(wfDir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
}

/** /object_info fixture: keys are installed node classes; nested fields are model dropdowns. */
function objectInfo(byClass: Record<string, Record<string, string[]>>): ObjectInfo {
  const obj: Record<string, unknown> = {};
  for (const [cls, fields] of Object.entries(byClass)) {
    const required: Record<string, unknown> = {};
    for (const [field, names] of Object.entries(fields)) required[field] = [names, {}];
    obj[cls] = { input: { required } };
  }
  return obj as ObjectInfo;
}

const fetchOf = (info: ObjectInfo) => vi.fn(async () => info);

beforeEach(() => {
  tmps = [];
});
afterEach(() => {
  for (const d of tmps) rmSync(d, { recursive: true, force: true });
});

describe('listBundleWorkflows', () => {
  it('returns workflows/*.json and excludes *.manifest.json', () => {
    const dir = makeBundle({
      'a.json': { N: { class_type: 'KSampler', inputs: {} } },
      'a.manifest.json': { id: 'a' },
      'b.json': { N: { class_type: 'KSampler', inputs: {} } },
    });
    expect(listBundleWorkflows(dir)).toEqual(['workflows/a.json', 'workflows/b.json']);
  });

  it('returns [] when the bundle ships no workflows/ dir', () => {
    const dir = tmp('bundle-empty-');
    expect(listBundleWorkflows(dir)).toEqual([]);
  });
});

describe('checkBundle', () => {
  it('a bundle with no workflows is ready and never probes the endpoint', async () => {
    const dir = tmp('bundle-textonly-');
    const fetch = fetchOf(objectInfo({}));
    const fit = await checkBundle({ bundleDir: dir, endpoint: 'http://c/', fetchObjectInfo: fetch, aliasesDir: tmp('al-') });
    expect(fit.status).toBe('ready');
    expect(fit.workflows).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('all models + nodes present → ready, zero counts', async () => {
    const dir = makeBundle({
      'img.json': {
        UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'flux.safetensors' } },
        S: { class_type: 'KSampler', inputs: {} },
      },
    });
    const fit = await checkBundle({
      bundleDir: dir,
      endpoint: 'http://c/',
      aliasesDir: tmp('al-'),
      fetchObjectInfo: fetchOf(objectInfo({ UNETLoader: { unet_name: ['flux.safetensors'] }, KSampler: {} })),
    });
    expect(fit.status).toBe('ready');
    expect(fit.modelsMissing).toBe(0);
    expect(fit.nodesMissing).toBe(0);
    expect(fit.workflows[0]!.ok).toBe(true);
  });

  it('rolls up a missing model in one workflow and a missing node in another → incomplete', async () => {
    const dir = makeBundle({
      'a.json': { UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'bundle.safetensors' } } },
      'b.json': { DIR: { class_type: 'LTXVDirector', inputs: {} } },
    });
    const fit = await checkBundle({
      bundleDir: dir,
      endpoint: 'http://c/',
      aliasesDir: tmp('al-'),
      // model differs (a.json missing) ; LTXVDirector pack not installed (b.json missing node)
      fetchObjectInfo: fetchOf(objectInfo({ UNETLoader: { unet_name: ['other.safetensors'] } })),
    });
    expect(fit.status).toBe('incomplete');
    expect(fit.modelsMissing).toBe(1);
    expect(fit.nodesMissing).toBe(1);
    const a = fit.workflows.find((w) => w.workflowKey === 'workflows/a.json')!;
    const b = fit.workflows.find((w) => w.workflowKey === 'workflows/b.json')!;
    expect(a.missing_refs).toHaveLength(1);
    expect(b.missing_node_classes).toEqual([{ nodeId: 'DIR', class_type: 'LTXVDirector' }]);
  });

  it('reads /object_info exactly once across multiple workflows', async () => {
    const dir = makeBundle({
      'a.json': { S: { class_type: 'KSampler', inputs: {} } },
      'b.json': { S: { class_type: 'KSampler', inputs: {} } },
      'c.json': { S: { class_type: 'KSampler', inputs: {} } },
    });
    const fetch = fetchOf(objectInfo({ KSampler: {} }));
    await checkBundle({ bundleDir: dir, endpoint: 'http://c/', aliasesDir: tmp('al-'), fetchObjectInfo: fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('endpoint unreachable → status unreachable, per-workflow error populated', async () => {
    const dir = makeBundle({ 'a.json': { S: { class_type: 'KSampler', inputs: {} } } });
    const fit = await checkBundle({
      bundleDir: dir,
      endpoint: 'http://c/',
      aliasesDir: tmp('al-'),
      fetchObjectInfo: vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    });
    expect(fit.status).toBe('unreachable');
    expect(fit.workflows[0]!.error).toMatch(/ECONNREFUSED/);
  });

  it('a malformed workflow JSON is reported per-workflow and makes the bundle incomplete', async () => {
    const dir = makeBundle({
      'good.json': { S: { class_type: 'KSampler', inputs: {} } },
      'broken.json': '{ this is not json ',
    });
    const fit = await checkBundle({
      bundleDir: dir,
      endpoint: 'http://c/',
      aliasesDir: tmp('al-'),
      fetchObjectInfo: fetchOf(objectInfo({ KSampler: {} })),
    });
    expect(fit.status).toBe('incomplete');
    const broken = fit.workflows.find((w) => w.workflowKey === 'workflows/broken.json')!;
    expect(broken.error).toMatch(/unreadable/);
  });

  it('saved aliases close the gaps: name_alias for a model + class_swap for a node → ready', async () => {
    const dir = makeBundle({
      'a.json': {
        UNET: { class_type: 'UNETLoader', inputs: { unet_name: 'bundle.safetensors' } },
        DIR: { class_type: 'LTXVDirector', inputs: {} },
      },
    });
    const aliasesDir = tmp('al-');
    const endpoint = 'http://c/';
    // The user has the model under a different name, and a GGUF director node.
    writeAliases(aliasesDir, endpoint, {
      name_aliases: { 'bundle.safetensors': 'local.safetensors' },
      class_swaps: { 'workflows/a.json': { DIR: 'LTXVDirectorGGUF' } },
    });
    const fit = await checkBundle({
      bundleDir: dir,
      endpoint,
      aliasesDir,
      fetchObjectInfo: fetchOf(objectInfo({
        UNETLoader: { unet_name: ['local.safetensors'] },
        LTXVDirectorGGUF: {},
      })),
    });
    expect(fit.status).toBe('ready');
    expect(fit.modelsMissing).toBe(0);
    expect(fit.nodesMissing).toBe(0);
  });
});
