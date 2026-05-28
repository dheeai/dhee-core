import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dheeReplaceCharacterReference } from '../../src/agent/pi/tools/replaceCharacterReference.js';
import type { ProjectInput } from '../../src/tasks/video/workflow/types.js';

let tempDir: string | null = null;

function executeReplace(params: unknown) {
  return dheeReplaceCharacterReference.execute(
    'call-id-1',
    params as never,
    undefined as never,
    undefined as never,
    {} as never,
  );
}

function makeNode(
  id: string,
  typeId: string,
  dependencies: string[] = [],
): Record<string, unknown> {
  return {
    id,
    typeId,
    itemId: id.includes(':') ? id.split(':')[1] : undefined,
    status: 'completed',
    dependencies,
    outputPath: `assets/${id.replace(/[^a-z0-9]+/gi, '_')}.out`,
    startedAt: 1,
    completedAt: 2,
  };
}

function prompt(refIds: string[], extraText = ''): object {
  return {
    shotNumber: 1,
    generationStrategy: 'flfv',
    frames: {
      first_frame: {
        imagePrompt: `first ${extraText}`,
        references: refIds.map((refId, index) => ({
          imageNumber: index + 1,
          type: refId.startsWith('setting_image:') ? 'setting' : 'character',
          refId,
        })),
      },
      last_frame: {
        imagePrompt: `last ${extraText}`,
        references: [],
      },
    },
    negativePrompt: extraText,
  };
}

function promptWithLastFrameRef(refId: string): object {
  return {
    shotNumber: 1,
    generationStrategy: 'flfv',
    frames: {
      first_frame: {
        imagePrompt: 'first',
        references: [{ imageNumber: 1, type: 'character', refId: 'character_image:ren_takahashi' }],
      },
      last_frame: {
        imagePrompt: 'last',
        references: [{ imageNumber: 1, type: 'character', refId }],
      },
    },
  };
}

function characterInput(id: string, filename: string): ProjectInput {
  return {
    id,
    source: {
      type: 'local_path',
      value: `assets/uploads/characters/${filename}`,
      originalValue: `/Users/me/${filename}`,
    },
    mediaType: 'image',
    purpose: 'character_ref',
    metadata: {
      originalFilename: filename,
      addedAt: 1,
      processedAt: 1,
      referenceRole: 'character',
      matchedCharacterId: filename.startsWith('Emna') ? 'emna_aoyama' : 'ren_takahashi',
      matchedCharacterName: filename.startsWith('Emna') ? 'Emna Aoyama' : 'Ren Takahashi',
      matchStrategy: 'filename',
    },
    processing: {
      status: 'completed',
      localPath: `assets/uploads/characters/${filename}`,
    },
  };
}

