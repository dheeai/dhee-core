/**
 * TDD tests for `renderStyleAnchor` — the shot-image-prompt style
 * enforcement helper. Each `it` enumerates a real `project.style`
 * value the executor may see, plus the edge cases that historically
 * caused the wrong rendering aesthetic to ship (Soft Seinen's
 * photorealistic Tokyo skylines despite anime project, 2026-05-19).
 *
 * Failure modes covered:
 *   - Style is unset → fall back to live-action anchor (safer than nothing)
 *   - Style is anime → anime anchor MUST lead, anti-photoreal in negative
 *   - Style is live-action (cinematic / cinematic_realism / photorealistic)
 *     → photoreal anchor + anti-cartoon negative (the character_image_guide
 *       case, mirrored here for shot prompts)
 *   - Free-form casing / underscore / space variants → still classified correctly
 *   - Unknown style → fallback bucket, NEVER throws
 *   - buildRenderStyleAnchorBlock returns empty when no style, full block otherwise
 *   - The block contains the EXACT anchor text (so the LLM can paste it)
 */
import { describe, expect, it } from 'vitest';
import {
  buildRenderStyleAnchor,
  buildRenderStyleAnchorBlock,
  classifyVisualStyle,
} from '../../src/core/prompts/renderStyleAnchor.js';

describe('classifyVisualStyle', () => {
  describe('anime variants', () => {
    it.each([
      ['anime', 'anime'],
      ['Anime', 'anime'],
      ['cel-shaded', 'anime'],
      ['cel_shaded', 'anime'],
      ['celshaded', 'anime'],
      ['japanese animation', 'anime'],
      ['80s anime', 'anime'],
    ])('classifies %p → %p', (input, expected) => {
      expect(classifyVisualStyle(input)).toBe(expected);
    });
  });

  describe('live-action variants', () => {
    it.each([
      ['cinematic_realism', 'live_action'],
      ['cinematic-realism', 'live_action'],
      ['cinematic', 'live_action'],
      ['photorealistic', 'live_action'],
      ['Photorealistic', 'live_action'],
      ['documentary', 'live_action'],
      ['realistic', 'live_action'],
      ['live-action', 'live_action'],
      ['live action', 'live_action'],
    ])('classifies %p → %p', (input, expected) => {
      expect(classifyVisualStyle(input)).toBe(expected);
    });
  });

  describe('3D animation variants', () => {
    it.each([
      ['3d_animation', '3d_animation'],
      ['3D Animation', '3d_animation'],
      ['pixar style', '3d_animation'],
      ['stylized 3d', '3d_animation'],
      ['CGI', '3d_animation'],
    ])('classifies %p → %p', (input, expected) => {
      expect(classifyVisualStyle(input)).toBe(expected);
    });
  });

  describe('painterly / illustration variants', () => {
    it.each([
      ['oil painting', 'oil_painting'],
      ['painterly', 'oil_painting'],
      ['watercolor', 'watercolor'],
      ['watercolour', 'watercolor'],
      ['comic book', 'comic'],
      ['graphic novel', 'comic'],
    ])('classifies %p → %p', (input, expected) => {
      expect(classifyVisualStyle(input)).toBe(expected);
    });
  });

  describe('edge cases', () => {
    it('null / undefined / empty / whitespace → fallback', () => {
      expect(classifyVisualStyle(null)).toBe('fallback');
      expect(classifyVisualStyle(undefined)).toBe('fallback');
      expect(classifyVisualStyle('')).toBe('fallback');
      expect(classifyVisualStyle('   ')).toBe('fallback');
    });

    it('unknown style → fallback, never throws', () => {
      expect(() => classifyVisualStyle('foo_bar_quux')).not.toThrow();
      expect(classifyVisualStyle('foo_bar_quux')).toBe('fallback');
    });

    it('stop_motion classifies correctly', () => {
      expect(classifyVisualStyle('stop motion')).toBe('stop_motion');
      expect(classifyVisualStyle('claymation')).toBe('stop_motion');
    });
  });
});

