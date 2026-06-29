/**
 * Regression: bundle + workflow paths must resolve against dhee-core's
 * package root (REPO_ROOT), NOT process.cwd(). When dhee-core is
 * loaded as a library inside a host process (Electron desktop, packaged
 * CLI), cwd is the host's working directory — using cwd silently
 * ENOENT'd the bundle/workflow JSON files and the dispatcher returned
 * a confusing generic error.
 *
 * Both surfaces affected:
 *   - `runProjectInProcess` resolves the bundle JSON path
 *   - `walker.ts` resolves the bundle-declared relative `workflowPath`
 *
 * These tests pin both: they chdir to a temp dir (simulating the
 * non-package cwd a host process would have) and verify the
 * REPO_ROOT-anchored paths still resolve to real files.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { loadBundle } from '../../src/dag/walker.js';
import { REPO_ROOT } from '../../src/agent/pi/paths.js';

describe('DAG bundle path resolution', () => {
  let originalCwd: string;
  let tmpDir: string;

  beforeEach(() => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'dhee-bundle-paths-'));
    // Simulate a host process whose cwd is unrelated to the dhee-core
    // package root — the exact failure mode the desktop hit when the
    // dispatcher resolved `src/dag/bundles/...` against cwd.
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads the prompt_relay bundle from a non-package cwd via REPO_ROOT', () => {
    // First, prove the broken (pre-fix) cwd-relative path WOULD have failed.
    // This is the failure mode we're regression-testing against.
    const cwdRelativePath = resolve(
      process.cwd(),
      'src/dag/bundles/ltx_prompt_relay.json',
    );
    expect(existsSync(cwdRelativePath)).toBe(false);

    // Now the REPO_ROOT-anchored path the dispatcher uses today:
    const repoRootPath = resolve(REPO_ROOT, 'src/dag/bundles/ltx_prompt_relay.json');
    expect(existsSync(repoRootPath)).toBe(true);

    const bundle = loadBundle(repoRootPath);
    expect(bundle.id).toBe('ltx_prompt_relay');
    expect(bundle.goal).toBe('final_video');
  });

  it('the bundle-declared relative workflowPath resolves under REPO_ROOT to a real file', () => {
    // walker.ts (in `buildRunnerContext`) resolves bundle config
    // `workflowPath` against REPO_ROOT when it's relative. This pins
    // that the canonical bundle's declared workflowPath does land on
    // a real file — i.e. the bundle + repo are internally consistent
    // and the host can find the workflow JSON from any cwd.
    const bundle = loadBundle(
      resolve(REPO_ROOT, 'src/dag/bundles/ltx_prompt_relay.json'),
    );
    const sceneClipNode = bundle.nodes.find((n) => n.id === 'scene_clip');
    expect(sceneClipNode).toBeDefined();

    const declared = (sceneClipNode!.runner.config as Record<string, unknown>)[
      'workflowPath'
    ];
    expect(typeof declared).toBe('string');
    const declaredPath = declared as string;

    // Bundle must declare a relative path (so it's portable across users
    // with different repo locations) — not an absolute path baked in.
    expect(declaredPath.startsWith('/')).toBe(false);

    // The cwd-relative resolution (the bug) would have failed from /tmp:
    const cwdRelative = resolve(process.cwd(), declaredPath);
    expect(existsSync(cwdRelative)).toBe(false);

    // The REPO_ROOT-relative resolution (the fix) succeeds:
    const repoRootRelative = resolve(REPO_ROOT, declaredPath);
    expect(existsSync(repoRootRelative)).toBe(true);
  });

  it('BUG-001 regression — bundle points at the non-chain director workflow (first-chunk safe)', () => {
    // Originally this test pinned the chain workflow (commit 25b7edf)
    // on the mistaken belief that the non-chain variant had a 4-seg
    // cap. The 4-seg cap actually belongs to a separate workflow file
    // (`ltx23_promptrelay_4seg_local.json`). The chain variant
    // requires an EXISTING source video (for continuation across
    // chunks) — when run on a first chunk with no source, its
    // VHS_LoadVideo node errors with "input directory could not be
    // loaded with cv" because no `video` input was supplied. That
    // bug, BUG-001, surfaced live on The Cup project's first
    // end-to-end relay attempt. Fix: revert to non-chain for the
    // default single-chunk path. Multi-chunk runs that need chain
    // continuation should be a future per-instance workflow switch
    // inside the runner (BUG-001 manifestation (b)).
    const bundle = loadBundle(
      resolve(REPO_ROOT, 'src/dag/bundles/ltx_prompt_relay.json'),
    );
    const sceneClipNode = bundle.nodes.find((n) => n.id === 'scene_clip');
    const declared = (sceneClipNode!.runner.config as Record<string, unknown>)[
      'workflowPath'
    ] as string;
    expect(declared).toMatch(/ltx23_director_local\.json$/);
    expect(declared).not.toMatch(/_chain_/);

    // Independent assertion: the declared workflow on disk must NOT
    // contain a VHS_LoadVideo node. The runner doesn't supply a
    // source video; the workflow can't depend on one for first-chunk
    // operation.
    const wfPath = resolve(REPO_ROOT, declared);
    const wf = JSON.parse(readFileSync(wfPath, 'utf-8')) as Record<
      string,
      { class_type?: string }
    >;
    const vhsLoaders = Object.entries(wf).filter(
      ([, n]) => n.class_type === 'VHS_LoadVideo',
    );
    expect(vhsLoaders).toEqual([]);
  });
});