function makeProject(extraFemale = false): string {
  tempDir = mkdtempSync(join(tmpdir(), 'dhee-replace-char-'));
  const projectDir = join(tempDir, 'Summer-sky-2');
  mkdirSync(join(projectDir, 'assets/uploads/characters'), { recursive: true });
  mkdirSync(join(projectDir, 'assets/uploads/references'), { recursive: true });
  mkdirSync(join(projectDir, 'assets'), { recursive: true });
  mkdirSync(join(projectDir, 'characters'), { recursive: true });
  mkdirSync(join(projectDir, 'prompts/images/shots'), { recursive: true });

  writeFileSync(join(projectDir, 'assets/uploads/characters/Emna.png'), 'old-emna');
  writeFileSync(join(projectDir, 'assets/uploads/characters/Ren.png'), 'ren');
  writeFileSync(join(projectDir, 'assets/uploads/references/NewEmna.png'), 'new-emna');
  writeFileSync(join(projectDir, 'characters/emna_aoyama.md'), '**Role:** The Firework Girl\n\nEmna is a bright teenage girl.');
  writeFileSync(join(projectDir, 'characters/ren_takahashi.md'), '**Role:** The quiet boy\n\nRen is a teenage boy.');

  const characters = [
    {
      id: 'ren_takahashi',
      name: 'Ren Takahashi',
      referenceImageId: 'uploaded_charref_ren_takahashi_ren-input',
      referenceImagePath: 'assets/uploads/characters/Ren.png',
    },
    {
      id: 'emna_aoyama',
      name: 'Emna Aoyama',
      referenceImageId: 'uploaded_charref_emna_aoyama_emna-input',
      referenceImagePath: 'assets/uploads/characters/Emna.png',
    },
  ];

  if (extraFemale) {
    characters.push({
      id: 'maya',
      name: 'Maya',
      referenceImageId: 'uploaded_charref_maya_maya-input',
      referenceImagePath: 'assets/uploads/characters/Maya.png',
    });
    writeFileSync(join(projectDir, 'assets/uploads/characters/Maya.png'), 'maya');
    writeFileSync(join(projectDir, 'characters/maya.md'), '**Role:** Another girl\n\nMaya is a girl.');
  }

  const visibleEmnaShots = new Set([3, 6, 7, 9]);
  for (let i = 1; i <= 11; i += 1) {
    const promptPath = join(projectDir, `prompts/images/shots/scene-1-shot-${i}.json`);
    const json =
      i === 7
        ? promptWithLastFrameRef('character_image:emna_aoyama')
        : visibleEmnaShots.has(i)
          ? prompt(['character_image:emna_aoyama'])
          : prompt(
              ['character_image:ren_takahashi'],
              i === 4 || i === 10 ? 'Emna is mentioned offscreen and in negativePrompt' : '',
            );
    writeFileSync(promptPath, JSON.stringify(json, null, 2));
  }

  const nodes: Record<string, Record<string, unknown>> = {
    'character_image:ren_takahashi': {
      ...makeNode('character_image:ren_takahashi', 'character_image'),
      itemId: 'ren_takahashi',
      outputPath: 'assets/uploads/characters/Ren.png',
      artifactId: 'uploaded_charref_ren_takahashi_ren-input',
    },
    'character_image:emna_aoyama': {
      ...makeNode('character_image:emna_aoyama', 'character_image'),
      itemId: 'emna_aoyama',
      outputPath: 'assets/uploads/characters/Emna.png',
      artifactId: 'uploaded_charref_emna_aoyama_emna-input',
    },
  };

  const shotVideoIds: string[] = [];
  for (let i = 1; i <= 11; i += 1) {
    const shotId = `scene_1_shot_${i}`;
    nodes[`shot_image_prompt:${shotId}`] = {
      ...makeNode(`shot_image_prompt:${shotId}`, 'shot_image_prompt'),
      itemId: shotId,
      outputPath: `prompts/images/shots/scene-1-shot-${i}.json`,
    };
    nodes[`shot_image:${shotId}`] = {
      ...makeNode(`shot_image:${shotId}`, 'shot_image', [
        'character_image:ren_takahashi',
        'character_image:emna_aoyama',
        `shot_image_prompt:${shotId}`,
      ]),
      itemId: shotId,
      outputPath: `assets/images/shot-${i}.png`,
    };
    nodes[`shot_image_last_frame:${shotId}`] = {
      ...makeNode(`shot_image_last_frame:${shotId}`, 'shot_image_last_frame', [
        `shot_image:${shotId}`,
      ]),
      itemId: shotId,
      outputPath: `assets/images/shot-${i}-last.png`,
    };
    nodes[`shot_video:${shotId}`] = {
      ...makeNode(`shot_video:${shotId}`, 'shot_video', [
        `shot_image_last_frame:${shotId}`,
      ]),
      itemId: shotId,
      outputPath: `assets/videos/shot-${i}.mp4`,
    };
    shotVideoIds.push(`shot_video:${shotId}`);
  }
  nodes.final_video = makeNode('final_video', 'final_video', shotVideoIds);

  writeFileSync(join(projectDir, 'assets/manifest.json'), JSON.stringify({
    assets: [{
      id: 'uploaded_charref_emna_aoyama_emna-input',
      type: 'character_ref',
      path: 'assets/uploads/characters/Emna.png',
      version: 1,
      createdAt: 1,
      nodeId: 'character_image:emna_aoyama',
    }],
  }, null, 2));

  writeFileSync(join(projectDir, 'project.json'), JSON.stringify({
    version: '3.0',
    id: 'summer-sky-2',
    title: 'Summer-sky-2',
    style: 'anime',
    characters,
    assets: ['uploaded_charref_emna_aoyama_emna-input'],
    inputs: [
      characterInput('emna-input', 'Emna.png'),
      characterInput('ren-input', 'Ren.png'),
    ],
    executorState: {
      nodes,
    },
  }, null, 2));

  return projectDir;
}

