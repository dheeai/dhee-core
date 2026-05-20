/**
 * TDD tests for `enforceShotCanonicalRefs`.
 *
 * Failure modes enumerated (the things that can actually go wrong in
 * production — what the user told us to enumerate FIRST and then code
 * the helper for):
 *
 *   FM1. LLM emits an empty references array even though the SVP's
 *        focus.primary names a character refId — the Soft Seinen
 *        scene 1 shot 3 incident, where the prose said "Kaito
 *        Nakamura sits at the news anchor desk…" but the LLM didn't
 *        list `protagonist` in references.
 *
 *   FM2. LLM lists SOME refs but misses the focus.primary character.
 *        Existing entries must be preserved (imageNumber + order),
 *        and the missing ref appended.
 *
 *   FM3. LLM correctly lists focus.primary — enforcer must NOT
 *        duplicate it. Output equals input.
 *
 *   FM4. focus.primary names a refId the project doesn't have (the
 *        SVP referenced a character that was never generated). The
 *        enforcer SKIPS it silently — inventing a ref isn't its job.
 *
 *   FM5. focus.background is mixed: some entries are refIds
 *        ("setting:broadcast_booth"), others are free-form prose
 *        ("broadcast booth interior with monitors"). Refs are added,
 *        prose is skipped. The references array stays clean.
 *
 *   FM6. perspectiveOf names a refId — same enforcement as primary.
 *        When perspectiveOf == focus.primary the enforcer must not
 *        add it twice.
 *
 *   FM7. SVP fields use the itemId form ("protagonist") but available
 *        refs use the full refId form ("character_image:protagonist").
 *        Enforcer matches either.
 *
 *   FM8. shot is null/undefined → no-op, no throw.
 *
 *   FM9. focus.lurking names a character (e.g. a stalker behind the
 *        protagonist). Enforcer adds it like primary.
 *
 *   FM10. New refs get imageNumbers AFTER the existing max — never
 *         colliding with an existing entry.
 */

import { describe, expect, it } from 'vitest';
import {
  enforceShotCanonicalRefs,
  type CanonicalRefsShot,
  type ShotImagePromptRefMinimal,
} from '../../src/core/planner/enforceShotCanonicalRefs.js';
import type { AvailableRefMinimal } from '../../src/core/planner/shotImagePromptNormalizer.js';

const AVAILABLE: AvailableRefMinimal[] = [
  { imageNumber: 0, type: 'character', refId: 'character_image:protagonist', label: 'protagonist' },
  { imageNumber: 0, type: 'character', refId: 'character_image:antagonist',   label: 'antagonist'  },
  { imageNumber: 0, type: 'setting',   refId: 'setting_image:broadcast_booth', label: 'broadcast_booth' },
];

