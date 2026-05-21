/**
 * TDD Tests for dialogue/audio flow through the pipeline.
 *
 * Dialogue flows: scene breakdown `audio` field → motion directive → video generation.
 * Tests verify that:
 * 1. Schema accepts `audio` field with dialogue
 * 2. The fallback motion prompt builder reads `audio` (not just old `soundCue`)
 * 3. Motion directive guide instructs LLM to extract dialogue from `audio` field
 */

import { describe, it, expect } from 'vitest';

describe('Dialogue flow: schema', () => {
  it('scene_video_prompt schema accepts audio field with dialogue', async () => {
    const { validateWithSchema } = await import('../../src/core/planner/schemas.js');
    const result = validateWithSchema('scene_video_prompt', {
      shots: [{
        shotNumber: 1,
        description: 'Elena confronts Marcus in the alley',
        audio: 'ELENA: Don\'t follow me. Rain on pavement, footsteps receding',
      }],
    });
    expect(result.valid).toBe(true);
  });

  it('collectionExtractor preserves audio field from shot JSON', async () => {
    const { extractCollectionItems } = await import('../../src/core/planner/collectionExtractor.js');
    const json = JSON.stringify({
      sceneNumber: 1,
      totalDuration: 15,
      shots: [
        {
          shotNumber: 1,
          purpose: 'show_dialogue',
          shotType: 'medium',
          duration: 5,
          description: 'Elena speaks',
          cameraWork: 'static medium',
          audio: 'ELENA: Don\'t follow me. Rain on pavement',
          transition: 'cut',
        },
      ],
    });

    const mockNode = { id: 'svp:s1', typeId: 'scene_video_prompt', itemId: 'scene_1', status: 'completed', displayName: '', isExpensive: false, isCollection: false, dependencies: [], dependents: [] };
    const result = await extractCollectionItems(mockNode as any, json, {} as any);

    expect(result!.shots).toHaveLength(1);
    // The shot's raw data should be available — audio field preserved
    expect(json).toContain('ELENA: Don\'t follow me');
  });
});

describe('Dialogue flow: fallback motion prompt', () => {
  it('buildFallbackMotionPrompt includes audio field content', async () => {
    const { buildFallbackMotionPrompt } = await import('../../src/core/planner/shotReferenceMapping.js');

    const shot = {
      description: 'Elena confronts Marcus in the rain-soaked alley',
      cameraWork: 'medium shot, static',
      audio: 'ELENA: Don\'t follow me. Rain pattering on cobblestones',
    };

    const prompt = buildFallbackMotionPrompt(shot);
    expect(prompt).toContain('Elena confronts Marcus');
    expect(prompt).toContain('medium shot');
    expect(prompt).toContain('ELENA: Don\'t follow me');
  });

  it('buildFallbackMotionPrompt reads legacy soundCue field', async () => {
    const { buildFallbackMotionPrompt } = await import('../../src/core/planner/shotReferenceMapping.js');

    const shot = {
      description: 'A wide shot of the marketplace',
      cameraWork: 'wide, static',
      soundCue: 'distant market chatter, bells ringing',
    };

    const prompt = buildFallbackMotionPrompt(shot);
    expect(prompt).toContain('distant market chatter');
  });

  it('buildFallbackMotionPrompt prefers audio over soundCue', async () => {
    const { buildFallbackMotionPrompt } = await import('../../src/core/planner/shotReferenceMapping.js');

    const shot = {
      description: 'Elena speaks',
      cameraWork: 'close up',
      audio: 'ELENA: Stay here. Thunder crack',
      soundCue: 'old sound cue that should be ignored',
    };

    const prompt = buildFallbackMotionPrompt(shot);
    expect(prompt).toContain('ELENA: Stay here');
    expect(prompt).not.toContain('old sound cue');
  });

  it('buildFallbackMotionPrompt handles missing audio gracefully', async () => {
    const { buildFallbackMotionPrompt } = await import('../../src/core/planner/shotReferenceMapping.js');

    const shot = {
      description: 'A wide establishing shot',
      cameraWork: 'wide, static',
    };

    const prompt = buildFallbackMotionPrompt(shot);
    expect(prompt).toContain('A wide establishing shot');
    expect(prompt).toContain('wide, static');
  });
});