describe('dhee_replace_character_reference', () => {
  afterEach(() => {
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  });

  it('replaces female lead refs and invalidates only prompt-visible shots', async () => {
    const projectDir = makeProject();

    const result = await executeReplace({
      project: 'Summer-sky-2',
      projectDir,
      character: 'female lead',
      referencePath: 'assets/uploads/references/NewEmna.png',
    });

    expect((result.details as { status: string }).status).toBe('completed');
    const details = result.details as {
      characterId: string;
      referencePath: string;
      matchedShots: string[];
      invalidated: string[];
    };
    expect(details.characterId).toBe('emna_aoyama');
    expect(details.referencePath).toBe('assets/uploads/characters/NewEmna.png');
    expect(details.matchedShots).toEqual([
      'scene_1_shot_3',
      'scene_1_shot_6',
      'scene_1_shot_7',
      'scene_1_shot_9',
    ]);

    for (const shot of details.matchedShots) {
      expect(details.invalidated).toContain(`shot_image:${shot}`);
      expect(details.invalidated).toContain(`shot_image_last_frame:${shot}`);
      expect(details.invalidated).toContain(`shot_video:${shot}`);
    }
    expect(details.invalidated).toContain('final_video');
    for (const untouched of [1, 2, 4, 5, 8, 10, 11]) {
      expect(details.invalidated).not.toContain(`shot_image:scene_1_shot_${untouched}`);
      expect(details.invalidated).not.toContain(`shot_video:scene_1_shot_${untouched}`);
    }
    expect(details.invalidated).not.toContain('character_image:emna_aoyama');

    const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8'));
    expect(project.characters.find((c: { id: string }) => c.id === 'emna_aoyama')).toMatchObject({
      referenceImageId: 'uploaded_charref_emna_aoyama_emna-input',
      referenceImagePath: 'assets/uploads/characters/NewEmna.png',
    });
    expect(project.inputs.find((input: { id: string }) => input.id === 'emna-input')).toMatchObject({
      source: { value: 'assets/uploads/characters/NewEmna.png' },
      purpose: 'character_ref',
      metadata: {
        matchedCharacterId: 'emna_aoyama',
        matchedCharacterName: 'Emna Aoyama',
        matchStrategy: 'metadata',
      },
      processing: {
        status: 'completed',
        localPath: 'assets/uploads/characters/NewEmna.png',
      },
    });
    expect(project.executorState.nodes['character_image:emna_aoyama']).toMatchObject({
      status: 'completed',
      outputPath: 'assets/uploads/characters/NewEmna.png',
      artifactId: 'uploaded_charref_emna_aoyama_emna-input',
    });
    expect(project.executorState.lastInvalidatedIds).toEqual(details.invalidated);

    const manifest = JSON.parse(readFileSync(join(projectDir, 'assets/manifest.json'), 'utf-8'));
    expect(manifest.assets).toContainEqual(expect.objectContaining({
      id: 'uploaded_charref_emna_aoyama_emna-input',
      type: 'character_ref',
      path: 'assets/uploads/characters/NewEmna.png',
      nodeId: 'character_image:emna_aoyama',
      metadata: expect.objectContaining({
        replacement: true,
        inputId: 'emna-input',
      }),
    }));
  });

  it('returns an ambiguity error without mutating project state', async () => {
    const projectDir = makeProject(true);
    const before = readFileSync(join(projectDir, 'project.json'), 'utf-8');

    const result = await executeReplace({
      project: 'Summer-sky-2',
      projectDir,
      character: 'female lead',
      referencePath: 'assets/uploads/references/NewEmna.png',
    });

    expect((result.details as { status: string }).status).toBe('failed');
    expect((result.details as { log: string }).log).toMatch(/ambiguous/i);
    expect(readFileSync(join(projectDir, 'project.json'), 'utf-8')).toBe(before);
  });
});
