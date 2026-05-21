/**
 * GIVEN a parsed shot_image_prompt JSON and the corresponding shot's
 *   firstFrameAnchor decision
 * WHEN enforceAnchorMode runs
 * THEN frames.first_frame.generationMode is overridden to match the
 *   anchor's intent — regardless of what the LLM originally picked.
 */
import { describe, it, expect } from 'vitest';
import { enforceAnchorMode } from '../../src/core/planner/enforceAnchorMode.js';

describe('enforceAnchorMode', () => {
  it('anchor=fresh + refs present → image_text_to_image', () => {
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'A wide shot of the bungalow',
          generationMode: 'edit_previous_shot', // LLM picked WRONG mode
          references: [{ refId: 'character_image:parvati' }],
        },
      },
    };
    const r = enforceAnchorMode(parsed, { reason: 'fresh' });
    expect(r.changed).toBe(true);
    expect(r.previousMode).toBe('edit_previous_shot');
    expect(r.enforcedMode).toBe('image_text_to_image');
    expect(parsed.frames.first_frame.generationMode).toBe('image_text_to_image');
  });

  it('anchor=fresh + NO refs → text_to_image (no composite step to waste)', () => {
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'Macro on a brass bell — atmosphere shot, no chars',
          generationMode: 'image_text_to_image',
          references: [],
        },
      },
    };
    const r = enforceAnchorMode(parsed, { reason: 'fresh' });
    expect(r.changed).toBe(true);
    expect(r.enforcedMode).toBe('text_to_image');
    expect(parsed.frames.first_frame.generationMode).toBe('text_to_image');
  });

  it('anchor=continuity → edit_previous_shot, regardless of what LLM picked', () => {
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'Continuation of prior beat',
          generationMode: 'image_text_to_image', // LLM picked wrong
          references: [{ refId: 'character_image:parvati' }],
        },
      },
    };
    const r = enforceAnchorMode(parsed, { reason: 'continuity', sourceShotNumber: 2 });
    expect(r.changed).toBe(true);
    expect(r.enforcedMode).toBe('edit_previous_shot');
    expect(parsed.frames.first_frame.generationMode).toBe('edit_previous_shot');
  });

  it('anchor=view_reuse → reuse_prior_frame (legacy anchors get the file-copy short-circuit)', () => {
    // `view_reuse` is the legacy "same view as earlier shot" reason;
    // newly-computed anchors emit `reuse_prior` instead. Both must
    // map to the file-copy generationMode so the executor skips the
    // image-edit pass.
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'Return to shot 2 setup',
          generationMode: 'image_text_to_image',
          references: [],
        },
      },
    };
    const r = enforceAnchorMode(parsed, { reason: 'view_reuse', sourceShotNumber: 2 });
    expect(r.changed).toBe(true);
    expect(r.enforcedMode).toBe('reuse_prior_frame');
  });

  it('anchor=reuse_prior → reuse_prior_frame (newly-computed same-view anchors)', () => {
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'Same view as prior shot',
          generationMode: 'image_text_to_image',
          references: [],
        },
      },
    };
    const r = enforceAnchorMode(parsed, { reason: 'reuse_prior', sourceShotNumber: 2 });
    expect(r.changed).toBe(true);
    expect(r.enforcedMode).toBe('reuse_prior_frame');
  });

  it('LLM already picked the correct mode → no change, no log noise', () => {
    const parsed = {
      frames: {
        first_frame: {
          imagePrompt: 'Continuation',
          generationMode: 'edit_previous_shot',
          references: [{ refId: 'character_image:parvati' }],
        },
      },
    };
    const r = enforceAnchorMode(parsed, { reason: 'continuity', sourceShotNumber: 1 });
    expect(r.changed).toBe(false);
    expect(r.previousMode).toBe('edit_previous_shot');
    expect(r.enforcedMode).toBe('edit_previous_shot');
  });

  it('no anchor supplied → no-op (legacy / pre-anchor projects)', () => {
    const parsed = {
      frames: {
        first_frame: { imagePrompt: 'x', generationMode: 'image_text_to_image', references: [] },
      },
    };
    expect(enforceAnchorMode(parsed, null).changed).toBe(false);
    expect(enforceAnchorMode(parsed, undefined).changed).toBe(false);
    expect(parsed.frames.first_frame.generationMode).toBe('image_text_to_image');
  });

  it('parsed object without frames.first_frame → no-op (single-frame i2v / t2v shapes)', () => {
    const parsed = {
      imagePrompt: 'Some single-frame output',
      generationMode: 'image_text_to_image',
    };
    const r = enforceAnchorMode(parsed, { reason: 'continuity', sourceShotNumber: 1 });
    expect(r.changed).toBe(false);
  });

  it('parsed is not an object → no-op (defensive)', () => {
    expect(enforceAnchorMode(null, { reason: 'fresh' }).changed).toBe(false);
    expect(enforceAnchorMode('not json', { reason: 'fresh' }).changed).toBe(false);
  });
});
