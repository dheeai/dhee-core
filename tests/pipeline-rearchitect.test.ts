/**
 * Surviving behavioural tests from the original "Pipeline
 * Re-Architecture" TDD pass. The bulk of that file was source/guide
 * greping — pinning sentinel strings in ExecutorAgent.ts /
 * motion_directive_guide.md / .env.example / test-stage.ts — and was
 * deleted because those tests didn't exercise behaviour and went
 * stale as the codebase moved.
 *
 * What's left:
 *   - normalizeSceneVideoPrompt does NOT seed generationStrategy
 *     on the parent shot (it's a per-shot-image-prompt concern).
 *   - WorkflowModeRegistry filters out i2v from available strategies.
 *   - Every video workflow manifest declares width/height parameter
 *     mappings (unless it derives resolution from input_image).
 *   - imageValidator surfaces a clear error for a missing file.
 *   - shot_image_prompt with flfv-style `frames` schema validates.
 *
 * If any of these duplicates an assertion that has since landed in a
 * more focused file (e.g. `imageValidator.test.ts` if/when one
 * exists), prefer to delete it here rather than carry two copies.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  normalizeSceneVideoPrompt,
  sceneVideoPromptSchema,
  validateWithSchema,
} from '../src/core/planner/schemas.js';

describe('normalizeSceneVideoPrompt: generationStrategy is a shot_image_prompt concern, not a scene_video_prompt one', () => {
  it('does not default generationStrategy on the parent shot', () => {
    const data = sceneVideoPromptSchema.parse({
      shots: [
        { shotNumber: 1, firstFrame: { description: 'A character walks', characters: ['kai'] } },
      ],
    });
    normalizeSceneVideoPrompt(data);
    expect(data.shots[0]!.generationStrategy).toBeUndefined();
  });
});

describe('WorkflowModeRegistry: video strategy filter', () => {
  it('i2v is not advertised in the LLM-facing strategies block', async () => {
    const { getWorkflowModeRegistry } = await import(
      '../src/services/providers/WorkflowModeRegistry.js'
    );
    const registry = getWorkflowModeRegistry();
    registry.refresh();
    const section = registry.generateVideoModesSection('comfyui');
    expect(section).not.toContain('`i2v`');
    const modes = registry.getAvailableModes('video_generation', 'comfyui');
    if (modes.length > 0) {
      expect(section).toContain('`flfv`');
    }
  });
});

describe('Workflow manifests declare resolution mappings', () => {
  it('FLUX Klein manifest has width and height parameter mappings', () => {
    const manifestPath = join(
      process.cwd(),
      'workflows/built-in/flux2_klein_edit.manifest.json',
    );
    if (!existsSync(manifestPath)) return; // skip if not present in this checkout
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const hasWidth = manifest.parameterMappings.some(
      (m: { input?: string }) => m.input === 'width',
    );
    const hasHeight = manifest.parameterMappings.some(
      (m: { input?: string }) => m.input === 'height',
    );
    expect(hasWidth).toBe(true);
    expect(hasHeight).toBe(true);
  });

  it('all video workflow manifests have width and height mappings (unless they derive from input image)', async () => {
    const userDir = join(process.cwd(), 'workflows/user');
    if (!existsSync(userDir)) return;
    const { readdirSync } = await import('fs');
    const manifests = readdirSync(userDir).filter((f) => f.endsWith('.manifest.json'));
    for (const mf of manifests) {
      const manifest = JSON.parse(readFileSync(join(userDir, mf), 'utf-8'));
      if (manifest.pipeline !== 'video_generation') continue;
      const derivesFromImage =
        manifest.parameterMappings.some(
          (m: { input?: string; field?: string }) =>
            m.input === 'first_frame' && m.field === 'image',
        ) && manifest.format === 'api';
      const hasWidth = manifest.parameterMappings.some(
        (m: { input?: string }) => m.input === 'width',
      );
      const hasHeight = manifest.parameterMappings.some(
        (m: { input?: string }) => m.input === 'height',
      );
      if (!derivesFromImage) {
        expect(hasWidth, `${mf} missing width mapping`).toBe(true);
        expect(hasHeight, `${mf} missing height mapping`).toBe(true);
      }
    }
  });
});

describe('imageValidator', () => {
  it('reports a clear error when the image file is missing', async () => {
    const { validateGeneratedImage } = await import(
      '../src/core/planner/imageValidator.js'
    );
    const result = await validateGeneratedImage(
      '/nonexistent/path.png',
      'test prompt',
      { width: 848, height: 480 },
    );
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('shot_image_prompt schema (slim, flfv-style frames)', () => {
  it('validates a frames-based prompt with first_frame + last_frame', () => {
    const result = validateWithSchema('shot_image_prompt', {
      shotNumber: 1,
      frames: {
        first_frame: {
          imagePrompt: 'A wide establishing shot...',
          generationMode: 'image_text_to_image',
          references: [
            { imageNumber: 1, type: 'character', refId: 'character_image:kai' },
          ],
        },
        last_frame: {
          imagePrompt: 'Character has moved to the right side of frame...',
          generationMode: 'edit_first_frame',
          references: [],
        },
      },
      negativePrompt: 'no artifacts',
      aspectRatio: '16:9',
    });
    expect(result.valid).toBe(true);
  });

  it('frames.last_frame is OPTIONAL at the schema layer — flfv enforcement is the executor\'s job', () => {
    const result = validateWithSchema('shot_image_prompt', {
      shotNumber: 1,
      frames: {
        first_frame: {
          imagePrompt: 'A wide shot...',
          generationMode: 'image_text_to_image',
          references: [],
        },
      },
      negativePrompt: 'test',
      aspectRatio: '16:9',
    });
    expect(result.valid).toBe(true);
  });
});
