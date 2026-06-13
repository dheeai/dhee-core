/**
 * Entity state continuity — generalized projection layer (was character-only).
 *
 * The ledger now tracks ANY stateful story entity (character / setting /
 * object), each tagged with a `kind`, with an OPEN facet bag (the planner
 * names whatever matters — `outfit`, `lighting`, `powered`, `broken`).
 * A global TRANSIENT_FACET_KEYS set (props/posture/expression/…) is excluded
 * from the reference-variant key, so a held torch or a pose never mints a new
 * reference, but a wardrobe / lighting / damage change does.
 *
 * These tests pin the generalization: multi-kind fold, open-bag keying,
 * transient exclusion, kind-filtered variant enumeration, per-entity refKey,
 * and back-compat with the legacy `{characters:[…]}` ledger shape.
 */
import { describe, it, expect } from 'vitest';
import {
  stateAtShot,
  computeStateKey,
  computeRefKey,
  enumerateStateVariants,
  refKeyForEntityAtShot,
  normalizeLedger,
  buildEntityStateContext,
  DEFAULT_TRANSIENT_FACET_KEYS,
  type ContinuityLedger,
} from '../../../src/dag/runners/entityState.js';

const LEDGER: ContinuityLedger = {
  entities: [
    {
      id: 'mira',
      kind: 'character',
      events: [
        { atShot: 'scene_2_shot_1', facets: { outfit: 'torn tank', condition: 'wet', props: ['lit torch'] } },
        { atShot: 'scene_4_shot_1', facets: { condition: 'bleeding, left arm' } },
      ],
    },
    {
      id: 'cistern',
      kind: 'setting',
      events: [{ atShot: 'scene_3_shot_1', facets: { lighting: 'pitch dark, torch-lit' } }],
    },
    {
      id: 'brass_door',
      kind: 'object',
      events: [{ atShot: 'scene_5_shot_2', facets: { state: 'forced open, hinges broken' } }],
    },
  ],
};

const ent = (ctx: ReturnType<typeof stateAtShot>, id: string) => ctx.entities.find((e) => e.id === id);

describe('entityState — multi-kind fold', () => {
  it('folds each kind with its own open facets and tags the kind', () => {
    const at = stateAtShot(LEDGER, 'scene_5_shot_5');
    expect(ent(at, 'mira')?.kind).toBe('character');
    expect(ent(at, 'mira')?.facets).toEqual({ outfit: 'torn tank', condition: 'bleeding, left arm', props: ['lit torch'] });
    expect(ent(at, 'cistern')?.kind).toBe('setting');
    expect(ent(at, 'cistern')?.facets).toEqual({ lighting: 'pitch dark, torch-lit' });
    expect(ent(at, 'brass_door')?.kind).toBe('object');
    expect(ent(at, 'brass_door')?.facets).toEqual({ state: 'forced open, hinges broken' });
  });

  it('respects shot ordering per entity (future events excluded)', () => {
    const at = stateAtShot(LEDGER, 'scene_3_shot_2');
    expect(ent(at, 'mira')?.facets.condition).toBe('wet'); // scene_4 bleeding not yet
    expect(ent(at, 'cistern')?.facets.lighting).toBe('pitch dark, torch-lit'); // scene_3_shot_1 applied
    expect(ent(at, 'brass_door')?.facets).toEqual({}); // scene_5 in the future
  });
});

describe('entityState — open-bag keying + transient exclusion', () => {
  it('refKey ignores transient facets but stateKey includes them', () => {
    const facets = { outfit: 'torn tank', condition: 'wet', props: ['lit torch'], posture: 'crouched' };
    // stateKey (full) changes if props/posture change; refKey (material) does not.
    expect(computeRefKey(facets)).toBe(computeRefKey({ outfit: 'torn tank', condition: 'wet' }));
    expect(computeStateKey(facets)).not.toBe(computeStateKey({ outfit: 'torn tank', condition: 'wet' }));
  });

  it('a setting lighting change is material (mints a variant)', () => {
    expect(computeRefKey({ lighting: 'pitch dark' })).not.toBe('base');
    expect(computeRefKey({ lighting: 'pitch dark' })).not.toBe(computeRefKey({ lighting: 'bright daylight' }));
  });

  it('an entity whose only facets are transient stays base', () => {
    expect(computeRefKey({ props: ['lit torch'] })).toBe('base');
    expect(computeRefKey({ posture: 'seated' })).toBe('base');
    expect([...DEFAULT_TRANSIENT_FACET_KEYS]).toEqual(expect.arrayContaining(['props', 'posture']));
  });

  it('key is order-independent across facet keys and list values', () => {
    expect(computeRefKey({ lighting: 'dark', damage: 'scorched' })).toBe(
      computeRefKey({ damage: 'scorched', lighting: 'dark' }),
    );
  });
});

describe('entityState — enumerateStateVariants', () => {
  it('emits variants across all kinds, each tagged with its kind', () => {
    const variants = enumerateStateVariants(LEDGER);
    const byKind = (k: string) => variants.filter((v) => v.kind === k);
    expect(byKind('character').map((v) => v.entityId)).toEqual(['mira', 'mira']); // wet, bleeding
    expect(byKind('setting').map((v) => v.entityId)).toEqual(['cistern']);
    expect(byKind('object').map((v) => v.entityId)).toEqual(['brass_door']);
    expect(variants.every((v) => v.id === `${v.entityId}__${v.refKey}` && v.refKey !== 'base')).toBe(true);
  });

  it('filters to a single kind when asked', () => {
    expect(enumerateStateVariants(LEDGER, 'setting').map((v) => v.entityId)).toEqual(['cistern']);
    expect(enumerateStateVariants(LEDGER, 'character').every((v) => v.kind === 'character')).toBe(true);
  });
});

