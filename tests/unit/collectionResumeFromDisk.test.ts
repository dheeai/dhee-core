/**
 * Tests for `listCollectionItemsFromDisk` — used by ExecutorAgent's
 * `expandPendingCollections` to resume a collection (character, setting,
 * scene, object) from per-item content files already on disk, instead of
 * re-running LLM extraction.
 *
 * Why this matters: on restart, the in-memory dependency graph may have
 * lost its expanded per-item character nodes (the previous process was
 * killed mid-flight, before a flush). The LLM-extraction Strategy C
 * then re-runs and produces a *different* set of items (e.g. 5 scenes
 * instead of 3) — non-deterministic LLM output that breaks alignment
 * with downstream artifacts already on disk.
 *
 * The disk-based resume is deterministic: filenames in characters/ are
 * the source of truth.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { listCollectionItemsFromDisk } from '../../src/core/planner/collectionResumeFromDisk.js';
import type { ArtifactTypeDefinition } from '../../src/core/templates/types.js';

function mkTypeDef(over: Partial<ArtifactTypeDefinition> & Pick<ArtifactTypeDefinition, 'id' | 'filePattern'>): ArtifactTypeDefinition {
  return {
    displayName: 'Test',
    category: 'entity',
    description: 'test',
    scope: 'project',
    isCollection: true,
    outputFormat: 'markdown',
    agentType: 'content',
    promptFile: 'x.md',
    isExpensive: false,
    requiresPerItemApproval: false,
    dependencies: [],
    ...over,
  } as ArtifactTypeDefinition;
}

describe('listCollectionItemsFromDisk', () => {
  let projectDir: string;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'dhee-collresume-'));
  });

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('returns [] when typeDef has no filePattern', () => {
    const td = mkTypeDef({ id: 'character', filePattern: undefined as unknown as string });
    expect(listCollectionItemsFromDisk(projectDir, td)).toEqual([]);
  });

  it('returns [] when the target directory does not exist', () => {
    const td = mkTypeDef({ id: 'character', filePattern: 'characters/{{name}}.md' });
    expect(listCollectionItemsFromDisk(projectDir, td)).toEqual([]);
  });

  it('returns one item per .md file in the directory, using the stem as itemId', () => {
    mkdirSync(join(projectDir, 'characters'));
    writeFileSync(join(projectDir, 'characters', 'jan.md'), '# Jan\n\nFighter.');
    writeFileSync(join(projectDir, 'characters', 'bishwa.md'), '# Bishwa\n\nBlacksmith.');
    const td = mkTypeDef({ id: 'character', filePattern: 'characters/{{name}}.md' });
    const items = listCollectionItemsFromDisk(projectDir, td);
    expect(items.map(i => i.itemId).sort()).toEqual(['bishwa', 'jan']);
  });

  it('uses the first markdown heading as display name when present', () => {
    mkdirSync(join(projectDir, 'characters'));
    writeFileSync(join(projectDir, 'characters', 'jan.md'), '# Jan The Brave\n\nFighter.');
    const td = mkTypeDef({ id: 'character', filePattern: 'characters/{{name}}.md' });
    const items = listCollectionItemsFromDisk(projectDir, td);
    expect(items[0]).toEqual({ itemId: 'jan', name: 'Jan The Brave' });
  });

  it('falls back to stem (with underscores → spaces) when no heading present', () => {
    mkdirSync(join(projectDir, 'settings'));
    writeFileSync(join(projectDir, 'settings', 'blacksmith_s_hut.md'), 'no heading here');
    const td = mkTypeDef({ id: 'setting', filePattern: 'settings/{{name}}.md' });
    const items = listCollectionItemsFromDisk(projectDir, td);
    expect(items[0]).toEqual({ itemId: 'blacksmith_s_hut', name: 'blacksmith s hut' });
  });

  it('substitutes {{chapter}} with chapter_1 in the path', () => {
    mkdirSync(join(projectDir, 'chapters', 'chapter_1', 'scenes'), { recursive: true });
    writeFileSync(join(projectDir, 'chapters', 'chapter_1', 'scenes', 'scene_1.md'), '# Morning Attack');
    writeFileSync(join(projectDir, 'chapters', 'chapter_1', 'scenes', 'scene_2.md'), '# Investigation');
    const td = mkTypeDef({
      id: 'scene',
      filePattern: 'chapters/{{chapter}}/scenes/{{name}}.md',
    });
    const items = listCollectionItemsFromDisk(projectDir, td);
    expect(items.map(i => i.itemId).sort()).toEqual(['scene_1', 'scene_2']);
    expect(items.find(i => i.itemId === 'scene_1')!.name).toBe('Morning Attack');
  });

  it('honours custom file extensions in the filePattern', () => {
    mkdirSync(join(projectDir, 'prompts'));
    writeFileSync(join(projectDir, 'prompts', 'a.json'), '{}');
    writeFileSync(join(projectDir, 'prompts', 'b.json'), '{}');
    writeFileSync(join(projectDir, 'prompts', 'README.md'), 'noise');
    const td = mkTypeDef({ id: 'thing', filePattern: 'prompts/{{name}}.json' });
    const items = listCollectionItemsFromDisk(projectDir, td);
    expect(items.map(i => i.itemId).sort()).toEqual(['a', 'b']);
  });

  it('ignores files that do not match the pattern extension', () => {
    mkdirSync(join(projectDir, 'characters'));
    writeFileSync(join(projectDir, 'characters', 'jan.md'), '# Jan');
    writeFileSync(join(projectDir, 'characters', '.DS_Store'), 'mac noise');
    writeFileSync(join(projectDir, 'characters', 'ignore.txt'), 'wrong ext');
    const td = mkTypeDef({ id: 'character', filePattern: 'characters/{{name}}.md' });
    const items = listCollectionItemsFromDisk(projectDir, td);
    expect(items.map(i => i.itemId)).toEqual(['jan']);
  });

  it('produces a stable, alphabetically sorted result', () => {
    mkdirSync(join(projectDir, 'characters'));
    writeFileSync(join(projectDir, 'characters', 'zod.md'), '');
    writeFileSync(join(projectDir, 'characters', 'alpha.md'), '');
    writeFileSync(join(projectDir, 'characters', 'mike.md'), '');
    const td = mkTypeDef({ id: 'character', filePattern: 'characters/{{name}}.md' });
    const items = listCollectionItemsFromDisk(projectDir, td);
    expect(items.map(i => i.itemId)).toEqual(['alpha', 'mike', 'zod']);
  });

  it('skips json files that are not parseable / unrelated metadata files', () => {
    mkdirSync(join(projectDir, 'characters'));
    writeFileSync(join(projectDir, 'characters', 'jan.md'), '# Jan');
    // Some templates write a sidecar manifest.json the same dir — must not
    // become a phantom "manifest" item.
    writeFileSync(join(projectDir, 'characters', 'manifest.json'), '{}');
    const td = mkTypeDef({ id: 'character', filePattern: 'characters/{{name}}.md' });
    const items = listCollectionItemsFromDisk(projectDir, td);
    expect(items.map(i => i.itemId)).toEqual(['jan']);
  });
});
