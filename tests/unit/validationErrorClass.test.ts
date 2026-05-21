/**
 * GIVEN a validation error from validateJsonOutput
 * WHEN classifyValidationError inspects it
 * THEN it returns one of three classes:
 *   - 'truncated'  — LLM output cut off mid-stream (Unexpected end of JSON
 *                    / Unterminated string). Must skip json_repair.
 *   - 'structural' — well-formed-ish JSON with fix-able syntax / schema
 *                    issues (trailing comma, missing required field, type
 *                    mismatch). json_repair can plausibly help.
 *   - 'semantic'   — JSON parses + matches the schema but violates a
 *                    project rule (hallucinated refs, OTS-with-one-char,
 *                    shotNumber mismatch). Skip json_repair.
 *
 * AND the retry-suffix builder produces class-appropriate guidance:
 *   - structural → generic JSON reminder
 *   - semantic   → inject the validation message verbatim
 *   - truncated  → inject + tell the LLM to keep fields short
 */
import { describe, it, expect } from 'vitest';
import {
  classifyValidationError,
  buildRetrySystemSuffix,
} from '../../src/core/planner/validationErrorClass.js';

describe('classifyValidationError — truncated', () => {
  it('classifies "Unexpected end of JSON input" as truncated (NOT structural)', () => {
    // Regression: this used to route to json_repair and produced
    // stub plans like { sceneTitle: "Default scene", shotPlan: [...
    // "Default shot." ] } when Stage A truncated. Repair can't recover
    // missing tokens; it just invents schema-satisfying filler.
    expect(
      classifyValidationError('JSON parse error: SyntaxError: Unexpected end of JSON input'),
    ).toBe('truncated');
  });

  it('classifies "Unterminated string" as truncated', () => {
    expect(
      classifyValidationError('JSON parse error: SyntaxError: Unterminated string in JSON at position 1023'),
    ).toBe('truncated');
  });
});

describe('classifyValidationError — structural', () => {
  it('classifies a generic JSON.parse SyntaxError (non-truncation) as structural', () => {
    expect(
      classifyValidationError('JSON parse error: SyntaxError: Unexpected token } in JSON at position 42'),
    ).toBe('structural');
  });

  it('classifies a Zod "Required" missing-field error as structural', () => {
    expect(classifyValidationError('shots: Required')).toBe('structural');
  });

  it('classifies a Zod type-mismatch error as structural', () => {
    expect(
      classifyValidationError('sceneNumber: Expected number, received string'),
    ).toBe('structural');
  });

  it('classifies a "must contain at least N" min-length error as structural', () => {
    expect(
      classifyValidationError('shots: Array must contain at least 1 element(s)'),
    ).toBe('structural');
  });
});

describe('classifyValidationError — semantic', () => {
  it('classifies the "no character ref" hallucination as semantic', () => {
    expect(
      classifyValidationError(
        'No reference to any known character / setting / object found in the imagePrompt or references[]. Expected at least one of: character_image:protagonist. The LLM may have hallucinated unrelated content — re-prompt with the project\'s character/setting list.',
      ),
    ).toBe('semantic');
  });

  it('classifies the OTS-with-single-character violation as semantic', () => {
    expect(
      classifyValidationError(
        'OTS-with-single-character violation. first_frame: over-the-shoulder framing requires 2+ character refs — found 0.',
      ),
    ).toBe('semantic');
  });

  it('classifies a shotNumber-mismatch error as semantic', () => {
    expect(
      classifyValidationError(
        'shotNumber mismatch: expected 3, got 5',
      ),
    ).toBe('semantic');
  });

  it('classifies a ref-mention-check failure as semantic', () => {
    expect(
      classifyValidationError(
        'ref-mention check failed: imagePrompt mentions "elena" but elena is not in references[].',
      ),
    ).toBe('semantic');
  });

  it('defaults unknown errors to semantic (safer — skips one LLM call)', () => {
    // An unfamiliar error shape means a future validation rule the
    // classifier doesn't know about yet. The safe assumption is
    // "semantic, skip json_repair" — at worst we miss a chance for
    // syntax repair, but we don't waste a call on something repair
    // can't fix.
    expect(classifyValidationError('some new validation rule the test does not know about')).toBe('semantic');
  });

  it('treats an empty error string as semantic', () => {
    expect(classifyValidationError('')).toBe('semantic');
  });
});

describe('buildRetrySystemSuffix', () => {
  it('structural retries get a generic "must be valid JSON" reminder', () => {
    const suffix = buildRetrySystemSuffix('structural', 'shots: Required');
    expect(suffix).toContain('CRITICAL: Your output MUST be valid JSON');
    expect(suffix).toContain('Do not include markdown');
    // Structural retries do NOT inject the error message — the schema
    // in the system prompt is what guides the LLM.
    expect(suffix).not.toContain('shots: Required');
  });

  it('semantic retries inject the actual validation error as corrective guidance', () => {
    const err =
      'No reference to any known character / setting / object found in the imagePrompt or references[]. Expected at least one of: character_image:protagonist.';
    const suffix = buildRetrySystemSuffix('semantic', err);
    expect(suffix).toContain('REJECTED');
    expect(suffix).toContain(err);
    expect(suffix).toContain('Output ONLY valid JSON');
  });

  it('semantic retries with an empty error still emit a coherent suffix', () => {
    // Edge case: defensive. classifyValidationError treats empty as
    // semantic; the retry suffix shouldn't crash.
    const suffix = buildRetrySystemSuffix('semantic', '');
    expect(suffix).toContain('REJECTED');
  });

  it('truncated retries inject the parser error AND coach the LLM to keep fields short', () => {
    const err = 'JSON parse error: SyntaxError: Unexpected end of JSON input';
    const suffix = buildRetrySystemSuffix('truncated', err);
    // The actual parser message lands in the prompt so the model knows
    // why we're retrying.
    expect(suffix).toContain(err);
    // The targeted directive: shorten verbose fields to fit the budget.
    expect(suffix).toMatch(/short|keep .* concise|under \d+/i);
  });
});
