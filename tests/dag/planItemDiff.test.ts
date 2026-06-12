/**
 * planItemDiff + deriveItemId — behavioral.
 *
 * These guard the keystone of bottom-up building: when a plan node is
 * rewritten, only changed/removed items must invalidate downstream.
 * deriveItemId must match what the walker materializes, or invalidation
 * keys (`character_image:concept_car`) won't line up with instances.
 */
import { describe, it, expect } from 'vitest';
import { deriveItemId } from '../../src/dag/itemId.js';
import { diffPlanItems, extractPlanItems } from '../../src/dag/planItemDiff.js';

describe('deriveItemId', () => {
  it('normalizes a string item (spaces → underscore, lowercased)', () => {
    expect(deriveItemId('Main Street')).toBe('main_street');
  });

  it('prefers id over name for object items, normalized', () => {
    expect(deriveItemId({ id: 'concept_car', name: 'The Car' })).toBe('concept_car');
    expect(deriveItemId({ name: 'The Car' })).toBe('the_car');
  });

  it('returns empty string when neither id nor name is present', () => {
    expect(deriveItemId({ description: 'no id' } as never)).toBe('');
  });
});

describe('extractPlanItems', () => {
  it('uses the declared itemKey when present', () => {
    const plan = { characters: [{ id: 'a' }], settings: [{ id: 'x' }] };
    expect(extractPlanItems(plan, 'characters')).toHaveLength(1);
    expect(deriveItemId(extractPlanItems(plan, 'characters')[0])).toBe('a');
  });

  it('falls back to the first array property when itemKey is absent', () => {
    expect(extractPlanItems({ characters: [{ id: 'a' }, { id: 'b' }] })).toHaveLength(2);
  });

  it('returns [] for non-objects / no arrays', () => {
    expect(extractPlanItems(null)).toEqual([]);
    expect(extractPlanItems({ foo: 'bar' })).toEqual([]);
  });
});

describe('diffPlanItems', () => {
  const key = 'characters';
  const a = { id: 'concept_car', name: 'The Car', description: 'silver' };
  const b = { id: 'sleek_sedan', name: 'Sedan', description: 'black' };

  it('null prior → every new item is added', () => {
    const d = diffPlanItems(null, { characters: [a, b] }, key);
    expect(d.added.sort()).toEqual(['concept_car', 'sleek_sedan']);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it('appending one item → only that item is added, siblings untouched', () => {
    const c = { id: 'electric_sports', name: 'EV', description: 'green' };
    const d = diffPlanItems({ characters: [a, b] }, { characters: [a, b, c] }, key);
    expect(d.added).toEqual(['electric_sports']);
    expect(d.removed).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it('removing one item → only that item is removed', () => {
    const d = diffPlanItems({ characters: [a, b] }, { characters: [a] }, key);
    expect(d.removed).toEqual(['sleek_sedan']);
    expect(d.added).toEqual([]);
    expect(d.changed).toEqual([]);
  });

  it('editing an item field → that id is changed, not added/removed', () => {
    const a2 = { ...a, description: 'matte silver' };
    const d = diffPlanItems({ characters: [a, b] }, { characters: [a2, b] }, key);
    expect(d.changed).toEqual(['concept_car']);
    expect(d.added).toEqual([]);
    expect(d.removed).toEqual([]);
  });

  it('reordering with no content change → no diff', () => {
    const d = diffPlanItems({ characters: [a, b] }, { characters: [b, a] }, key);
    expect(d).toEqual({ added: [], removed: [], changed: [] });
  });
});