describe('buildRenderStyleAnchor', () => {
  it('anime: positive anchor leads with hand-drawn / cel / line-work vocabulary', () => {
    const a = buildRenderStyleAnchor('anime');
    expect(a.styleKey).toBe('anime');
    expect(a.positiveAnchor.toLowerCase()).toMatch(/hand-drawn|anime cel|line work|painted background/);
    // The anchor must end with a separator the LLM can paste before its own prose.
    expect(a.positiveAnchor.endsWith('— ')).toBe(true);
  });

  it('anime: negative MUST push away from photoreal / live-action vocabulary', () => {
    const a = buildRenderStyleAnchor('anime');
    expect(a.negativeTokens).toEqual(
      expect.arrayContaining(['photorealistic', 'photograph', 'film grain', 'live-action']),
    );
    // And MUST NOT contain anime/cel tokens (which would self-negate).
    for (const t of a.negativeTokens) {
      expect(t.toLowerCase()).not.toContain('anime');
      expect(t.toLowerCase()).not.toContain('cel-shaded');
    }
  });

  it('live_action: photoreal anchor + anti-cartoon negative', () => {
    const a = buildRenderStyleAnchor('cinematic_realism');
    expect(a.styleKey).toBe('live_action');
    expect(a.positiveAnchor.toLowerCase()).toMatch(/photoreal|85mm|natural skin/);
    expect(a.negativeTokens).toEqual(
      expect.arrayContaining(['cartoon', 'anime', 'cel-shaded', 'illustration', 'mascot']),
    );
  });

  it('photorealistic resolves to the same bucket as cinematic_realism', () => {
    const a1 = buildRenderStyleAnchor('photorealistic');
    const a2 = buildRenderStyleAnchor('cinematic_realism');
    expect(a1.styleKey).toBe(a2.styleKey);
    expect(a1.positiveAnchor).toBe(a2.positiveAnchor);
  });

  it('null / empty → fallback to live-action anchor (safer default than nothing)', () => {
    expect(buildRenderStyleAnchor(null).styleKey).toBe('fallback');
    expect(buildRenderStyleAnchor('').styleKey).toBe('fallback');
    // Fallback anchor MUST still produce a usable anchor (not empty string).
    expect(buildRenderStyleAnchor(null).positiveAnchor.length).toBeGreaterThan(20);
  });
});

describe('buildRenderStyleAnchorBlock', () => {
  it('returns empty string when visualStyle is missing — guide handles general guidance in that case', () => {
    expect(buildRenderStyleAnchorBlock(null)).toBe('');
    expect(buildRenderStyleAnchorBlock(undefined)).toBe('');
    expect(buildRenderStyleAnchorBlock('')).toBe('');
    expect(buildRenderStyleAnchorBlock('   ')).toBe('');
  });

  it('wraps the anchor in a <render_style_anchor> block for executor injection', () => {
    const block = buildRenderStyleAnchorBlock('anime');
    expect(block).toContain('<render_style_anchor>');
    expect(block).toContain('</render_style_anchor>');
  });

  it('names the project visual style verbatim AND the resolved bucket', () => {
    const block = buildRenderStyleAnchorBlock('anime');
    expect(block).toContain('Project Visual style: anime');
    expect(block).toContain('resolved bucket: anime');
  });

  it('emits a MANDATORY label for the positive opening clause (so the LLM treats it as a hard rule)', () => {
    const block = buildRenderStyleAnchorBlock('anime');
    expect(block).toMatch(/MANDATORY positive-prompt opening clause/i);
    // The literal anchor text must appear, so the LLM can paste it verbatim.
    expect(block).toContain('Hand-drawn anime cel');
  });

  it('emits a MANDATORY label for the negative tokens', () => {
    const block = buildRenderStyleAnchorBlock('anime');
    expect(block).toMatch(/MANDATORY tokens to include in the negative prompt/i);
    // Spot-check at least one critical anti-photoreal token is in the block text.
    expect(block).toMatch(/photorealistic/);
  });

  it('for live-action style the block names anti-cartoon negatives (mirrors character_image_guide)', () => {
    const block = buildRenderStyleAnchorBlock('cinematic_realism');
    expect(block).toMatch(/cartoon/);
    expect(block).toMatch(/anime/);
    expect(block).toMatch(/mascot/);
  });

  it('block trims its leading newlines so concatenation in user-message assembly is clean', () => {
    const block = buildRenderStyleAnchorBlock('anime');
    // The block leads with two newlines so it separates from prior context cleanly.
    // Tests pin that contract so a future refactor doesn't bunch blocks together.
    expect(block.startsWith('\n\n<render_style_anchor>')).toBe(true);
  });
});
