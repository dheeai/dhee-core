import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveCharacterReferenceBinding,
  writeCharacterReferenceBindingOutput,
} from '../../src/dag/projectCharacterReferences.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'char-ref-'));
  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  mkdirSync(join(projectDir, 'assets/uploads/characters'), { recursive: true });
  writeFileSync(
    join(projectDir, 'plans/characters_plan.json'),
    JSON.stringify({
      characters: [
        { id: 'arjun', name: 'Arjun' },
        { id: 'arjuns_father', name: "Arjun's Father" },
      ],
    }),
  );
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

function writeProjectInputs(inputs: unknown[]): void {
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({ inputs }, null, 2));
}

function characterRefInput(path: string, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `input-${path}`,
    source: { type: 'local_path', value: path },
    mediaType: 'image',
    purpose: 'character_ref',
    metadata: {
      originalFilename: path.split('/').pop(),
      referenceRole: 'character',
      ...metadata,
    },
    processing: { status: 'completed', localPath: path },
  };
}

describe('project character reference binding', () => {
  it('maps one setup character reference to the first planned character', () => {
    writeFileSync(join(projectDir, 'assets/uploads/characters/hero.png'), 'uploaded');
    writeProjectInputs([
      characterRefInput('assets/uploads/characters/hero.png'),
    ]);

    const binding = resolveCharacterReferenceBinding({ projectDir, characterId: 'arjun' });

    expect(binding).toMatchObject({
      characterId: 'arjun',
      sourceRel: 'assets/uploads/characters/hero.png',
      strategy: 'single_reference_first_character',
    });

    const result = writeCharacterReferenceBindingOutput({
      projectDir,
      outputPath: 'assets/images/characters/arjun.png',
      binding: binding!,
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(projectDir, 'assets/images/characters/arjun.png'), 'utf8')).toBe('uploaded');
  });

  it('uses explicit replacement metadata when multiple references exist', () => {
    writeFileSync(join(projectDir, 'assets/uploads/characters/boy.png'), 'boy');
    writeFileSync(join(projectDir, 'assets/uploads/characters/father.png'), 'father');
    writeProjectInputs([
      characterRefInput('assets/uploads/characters/boy.png'),
      characterRefInput('assets/uploads/characters/father.png', {
        replacementCharacterId: 'arjuns_father',
        replacementCharacterName: "Arjun's Father",
      }),
    ]);

    const binding = resolveCharacterReferenceBinding({ projectDir, characterId: 'arjuns_father' });

    expect(binding).toMatchObject({
      characterId: 'arjuns_father',
      sourceRel: 'assets/uploads/characters/father.png',
      strategy: 'explicit_id',
    });
  });

  it('leaves multiple unlabelled references unresolved instead of guessing', () => {
    writeFileSync(join(projectDir, 'assets/uploads/characters/one.png'), 'one');
    writeFileSync(join(projectDir, 'assets/uploads/characters/two.png'), 'two');
    writeProjectInputs([
      characterRefInput('assets/uploads/characters/one.png'),
      characterRefInput('assets/uploads/characters/two.png'),
    ]);

    expect(resolveCharacterReferenceBinding({ projectDir, characterId: 'arjun' })).toBeNull();
  });
});
