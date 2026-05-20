import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFailedAttempt, clearFailedAttempt } from '../../src/core/planner/writeFailedAttempt.js';
import type { ExecutionNode } from '../../src/core/planner/types.js';
import type { VideoTemplate } from '../../src/core/templates/types.js';

function shotImagePromptTemplate(): VideoTemplate {
  return {
    id: 't',
    displayName: 'T',
    description: '',
    version: '1.0.0',
    defaultStyle: 'd',
    styles: [{ id: 'd', displayName: 'D', description: '', promptModifiers: [], negativePrompt: [] }],
    inputTypes: [],
    artifactTypes: {
      shot_image_prompt: {
        id: 'shot_image_prompt',
        displayName: 'Shot Composition',
        category: 'structure',
        description: '',
        isCollection: true,
        itemName: 'shot prompt',
        outputFormat: 'markdown',
        filePattern: 'prompts/images/shots/scene-{{index}}-shot-{{subindex}}.json',
        agentType: 'content',
        promptFile: '',
        isExpensive: false,
        requiresPerItemApproval: false,
        dependencies: [],
      },
    },
    contextVariables: {},
    orchestratorPrompt: '',
  } as VideoTemplate;
}

function shotNode(itemId: string): ExecutionNode {
  return {
    id: `shot_image_prompt:${itemId}`,
    typeId: 'shot_image_prompt',
    itemId,
    displayName: `Shot Composition: ${itemId}`,
    status: 'failed',
    dependencies: [],
    dependents: [],
    isExpensive: false,
    isCollection: true,
  } as ExecutionNode;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kshana-failed-attempt-'));
});

afterEach(() => {
  // Restore writable perms on anything we chmod-ed in the read-only test.
  try { chmodSync(tmpDir, 0o755); } catch { /* may not exist */ }
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('writeFailedAttempt', () => {
  it('GIVEN a shot_image_prompt failure with broken JSON content WHEN writing THEN both .failed and .failed.error files land at the artifact path', () => {
    // The exact repro for today's symptom: shot_9 in scene 1
    // failed validation. The user needs the broken JSON on disk
    // to inspect/repair, plus the validator's reason next to it.
    const node = shotNode('scene_1_shot_9');
    const brokenContent =
      '{"imagePrompt": "a vast surreal arena", "references": []}';
    const errorMsg =
      'No reference to any known character / setting / object found in the imagePrompt or references[]. Expected at least one of: character_image:protagonist.';

    const result = writeFailedAttempt(
      node,
      brokenContent,
      errorMsg,
      tmpDir,
      shotImagePromptTemplate(),
    );

    expect(result.contentPath).toBe('prompts/images/shots/scene-1-shot-9.json.failed');
    expect(result.errorPath).toBe('prompts/images/shots/scene-1-shot-9.json.failed.error');

    expect(readFileSync(join(tmpDir, result.contentPath!), 'utf-8')).toBe(brokenContent);
    expect(readFileSync(join(tmpDir, result.errorPath!), 'utf-8')).toBe(errorMsg);
  });

  it('GIVEN a non-existent parent directory WHEN writing THEN the directory tree is created and both files land', () => {
    // First-run failures hit before any prompts/images/shots/
    // directory has been created. The helper must mkdir -p.
    const node = shotNode('scene_2_shot_1');
    const result = writeFailedAttempt(
      node,
      '{"x": 1}',
      'bad',
      tmpDir,
      shotImagePromptTemplate(),
    );

    expect(result.contentPath).not.toBeNull();
    expect(existsSync(join(tmpDir, result.contentPath!))).toBe(true);
    expect(existsSync(join(tmpDir, result.errorPath!))).toBe(true);
  });

  it('GIVEN an existing previous .failed file WHEN writing THEN it is overwritten with the latest broken content (no stale leftovers)', () => {
    const node = shotNode('scene_1_shot_9');
    writeFailedAttempt(node, 'first attempt', 'first error', tmpDir, shotImagePromptTemplate());
    const second = writeFailedAttempt(node, 'second attempt', 'second error', tmpDir, shotImagePromptTemplate());

    expect(readFileSync(join(tmpDir, second.contentPath!), 'utf-8')).toBe('second attempt');
    expect(readFileSync(join(tmpDir, second.errorPath!), 'utf-8')).toBe('second error');
  });

  it('GIVEN previously-written sidecars + a successful retry WHEN clearFailedAttempt runs THEN both files are removed (no stale broken markers)', () => {
    // Repro for the user-visible cleanup case: shot_9 fails first
    // pass, .failed lands. json_repair then succeeds and we write
    // the proper artefact via writeOutput. The `.failed` next to
    // the now-valid artefact is misleading — must go.
    const node = shotNode('scene_1_shot_9');
    writeFailedAttempt(node, '{"x":1}', 'bad', tmpDir, shotImagePromptTemplate());
    const contentAbs = join(tmpDir, 'prompts/images/shots/scene-1-shot-9.json.failed');
    const errorAbs = join(tmpDir, 'prompts/images/shots/scene-1-shot-9.json.failed.error');
    expect(existsSync(contentAbs)).toBe(true);
    expect(existsSync(errorAbs)).toBe(true);

    clearFailedAttempt(node, tmpDir, shotImagePromptTemplate());

    expect(existsSync(contentAbs)).toBe(false);
    expect(existsSync(errorAbs)).toBe(false);
  });

  it('GIVEN no sidecars exist WHEN clearFailedAttempt runs THEN it is a no-op (idempotent — safe to call before writeOutput unconditionally)', () => {
    const node = shotNode('scene_1_shot_1');
    expect(() => clearFailedAttempt(node, tmpDir, shotImagePromptTemplate())).not.toThrow();
  });

  it('GIVEN the parent dir is read-only WHEN writing THEN both paths come back null and no exception escapes (the original validation error stays the primary signal)', () => {
    // Make the project root read-only so the mkdir/write fails.
    // The helper must swallow — we don't want a sidecar I/O issue
    // to mask the user's real problem (the LLM hallucination).
    const lockedDir = join(tmpDir, 'locked');
    mkdirSync(lockedDir);
    chmodSync(lockedDir, 0o555);

    const node = shotNode('scene_1_shot_9');
    const result = writeFailedAttempt(
      node,
      '{"x":1}',
      'bad',
      lockedDir,
      shotImagePromptTemplate(),
    );

    expect(result.contentPath).toBeNull();
    expect(result.errorPath).toBeNull();
  });
});
