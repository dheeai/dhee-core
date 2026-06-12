import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveSettingReferenceBinding,
  writeSettingReferenceBindingOutput,
} from '../../src/dag/projectSettingReferences.js';

let projectDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'setting-ref-'));
  mkdirSync(join(projectDir, 'plans'), { recursive: true });
  mkdirSync(join(projectDir, 'assets/uploads/settings'), { recursive: true });
  writeFileSync(
    join(projectDir, 'plans/settings_plan.json'),
    JSON.stringify({
      settings: [
        { id: 'everest_base_camp', name: 'Everest Base Camp' },
        { id: 'summit_ridge', name: 'Summit Ridge' },
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

function settingRefInput(path: string, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `input-${path}`,
    source: { type: 'local_path', value: path },
    mediaType: 'image',
    purpose: 'setting_ref',
    metadata: {
      originalFilename: path.split('/').pop(),
      referenceRole: 'setting',
      ...metadata,
    },
    processing: { status: 'completed', localPath: path },
  };
}

describe('project setting reference binding', () => {
  it('maps one setup setting reference to the first planned setting', () => {
    writeFileSync(join(projectDir, 'assets/uploads/settings/everest.png'), 'uploaded');
    writeProjectInputs([
      settingRefInput('assets/uploads/settings/everest.png'),
    ]);

    const binding = resolveSettingReferenceBinding({
      projectDir,
      settingId: 'everest_base_camp',
    });

    expect(binding).toMatchObject({
      settingId: 'everest_base_camp',
      sourceRel: 'assets/uploads/settings/everest.png',
      strategy: 'single_reference_first_setting',
    });

    const result = writeSettingReferenceBindingOutput({
      projectDir,
      outputPath: 'assets/images/settings/everest_base_camp.png',
      binding: binding!,
    });

    expect(result.ok).toBe(true);
    expect(readFileSync(join(projectDir, 'assets/images/settings/everest_base_camp.png'), 'utf8')).toBe('uploaded');
    expect(result.metadata).toMatchObject({
      generationTool: 'project.setting_reference',
      userSupplied: true,
    });
  });

  it('uses explicit replacement metadata when multiple references exist', () => {
    writeFileSync(join(projectDir, 'assets/uploads/settings/base.png'), 'base');
    writeFileSync(join(projectDir, 'assets/uploads/settings/summit.png'), 'summit');
    writeProjectInputs([
      settingRefInput('assets/uploads/settings/base.png'),
      settingRefInput('assets/uploads/settings/summit.png', {
        replacementSettingId: 'summit_ridge',
        replacementSettingName: 'Summit Ridge',
      }),
    ]);

    const binding = resolveSettingReferenceBinding({
      projectDir,
      settingId: 'summit_ridge',
    });

    expect(binding).toMatchObject({
      settingId: 'summit_ridge',
      sourceRel: 'assets/uploads/settings/summit.png',
      strategy: 'explicit_id',
    });
  });

  it('leaves multiple unlabelled references unresolved instead of guessing', () => {
    writeFileSync(join(projectDir, 'assets/uploads/settings/one.png'), 'one');
    writeFileSync(join(projectDir, 'assets/uploads/settings/two.png'), 'two');
    writeProjectInputs([
      settingRefInput('assets/uploads/settings/one.png'),
      settingRefInput('assets/uploads/settings/two.png'),
    ]);

    expect(resolveSettingReferenceBinding({
      projectDir,
      settingId: 'everest_base_camp',
    })).toBeNull();
  });
});
