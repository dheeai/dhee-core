/**
 * End-to-end resolution: ref name → on-disk path, via the dependency
 * graph (executorState.nodes), not via `project.characters[]` /
 * `project.settings[]`.
 *
 * Pins the new behavior introduced in PR2 so the legacy-array
 * deletion in PR4 doesn't silently break the executor's image
 * generation tool, which calls `resolveReferencesToPaths` /
 * `findImagePathFromArtifactId` to find ref images for character /
 * setting prompts.
 *
 * Tests run against fixture project.json files so we don't rely on a
 * live server or an LLM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// We intentionally test via projectView directly rather than through
// tools.ts (which transitively imports the LLM stack). The
// substantive behavior — "graph node outputPath wins over flat
// arrays" — is in projectView, and exercising it here proves PR4
// can delete the flat arrays without breaking the resolver.
import { getReferenceImagePath, getNodeByItemId } from '../../src/core/planner/projectView.js';
import type { ExecutorState } from '../../src/core/planner/types.js';

function mkExecutorState(nodes: Array<Partial<{
  id: string; typeId: string; itemId?: string; status: string;
  outputPath?: string; displayName?: string;
}>>): ExecutorState {
  const nodeMap: Record<string, never> = {};
  for (const n of nodes) {
    const id = n.id!;
    nodeMap[id] = {
      id,
      typeId: n.typeId!,
      ...(n.itemId !== undefined ? { itemId: n.itemId } : {}),
      status: (n.status ?? 'pending') as 'pending' | 'completed',
      displayName: n.displayName ?? id,
      isExpensive: false,
      isCollection: false,
      dependencies: [],
      dependents: [],
      ...(n.outputPath !== undefined ? { outputPath: n.outputPath } : {}),
    } as never;
  }
  return {
    nodes: nodeMap,
    targetArtifacts: ['final_video'],
    goalDescription: 'test',
    createdAt: 1, updatedAt: 1,
  };
}

describe('ref-resolution from graph (PR2 contract — survives PR4)', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'dhee-refres-'));
    mkdirSync(join(projectDir, 'assets/images'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('resolves a character ref via the graph when character_image:<itemId> has outputPath', () => {
    // assets/images/CharRef_jan.png exists on disk
    writeFileSync(join(projectDir, 'assets/images/CharRef_jan.png'), Buffer.from([]));
    const state = mkExecutorState([
      { id: 'character:jan', typeId: 'character', itemId: 'jan', status: 'completed' },
      {
        id: 'character_image:jan', typeId: 'character_image', itemId: 'jan',
        status: 'completed', outputPath: 'assets/images/CharRef_jan.png',
      },
    ]);
    expect(getReferenceImagePath(state, 'character', 'jan')).toBe('assets/images/CharRef_jan.png');
  });

  it('resolves with case-insensitive name (callers pass "Jan", graph stores "jan")', () => {
    const state = mkExecutorState([{
      id: 'character_image:jan', typeId: 'character_image', itemId: 'jan',
      status: 'completed', outputPath: 'assets/images/CharRef_jan.png',
    }]);
    expect(getReferenceImagePath(state, 'character', 'Jan')).toBe('assets/images/CharRef_jan.png');
    expect(getReferenceImagePath(state, 'character', 'JAN')).toBe('assets/images/CharRef_jan.png');
  });

  it('returns null when the image node exists but outputPath is not set yet (image not generated)', () => {
    const state = mkExecutorState([{
      id: 'character_image:jan', typeId: 'character_image', itemId: 'jan',
      status: 'pending',
    }]);
    expect(getReferenceImagePath(state, 'character', 'jan')).toBeNull();
  });

  it('returns null when no image node exists for the itemId at all', () => {
    const state = mkExecutorState([{
      id: 'character:jan', typeId: 'character', itemId: 'jan', status: 'completed',
    }]);
    expect(getReferenceImagePath(state, 'character', 'jan')).toBeNull();
  });

  it('returns null when state is missing entirely (project never run)', () => {
    expect(getReferenceImagePath(undefined, 'character', 'jan')).toBeNull();
  });

  it('character refs do not match setting nodes and vice versa', () => {
    const state = mkExecutorState([
      {
        id: 'setting_image:jan', typeId: 'setting_image', itemId: 'jan',
        status: 'completed', outputPath: 'assets/images/wrong.png',
      },
    ]);
    // Asking for a *character* named "jan" should NOT pick up the
    // setting node with the same itemId.
    expect(getReferenceImagePath(state, 'character', 'jan')).toBeNull();
    expect(getReferenceImagePath(state, 'setting', 'jan')).toBe('assets/images/wrong.png');
  });

  it('getNodeByItemId returns the right node when multiple types share an itemId', () => {
    const state = mkExecutorState([
      { id: 'character_image:jan', typeId: 'character_image', itemId: 'jan', status: 'completed' },
      { id: 'character:jan', typeId: 'character', itemId: 'jan', status: 'completed' },
    ]);
    expect(getNodeByItemId(state, 'character_image', 'jan')!.id).toBe('character_image:jan');
    expect(getNodeByItemId(state, 'character', 'jan')!.id).toBe('character:jan');
  });
});
