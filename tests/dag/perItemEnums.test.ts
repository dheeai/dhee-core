/**
 * Per-item id binding for `llm.generate` — the three failures it exists to
 * stop, and the one that made a fix to it unreachable.
 *
 * Every case here comes from a film that actually broke. The point of pinning
 * them is that each is invisible to the check above it: an id can be licensed
 * and still be in the wrong slot; licensed AND correctly slotted and still be
 * undeclared; and a document that fails all three can still be served straight
 * out of a cache without any of them running.
 */
import { describe, expect, it } from 'vitest';
import {
  allowlistForItem,
  checkAuthoredIds,
  collectIds,
  findMisslottedIds,
  findUndeclaredIds,
  findUnlicensedIds,
  injectEnums,
} from '../../src/dag/runners/perItemEnums.js';

const ALLOW = ['sereth_vale', 'kael', 'the_deep_quarries', 'the_lower_gallery__gold_vein'];

/** The document g4-meromero actually authored for scene_7. */
const g4Scene = () => ({
  references: [
    { id: 'sereth_vale', type: 'character' },
    { id: 'kael', type: 'character' },
    { id: 'the_lower_gallery__gold_vein', type: 'location' },
  ],
  shots: [
    {
      acting: [{ subjectId: 'sereth_vale' }, { subjectId: 'kael' }],
      sceneryIds: ['the_deep_quarries', 'the_lower_gallery__gold_vein'],
    },
    {
      acting: [{ subjectId: 'sereth_vale' }],
      sceneryIds: ['the_lower_gallery__gold_vein'],
    },
  ],
});

const CFG = {
  from: 'scenes_plan',
  idPaths: ['references[].id', 'shots[].acting[].subjectId', 'shots[].sceneryIds[]'],
  characterPaths: ['shots[].acting[].subjectId'],
  sceneryPaths: ['shots[].sceneryIds[]'],
  requireDeclared: {
    paths: ['shots[].sceneryIds[]', 'shots[].acting[].subjectId'],
    declaredPath: 'references[].id',
  },
};

describe('undeclared ids — licensed, correctly slotted, and still fatal', () => {
  it('catches the id g4-meromero staged but never declared', () => {
    // Section licensed four ids; the shots staged all four; references[] listed
    // three. Every other gate passed and the film died at its last scene with
    // `shots[0] references unknown id the_deep_quarries`.
    const found = findUndeclaredIds(g4Scene(), CFG.requireDeclared.paths, 'references[].id');
    expect(found.map((f) => f.value)).toEqual(['the_deep_quarries']);
    expect(found[0].path).toBe('shots[0].sceneryIds[0]');
  });

  it('is invisible to the licence check — the id IS licensed', () => {
    expect(findUnlicensedIds(g4Scene(), CFG.idPaths, ALLOW)).toEqual([]);
  });

  it('is invisible to the slot check — it IS scenery', () => {
    expect(findMisslottedIds(g4Scene(), { characterPaths: CFG.characterPaths, sceneryPaths: CFG.sceneryPaths })).toEqual([]);
  });

  it('an enum could never have prevented it', () => {
    // The enum binds every id field to the same allowlist, and this id is in it.
    const schema = { properties: { shots: { items: { properties: { sceneryIds: { items: { type: 'string' } } } } } } };
    const out = injectEnums(schema, ['properties/shots/items/properties/sceneryIds/items'], ALLOW);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.schema as any).properties.shots.items.properties.sceneryIds.items.enum).toContain('the_deep_quarries');
    }
  });

  it('a fully-declared document is clean', () => {
    const doc = g4Scene();
    doc.references.push({ id: 'the_deep_quarries', type: 'location' });
    expect(findUndeclaredIds(doc, CFG.requireDeclared.paths, 'references[].id')).toEqual([]);
  });
});

describe('checkAuthoredIds — one message, all three classes', () => {
  it('reports the undeclared id and says to ADD the declaration', () => {
    const problem = checkAuthoredIds(g4Scene(), CFG, ALLOW);
    expect(problem).toBeDefined();
    expect(problem).toContain('the_deep_quarries');
    // Deleting the id from the shot would silently drop a prop the beat wanted.
    expect(problem).toMatch(/Add an entry for/i);
  });

  it('reports an unlicensed id with the legal values named', () => {
    const doc = g4Scene();
    doc.references.push({ id: 'chocolate_bar', type: 'object' });
    const problem = checkAuthoredIds(doc, CFG, ALLOW);
    expect(problem).toContain('chocolate_bar');
    for (const id of ALLOW) expect(problem).toContain(id);
  });

  it('reports a character sitting in a scenery field', () => {
    const doc = g4Scene();
    doc.references.push({ id: 'the_deep_quarries', type: 'location' });
    doc.shots[0].sceneryIds.push('kael');
    const problem = checkAuthoredIds(doc, CFG, ALLOW);
    expect(problem).toMatch(/kael.*character/is);
  });

  it('says nothing about a clean document', () => {
    const doc = g4Scene();
    doc.references.push({ id: 'the_deep_quarries', type: 'location' });
    expect(checkAuthoredIds(doc, CFG, ALLOW)).toBeUndefined();
  });

  it('an off-screen speaker may sit outside the allowlist', () => {
    const doc: any = g4Scene();
    doc.references.push({ id: 'the_deep_quarries', type: 'location' });
    doc.shots[0].dialogue = [{ subjectId: 'a_pursuer', offScreen: true }];
    const cfg = {
      ...CFG,
      idPaths: [...CFG.idPaths, { path: 'shots[].dialogue[].subjectId', exemptWhen: { field: 'offScreen', equals: true } }],
    };
    expect(checkAuthoredIds(doc, cfg, ALLOW)).toBeUndefined();
  });
});

describe('the allowlist comes from the plan, per item', () => {
  const plan = {
    sections: [
      { id: 'scene_6', entities: ['sereth_vale'] },
      { id: 'scene_7', entities: ALLOW },
    ],
  };
  const opts = { itemsKey: 'sections', matchField: 'id', valuesField: 'entities' };

  it('reads this item, not a neighbour', () => {
    const out = allowlistForItem(plan, { ...opts, itemId: 'scene_7' });
    expect(out.ok && out.ids).toEqual(ALLOW);
    const six = allowlistForItem(plan, { ...opts, itemId: 'scene_6' });
    expect(six.ok && six.ids).toEqual(['sereth_vale']);
  });

  it('refuses rather than authoring unconstrained when the section is missing', () => {
    expect(allowlistForItem(plan, { ...opts, itemId: 'scene_99' }).ok).toBe(false);
  });
});

describe('path walking', () => {
  it('names the concrete location of each id', () => {
    expect(collectIds(g4Scene(), 'shots[].acting[].subjectId').map((h) => h.path)).toEqual([
      'shots[0].acting[0].subjectId',
      'shots[0].acting[1].subjectId',
      'shots[1].acting[0].subjectId',
    ]);
  });

  it('a missing branch yields nothing rather than throwing', () => {
    expect(collectIds({}, 'shots[].sceneryIds[]')).toEqual([]);
    expect(collectIds(null, 'references[].id')).toEqual([]);
  });
});
