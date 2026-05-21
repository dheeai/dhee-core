/**
 * Schema validation for shot_image_prompt — the "self-healing" name
 * comes from the original TDD context (executor detects corrupt JSON
 * and re-invokes the LLM). The executor-side detection used to be
 * tested by grepping the source for sentinel strings; those tests
 * were deleted because they pinned text, not behavior. What's left
 * here is the load-bearing schema contract.
 */

import { describe, it, expect } from 'vitest';
import { validateWithSchema } from '../../src/core/planner/schemas.js';

describe('Corrupt prompt self-healing: schema validation', () => {
  it('valid single-frame prompt passes schema', () => {
    const result = validateWithSchema('shot_image_prompt', {
      imagePrompt: 'A wide establishing shot of the village',
      negativePrompt: 'blurry',
      aspectRatio: '16:9',
      generationMode: 'image_text_to_image',
      references: [],
    });
    expect(result.valid).toBe(true);
  });

  it('valid multi-frame prompt passes schema', () => {
    const result = validateWithSchema('shot_image_prompt', {
      shotNumber: 1,
      frames: {
        first_frame: {
          imagePrompt: 'A wide shot',
          generationMode: 'image_text_to_image',
          references: [],
        },
        last_frame: {
          imagePrompt: 'Character moved right',
          generationMode: 'edit_first_frame',
          references: [],
        },
      },
      negativePrompt: 'blurry',
      aspectRatio: '16:9',
    });
    expect(result.valid).toBe(true);
  });

  it('rejects prompt with empty imagePrompt', () => {
    const result = validateWithSchema('shot_image_prompt', {
      imagePrompt: '',
      negativePrompt: 'blurry',
      generationMode: 'text_to_image',
      references: [],
    });
    expect(result.valid).toBe(false);
  });

  it('rejects multi-frame prompt with empty first_frame imagePrompt', () => {
    const result = validateWithSchema('shot_image_prompt', {
      frames: {
        first_frame: {
          imagePrompt: '',
          generationMode: 'image_text_to_image',
          references: [],
        },
      },
      negativePrompt: 'blurry',
    });
    expect(result.valid).toBe(false);
  });

  it('rejects completely empty object', () => {
    const result = validateWithSchema('shot_image_prompt', {});
    expect(result.valid).toBe(false);
  });
});
