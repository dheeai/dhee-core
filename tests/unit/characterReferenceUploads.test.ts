import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendCharacterReferenceImagesToContent,
  addProjectLocalCharacterReferenceInputs,
  buildCharacterReferenceProjectInputs,
  copyCharacterReferenceImagesToProject,
  normalizeProjectLocalCharacterReferenceImages,
} from '../../src/server/characterReferenceUploads.js';

let tempDir: string | null = null;

function makeTempProject(): { root: string; uploadsDir: string; projectDir: string } {
  tempDir = mkdtempSync(join(tmpdir(), 'dhee-character-refs-'));
  const uploadsDir = join(tempDir, 'uploads');
  const projectDir = join(tempDir, 'demo.dhee');
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(join(projectDir, 'assets/uploads/characters'), { recursive: true });
  return { root: tempDir, uploadsDir, projectDir };
}

describe('character reference uploads', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('copies staged images into project-local character uploads with collision suffixes', () => {
    const { uploadsDir, projectDir } = makeTempProject();
    const sourcePath = join(uploadsDir, 'alice.png');
    writeFileSync(sourcePath, 'uploaded');
    writeFileSync(join(projectDir, 'assets/uploads/characters/alice.png'), 'existing');

    const copied = copyCharacterReferenceImagesToProject({
      projectDir,
      uploadsDir,
      stagedUploads: [{
        name: 'alice.png',
        path: sourcePath,
        mimeType: 'image/png',
        size: 8,
      }],
    });

    expect(copied).toEqual([expect.objectContaining({
      name: 'alice-2.png',
      originalFilename: 'alice.png',
      relativePath: 'assets/uploads/characters/alice-2.png',
      mimeType: 'image/png',
      size: 8,
    })]);
    expect(readFileSync(join(projectDir, 'assets/uploads/characters/alice-2.png'), 'utf-8')).toBe('uploaded');
  });

  it('formats copied images into prompt content and project inputs', () => {
    const copied = [{
      name: 'alice.png',
      sourcePath: '/tmp/dhee/uploads/alice.png',
      relativePath: 'assets/uploads/characters/alice.png',
      mimeType: 'image/png',
      size: 8,
    }];

    expect(appendCharacterReferenceImagesToContent('A story prompt', copied)).toBe(
      'A story prompt\n\nAttached character reference images:\n- alice.png: assets/uploads/characters/alice.png',
    );

    expect(buildCharacterReferenceProjectInputs(copied, 123)).toEqual([expect.objectContaining({
      id: 'character-ref-123-1',
      source: {
        type: 'local_path',
        value: 'assets/uploads/characters/alice.png',
        originalValue: '/tmp/dhee/uploads/alice.png',
      },
      metadata: expect.objectContaining({
        originalFilename: 'alice.png',
      }),
      mediaType: 'image',
      purpose: 'character_ref',
      processing: {
        status: 'completed',
        localPath: 'assets/uploads/characters/alice.png',
      },
    })]);
  });

  it('normalizes project-local images and appends inputs without duplicates', () => {
    const { projectDir } = makeTempProject();
    const imagePath = join(projectDir, 'assets/uploads/characters/hero.png');
    writeFileSync(imagePath, 'hero');
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
      title: 'demo',
      inputs: [],
    }, null, 2));

    const normalized = normalizeProjectLocalCharacterReferenceImages({
      projectDir,
      images: [{
        name: 'hero.png',
        relativePath: 'assets/uploads/characters/hero.png',
        sourcePath: '/Users/me/Desktop/hero.png',
        originalFilename: 'Hero Portrait.png',
        mimeType: 'image/png',
      }],
    });

    expect(normalized).toEqual([expect.objectContaining({
      name: 'hero.png',
      originalFilename: 'Hero Portrait.png',
      relativePath: 'assets/uploads/characters/hero.png',
    })]);

    const first = addProjectLocalCharacterReferenceInputs({
      projectDir,
      images: normalized,
      now: 456,
      notes: 'Added from desktop chat.',
    });
    const second = addProjectLocalCharacterReferenceInputs({
      projectDir,
      images: normalized,
      now: 789,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8'));
    expect(project.inputs).toHaveLength(1);
    expect(project.inputs[0]).toEqual(expect.objectContaining({
      id: 'character-ref-456-1',
      notes: 'Added from desktop chat.',
      source: expect.objectContaining({
        value: 'assets/uploads/characters/hero.png',
        originalValue: '/Users/me/Desktop/hero.png',
      }),
      metadata: expect.objectContaining({
        originalFilename: 'Hero Portrait.png',
      }),
    }));
  });
});
