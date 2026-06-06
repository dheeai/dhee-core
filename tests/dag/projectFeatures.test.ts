/**
 * isGateAfterCollectionsEnabled — opt-OUT, defaults ON. Returns false
 * ONLY for an explicit boolean `false` under
 * project.features.gateAfterCollections; everything else (missing,
 * true, missing features, non-object project, wrong-type value) → ON.
 */
import { describe, it, expect } from 'vitest';
import { isGateAfterCollectionsEnabled } from '../../src/dag/projectFeatures.js';

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
