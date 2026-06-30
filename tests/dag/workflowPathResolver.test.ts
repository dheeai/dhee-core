import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveWorkflowPath, isCloudEndpoint } from '../../src/dag/workflowPathResolver.js';

let bundleDir: string;

beforeEach(() => {
  bundleDir = mkdtempSync(join(tmpdir(), 'wf-resolver-'));
  mkdirSync(join(bundleDir, 'workflows'), { recursive: true });
  writeFileSync(join(bundleDir, 'workflows/ltx_director_local.json'), '{}');
  writeFileSync(join(bundleDir, 'workflows/ltx_director_cloud.json'), '{}');
});

afterEach(() => rmSync(bundleDir, { recursive: true, force: true }));

const CLOUD = 'https://cloud.comfy.org/api';
const LOCAL = 'http://localhost:8188';

describe('isCloudEndpoint', () => {
  it('flags cloud.comfy.org and the /comfy/api proxy, not local boxes', () => {
    expect(isCloudEndpoint(CLOUD)).toBe(true);
    expect(isCloudEndpoint('https://dhee.ai/comfy/api')).toBe(true);
    expect(isCloudEndpoint('https://dhee.ai/comfy/api/')).toBe(true);
    expect(isCloudEndpoint(LOCAL)).toBe(false);
    expect(isCloudEndpoint('http://100.93.149.119:8188')).toBe(false);
    expect(isCloudEndpoint('https://comfyui.share.zrok.io')).toBe(false);
  });
});

describe('resolveWorkflowPath', () => {
  it('uses the canonical path when there is no endpoint', () => {
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/ltx_director_local.json',
      bundleDir,
    });
    expect(p).toBe(join(bundleDir, 'workflows/ltx_director_local.json'));
  });

  it('uses the canonical path for a local (non-cloud) endpoint', () => {
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/ltx_director_local.json',
      bundleDir,
      endpointUrl: LOCAL,
    });
    expect(p).toBe(join(bundleDir, 'workflows/ltx_director_local.json'));
  });

  it('uses the explicit workflowPathCloud when the endpoint is cloud', () => {
    mkdirSync(join(bundleDir, 'workflows/cloud'), { recursive: true });
    writeFileSync(join(bundleDir, 'workflows/cloud/ltx23_director_cloud.json'), '{}');
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/ltx_director_local.json',
      workflowPathCloud: 'workflows/cloud/ltx23_director_cloud.json',
      bundleDir,
      endpointUrl: CLOUD,
    });
    expect(p).toBe(join(bundleDir, 'workflows/cloud/ltx23_director_cloud.json'));
  });

  it('derives the _cloud variant by convention when no explicit cloud path is set', () => {
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/ltx_director_local.json',
      bundleDir,
      endpointUrl: CLOUD,
    });
    expect(p).toBe(join(bundleDir, 'workflows/ltx_director_cloud.json'));
  });

  it('falls back to the canonical path when the cloud variant does not exist', () => {
    rmSync(join(bundleDir, 'workflows/ltx_director_cloud.json'));
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/ltx_director_local.json',
      bundleDir,
      endpointUrl: CLOUD,
    });
    expect(p).toBe(join(bundleDir, 'workflows/ltx_director_local.json'));
  });

  it('passes an absolute path through unchanged', () => {
    const abs = join(bundleDir, 'workflows/ltx_director_local.json');
    expect(resolveWorkflowPath({ workflowPath: abs, bundleDir })).toBe(abs);
  });

  it('falls back to REPO_ROOT when the path is not bundle-relative', () => {
    // The real shipped cloud graph lives at <repo>/workflows/cloud/. With a
    // bundleDir that doesn't contain it, the resolver must fall back to
    // REPO_ROOT and actually find the file that ships with dhee-core.
    const p = resolveWorkflowPath({
      workflowPath: 'workflows/cloud/ltx23_director_cloud.json',
      bundleDir,
      endpointUrl: CLOUD,
    });
    expect(p.endsWith('workflows/cloud/ltx23_director_cloud.json')).toBe(true);
    expect(p).not.toContain(bundleDir);
  });
});
