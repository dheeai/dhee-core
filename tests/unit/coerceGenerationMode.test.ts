/**
 * Tests for `coerceGenerationMode` — Bug 5.
 *
 * Ruby V3 scene_2_shot_7 had `generationMode: 'reuse_prior_frame'` on
 * first_frame. The mode IS handled by the executor but was undocumented
 * in the schema. After tightening the schema to a closed enum, the
 * normalizer accepts the documented modes verbatim, maps common slips
 * to their canonical form, and falls back to `image_text_to_image`
 * (safe default) for anything unknown.
 */
import { describe, it, expect } from 'vitest';
import { coerceGenerationMode } from '../../src/core/planner/schemas.js';

describe('coerceGenerationMode', () => {
  it('passes through canonical modes verbatim', () => {
    expect(coerceGenerationMode('image_text_to_image')).toBe('image_text_to_image');
    expect(coerceGenerationMode('text_to_image')).toBe('text_to_image');
    expect(coerceGenerationMode('edit_previous_shot')).toBe('edit_previous_shot');
    expect(coerceGenerationMode('edit_first_frame')).toBe('edit_first_frame');
    expect(coerceGenerationMode('reuse_prior_frame')).toBe('reuse_prior_frame');
  });

  it('is case-insensitive on canonical modes', () => {
    expect(coerceGenerationMode('Image_Text_To_Image')).toBe('image_text_to_image');
    expect(coerceGenerationMode('REUSE_PRIOR_FRAME')).toBe('reuse_prior_frame');
  });

  it('trims whitespace before classifying', () => {
    expect(coerceGenerationMode('  edit_first_frame  ')).toBe('edit_first_frame');
  });

  it('maps common LLM typos to canonical form', () => {
    expect(coerceGenerationMode('reuse_previous_frame')).toBe('reuse_prior_frame');
    expect(coerceGenerationMode('copy_prior_frame')).toBe('reuse_prior_frame');
    expect(coerceGenerationMode('edit_prior_shot')).toBe('edit_previous_shot');
    expect(coerceGenerationMode('edit_prev_shot')).toBe('edit_previous_shot');
    expect(coerceGenerationMode('fresh')).toBe('image_text_to_image');
    expect(coerceGenerationMode('text2img')).toBe('image_text_to_image');
    expect(coerceGenerationMode('txt2img')).toBe('image_text_to_image');
  });

  it('falls back to image_text_to_image for unknown strings', () => {
    expect(coerceGenerationMode('totally_made_up_mode')).toBe('image_text_to_image');
    expect(coerceGenerationMode('')).toBe('image_text_to_image');
  });

  it('falls back to image_text_to_image for non-string inputs', () => {
    expect(coerceGenerationMode(null)).toBe('image_text_to_image');
    expect(coerceGenerationMode(undefined)).toBe('image_text_to_image');
    expect(coerceGenerationMode(42)).toBe('image_text_to_image');
    expect(coerceGenerationMode({})).toBe('image_text_to_image');
  });
});
