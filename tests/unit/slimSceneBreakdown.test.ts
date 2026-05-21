/**
 * Schema-level contract tests for the slim scene_video_prompt format
 * (shot structure, no firstFrame/lastFrame) and the per-shot
 * shot_image_prompt format that owns frame descriptions and refs.
 *
 * Earlier this file also greped ExecutorAgent.ts and the prompt-skill
 * markdown for sentinel strings to "test" the system prompt and guide
 * contents; deleted because those tests pinned text rather than
 * behavior — and the hierarchical-breakdown refactor (Stage A → B → C)
 * made some of the sentinels stale anyway.
 */

import { describe, it, expect } from 'vitest';

describe('Slim scene breakdown: schema', () => {
  it('scene_video_prompt validates slim shot without firstFrame/lastFrame', async () => {
    const { validateWithSchema } = await import('../../src/core/planner/schemas.js');
    const result = validateWithSchema('scene_video_prompt', {
      sceneNumber: 1,
      sceneTitle: 'Test',
      totalDuration: 30,
      shots: [{
        shotNumber: 1,
        shotType: 'wide',
        duration: 5,
        description: 'Amber sunlight through curtains, dust motes drifting',
        characters: [],
        setting: 'bedroom',
        cameraWork: 'static, shallow DOF',
        soundCue: 'distant bird chirp',
        transition: 'fade',
      }],
    });
    expect(result.valid).toBe(true);
  });

  it('scene_video_prompt validates without generationStrategy', async () => {
    const { validateWithSchema } = await import('../../src/core/planner/schemas.js');
    const result = validateWithSchema('scene_video_prompt', {
      shots: [{
        shotNumber: 1,
        description: 'A character walks into frame',
        characters: ['kai'],
        setting: 'bridge',
      }],
    });
    expect(result.valid).toBe(true);
  });

  it('shot_image_prompt with generationStrategy validates', async () => {
    const { validateWithSchema } = await import('../../src/core/planner/schemas.js');
    const result = validateWithSchema('shot_image_prompt', {
      shotNumber: 1,
      generationStrategy: 'flfv',
      frames: {
        first_frame: {
          imagePrompt: 'A wide establishing shot of the village',
          generationMode: 'image_text_to_image',
          references: [{ imageNumber: 1, type: 'setting', refId: 'setting_image:village' }],
        },
        last_frame: {
          imagePrompt: 'Character has entered from the left',
          generationMode: 'edit_first_frame',
          references: [],
        },
      },
      negativePrompt: 'blurry',
      aspectRatio: '16:9',
    });
    expect(result.valid).toBe(true);
  });
});

describe('Slim scene breakdown: 7-field format with purpose', () => {
  it('schema accepts 7-field shot (no shotType, no secondaryPurpose)', async () => {
    const { validateWithSchema } = await import('../../src/core/planner/schemas.js');
    const result = validateWithSchema('scene_video_prompt', {
      shots: [{
        shotNumber: 1,
        purpose: 'set_the_mood',
        duration: 4,
        description: 'Raindrops strike a brass bell',
        cameraWork: 'extreme close-up, macro, static, shallow DOF',
        audio: 'metallic ring of rain on brass',
        transition: 'fade',
      }],
    });
    expect(result.valid).toBe(true);
  });

  it('schema accepts valid purpose enum values', async () => {
    const { purposeValues } = await import('../../src/core/planner/schemas.js');
    expect(purposeValues).toContain('set_the_world');
    expect(purposeValues).toContain('meet_character');
    expect(purposeValues).toContain('show_dialogue');
    expect(purposeValues).toContain('show_change');
    expect(purposeValues).toContain('punctuate');
    expect(purposeValues.length).toBe(12);
  });

  it('shotTypeValues is no longer exported', async () => {
    const mod = await import('../../src/core/planner/schemas.js');
    expect((mod as any).shotTypeValues).toBeUndefined();
  });
});

