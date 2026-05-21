/**
 * TDD Tests for Cross-Shot Chaining
 *
 * The LLM decides per-shot whether to:
 * - `image_text_to_image`: Generate fresh from character/setting refs (default)
 * - `edit_previous_shot`: Edit the previous shot's last frame for visual continuity
 *
 * When a shot uses `edit_previous_shot`, the executor must:
 * 1. Find the previous shot in the same scene
 * 2. Get its last_frame (or outputPath as fallback)
 * 3. Use it as the base image for FLUX Klein editing
 * 4. The shot_image node must depend on the previous shot_image node
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  validateWithSchema,
  shotImagePromptSchema,
} from '../../src/core/planner/schemas.js';

// ──────────────────────────────────────────────────────────────────────────────
// Schema: edit_previous_shot is a valid generation mode
// ──────────────────────────────────────────────────────────────────────────────

describe('Cross-shot chaining: schema validation', () => {
  it('single-frame prompt with edit_previous_shot mode validates', () => {
    const result = validateWithSchema('shot_image_prompt', {
      imagePrompt: 'Same angle, the character has now turned to face the door',
      negativePrompt: 'blurry',
      aspectRatio: '16:9',
      generationMode: 'edit_previous_shot',
      references: [],
    });
    expect(result.valid).toBe(true);
  });

  it('multi-frame prompt with edit_previous_shot on first_frame validates', () => {
    const result = validateWithSchema('shot_image_prompt', {
      shotNumber: 2,
      frames: {
        first_frame: {
          imagePrompt: 'Same angle, character now facing the door',
          generationMode: 'edit_previous_shot',
          references: [],
        },
        last_frame: {
          imagePrompt: 'Character has reached the door, hand on handle',
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

// ──────────────────────────────────────────────────────────────────────────────
// Dependency: shot N+1 depends on shot N when using edit_previous_shot
// ──────────────────────────────────────────────────────────────────────────────

describe('Cross-shot chaining: dependency wiring', () => {
  it('getPreviousShotId returns correct previous shot within same scene', async () => {
    const { getPreviousShotId } = await import('../../src/core/planner/crossShotChaining.js');
    expect(getPreviousShotId('scene_1_shot_2')).toBe('scene_1_shot_1');
    expect(getPreviousShotId('scene_1_shot_5')).toBe('scene_1_shot_4');
    expect(getPreviousShotId('scene_3_shot_3')).toBe('scene_3_shot_2');
  });

  it('getPreviousShotId returns null for first shot in a scene', async () => {
    const { getPreviousShotId } = await import('../../src/core/planner/crossShotChaining.js');
    expect(getPreviousShotId('scene_1_shot_1')).toBeNull();
    expect(getPreviousShotId('scene_2_shot_1')).toBeNull();
  });

  it('getLastFramePath returns last_frame from outputPaths if available', async () => {
    const { getLastFramePath } = await import('../../src/core/planner/crossShotChaining.js');

    const node = {
      id: 'shot_image:scene_1_shot_1',
      status: 'completed' as const,
      outputPath: 'assets/images/shots/scene_1_shot_1.png',
      outputPaths: {
        first_frame: 'assets/images/shots/scene_1_shot_1_first.png',
        last_frame: 'assets/images/shots/scene_1_shot_1_last.png',
      },
    };

    expect(getLastFramePath(node as any)).toBe('assets/images/shots/scene_1_shot_1_last.png');
  });

  it('getLastFramePath falls back to outputPath when no last_frame', async () => {
    const { getLastFramePath } = await import('../../src/core/planner/crossShotChaining.js');

    const node = {
      id: 'shot_image:scene_1_shot_1',
      status: 'completed' as const,
      outputPath: 'assets/images/shots/scene_1_shot_1.png',
    };

    expect(getLastFramePath(node as any)).toBe('assets/images/shots/scene_1_shot_1.png');
  });

  it('getLastFramePath returns null for incomplete nodes', async () => {
    const { getLastFramePath } = await import('../../src/core/planner/crossShotChaining.js');

    const node = {
      id: 'shot_image:scene_1_shot_1',
      status: 'pending' as const,
    };

    expect(getLastFramePath(node as any)).toBeNull();
  });

  // Bug 8a / 11: silent first_frame fallback when last_frame node didn't render
  // (prompt_relay default + first-frame-only producer). The node has outputPaths
  // populated with first_frame but no last_frame — must NOT silently fall back
  // to outputPath, because outputPath in that case IS the first frame.
  it('getLastFramePath returns null when outputPaths has first_frame but no last_frame', async () => {
    const { getLastFramePath } = await import('../../src/core/planner/crossShotChaining.js');

    const node = {
      id: 'shot_image:scene_1_shot_1',
      status: 'completed' as const,
      outputPath: 'assets/images/shots/scene_1_shot_1_first.png',
      outputPaths: {
        first_frame: 'assets/images/shots/scene_1_shot_1_first.png',
        // last_frame deliberately absent — prompt_relay no-op
      },
    };

    expect(getLastFramePath(node as any)).toBeNull();
  });

  it('getLastFramePath returns null when outputPaths is empty but outputPath is set', async () => {
    const { getLastFramePath } = await import('../../src/core/planner/crossShotChaining.js');

    const node = {
      id: 'shot_image:scene_1_shot_1',
      status: 'completed' as const,
      outputPath: 'assets/images/shots/scene_1_shot_1.png',
      outputPaths: {},
    };

    // outputPaths is explicitly set (even empty) → multi-frame mode was on the
    // table; refusing to fall back is safer than copying an unknown frame.
    expect(getLastFramePath(node as any)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Prompt guide: LLM knows about edit_previous_shot mode
// ──────────────────────────────────────────────────────────────────────────────

describe('Cross-shot chaining: prompt guide', () => {
  it('shot_composition_guide documents edit_previous_shot mode', () => {
    const guidePath = join(process.cwd(), 'prompts/skills/defaults/shot_composition_guide.md');
    const guide = readFileSync(guidePath, 'utf-8');
    expect(guide).toContain('edit_previous_shot');
  });

  it('shot_composition_guide explains when to use edit_previous_shot vs image_text_to_image', () => {
    const guidePath = join(process.cwd(), 'prompts/skills/defaults/shot_composition_guide.md');
    const guide = readFileSync(guidePath, 'utf-8');
    // Should have guidance on when to chain vs when to generate fresh
    expect(guide).toMatch(/edit_previous_shot.*continuity|continuation.*edit_previous_shot/i);
  });

  it('scene_video_prompt_guide mentions cross-shot chaining for lastFrame', () => {
    const guidePath = join(process.cwd(), 'prompts/skills/defaults/scene_breakdown_guide.md');
    const guide = readFileSync(guidePath, 'utf-8');
    expect(guide).toMatch(/cross-shot|previous shot|chain/i);
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Module: crossShotChaining.ts exists
// ──────────────────────────────────────────────────────────────────────────────

describe('Cross-shot chaining: cross-scene (Layer C2)', () => {
  // Build a minimal mock executor with a configurable node graph.
  function mockExec(nodes: Array<{ id: string; itemId?: string; typeId: string; status: string; outputPath?: string }>) {
    return {
      getAllNodes: () => nodes,
      getNode: (id: string) => nodes.find(n => n.id === id),
    };
  }

  it('getPreviousShotIdAcrossScenes returns same-scene predecessor when one exists', async () => {
    const { getPreviousShotIdAcrossScenes } = await import('../../src/core/planner/crossShotChaining.js');
    const exec = mockExec([
      { id: 'shot_image:scene_2_shot_1', itemId: 'scene_2_shot_1', typeId: 'shot_image', status: 'completed' },
      { id: 'shot_image:scene_2_shot_2', itemId: 'scene_2_shot_2', typeId: 'shot_image', status: 'completed' },
    ]);
    expect(getPreviousShotIdAcrossScenes('scene_2_shot_3', exec as any)).toBe('scene_2_shot_2');
  });

  it('getPreviousShotIdAcrossScenes returns prior scene\'s last shot for shot 1 of scene N>1', async () => {
    const { getPreviousShotIdAcrossScenes } = await import('../../src/core/planner/crossShotChaining.js');
    const exec = mockExec([
      { id: 'shot_image:scene_1_shot_1', itemId: 'scene_1_shot_1', typeId: 'shot_image', status: 'completed' },
      { id: 'shot_image:scene_1_shot_2', itemId: 'scene_1_shot_2', typeId: 'shot_image', status: 'completed' },
      { id: 'shot_image:scene_1_shot_3', itemId: 'scene_1_shot_3', typeId: 'shot_image', status: 'completed' },
    ]);
    expect(getPreviousShotIdAcrossScenes('scene_2_shot_1', exec as any)).toBe('scene_1_shot_3');
  });

  it('getPreviousShotIdAcrossScenes returns null for scene 1 shot 1 (project start)', async () => {
    const { getPreviousShotIdAcrossScenes } = await import('../../src/core/planner/crossShotChaining.js');
    const exec = mockExec([
      { id: 'shot_image:scene_1_shot_1', itemId: 'scene_1_shot_1', typeId: 'shot_image', status: 'completed' },
    ]);
    expect(getPreviousShotIdAcrossScenes('scene_1_shot_1', exec as any)).toBeNull();
  });

  it('getPreviousShotIdAcrossScenes ignores prior-scene shots that did not complete', async () => {
    const { getPreviousShotIdAcrossScenes } = await import('../../src/core/planner/crossShotChaining.js');
    const exec = mockExec([
      { id: 'shot_image:scene_1_shot_1', itemId: 'scene_1_shot_1', typeId: 'shot_image', status: 'completed' },
      { id: 'shot_image:scene_1_shot_2', itemId: 'scene_1_shot_2', typeId: 'shot_image', status: 'pending' },
    ]);
    expect(getPreviousShotIdAcrossScenes('scene_2_shot_1', exec as any)).toBe('scene_1_shot_1');
  });

  it('getPreviousShotIdAcrossScenes returns null when prior scene has no completed shots', async () => {
    const { getPreviousShotIdAcrossScenes } = await import('../../src/core/planner/crossShotChaining.js');
    const exec = mockExec([
      { id: 'shot_image:scene_1_shot_1', itemId: 'scene_1_shot_1', typeId: 'shot_image', status: 'pending' },
    ]);
    expect(getPreviousShotIdAcrossScenes('scene_2_shot_1', exec as any)).toBeNull();
  });

  it('getPreviousShotIdAcrossScenes picks the highest shot number in the prior scene', async () => {
    const { getPreviousShotIdAcrossScenes } = await import('../../src/core/planner/crossShotChaining.js');
    const exec = mockExec([
      { id: 'shot_image:scene_1_shot_1', itemId: 'scene_1_shot_1', typeId: 'shot_image', status: 'completed' },
      { id: 'shot_image:scene_1_shot_5', itemId: 'scene_1_shot_5', typeId: 'shot_image', status: 'completed' },
      { id: 'shot_image:scene_1_shot_3', itemId: 'scene_1_shot_3', typeId: 'shot_image', status: 'completed' },
    ]);
    expect(getPreviousShotIdAcrossScenes('scene_2_shot_1', exec as any)).toBe('scene_1_shot_5');
  });
});

describe('Cross-shot chaining: module exists', () => {
  it('crossShotChaining module exports required functions', async () => {
    const mod = await import('../../src/core/planner/crossShotChaining.js');
    expect(mod.getPreviousShotId).toBeTypeOf('function');
    expect(mod.getLastFramePath).toBeTypeOf('function');
  });
});
