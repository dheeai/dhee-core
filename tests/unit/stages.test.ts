/**
 * Tests for the shared stage vocabulary module.
 *
 * Context: `STAGE_ALIASES` + `TEMPLATE_DEPS` used to live privately inside
 * `scripts/reset-project.ts`. We've extracted them to
 * `src/core/planner/stages.ts` so both the reset script and the executor's
 * new `stopAtStage` gate can consume the same vocabulary.
 *
 * These tests lock down the contract that consumers of stages.ts rely on.
 */

import { describe, it, expect } from 'vitest';
import {
  STAGE_ALIASES,
  TEMPLATE_DEPS,
  VALID_STAGES,
  resolveStageToTypeIds,
} from '../../src/core/planner/stages.js';

describe('STAGE_ALIASES', () => {
  it('every alias value is an array of typeIds (post-normalization)', () => {
    for (const [stage, typeIds] of Object.entries(STAGE_ALIASES)) {
      expect(Array.isArray(typeIds), `${stage} alias must be an array`).toBe(true);
      expect((typeIds as string[]).length, `${stage} alias must not be empty`).toBeGreaterThan(0);
    }
  });

  it('character_image alias bundles character_image + setting_image + object_image', () => {
    // Core value-add of the alias: resetting or gating at character_image
    // covers all three reference-image siblings in one command.
    expect(STAGE_ALIASES.character_image).toEqual(
      expect.arrayContaining(['character_image', 'setting_image', 'object_image'])
    );
  });

  it('reference_images is an explicit alias for all three image types', () => {
    expect(STAGE_ALIASES.reference_images).toEqual(
      expect.arrayContaining(['character_image', 'setting_image', 'object_image'])
    );
  });

  it('single-type stages map to a one-element array', () => {
    expect(STAGE_ALIASES.plot).toEqual(['plot']);
    expect(STAGE_ALIASES.story).toEqual(['story']);
    // The user-facing scene_video_prompt stage now spans the full
    // hierarchical breakdown (Stage A plan + Stage B per-shot + Stage C
    // assembler) so /reset scene_video_prompt clears all three layers.
    expect(STAGE_ALIASES.scene_video_prompt).toEqual([
      'scene_shot_plan',
      'shot_breakdown',
      'scene_video_prompt',
    ]);
    expect(STAGE_ALIASES.scene_shot_plan).toEqual(['scene_shot_plan']);
    expect(STAGE_ALIASES.shot_breakdown).toEqual(['shot_breakdown']);
  });
});

describe('TEMPLATE_DEPS', () => {
  it('includes every required template dependency edge', () => {
    // Sanity: reset-script's downstream-computation depends on these edges.
    expect(TEMPLATE_DEPS.story).toContain('plot');
    // After the hierarchical breakdown refactor, scene text feeds into
    // scene_shot_plan (Stage A LLM) — not directly into scene_video_prompt
    // (which is now the deterministic Stage C assembler).
    expect(TEMPLATE_DEPS.scene_shot_plan).toContain('scene');
    expect(TEMPLATE_DEPS.scene_shot_plan).toContain('world_style');
    expect(TEMPLATE_DEPS.shot_breakdown).toContain('scene_shot_plan');
    expect(TEMPLATE_DEPS.scene_video_prompt).toContain('scene_shot_plan');
    expect(TEMPLATE_DEPS.scene_video_prompt).toContain('shot_breakdown');
    expect(TEMPLATE_DEPS.shot_video).toContain('shot_image');
    expect(TEMPLATE_DEPS.shot_video).toContain('shot_motion_directive');
    expect(TEMPLATE_DEPS.final_video).toContain('shot_video');
  });

  it('object_image depends on object + world_style', () => {
    expect(TEMPLATE_DEPS.object_image).toEqual(
      expect.arrayContaining(['object', 'world_style'])
    );
  });

  it('story_essence is its own typeId, depends on story only', () => {
    // story_essence is a small focused artifact: read story → emit
    // editorial-intent JSON. Used downstream by hierarchical extraction
    // and scene prose to tune their prompts to the story's genre/tone.
    expect(TEMPLATE_DEPS.story_essence).toBeDefined();
    expect(TEMPLATE_DEPS.story_essence).toEqual(['story']);
  });

  it('character / setting / scene depend on story_essence so it runs first', () => {
    // Adding story_essence to the dep tree means the executor runs it
    // BEFORE the hierarchical extractor fires (during character/setting/scene
    // expansion via Strategy C). The extractor reads prompts/story_essence.json
    // and tunes its prompts accordingly.
    expect(TEMPLATE_DEPS.character).toContain('story_essence');
    expect(TEMPLATE_DEPS.setting).toContain('story_essence');
    expect(TEMPLATE_DEPS.scene).toContain('story_essence');
  });
});

describe('STAGE_ALIASES — story_essence', () => {
  it('story_essence is registered as a single-type stage', () => {
    // Lets users run `pnpm run-to <project> story_essence` to stop at
    // essence detection, inspect prompts/story_essence.json, edit if
    // needed, then continue with `pnpm run-to <project> scene`.
    expect(STAGE_ALIASES.story_essence).toEqual(['story_essence']);
  });

  it('VALID_STAGES includes story_essence', () => {
    expect(VALID_STAGES).toContain('story_essence');
  });
});

describe('VALID_STAGES', () => {
  it('matches Object.keys(STAGE_ALIASES)', () => {
    expect([...VALID_STAGES].sort()).toEqual(Object.keys(STAGE_ALIASES).sort());
  });
});

describe('resolveStageToTypeIds', () => {
  it('returns the alias array for a known stage', () => {
    expect(resolveStageToTypeIds('plot')).toEqual(['plot']);
    expect(resolveStageToTypeIds('character_image')).toEqual(
      expect.arrayContaining(['character_image', 'setting_image', 'object_image'])
    );
  });

  it('returns null for an unknown stage', () => {
    expect(resolveStageToTypeIds('totally_bogus_stage')).toBeNull();
    expect(resolveStageToTypeIds('')).toBeNull();
  });

  it('is case-sensitive (stage names are lowercase canonically)', () => {
    // Matches reset-project.ts behavior and the frontend's lowercase stage list.
    expect(resolveStageToTypeIds('Plot')).toBeNull();
    expect(resolveStageToTypeIds('CHARACTER_IMAGE')).toBeNull();
  });
});
