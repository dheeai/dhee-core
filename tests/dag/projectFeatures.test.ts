/**
 * isGateAfterCollectionsEnabled — opt-OUT, defaults ON. Returns false
 * ONLY for an explicit boolean `false` under
 * project.features.gateAfterCollections; everything else (missing,
 * true, missing features, non-object project, wrong-type value) → ON.
 */
import { describe, it, expect } from 'vitest';
import { isGateAfterCollectionsEnabled, getBudgetCapUsd, isNarrationEnabled } from '../../src/dag/projectFeatures.js';

describe('isGateAfterCollectionsEnabled (default ON / opt-out)', () => {
  it('ON when explicitly true', () => {
    expect(isGateAfterCollectionsEnabled({ features: { gateAfterCollections: true } })).toBe(true);
  });

  it('OFF only when explicitly false', () => {
    expect(isGateAfterCollectionsEnabled({ features: { gateAfterCollections: false } })).toBe(false);
  });

  it('ON when the flag is missing (default)', () => {
    expect(isGateAfterCollectionsEnabled({ features: {} })).toBe(true);
    expect(isGateAfterCollectionsEnabled({ name: 'p', bundleSource: 'built-in:x' })).toBe(true);
  });

  it('ON when features is absent or not an object', () => {
    expect(isGateAfterCollectionsEnabled({})).toBe(true);
    expect(isGateAfterCollectionsEnabled({ features: null })).toBe(true);
    expect(isGateAfterCollectionsEnabled({ features: 'nope' })).toBe(true);
  });

  it('ON for truthy-but-not-false values (only the boolean false opts out)', () => {
    expect(isGateAfterCollectionsEnabled({ features: { gateAfterCollections: 'false' } })).toBe(true);
    expect(isGateAfterCollectionsEnabled({ features: { gateAfterCollections: 0 } })).toBe(true);
    expect(isGateAfterCollectionsEnabled({ features: { gateAfterCollections: 1 } })).toBe(true);
  });

  it('ON on non-object / nullish project inputs (default)', () => {
    expect(isGateAfterCollectionsEnabled(null)).toBe(true);
    expect(isGateAfterCollectionsEnabled(undefined)).toBe(true);
    expect(isGateAfterCollectionsEnabled('project')).toBe(true);
  });
});

describe('getBudgetCapUsd (strict opt-in number)', () => {
  it('returns the cap when a finite number > 0', () => {
    expect(getBudgetCapUsd({ features: { budgetCapUsd: 5 } })).toBe(5);
    expect(getBudgetCapUsd({ features: { budgetCapUsd: 0.5 } })).toBe(0.5);
  });

  it('undefined (no cap) when missing, ≤ 0, or non-finite', () => {
    expect(getBudgetCapUsd({ features: {} })).toBeUndefined();
    expect(getBudgetCapUsd({ features: { budgetCapUsd: 0 } })).toBeUndefined();
    expect(getBudgetCapUsd({ features: { budgetCapUsd: -3 } })).toBeUndefined();
    expect(getBudgetCapUsd({ features: { budgetCapUsd: Infinity } })).toBeUndefined();
    expect(getBudgetCapUsd({ features: { budgetCapUsd: NaN } })).toBeUndefined();
  });

  it('undefined for non-number values (no silent string coercion)', () => {
    expect(getBudgetCapUsd({ features: { budgetCapUsd: '5' } })).toBeUndefined();
    expect(getBudgetCapUsd({ features: { budgetCapUsd: null } })).toBeUndefined();
  });

  it('undefined when features is absent or project is non-object', () => {
    expect(getBudgetCapUsd({})).toBeUndefined();
    expect(getBudgetCapUsd({ features: null })).toBeUndefined();
    expect(getBudgetCapUsd(null)).toBeUndefined();
    expect(getBudgetCapUsd(undefined)).toBeUndefined();
    expect(getBudgetCapUsd('project')).toBeUndefined();
  });
});

describe('isNarrationEnabled (strict opt-in, default OFF)', () => {
  it('true only when explicitly true', () => {
    expect(isNarrationEnabled({ features: { narration: true } })).toBe(true);
  });

  it('false when explicitly false, missing, or wrong-typed', () => {
    expect(isNarrationEnabled({ features: { narration: false } })).toBe(false);
    expect(isNarrationEnabled({ features: {} })).toBe(false);
    expect(isNarrationEnabled({ features: { narration: 'true' } })).toBe(false);
    expect(isNarrationEnabled({})).toBe(false);
    expect(isNarrationEnabled(null)).toBe(false);
    expect(isNarrationEnabled(undefined)).toBe(false);
  });
});
