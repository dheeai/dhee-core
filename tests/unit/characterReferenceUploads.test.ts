import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendReferenceImagesToContent,
  appendCharacterReferenceImagesToContent,
  addProjectLocalCharacterReferenceInputs,
  addProjectLocalReferenceInputs,
  buildReferenceImageProjectInputs,
  buildCharacterReferenceProjectInputs,
  copyReferenceImagesToProject,
  copyCharacterReferenceImagesToProject,
  normalizeProjectLocalReferenceImages,
  normalizeProjectLocalCharacterReferenceImages,
} from '../../src/server/characterReferenceUploads.js';

let tempDir: string | null = null;

function makeTempProject(): { root: string; uploadsDir: string; projectDir: string } {
  tempDir = mkdtempSync(join(tmpdir(), 'dhee-character-refs-'));
  const uploadsDir = join(tempDir, 'uploads');
  const projectDir = join(tempDir, 'demo.dhee');
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(join(projectDir, 'assets/uploads/characters'), { recursive: true });
  mkdirSync(join(projectDir, 'assets/uploads/settings'), { recursive: true });
  mkdirSync(join(projectDir, 'assets/uploads/references'), { recursive: true });
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

  it('copies and formats setting and auto reference images separately', () => {
    const { uploadsDir, projectDir } = makeTempProject();
    const fieldPath = join(uploadsDir, 'field.png');
    const genericPath = join(uploadsDir, 'image.png');
    writeFileSync(fieldPath, 'field');
    writeFileSync(genericPath, 'generic');

    const copied = copyReferenceImagesToProject({
      projectDir,
      uploadsDir,
      stagedUploads: [
        {
          name: 'field.png',
          path: fieldPath,
          referenceRole: 'setting',
          mimeType: 'image/png',
        },
        {
          name: 'image.png',
          path: genericPath,
          referenceRole: 'auto',
          mimeType: 'image/png',
        },
      ],
    });

    expect(copied).toEqual([
      expect.objectContaining({
        relativePath: 'assets/uploads/settings/field.png',
        purpose: 'setting_ref',
        referenceRole: 'setting',
      }),
      expect.objectContaining({
        relativePath: 'assets/uploads/references/image.png',
        purpose: 'reference_general',
        referenceRole: 'auto',
      }),
    ]);

    expect(appendReferenceImagesToContent('A story prompt', copied)).toBe(
      [
        'A story prompt',
        '',
        'Attached setting reference images:',
        '- field.png: assets/uploads/settings/field.png',
        '',
        'Attached reference images:',
        '- image.png: assets/uploads/references/image.png',
      ].join('\n'),
    );

    expect(buildReferenceImageProjectInputs(copied, 123)).toEqual([
      expect.objectContaining({
        id: 'setting-ref-123-1',
        purpose: 'setting_ref',
        metadata: expect.objectContaining({ referenceRole: 'setting' }),
      }),
      expect.objectContaining({
        id: 'reference-image-123-2',
        purpose: 'reference_general',
        metadata: expect.objectContaining({ referenceRole: 'auto' }),
      }),
    ]);
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

  it('normalizes project-local setting images and appends inputs without duplicates', () => {
    const { projectDir } = makeTempProject();
    const imagePath = join(projectDir, 'assets/uploads/settings/field.png');
    writeFileSync(imagePath, 'field');
    writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
      title: 'demo',
      inputs: [],
    }, null, 2));

    const normalized = normalizeProjectLocalReferenceImages({
      projectDir,
      images: [{
        name: 'field.png',
        relativePath: 'assets/uploads/settings/field.png',
        sourcePath: '/Users/me/Desktop/field.png',
        originalFilename: 'Field.png',
        mimeType: 'image/png',
        referenceRole: 'setting',
      }],
    });

    expect(normalized).toEqual([expect.objectContaining({
      purpose: 'setting_ref',
      referenceRole: 'setting',
      relativePath: 'assets/uploads/settings/field.png',
    })]);

    const first = addProjectLocalReferenceInputs({
      projectDir,
      images: normalized,
      now: 456,
      notes: 'Added from desktop chat.',
    });
    const second = addProjectLocalReferenceInputs({
      projectDir,
      images: normalized,
      now: 789,
    });

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8'));
    expect(project.inputs).toHaveLength(1);
    expect(project.inputs[0]).toEqual(expect.objectContaining({
      id: 'setting-ref-456-1',
      purpose: 'setting_ref',
      notes: 'Added from desktop chat.',
      source: expect.objectContaining({
        value: 'assets/uploads/settings/field.png',
        originalValue: '/Users/me/Desktop/field.png',
      }),
      metadata: expect.objectContaining({
        originalFilename: 'Field.png',
        referenceRole: 'setting',
      }),
    }));
  });
});