describe('entityState — refKeyForEntityAtShot', () => {
  it('folds any entity kind to its refKey at a shot', () => {
    expect(refKeyForEntityAtShot(LEDGER, 'scene_1_shot_1', 'cistern')).toBe('base');
    expect(refKeyForEntityAtShot(LEDGER, 'scene_3_shot_4', 'cistern')).toBe(computeRefKey({ lighting: 'pitch dark, torch-lit' }));
    expect(refKeyForEntityAtShot(LEDGER, 'scene_1_shot_1', 'unknown')).toBe('base');
  });
});

describe('entityState — normalizeLedger back-compat', () => {
  it('accepts the legacy {characters:[…]} shape as kind=character', () => {
    const led = normalizeLedger({
      characters: [{ id: 'x', events: [{ atShot: 'scene_1_shot_2', facets: { outfit: 'coat' } }] }],
    });
    expect(led.entities).toHaveLength(1);
    expect(led.entities[0]?.kind).toBe('character');
    expect(led.entities[0]?.id).toBe('x');
  });

  it('accepts the new {entities:[…]} shape and drops malformed entries', () => {
    const led = normalizeLedger({
      entities: [
        { id: 'ok', kind: 'setting', events: [{ atShot: 'scene_1_shot_1', facets: { lighting: 'dim' } }] },
        { kind: 'object' }, // no id → dropped
        'garbage',
      ],
    });
    expect(led.entities.map((e) => e.id)).toEqual(['ok']);
    expect(led.entities[0]?.kind).toBe('setting');
  });

  it('defaults a missing / non-string kind to character', () => {
    expect(normalizeLedger({ entities: [{ id: 'y', events: [] }] }).entities[0]?.kind).toBe('character');
    expect(normalizeLedger({ entities: [{ id: 'z', kind: 42, events: [] }] }).entities[0]?.kind).toBe('character');
  });

  it('preserves an arbitrary (open) kind string — kinds are bundle-declared, not a closed enum', () => {
    const led = normalizeLedger({ entities: [{ id: 'dragon', kind: 'creature', events: [] }] });
    expect(led.entities[0]?.kind).toBe('creature');
  });
});

describe('entityState — buildEntityStateContext', () => {
  it('returns only diverged entities (any kind), with empty deps', () => {
    const { context, additionalDependencies } = buildEntityStateContext({ ledger: LEDGER, itemId: 'scene_3_shot_2' });
    // At scene_3_shot_2: mira (wet) + cistern (dark) diverged; brass_door still base.
    expect(context.entities.map((e) => e.id).sort()).toEqual(['cistern', 'mira']);
    expect(additionalDependencies).toEqual([]);
  });

  it('empty for an absent ledger', () => {
    expect(buildEntityStateContext({ ledger: undefined, itemId: 'scene_1_shot_1' }).context.entities).toEqual([]);
  });
});

describe('entityState — covers a non-visual kind (voice)', () => {
  // A narrator whose vocal delivery evolves across the piece. The SAME
  // ledger/fold/refKey applies; only the mint (TTS/voice-design, built when an
  // audio bundle needs it) and the transient set differ from visual kinds.
  const VOICE_LEDGER: ContinuityLedger = {
    entities: [
      {
        id: 'narrator',
        kind: 'voice',
        events: [
          { atShot: 'scene_1_shot_1', facets: { register: 'calm, measured', pace: 'slow' } },
          { atShot: 'scene_4_shot_2', facets: { register: 'urgent, clipped', pace: 'fast', emphasis: 'final word' } },
        ],
      },
    ],
  };

  it('treats vocal register/pace as MATERIAL — the emotional state is not discarded', () => {
    // The whole risk a global visual transient-set would create: silently
    // dropping a voice's emotional state. register/pace must mint distinct voices.
    const k1 = refKeyForEntityAtShot(VOICE_LEDGER, 'scene_1_shot_1', 'narrator');
    const k2 = refKeyForEntityAtShot(VOICE_LEDGER, 'scene_4_shot_2', 'narrator');
    expect(k1).not.toBe('base');
    expect(k2).not.toBe('base');
    expect(k1).not.toBe(k2); // calm/slow vs urgent/fast → distinct voice renders
  });

  it('honours a per-kind transient set (a momentary emphasis does not mint a new voice)', () => {
    const voiceTransient = new Set(['emphasis']);
    const withEmphasis = refKeyForEntityAtShot(VOICE_LEDGER, 'scene_4_shot_2', 'narrator', voiceTransient);
    const sameMaterialOnly = computeRefKey({ register: 'urgent, clipped', pace: 'fast' }, voiceTransient);
    expect(withEmphasis).toBe(sameMaterialOnly);
  });

  it('enumerates voice variants tagged kind=voice', () => {
    const variants = enumerateStateVariants(VOICE_LEDGER, 'voice');
    expect(variants).toHaveLength(2);
    expect(variants.every((v) => v.kind === 'voice')).toBe(true);
  });
});
