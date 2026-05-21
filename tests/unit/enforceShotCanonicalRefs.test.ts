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

  it('FM11: canonicalSceneSetting alone → setting appended', () => {
    // 2026-05-20 Ruby V3 s1s1 case: shot prose names a bus station, but
    // the LLM emitted references with only the Ruby character. The SVP's
    // canonicalSceneSetting carries the scene setting refId; the enforcer
    // must add it so Flux Klein has a base canvas to anchor the location.
    const shot: CanonicalRefsShot = { canonicalSceneSetting: 'broadcast_booth' };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual(['setting_image:broadcast_booth']);
    expect(references).toHaveLength(1);
    expect(references[0]!.refId).toBe('setting_image:broadcast_booth');
    expect(references[0]!.type).toBe('setting');
  });

  it('FM11b: setting already present in references → not duplicated', () => {
    const existing: ShotImagePromptRefMinimal[] = [
      { imageNumber: 1, type: 'setting', refId: 'setting_image:broadcast_booth' },
    ];
    const shot: CanonicalRefsShot = { canonicalSceneSetting: 'broadcast_booth' };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, existing, AVAILABLE);
    expect(addedRefIds).toEqual([]);
    expect(references).toEqual(existing);
  });

  it('FM11c: setting + characters → setting gets the lowest imageNumber', () => {
    // Setting goes first in canonicalIds so the base canvas (slot 1) is
    // the location, then characters layer on top in narrative order.
    const shot: CanonicalRefsShot = {
      canonicalSceneSetting: 'broadcast_booth',
      focus: { primary: 'protagonist' },
    };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual([
      'setting_image:broadcast_booth',
      'character_image:protagonist',
    ]);
    expect(references[0]!.refId).toBe('setting_image:broadcast_booth');
    expect(references[0]!.imageNumber).toBe(1);
    expect(references[1]!.refId).toBe('character_image:protagonist');
    expect(references[1]!.imageNumber).toBe(2);
  });

  it('FM11d: canonicalSceneSetting names a setting not in availableRefs → silently skipped', () => {
    const shot: CanonicalRefsShot = { canonicalSceneSetting: 'mars_colony' };
    const { references, addedRefIds } = enforceShotCanonicalRefs(shot, [], AVAILABLE);
    expect(addedRefIds).toEqual([]);
    expect(references).toEqual([]);
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

  // Bug 1 (Ruby V3, 2026-05-20): the LLM picked the INTERIOR setting for a
  // doorway/threshold shot, but SVP canonical is the EXTERIOR. Old behaviour
  // appended the canonical → two settings → undefined Klein binding. Right
  // behaviour: replace the existing setting with the canonical one. The SVP
  // is the authoritative continuity record.
  it('Bug 1: existing different setting → REPLACED by canonical (not duplicated)', () => {
    const SECOND_SETTING: AvailableRefMinimal = {
      imageNumber: 0,
      type: 'setting',
      refId: 'setting_image:pawn_shop_interior',
      label: 'pawn_shop_interior',
    };
    const available = [...AVAILABLE, SECOND_SETTING];

    const existing: ShotImagePromptRefMinimal[] = [
      { imageNumber: 1, type: 'setting',   refId: 'setting_image:pawn_shop_interior' },
      { imageNumber: 2, type: 'character', refId: 'character_image:protagonist' },
      { imageNumber: 3, type: 'character', refId: 'character_image:antagonist' },
    ];
    const shot: CanonicalRefsShot = { canonicalSceneSetting: 'broadcast_booth' };

    const { references } = enforceShotCanonicalRefs(shot, existing, available);

    // Exactly one setting in the output
    const settings = references.filter(r => r.type === 'setting');
    expect(settings).toHaveLength(1);
    expect(settings[0]!.refId).toBe('setting_image:broadcast_booth');

    // Characters preserved
    const chars = references.filter(r => r.type === 'character');
    expect(chars.map(c => c.refId).sort()).toEqual([
      'character_image:antagonist',
      'character_image:protagonist',
    ]);
  });

  // Bug 1 (cap): the canonical-refs enforcer can push refs past Klein's
  // 4-slot capacity (s2s7 ended with 5 refs after enforcement). After ANY
  // append, the final references[] must be deduplicated by refId and
  // capped at 4. The setting (slot 1) wins priority; characters fill 2-4.
  it('Bug 1 cap: enforcement that would exceed 4 refs → capped at 4 with setting kept', () => {
    const FIVE_CHARS: AvailableRefMinimal[] = [
      { imageNumber: 0, type: 'character', refId: 'character_image:char_a', label: 'char_a' },
      { imageNumber: 0, type: 'character', refId: 'character_image:char_b', label: 'char_b' },
      { imageNumber: 0, type: 'character', refId: 'character_image:char_c', label: 'char_c' },
      { imageNumber: 0, type: 'character', refId: 'character_image:char_d', label: 'char_d' },
      { imageNumber: 0, type: 'character', refId: 'character_image:char_e', label: 'char_e' },
      { imageNumber: 0, type: 'setting',   refId: 'setting_image:room',    label: 'room'   },
    ];

    const existing: ShotImagePromptRefMinimal[] = [
      { imageNumber: 1, type: 'character', refId: 'character_image:char_a' },
      { imageNumber: 2, type: 'character', refId: 'character_image:char_b' },
      { imageNumber: 3, type: 'character', refId: 'character_image:char_c' },
      { imageNumber: 4, type: 'character', refId: 'character_image:char_d' },
    ];

    // SVP names another character AND the setting — both would normally be
    // appended, taking refs to 6. Must cap at 4 and ensure setting wins.
    const shot: CanonicalRefsShot = {
      canonicalSceneSetting: 'room',
      focus: { primary: 'char_e' },
    };
    const { references } = enforceShotCanonicalRefs(shot, existing, FIVE_CHARS);

    expect(references.length).toBeLessThanOrEqual(4);
    // The canonical setting must be retained — Klein binds slot 1 as the
    // canvas, so dropping it would force a character into the canvas slot.
    expect(references.some(r => r.refId === 'setting_image:room')).toBe(true);
  });

  it('Bug 1 cap: existing references already at 4 + canonical setting needed → setting replaces last char', () => {
    const existing: ShotImagePromptRefMinimal[] = [
      { imageNumber: 1, type: 'character', refId: 'character_image:protagonist' },
      { imageNumber: 2, type: 'character', refId: 'character_image:antagonist'  },
      { imageNumber: 3, type: 'character', refId: 'character_image:antagonist'  }, // dupe just to fill
      { imageNumber: 4, type: 'character', refId: 'character_image:protagonist' },
    ];
    const shot: CanonicalRefsShot = { canonicalSceneSetting: 'broadcast_booth' };
    const { references } = enforceShotCanonicalRefs(shot, existing, AVAILABLE);

    expect(references.length).toBeLessThanOrEqual(4);
    expect(references.some(r => r.refId === 'setting_image:broadcast_booth')).toBe(true);
  });
});
