/**
 * Tests for `validateSidePair` — extracted from parseTurn2RefsJson Stage 8
 * (Bug 3 — Ruby V3 s3s6). Verifies the side-pair invariant rules.
 */
import { describe, it, expect } from 'vitest';
import { validateSidePair } from '../../src/core/planner/validateSidePair.js';

interface Ref { type?: string; side?: string; refId?: string }

describe('validateSidePair', () => {
  it('strips side from non-character refs (6.2)', () => {
    const refs: Ref[] = [
      { type: 'setting', side: 'A' as string },
      { type: 'object',  side: 'B' as string },
    ];
    validateSidePair(refs);
    expect(refs[0]!.side).toBeUndefined();
    expect(refs[1]!.side).toBeUndefined();
  });

  it('strips duplicate side="A" labels keeping the first (6.1)', () => {
    const refs: Ref[] = [
      { type: 'character', side: 'A' as string, refId: 'r1' },
      { type: 'character', side: 'A' as string, refId: 'r2' },
      { type: 'character', side: 'B' as string, refId: 'r3' },
    ];
    validateSidePair(refs);
    expect(refs[0]!.side).toBe('A');
    expect(refs[1]!.side).toBeUndefined();
    expect(refs[2]!.side).toBe('B');
  });

  it('strips lone side label when only one character is present (6.3)', () => {
    const refs: Ref[] = [
      { type: 'character', side: 'A' as string, refId: 'r1' },
    ];
    validateSidePair(refs);
    expect(refs[0]!.side).toBeUndefined();
  });

  it('Bug 3: strips half-specified pair (A without B)', () => {
    // The Ruby V3 s3s6 scenario: align mutated refs leaving angel(A) alone.
    const refs: Ref[] = [
      { type: 'setting', refId: 'setting:room' },
      { type: 'character', side: 'A' as string, refId: 'angel' },
    ];
    validateSidePair(refs);
    expect(refs[1]!.side).toBeUndefined();
  });

  it('preserves a true OTS pair (A + B)', () => {
    const refs: Ref[] = [
      { type: 'character', side: 'A' as string, refId: 'angel' },
      { type: 'character', side: 'B' as string, refId: 'ruby' },
    ];
    validateSidePair(refs);
    expect(refs[0]!.side).toBe('A');
    expect(refs[1]!.side).toBe('B');
  });

  it('preserves extras beyond the pair (3+ chars, A+B+unlabelled)', () => {
    const refs: Ref[] = [
      { type: 'character', side: 'A' as string, refId: 'r1' },
      { type: 'character', side: 'B' as string, refId: 'r2' },
      { type: 'character', refId: 'r3' },
    ];
    validateSidePair(refs);
    expect(refs[0]!.side).toBe('A');
    expect(refs[1]!.side).toBe('B');
    expect(refs[2]!.side).toBeUndefined();
  });
});
