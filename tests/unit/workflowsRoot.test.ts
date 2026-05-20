/**
 * `setUserWorkflowsDir()` lets the embedding host (dhee-desktop)
 * point the WorkflowModeRegistry at a writable directory it controls
 * (typically `userData/workflows/user/`) without losing access to the
 * built-in / cloud workflows that ship with dhee-core.
 *
 * Init order requirement: the host must call `setUserWorkflowsDir()`
 * BEFORE the first `getWorkflowModeRegistry()` call. We assert and
 * throw if violated so timing bugs surface immediately rather than
 * silently scanning the wrong directory.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { WorkflowModeRegistry } from '../../src/services/providers/WorkflowModeRegistry.js';
import {
  setUserWorkflowsDir,
  getUserWorkflowsDir,
  resetUserWorkflowsDirForTesting,
} from '../../src/services/providers/workflowsRoot.js';

const STUB_USER_MANIFEST = {
  id: 'my_custom_workflow',
  displayName: 'My Custom Workflow',
  pipeline: 'image_generation',
  llmDescription: 'A user-uploaded test workflow',
  selectionCriteria: 'Use this for tests',
  outputType: 'image',
  priority: 5,
  inputRequirements: [
    { id: 'prompt', type: 'text', source: 'llm', required: true },
  ],
  workflowFile: 'my_custom_workflow.json',
  format: 'api',
  parameterMappings: [{ input: 'prompt', nodeId: '6', field: 'text' }],
};

describe('setUserWorkflowsDir — host-supplied user workflow directory', () => {
  let coreRoot: string;
  let userDir: string;

  beforeEach(() => {
    resetUserWorkflowsDirForTesting();

    // Fake dhee-core layout: only built-in, no user/ subdir.
    coreRoot = mkdtempSync(join(tmpdir(), 'dhee-core-'));
    const builtInDir = join(coreRoot, 'workflows', 'built-in');
    mkdirSync(builtInDir, { recursive: true });

    // Separate, host-owned user workflows dir (e.g. userData/workflows/user/).
    userDir = mkdtempSync(join(tmpdir(), 'dhee-userwf-'));
    writeFileSync(
      join(userDir, 'my_custom_workflow.manifest.json'),
      JSON.stringify(STUB_USER_MANIFEST),
    );
    writeFileSync(join(userDir, 'my_custom_workflow.json'), '{}');
  });

  afterEach(() => {
    resetUserWorkflowsDirForTesting();
    rmSync(coreRoot, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  it('returns undefined by default (no override set)', () => {
    expect(getUserWorkflowsDir()).toBeUndefined();
  });

  it('round-trips a directory path', () => {
    setUserWorkflowsDir(userDir);
    expect(getUserWorkflowsDir()).toBe(userDir);
  });

  it('makes the registry discover manifests in the user directory', () => {
    setUserWorkflowsDir(userDir);

    const reg = new WorkflowModeRegistry(coreRoot);
    reg.refresh();

    const mode = reg.getMode('my_custom_workflow');
    expect(mode).toBeDefined();
    expect(mode?.displayName).toBe('My Custom Workflow');
    // User workflows are NOT built-in
    expect(mode?.builtIn).toBe(false);
  });

  it('the user directory is scanned in addition to the dhee-core workflow dirs (not replacing them)', () => {
    // Add a built-in manifest under coreRoot so we can verify both
    // are discovered when setUserWorkflowsDir is set.
    const builtInDir = join(coreRoot, 'workflows', 'built-in');
    writeFileSync(
      join(builtInDir, 'shipped.manifest.json'),
      JSON.stringify({
        ...STUB_USER_MANIFEST,
        id: 'shipped',
        displayName: 'Shipped Workflow',
        mode: 'local',
        workflowFile: 'shipped.json',
      }),
    );
    writeFileSync(join(builtInDir, 'shipped.json'), '{}');

    setUserWorkflowsDir(userDir);
    const reg = new WorkflowModeRegistry(coreRoot);
    reg.refresh();

    expect(reg.getMode('shipped')).toBeDefined();
    expect(reg.getMode('my_custom_workflow')).toBeDefined();
  });

  it('rejects setting the user dir to a non-existent path (catch typos early)', () => {
    expect(() =>
      setUserWorkflowsDir('/does/not/exist/at/all'),
    ).toThrow(/does not exist/i);
  });

  it('rejects setting the user dir to a file (must be a directory)', () => {
    const filePath = join(userDir, 'my_custom_workflow.manifest.json');
    expect(() => setUserWorkflowsDir(filePath)).toThrow(/not a directory/i);
  });
});