describe('enforceShotCanonicalRefs', () => {
  it('FM1: empty references + focus.primary → primary character appended', () => {
    const shot: CanonicalRefsShot = { focus: { primary: 'protagonist' } };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual(['character_image:protagonist']);
    expect(references).toHaveLength(1);
    expect(references[0]!.refId).toBe('character_image:protagonist');
    expect(references[0]!.type).toBe('character');
    expect(references[0]!.imageNumber).toBe(1);
  });

  it('FM2: partial references → missing primary appended, existing preserved', () => {
    const existing: ShotImagePromptRefMinimal[] = [
      { imageNumber: 1, type: 'setting', refId: 'setting_image:broadcast_booth' },
    ];
    const shot: CanonicalRefsShot = { focus: { primary: 'protagonist' } };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, existing, AVAILABLE);
    expect(addedRefIds).toEqual(['character_image:protagonist']);
    expect(references).toHaveLength(2);
    expect(references[0]).toEqual({
      imageNumber: 1, type: 'setting', refId: 'setting_image:broadcast_booth',
    });
    expect(references[1]!.refId).toBe('character_image:protagonist');
    expect(references[1]!.imageNumber).toBe(2);
  });

  it('FM3: focus.primary already in references → no duplicate, no change', () => {
    const existing: ShotImagePromptRefMinimal[] = [
      { imageNumber: 1, type: 'character', refId: 'character_image:protagonist' },
    ];
    const shot: CanonicalRefsShot = { focus: { primary: 'protagonist' } };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, existing, AVAILABLE);
    expect(addedRefIds).toEqual([]);
    expect(references).toEqual(existing);
  });

  it('FM4: focus.primary names a refId not in availableRefs → silently skipped', () => {
    const shot: CanonicalRefsShot = { focus: { primary: 'ghost_character' } };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual([]);
    expect(references).toEqual([]);
  });

  it('FM5: focus.background mixes refIds and prose → only refIds added', () => {
    const shot: CanonicalRefsShot = {
      focus: {
        background: [
          'broadcast_booth',
          'broadcast booth interior with monitors and teleprompter',
        ],
      },
    };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual(['setting_image:broadcast_booth']);
    expect(references).toHaveLength(1);
    expect(references[0]!.refId).toBe('setting_image:broadcast_booth');
  });

  it('FM6: perspectiveOf same as focus.primary → only added once', () => {
    const shot: CanonicalRefsShot = {
      perspectiveOf: 'protagonist',
      focus: { primary: 'protagonist' },
    };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual(['character_image:protagonist']);
    expect(references).toHaveLength(1);
  });

  it('FM6b: perspectiveOf differs from focus.primary → both added', () => {
    const shot: CanonicalRefsShot = {
      perspectiveOf: 'antagonist',
      focus: { primary: 'protagonist' },
    };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual([
      'character_image:antagonist',
      'character_image:protagonist',
    ]);
    expect(references).toHaveLength(2);
  });

  it('FM7: SVP uses itemId, availableRefs use full prefixed refId → still resolves', () => {
    // The SVP field is just "protagonist" but availableRefs has
    // "character_image:protagonist". Enforcer must look up by both forms.
    const shot: CanonicalRefsShot = { focus: { primary: 'protagonist' } };
    const { addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual(['character_image:protagonist']);
  });

  it('FM7b: SVP uses full refId form → also resolves (caller variation)', () => {
    const shot: CanonicalRefsShot = {
      focus: { primary: 'character_image:protagonist' },
    };
    const { addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual(['character_image:protagonist']);
  });

  it('FM8: shot null → no-op, returns inputs', () => {
    const existing: ShotImagePromptRefMinimal[] = [
      { imageNumber: 1, type: 'setting', refId: 'setting_image:broadcast_booth' },
    ];
    const { references, addedRefIds } = enforceShotCanonicalRefs(null, existing, AVAILABLE);
    expect(references).toEqual(existing);
    expect(addedRefIds).toEqual([]);
  });

  it('FM8b: shot undefined → no-op, no throw', () => {
    expect(() => enforceShotCanonicalRefs(undefined, [], AVAILABLE)).not.toThrow();
    const result = enforceShotCanonicalRefs(undefined, [], AVAILABLE);
    expect(result.references).toEqual([]);
    expect(result.addedRefIds).toEqual([]);
  });

  it('FM9: focus.lurking names a character → added', () => {
    const shot: CanonicalRefsShot = {
      focus: { lurking: 'antagonist' },
    };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual(['character_image:antagonist']);
    expect(references).toHaveLength(1);
    expect(references[0]!.refId).toBe('character_image:antagonist');
  });

  it('FM10: new refs get imageNumbers AFTER existing max', () => {
    const existing: ShotImagePromptRefMinimal[] = [
      { imageNumber: 3, type: 'setting', refId: 'setting_image:broadcast_booth' },
      { imageNumber: 7, type: 'character', refId: 'character_image:antagonist' },
    ];
    const shot: CanonicalRefsShot = { focus: { primary: 'protagonist' } };
    const { references } = enforceShotCanonicalRefs(shot, existing, AVAILABLE);
    const added = references.find(r => r.refId === 'character_image:protagonist');
    expect(added).toBeDefined();
    expect(added!.imageNumber).toBe(8); // max(3,7) + 1
  });

  it('idempotency: running twice produces the same result', () => {
    const shot: CanonicalRefsShot = {
      perspectiveOf: 'antagonist',
      focus: {
        primary: 'protagonist',
        background: ['broadcast_booth'],
      },
    };
    const first = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    const second = enforceShotCanonicalRefs(shot, first.references, AVAILABLE);
    expect(second.addedRefIds).toEqual([]);
    expect(second.references).toEqual(first.references);
  });

  it('empty shot (no fields) → no-op', () => {
    const { references, addedRefIds } = enforceShotCanonicalRefs({}, [], AVAILABLE);
    expect(references).toEqual([]);
    expect(addedRefIds).toEqual([]);
  });

  it('empty availableRefs → all canonicalIds skipped, no error', () => {
    const shot: CanonicalRefsShot = { focus: { primary: 'protagonist' } };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], []);
    expect(references).toEqual([]);
    expect(addedRefIds).toEqual([]);
  });

  it('order: perspectiveOf is added BEFORE focus.primary (when both differ)', () => {
    const shot: CanonicalRefsShot = {
      perspectiveOf: 'antagonist',
      focus: { primary: 'protagonist' },
    };
    const { references } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(references[0]!.refId).toBe('character_image:antagonist');
    expect(references[1]!.refId).toBe('character_image:protagonist');
  });
});
