/**
 * llmAccess pure helpers: purpose resolution + message normalization.
 * Unexported before pass 4 (the only export, createRunnerLLMAccess,
 * immediately builds a live router), so the tier→purpose fallback and
 * the message-stripping logic had no coverage. Exported purely for
 * testability — no behavior change.
 */
import { describe, it, expect } from 'vitest';
import type { LLMAccessMessage, LLMGenerateTextOptions } from '@dhee/runner-sdk';
import { resolvePurpose, normalizeMessages } from '../../src/dag/llmAccess.js';

const opts = (o: Partial<LLMGenerateTextOptions>): LLMGenerateTextOptions =>
  ({ messages: [], ...o }) as LLMGenerateTextOptions;

describe('resolvePurpose', () => {
  it('returns an explicit, valid purpose verbatim', () => {
    expect(resolvePurpose(opts({ purpose: 'content.story' }))).toBe('content.story');
  });

  it('throws on an unknown explicit purpose', () => {
    expect(() => resolvePurpose(opts({ purpose: 'not.a.purpose' as never }))).toThrow(
      /unknown LLM purpose/i,
    );
  });

  it('maps tier → a representative purpose when none is given', () => {
    expect(resolvePurpose(opts({ tier: 'heavy' }))).toBe('content.story');
    expect(resolvePurpose(opts({ tier: 'medium' }))).toBe('structured.scene_breakdown');
    expect(resolvePurpose(opts({ tier: 'light' }))).toBe('utility.image_review');
  });

  it('defaults to the medium-tier purpose when neither purpose nor tier is set', () => {
    expect(resolvePurpose(opts({}))).toBe('structured.scene_breakdown');
  });
});

describe('normalizeMessages', () => {
  it('keeps only role + content, dropping any extra fields', () => {
    const input = [
      { role: 'system', content: 'you are helpful', name: 'x', extra: 1 },
      { role: 'user', content: 'hi' },
    ] as unknown as LLMAccessMessage[];
    const out = normalizeMessages(input);
    expect(out).toEqual([
      { role: 'system', content: 'you are helpful' },
      { role: 'user', content: 'hi' },
    ]);
    expect(Object.keys(out[0]!)).toEqual(['role', 'content']);
  });

  it('returns an empty array unchanged', () => {
    expect(normalizeMessages([])).toEqual([]);
  });
});
