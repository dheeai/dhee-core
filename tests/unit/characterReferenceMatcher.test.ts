import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  matchUploadedReferences,
  matchUploadedCharacterReferences,
  type CharacterReferenceTarget,
} from '../../src/core/planner/characterReferenceMatcher.js';
import type { ProjectInput } from '../../src/tasks/video/workflow/types.js';

let tempDir: string | null = null;

function makeProject(): string {
  tempDir = mkdtempSync(join(tmpdir(), 'dhee-character-ref-matcher-'));
  mkdirSync(join(tempDir, 'assets/uploads/characters'), { recursive: true });
  mkdirSync(join(tempDir, 'assets/uploads/settings'), { recursive: true });
  mkdirSync(join(tempDir, 'assets/uploads/references'), { recursive: true });
  return tempDir;
}

function imageInput(
  id: string,
  filename: string,
  metadata: Partial<ProjectInput['metadata']> = {},
  purpose: ProjectInput['purpose'] = 'character_ref',
  directory = 'assets/uploads/characters',
): ProjectInput {
  return {
    id,
    source: {
      type: 'local_path',
      value: `${directory}/${filename}`,
    },
    mediaType: 'image',
    purpose,
    metadata: {
      originalFilename: filename,
      addedAt: 1,
      ...metadata,
    },
    processing: {
      status: 'completed',
      localPath: `${directory}/${filename}`,
    },
  };
}

const targets: CharacterReferenceTarget[] = [
  { id: 'character_image:leo', itemId: 'leo', displayName: 'Character Reference Images: Leo' },
  { id: 'character_image:coach_harris', itemId: 'coach_harris', displayName: 'Character Reference Images: Coach Harris' },
];

describe('character reference matcher', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('matches explicit metadata before filename or fallback', () => {
    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'assets/uploads/characters/generic.png'), 'image');

    const assignments = matchUploadedCharacterReferences({
      projectDir,
      inputs: [imageInput('input-1', 'generic.png', { matchedCharacterId: 'coach_harris' })],
      targets,
    });

    expect(assignments.get('character_image:coach_harris')).toEqual(expect.objectContaining({
      relativePath: 'assets/uploads/characters/generic.png',
      matchStrategy: 'metadata',
    }));
    expect(assignments.has('character_image:leo')).toBe(false);
  });

  it('matches uploaded filenames to character IDs and names', () => {
    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'assets/uploads/characters/coach-harris-reference.png'), 'image');

    const assignments = matchUploadedCharacterReferences({
      projectDir,
      inputs: [imageInput('input-1', 'coach-harris-reference.png')],
      targets,
    });

    expect(assignments.get('character_image:coach_harris')).toEqual(expect.objectContaining({
      relativePath: 'assets/uploads/characters/coach-harris-reference.png',
      matchStrategy: 'filename',
    }));
    expect(assignments.has('character_image:leo')).toBe(false);
  });

  it('falls back to the first main character for a generic upload', () => {
    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'assets/uploads/characters/boy.png'), 'image');

    const assignments = matchUploadedCharacterReferences({
      projectDir,
      inputs: [imageInput('input-1', 'boy.png')],
      targets,
    });

    expect(assignments.get('character_image:leo')).toEqual(expect.objectContaining({
      relativePath: 'assets/uploads/characters/boy.png',
      matchStrategy: 'ordered_fallback',
    }));
    expect(assignments.has('character_image:coach_harris')).toBe(false);
  });

  it('assigns multiple uploads once each', () => {
    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'assets/uploads/characters/boy.png'), 'image');
    writeFileSync(join(projectDir, 'assets/uploads/characters/coach.png'), 'image');

    const assignments = matchUploadedCharacterReferences({
      projectDir,
      inputs: [
        imageInput('input-1', 'boy.png'),
        imageInput('input-2', 'coach.png'),
      ],
      targets,
    });

    expect(assignments.get('character_image:leo')?.input.id).toBe('input-1');
    expect(assignments.get('character_image:coach_harris')?.input.id).toBe('input-2');
    expect(assignments.get('character_image:coach_harris')?.matchStrategy).toBe('filename');
  });

  it('ignores inputs whose copied file is missing', () => {
    const projectDir = makeProject();

    const assignments = matchUploadedCharacterReferences({
      projectDir,
      inputs: [imageInput('input-1', 'missing.png')],
      targets,
    });

    expect(assignments.size).toBe(0);
  });

  it('maps an explicit setting upload to a setting_image node', () => {
    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'assets/uploads/settings/field.png'), 'image');

    const assignments = matchUploadedReferences({
      projectDir,
      inputs: [
        imageInput(
          'input-field',
          'field.png',
          { matchedSettingId: 'football_field' },
          'setting_ref',
          'assets/uploads/settings',
        ),
      ],
      targets: [
        { id: 'character_image:leo', itemId: 'leo', displayName: 'Character Reference Images: Leo', kind: 'character' },
        { id: 'setting_image:football_field', itemId: 'football_field', displayName: 'Setting Reference Images: football field', kind: 'setting' },
      ],
    });

    expect(assignments.get('setting_image:football_field')).toEqual(expect.objectContaining({
      relativePath: 'assets/uploads/settings/field.png',
      targetKind: 'setting',
      matchStrategy: 'metadata',
    }));
    expect(assignments.has('character_image:leo')).toBe(false);
  });

  it('matches an auto filename to a setting node without falling back to a character', () => {
    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'assets/uploads/references/field.png'), 'image');

    const assignments = matchUploadedReferences({
      projectDir,
      inputs: [
        imageInput(
          'input-field',
          'field.png',
          {},
          'reference_general',
          'assets/uploads/references',
        ),
      ],
      targets: [
        { id: 'character_image:leo', itemId: 'leo', displayName: 'Character Reference Images: Leo', kind: 'character' },
        { id: 'setting_image:field', itemId: 'field', displayName: 'Setting Reference Images: field', kind: 'setting' },
      ],
    });

    expect(assignments.get('setting_image:field')).toEqual(expect.objectContaining({
      relativePath: 'assets/uploads/references/field.png',
      targetKind: 'setting',
      matchStrategy: 'filename',
    }));
    expect(assignments.has('character_image:leo')).toBe(false);
  });

  it('does not ordered-fallback an ambiguous auto upload', () => {
    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'assets/uploads/references/image.png'), 'image');

    const assignments = matchUploadedReferences({
      projectDir,
      inputs: [
        imageInput(
          'input-auto',
          'image.png',
          {},
          'reference_general',
          'assets/uploads/references',
        ),
      ],
      targets: [
        { id: 'character_image:leo', itemId: 'leo', displayName: 'Character Reference Images: Leo', kind: 'character' },
        { id: 'setting_image:field', itemId: 'field', displayName: 'Setting Reference Images: field', kind: 'setting' },
      ],
    });

    expect(assignments.size).toBe(0);
  });

  it('single-fallbacks an auto upload only when one graph target is plausible', () => {
    const projectDir = makeProject();
    writeFileSync(join(projectDir, 'assets/uploads/references/image.png'), 'image');

    const assignments = matchUploadedReferences({
      projectDir,
      inputs: [
        imageInput(
          'input-auto',
          'image.png',
          {},
          'reference_general',
          'assets/uploads/references',
        ),
      ],
      targets: [
        { id: 'setting_image:field', itemId: 'field', displayName: 'Setting Reference Images: field', kind: 'setting' },
      ],
    });

    expect(assignments.get('setting_image:field')).toEqual(expect.objectContaining({
      relativePath: 'assets/uploads/references/image.png',
      targetKind: 'setting',
      matchStrategy: 'single_auto',
    }));
  });
});
