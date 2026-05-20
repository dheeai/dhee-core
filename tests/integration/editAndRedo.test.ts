/**
 * TDD Tests for Edit & Redo feature.
 *
 * Tests the REST endpoint for loading prompt data and the
 * save-before-redo logic for edited prompts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `edit-redo-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true });
});

function createTestProject(nodes: Record<string, any>) {
  const projectDir = join(testDir, 'test.dhee');
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(join(projectDir, 'assets', 'images'), { recursive: true });
  mkdirSync(join(projectDir, 'prompts', 'images', 'characters'), { recursive: true });
  mkdirSync(join(projectDir, 'prompts', 'images', 'settings'), { recursive: true });
  mkdirSync(join(projectDir, 'prompts', 'images', 'shots'), { recursive: true });
  mkdirSync(join(projectDir, 'prompts', 'motion'), { recursive: true });

  const project = {
    id: 'test',
    title: 'Test Project',
    templateId: 'narrative',
    executorState: { nodes },
  };
  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2));
  return projectDir;
}

// ──────────────────────────────────────────────────────────────────────────────
// Prompt resolution: find prompt file for any node type
// ──────────────────────────────────────────────────────────────────────────────

describe('Edit & Redo: prompt file resolution', () => {
  it('resolveNodePromptPath returns shot_image_prompt outputPath for shot_image nodes', async () => {
    const { resolveNodePromptPath } = await import('../../src/server/editAndRedo.js');

    const nodes = {
      'shot_image_prompt:scene_1_shot_1': {
        id: 'shot_image_prompt:scene_1_shot_1',
        typeId: 'shot_image_prompt',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        outputPath: 'prompts/images/shots/scene-1-shot-1.json',
      },
      'shot_image:scene_1_shot_1': {
        id: 'shot_image:scene_1_shot_1',
        typeId: 'shot_image',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        outputPath: 'assets/images/shot_s1s1.png',
      },
    };

    const result = resolveNodePromptPath('shot_image:scene_1_shot_1', nodes);
    expect(result).toBe('prompts/images/shots/scene-1-shot-1.json');
  });

  it('resolveNodePromptPath returns motion directive path for shot_video nodes', async () => {
    const { resolveNodePromptPath } = await import('../../src/server/editAndRedo.js');

    const nodes = {
      'shot_motion_directive:scene_1_shot_1': {
        id: 'shot_motion_directive:scene_1_shot_1',
        typeId: 'shot_motion_directive',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        outputPath: 'prompts/motion/scene_1_shot_1.json',
      },
      'shot_video:scene_1_shot_1': {
        id: 'shot_video:scene_1_shot_1',
        typeId: 'shot_video',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        outputPath: 'assets/videos/shots/s1s1.mp4',
      },
    };

    const result = resolveNodePromptPath('shot_video:scene_1_shot_1', nodes);
    expect(result).toBe('prompts/motion/scene_1_shot_1.json');
  });

  it('resolveNodePromptPath returns character prompt path for character_image nodes', async () => {
    const { resolveNodePromptPath } = await import('../../src/server/editAndRedo.js');

    const nodes = {
      'character_image:kai': {
        id: 'character_image:kai',
        typeId: 'character_image',
        itemId: 'kai',
        status: 'completed',
        outputPath: 'assets/images/char_kai.png',
        promptPath: 'prompts/images/characters/kai.json',
      },
    };

    const result = resolveNodePromptPath('character_image:kai', nodes);
    expect(result).toContain('characters/kai');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Save edited prompt: write to disk
// ──────────────────────────────────────────────────────────────────────────────

describe('Edit & Redo: save edited prompt', () => {
  it('saveEditedPrompt writes new content to shot_image_prompt file', async () => {
    const { saveEditedPrompt } = await import('../../src/server/editAndRedo.js');

    const projectDir = createTestProject({
      'shot_image_prompt:scene_1_shot_1': {
        id: 'shot_image_prompt:scene_1_shot_1',
        typeId: 'shot_image_prompt',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        outputPath: 'prompts/images/shots/scene-1-shot-1.json',
      },
      'shot_image:scene_1_shot_1': {
        id: 'shot_image:scene_1_shot_1',
        typeId: 'shot_image',
        itemId: 'scene_1_shot_1',
        status: 'completed',
      },
    });

    // Create original prompt file
    const originalPrompt = { imagePrompt: 'original prompt', negativePrompt: 'bad', references: [] };
    writeFileSync(
      join(projectDir, 'prompts/images/shots/scene-1-shot-1.json'),
      JSON.stringify(originalPrompt),
    );

    // Save edited prompt
    const edited = { imagePrompt: 'edited prompt with new details', negativePrompt: 'worse' };
    await saveEditedPrompt(projectDir, 'shot_image:scene_1_shot_1', edited);

    // Verify file was overwritten
    const content = JSON.parse(readFileSync(
      join(projectDir, 'prompts/images/shots/scene-1-shot-1.json'),
      'utf-8',
    ));
    expect(content.imagePrompt).toBe('edited prompt with new details');
  });

  it('saveEditedPrompt writes motion directive for shot_video nodes', async () => {
    const { saveEditedPrompt } = await import('../../src/server/editAndRedo.js');

    const projectDir = createTestProject({
      'shot_motion_directive:scene_1_shot_1': {
        id: 'shot_motion_directive:scene_1_shot_1',
        typeId: 'shot_motion_directive',
        itemId: 'scene_1_shot_1',
        status: 'completed',
        outputPath: 'prompts/motion/scene_1_shot_1.json',
      },
      'shot_video:scene_1_shot_1': {
        id: 'shot_video:scene_1_shot_1',
        typeId: 'shot_video',
        itemId: 'scene_1_shot_1',
        status: 'completed',
      },
    });

    // Create original motion file
    writeFileSync(
      join(projectDir, 'prompts/motion/scene_1_shot_1.json'),
      JSON.stringify({ motionDirective: 'old motion' }),
    );

    // Save edited motion
    await saveEditedPrompt(projectDir, 'shot_video:scene_1_shot_1', {
      motionDirective: 'New motion: figure walks forward, slow push-in',
    });

    const content = JSON.parse(readFileSync(
      join(projectDir, 'prompts/motion/scene_1_shot_1.json'),
      'utf-8',
    ));
    expect(content.motionDirective).toBe('New motion: figure walks forward, slow push-in');
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Available references: collect for shot images
// ──────────────────────────────────────────────────────────────────────────────

describe('Edit & Redo: available references', () => {
  it('getAvailableReferences returns all completed character/setting/object images', async () => {
    const { getAvailableReferences } = await import('../../src/server/editAndRedo.js');

    const nodes = {
      'character_image:kai': {
        id: 'character_image:kai',
        typeId: 'character_image',
        itemId: 'kai',
        status: 'completed',
        outputPath: 'assets/images/char_kai.png',
      },
      'setting_image:bridge': {
        id: 'setting_image:bridge',
        typeId: 'setting_image',
        itemId: 'bridge',
        status: 'completed',
        outputPath: 'assets/images/set_bridge.png',
      },
      'character_image:aria': {
        id: 'character_image:aria',
        typeId: 'character_image',
        itemId: 'aria',
        status: 'pending', // Not completed — should be excluded
      },
    };

    const refs = getAvailableReferences(nodes, 'test-project');
    expect(refs.length).toBe(2);
    expect(refs.find(r => r.nodeId === 'character_image:kai')).toBeDefined();
    expect(refs.find(r => r.nodeId === 'setting_image:bridge')).toBeDefined();
    expect(refs.find(r => r.nodeId === 'character_image:aria')).toBeUndefined();
  });
});