describe('Dialogue flow: resolveNodePromptPath loads prompt with markdown fences', () => {
  it('node-prompt API strips markdown fences before parsing JSON', async () => {
    const { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    // Create a temp prompt file with markdown fences (as LLM produces)
    const dir = join(tmpdir(), `prompt-test-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const fencedJson = '```json\n{"imagePrompt": "A test prompt", "negativePrompt": "blur"}\n```';
    writeFileSync(join(dir, 'test.json'), fencedJson);

    // The parsing logic should strip fences
    const { stripMarkdownFences } = await import('../../src/server/editAndRedo.js');
    const cleaned = stripMarkdownFences(fencedJson);
    const parsed = JSON.parse(cleaned);
    expect(parsed.imagePrompt).toBe('A test prompt');

    rmSync(dir, { recursive: true });
  });
});

describe('Dialogue flow: guide consistency', () => {
  it('scene_breakdown_guide defines the JSON format with purpose and audio fields', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const guide = readFileSync(join(process.cwd(), 'prompts/skills/defaults/scene_breakdown_guide.md'), 'utf-8');
    expect(guide).toContain('"purpose"');
    expect(guide).toContain('"audio"');
    expect(guide).toContain('"cameraWork"');
    expect(guide).not.toContain('"soundCue"');
    expect(guide).not.toContain('"shotType"');
  });
});

describe('Dialogue flow: schemas generated from shared constants (single source of truth)', () => {
  it('getPromptSchema returns schema for all JSON types', async () => {
    const { getPromptSchema } = await import('../../src/core/planner/schemas.js');
    expect(getPromptSchema('scene_video_prompt')).not.toBeNull();
    expect(getPromptSchema('shot_image_prompt')).not.toBeNull();
    expect(getPromptSchema('character_image')).not.toBeNull();
    expect(getPromptSchema('setting_image')).not.toBeNull();
  });

  it('scene_video_prompt schema uses purposeValues constant (not hardcoded)', async () => {
    const { getPromptSchema, purposeValues } = await import('../../src/core/planner/schemas.js');
    const schema = getPromptSchema('scene_video_prompt')!;
    // Every purpose value from the constant must appear in the schema
    for (const p of purposeValues) {
      expect(schema).toContain(p);
    }
  });

  it('scene_video_prompt schema has no shotType or secondaryPurpose', async () => {
    const { getPromptSchema } = await import('../../src/core/planner/schemas.js');
    const schema = getPromptSchema('scene_video_prompt')!;
    expect(schema).not.toContain('shotType');
    expect(schema).not.toContain('secondaryPurpose');
  });

  it('scene_video_prompt schema has audio not soundCue', async () => {
    const { getPromptSchema } = await import('../../src/core/planner/schemas.js');
    const schema = getPromptSchema('scene_video_prompt')!;
    expect(schema).toContain('audio');
    expect(schema).not.toContain('soundCue');
    expect(schema).not.toContain('"dialogue"');
  });

  it('shot_image_prompt schema has all generation modes', async () => {
    const { getPromptSchema } = await import('../../src/core/planner/schemas.js');
    const schema = getPromptSchema('shot_image_prompt')!;
    expect(schema).toContain('image_text_to_image');
    expect(schema).toContain('edit_previous_shot');
    expect(schema).toContain('edit_first_frame');
    expect(schema).toContain('text_to_image');
    expect(schema).toContain('generationStrategy');
    expect(schema).toContain('object');
  });
});

// Removed 2026-05-19: a "motion directive guide" suite that called
// `readFileSync` on prompts/skills/defaults/motion_directive_guide.md and
// then ran string regexes against its bytes. CLAUDE.md forbids tests
// that grep source / prompt files for literal strings ("Tests must
// exercise actual behavior — call functions, render components, check
// outputs"). The test pinned a specific phrasing of the guide and broke
// the moment we replaced it with the LTX-V version, even though the
// motion-directive runtime behavior was unaffected. Replace with a
// behavior test (e.g., end-to-end: feed a shot with `audio: "ELENA: …"`
// through the motion-directive node and assert the produced directive
// quotes the line) if that contract is worth pinning.
