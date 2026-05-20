/**
 * Single source of truth tests for the workflow integration helpers.
 * Both pi-agent tools and REST routes wrap these — coverage here is
 * what proves the contract for both call sites.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  validateWorkflowFile,
  analyzeWorkflowFile,
  saveWorkflow,
  listWorkflows,
  getWorkflow,
  updateWorkflow,
  deleteWorkflow,
  refreshWorkflowRegistry,
  WorkflowIntegrationError,
} from '../../src/services/comfyui/workflowIntegration.js';
import {
  setUserWorkflowsDir,
  resetUserWorkflowsDirForTesting,
} from '../../src/services/providers/workflowsRoot.js';
import { getWorkflowModeRegistry } from '../../src/services/providers/WorkflowModeRegistry.js';
import type { WorkflowManifest } from '../../src/services/providers/types.js';
import type { LLMClient } from '../../src/core/llm/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_API_WORKFLOW = JSON.stringify({
  '5': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
  '6': { class_type: 'KSampler', inputs: { seed: 42 } },
  '9': { class_type: 'SaveImage', inputs: {} },
});

const VALID_LITEGRAPH_WORKFLOW = JSON.stringify({
  nodes: [
    { id: 5, type: 'CLIPTextEncode', widgets_values: ['a cat'] },
    { id: 6, type: 'KSampler', widgets_values: [42] },
    { id: 9, type: 'SaveImage' },
  ],
  links: [],
});

function makeManifest(id: string): WorkflowManifest {
  return {
    id,
    displayName: id,
    pipeline: 'image_generation',
    llmDescription: 'Test workflow',
    selectionCriteria: 'Tests only',
    outputType: 'image',
    priority: 5,
    inputRequirements: [
      { id: 'prompt', type: 'text', source: 'llm', description: 'Prompt', required: true },
    ],
    workflowFile: `${id}.json`,
    format: 'api',
    parameterMappings: [{ input: 'prompt', nodeId: '5', field: 'text' }],
  };
}

// Returns canned analysis without hitting any network. Matches the
// LLMClient.generate({messages,temperature}) → {content} shape that
// analyzeWorkflowWithLLM consumes.
function mockLlm(): LLMClient {
  return {
    async generate() {
      return {
        content: JSON.stringify({
          pipeline: 'image_generation',
          displayName: 'Mocked Workflow',
          llmDescription: 'A mocked workflow.',
          selectionCriteria: 'Use this in tests.',
          suggestedMappings: [
            { nodeId: '5', classType: 'CLIPTextEncode', suggestedInput: 'prompt', reason: 'text input' },
          ],
          explanation: 'mock',
        }),
      };
    },
  } as unknown as LLMClient;
}

// ---------------------------------------------------------------------------
// Setup: each test gets its own user workflows dir + a tmpdir for source files
// ---------------------------------------------------------------------------

let userDir: string;
let sourceDir: string;

beforeEach(() => {
  resetUserWorkflowsDirForTesting();
  userDir = mkdtempSync(join(tmpdir(), 'dhee-userwf-'));
  sourceDir = mkdtempSync(join(tmpdir(), 'dhee-src-'));
  setUserWorkflowsDir(userDir);
});

afterEach(() => {
  resetUserWorkflowsDirForTesting();
  rmSync(userDir, { recursive: true, force: true });
  rmSync(sourceDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// validateWorkflowFile
// ---------------------------------------------------------------------------

describe('validateWorkflowFile', () => {
  it('returns ok for a valid API-format ComfyUI workflow', () => {
    const path = join(sourceDir, 'wf.json');
    writeFileSync(path, VALID_API_WORKFLOW);
    const result = validateWorkflowFile(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.totalNodes).toBe(3);
  });

  it('returns ok for a valid LiteGraph-format ComfyUI workflow', () => {
    const path = join(sourceDir, 'wf.json');
    writeFileSync(path, VALID_LITEGRAPH_WORKFLOW);
    const result = validateWorkflowFile(path);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.parsed.totalNodes).toBe(3);
  });

  it('returns reason when file does not exist', () => {
    const result = validateWorkflowFile('/nonexistent/file.json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not found/i);
  });

  it('returns reason when JSON is malformed', () => {
    const path = join(sourceDir, 'bad.json');
    writeFileSync(path, '{ this is not valid json');
    const result = validateWorkflowFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a valid ComfyUI workflow/i);
  });

  it('rejects an empty workflow with zero nodes', () => {
    const path = join(sourceDir, 'empty.json');
    writeFileSync(path, '{}');
    const result = validateWorkflowFile(path);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/zero nodes/i);
  });
});

// ---------------------------------------------------------------------------
// analyzeWorkflowFile
// ---------------------------------------------------------------------------

describe('analyzeWorkflowFile', () => {
  it('returns parsed + analysis when LLM succeeds', async () => {
    const path = join(sourceDir, 'wf.json');
    writeFileSync(path, VALID_API_WORKFLOW);
    const result = await analyzeWorkflowFile(path, mockLlm());
    expect(result.parsed.totalNodes).toBe(3);
    expect(result.analysis).not.toBeNull();
    expect(result.analysis?.displayName).toBe('Mocked Workflow');
    expect(result.llmFailed).toBe(false);
  });

  it('returns parsed + null analysis when LLM throws', async () => {
    const path = join(sourceDir, 'wf.json');
    writeFileSync(path, VALID_API_WORKFLOW);
    const failingLlm = {
      async generate() {
        throw new Error('rate limited');
      },
    } as unknown as LLMClient;
    const result = await analyzeWorkflowFile(path, failingLlm);
    expect(result.parsed.totalNodes).toBe(3);
    expect(result.analysis).toBeNull();
    expect(result.llmFailed).toBe(true);
    expect(result.llmError).toMatch(/rate limited/);
  });

  it('throws WorkflowIntegrationError when the file is not a valid workflow', async () => {
    const path = join(sourceDir, 'bad.json');
    writeFileSync(path, 'not json');
    await expect(analyzeWorkflowFile(path, mockLlm())).rejects.toThrow(WorkflowIntegrationError);
  });
});

// ---------------------------------------------------------------------------
// saveWorkflow
// ---------------------------------------------------------------------------

describe('saveWorkflow', () => {
  it('persists the workflow JSON and manifest under the user dir', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);

    const result = saveWorkflow({
      sourcePath,
      manifest: makeManifest('my_test'),
    });

    expect(result.finalId).toBe('my_test');
    expect(existsSync(join(userDir, 'my_test.json'))).toBe(true);
    expect(existsSync(join(userDir, 'my_test.manifest.json'))).toBe(true);

    const persisted = JSON.parse(readFileSync(join(userDir, 'my_test.manifest.json'), 'utf-8'));
    expect(persisted.id).toBe('my_test');
    expect(persisted.workflowFile).toBe('my_test.json');
    expect(persisted.builtIn).toBe(false);
  });

  it('makes the workflow visible to listWorkflows() immediately (registry refresh)', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({ sourcePath, manifest: makeManifest('after_save') });
    const list = listWorkflows({ userOnly: true });
    expect(list.some(w => w.id === 'after_save')).toBe(true);
  });

  it('sanitizes ids that contain unsafe characters', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);

    const result = saveWorkflow({
      sourcePath,
      manifest: { ...makeManifest('not safe id!'), id: 'not safe id!' },
    });
    expect(result.finalId).toBe('not_safe_id');
  });

  it('throws on collision by default', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({ sourcePath, manifest: makeManifest('dupe') });

    expect(() =>
      saveWorkflow({ sourcePath, manifest: makeManifest('dupe') }),
    ).toThrow(/already exists/i);
  });

  it('overwrites on collision when onConflict=overwrite', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({ sourcePath, manifest: { ...makeManifest('dupe'), displayName: 'First' } });
    const result = saveWorkflow({
      sourcePath,
      manifest: { ...makeManifest('dupe'), displayName: 'Second' },
      onConflict: 'overwrite',
    });
    expect(result.finalId).toBe('dupe');
    const persisted = JSON.parse(readFileSync(result.manifestPath, 'utf-8'));
    expect(persisted.displayName).toBe('Second');
  });

  it('renames on collision when onConflict=rename', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({ sourcePath, manifest: makeManifest('dupe') });
    const result = saveWorkflow({
      sourcePath,
      manifest: makeManifest('dupe'),
      onConflict: 'rename',
    });
    expect(result.finalId).toMatch(/^dupe_/);
    expect(result.finalId).not.toBe('dupe');
  });

  it('throws when source file is missing', () => {
    expect(() =>
      saveWorkflow({
        sourcePath: '/does/not/exist.json',
        manifest: makeManifest('x'),
      }),
    ).toThrow(/Source workflow file not found/);
  });

  // ── User uploads are local-only ─────────────────────────────────
  // User-supplied workflows reference custom nodes / model files
  // that exist on the user's local ComfyUI install. Cloud ComfyUI
  // is a managed service with a fixed set of nodes — running a
  // user workflow there would fail at submission. Lock the
  // persisted `mode` to 'local' regardless of what the caller asks
  // for.

  it('forces mode=local when persisting a user manifest', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({
      sourcePath,
      manifest: { ...makeManifest('local_lock'), mode: 'both' },
    });
    const persisted = JSON.parse(
      readFileSync(join(userDir, 'local_lock.manifest.json'), 'utf-8'),
    );
    expect(persisted.mode).toBe('local');
  });

  it('forces mode=local even when the caller explicitly asks for mode=cloud', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({
      sourcePath,
      manifest: { ...makeManifest('no_cloud_for_you'), mode: 'cloud' },
    });
    const persisted = JSON.parse(
      readFileSync(join(userDir, 'no_cloud_for_you.manifest.json'), 'utf-8'),
    );
    expect(persisted.mode).toBe('local');
  });

  it('updateWorkflow refuses to flip mode away from local', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({ sourcePath, manifest: makeManifest('still_local') });

    // The narrow WorkflowUpdate type doesn't include `mode` — but the
    // implementation should also defend at runtime if a caller goes
    // around the type via `as`.
    const result = updateWorkflow('still_local', {
      displayName: 'Renamed',
      ...({ mode: 'cloud' } as unknown as object),
    });
    expect(result.mode).toBe('local');
  });
});

// ---------------------------------------------------------------------------
// list / get
// ---------------------------------------------------------------------------

describe('listWorkflows / getWorkflow', () => {
  it('returns empty user list when nothing has been saved', () => {
    expect(listWorkflows({ userOnly: true })).toEqual([]);
  });

  it('returns saved workflows', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({ sourcePath, manifest: makeManifest('a') });
    saveWorkflow({ sourcePath, manifest: makeManifest('b') });

    const list = listWorkflows({ userOnly: true });
    const ids = list.map(w => w.id).sort();
    expect(ids).toContain('a');
    expect(ids).toContain('b');
  });

  it('getWorkflow returns the full manifest', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({ sourcePath, manifest: makeManifest('lookup_me') });

    const fetched = getWorkflow('lookup_me');
    expect(fetched).toBeDefined();
    expect(fetched?.id).toBe('lookup_me');
    expect(fetched?.parameterMappings).toHaveLength(1);
  });

  it('refreshWorkflowRegistry picks up COMFY_MODE flips so listWorkflows sees the new state', () => {
    const savedComfyMode = process.env['COMFY_MODE'];
    try {
      const sourcePath = join(sourceDir, 'src.json');
      writeFileSync(sourcePath, VALID_API_WORKFLOW);
      saveWorkflow({ sourcePath, manifest: makeManifest('mode_flip_test') });

      // Local mode: should be active.
      delete process.env['COMFY_MODE'];
      refreshWorkflowRegistry();
      expect(listWorkflows({ userOnly: true })
        .find(w => w.id === 'mode_flip_test')?.active).toBe(true);

      // Flip to cloud — without refreshWorkflowRegistry the registry
      // would still report active=true because the filter is applied
      // at refresh() time, not at lookup time.
      process.env['COMFY_MODE'] = 'cloud';
      refreshWorkflowRegistry();
      expect(listWorkflows({ userOnly: true })
        .find(w => w.id === 'mode_flip_test')?.active).toBe(false);

      // Flip back to local — refresh re-includes it.
      process.env['COMFY_MODE'] = 'local';
      refreshWorkflowRegistry();
      expect(listWorkflows({ userOnly: true })
        .find(w => w.id === 'mode_flip_test')?.active).toBe(true);
    } finally {
      if (savedComfyMode === undefined) delete process.env['COMFY_MODE'];
      else process.env['COMFY_MODE'] = savedComfyMode;
    }
  });

  it('user uploads stay visible (active=false) when the registry mode-filter hides them', () => {
    const savedComfyMode = process.env['COMFY_MODE'];
    try {
      // Save while in local mode (default) — registry sees the manifest.
      const sourcePath = join(sourceDir, 'src.json');
      writeFileSync(sourcePath, VALID_API_WORKFLOW);
      saveWorkflow({ sourcePath, manifest: makeManifest('cloud_hidden') });

      // Verify it's active in local mode.
      let list = listWorkflows({ userOnly: true });
      expect(list.find(w => w.id === 'cloud_hidden')?.active).toBe(true);

      // Flip to cloud mode + force a registry refresh — the local-only
      // user manifest disappears from registry.getAllModes(). Without
      // the raw-disk merge, the UI list would lose it entirely.
      process.env['COMFY_MODE'] = 'cloud';
      // Re-construct the registry the same way getWorkflowModeRegistry
      // does on first access — clearer than reaching for refresh()
      // through the singleton.
      resetUserWorkflowsDirForTesting();
      setUserWorkflowsDir(userDir);

      list = listWorkflows({ userOnly: true });
      const found = list.find(w => w.id === 'cloud_hidden');
      expect(found).toBeDefined();
      expect(found?.active).toBe(false);
    } finally {
      if (savedComfyMode === undefined) delete process.env['COMFY_MODE'];
      else process.env['COMFY_MODE'] = savedComfyMode;
    }
  });

  it('getWorkflow returns undefined for unknown ids', () => {
    expect(getWorkflow('does_not_exist')).toBeUndefined();
  });

  it('getWorkflow falls back to disk for mode-filtered user manifests', () => {
    const savedComfyMode = process.env['COMFY_MODE'];
    try {
      const sourcePath = join(sourceDir, 'src.json');
      writeFileSync(sourcePath, VALID_API_WORKFLOW);
      saveWorkflow({ sourcePath, manifest: makeManifest('hidden_in_cloud') });

      // Flip to cloud — registry no longer sees the local-only manifest.
      process.env['COMFY_MODE'] = 'cloud';
      refreshWorkflowRegistry();
      const fromRegistry = getWorkflowModeRegistry().getMode('hidden_in_cloud');
      expect(fromRegistry).toBeUndefined();

      // getWorkflow should still resolve via disk read.
      const fetched = getWorkflow('hidden_in_cloud');
      expect(fetched).toBeDefined();
      expect(fetched?.id).toBe('hidden_in_cloud');
      expect(fetched?.parameterMappings).toHaveLength(1);
    } finally {
      if (savedComfyMode === undefined) delete process.env['COMFY_MODE'];
      else process.env['COMFY_MODE'] = savedComfyMode;
    }
  });
});

// ---------------------------------------------------------------------------
// updateWorkflow
// ---------------------------------------------------------------------------

describe('updateWorkflow', () => {
  it('patches displayName and persists', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({ sourcePath, manifest: makeManifest('to_patch') });

    const updated = updateWorkflow('to_patch', { displayName: 'New Name' });
    expect(updated.displayName).toBe('New Name');

    const reloaded = getWorkflow('to_patch');
    expect(reloaded?.displayName).toBe('New Name');
  });

  it('refuses to patch a non-existent workflow', () => {
    expect(() => updateWorkflow('ghost', { displayName: 'x' })).toThrow(/No workflow with id/);
  });
});

// ---------------------------------------------------------------------------
// deleteWorkflow
// ---------------------------------------------------------------------------

describe('deleteWorkflow', () => {
  it('removes manifest + JSON and registry entry', () => {
    const sourcePath = join(sourceDir, 'src.json');
    writeFileSync(sourcePath, VALID_API_WORKFLOW);
    saveWorkflow({ sourcePath, manifest: makeManifest('to_delete') });

    expect(getWorkflow('to_delete')).toBeDefined();
    deleteWorkflow('to_delete');
    expect(getWorkflow('to_delete')).toBeUndefined();
    expect(existsSync(join(userDir, 'to_delete.json'))).toBe(false);
    expect(existsSync(join(userDir, 'to_delete.manifest.json'))).toBe(false);
  });

  it('refuses to delete a non-existent workflow', () => {
    expect(() => deleteWorkflow('ghost')).toThrow(/No workflow with id/);
  });
});
