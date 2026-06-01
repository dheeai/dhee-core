/**
 * bundleDisplay — pure helpers for the bundle picker's display fields.
 *
 * `titleizeBundleId` turns a snake_case bundle id ("narrative_prompt_relay")
 * into a Title Case display label ("Narrative Prompt Relay") for use
 * when a bundle.json doesn't set `displayName`. Acronym-aware: known
 * tokens (LTX, ZIT, VLM) stay uppercase; unknown short tokens (≤3
 * chars) stay as-cased; everything else gets Title Case.
 *
 * `summaryOf` derives a short tagline from a bundle's metadata: returns
 * `summary` verbatim when present; else returns the first sentence of
 * `description` (truncated to 120 chars); else empty string.
 */
import { describe, it, expect } from 'vitest';
import { titleizeBundleId, summaryOf } from '../../src/dag/bundleDisplay.js';

describe('titleizeBundleId', () => {
  it('snake_case → Title Case', () => {
    expect(titleizeBundleId('narrative_prompt_relay')).toBe('Narrative Prompt Relay');
    expect(titleizeBundleId('narrative_shot_by_shot')).toBe('Narrative Shot By Shot');
  });

  it('single token', () => {
    expect(titleizeBundleId('narrative')).toBe('Narrative');
  });

  it('preserves known acronyms', () => {
    expect(titleizeBundleId('ltx_prompt_relay')).toBe('LTX Prompt Relay');
    expect(titleizeBundleId('zit_chain_review')).toBe('ZIT Chain Review');
    expect(titleizeBundleId('vlm_judge_demo')).toBe('VLM Judge Demo');
  });

  it('does not break on mixed-case input', () => {
    expect(titleizeBundleId('FooBar_baz')).toBe('FooBar Baz');
  });

  it('empty string → empty string', () => {
    expect(titleizeBundleId('')).toBe('');
  });

  it('hyphens treated like underscores', () => {
    expect(titleizeBundleId('narrative-shot-by-shot')).toBe('Narrative Shot By Shot');
  });
});

describe('summaryOf', () => {
  it('returns explicit summary verbatim', () => {
    expect(summaryOf({ summary: 'A tagline.', description: 'long...' })).toBe('A tagline.');
  });

  it('derives from first sentence of description when summary is missing', () => {
    expect(
      summaryOf({
        description: 'Full story pipeline. Plot → scenes → shots → video. Local Comfy.',
      }),
    ).toBe('Full story pipeline.');
  });

  it('truncates a long single-sentence description at 120 chars', () => {
    const long = 'x'.repeat(200);
    const r = summaryOf({ description: long });
    expect(r.length).toBeLessThanOrEqual(121); // 120 + trailing ellipsis char
    expect(r.endsWith('…')).toBe(true);
  });

  it('falls back to empty string when both summary and description are missing', () => {
    expect(summaryOf({})).toBe('');
  });

  it('handles description that already ends with no period', () => {
    expect(summaryOf({ description: 'A pipeline without a period' })).toBe(
      'A pipeline without a period',
    );
  });
});
