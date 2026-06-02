/**
 * backfillHelpers — TDD coverage for the pure functions the legacy-
 * project event-log backfill leans on.
 *
 * Failure modes enumerated up front:
 *
 *   extractRefs:
 *     1. Empty / null / non-object input → []
 *     2. Top-level `references: [{ id, type }]` → flat passthrough
 *     3. Nested `frames.first_frame.references: [{ refId }]` →
 *        parses refId='character_image:lara_croft' into id='lara_croft',
 *        type='character'
 *     4. Multiple frames (first_frame + last_frame) → refs from both
 *     5. Mixed flat + nested → both collected
 *     6. Malformed entries (missing id/refId) are silently skipped
 *     7. refId with no colon (just a bare stage name) → no item id,
 *        no entry pushed
 *     8. Explicit `type` field on refId entry wins over inferred
 *
 *   deriveDeps:
 *     9. Stage upstream → exactly one dep, no itemId
 *    10. scope='matching' → 1:1 if same-itemId upstream exists; 0 if
 *        no matching upstream
 *    11. scope='previousN' → N priors sorted by shot number desc,
 *        excludes self
 *    12. scope='all' with no referenceMap → full fan-out (every
 *        upstream instance becomes a dep)
 *    13. scope='all' with referenceMap → narrows to allowed itemIds
 *        ONLY for upstreams matching the ref type (character_image
 *        filtered by type='character', setting_image by type='setting')
 *    14. referenceMap with no matching type for an upstream → that
 *        upstream stays fan-out (don't accidentally drop everything)
 *    15. previousN with no shot-numbered downstream → returns []
 *
 *   synthesizeMissingPromptEntries:
 *    16. Adds prompt-tier entries when bundle declares them but the
 *        map lacks them, copying itemId from the image-tier
 *    17. Skips pairs where bundle doesn't declare the prompt node
 *    18. Doesn't duplicate entries that already exist (same itemId)
 *    19. Returned count = number of synthetic entries minted
 *    20. Synthetic flag is set on minted entries (truthy)
 */
import { describe, it, expect } from 'vitest';
import type { DagBundle } from '../../../src/dag/schema.js';
import {
  deriveDeps,
  extractRefs,
  synthesizeMissingPromptEntries,
  type EntriesByBundleNode,
  type ReferenceMap,
} from '../../../src/dag/eventLog/backfillHelpers.js';

// ── Test fixture: a tiny bundle exercising every scope ───────────────

function makeBundle(): DagBundle {
  return {
    id: 'test',
    version: '0.1.0',
    goal: 'shot_video',
    nodes: [
      {
        id: 'plot',
        kind: 'stage',
        inputs: [],
        outputs: { format: 'md', pattern: 'plot.md' },
        runner: { tool: 'llm.generate', config: {} },
      },
      {
        id: 'characters_plan',
        kind: 'stage',
        inputs: [{ from: 'plot', usage: 'context' }],
        outputs: { format: 'json', pattern: 'chars.json' },
        runner: { tool: 'llm.generate', config: {} },
      },
      {
        id: 'character_image_prompt',
        kind: 'collection',
        itemSource: 'characters_plan',
        inputs: [{ from: 'characters_plan', usage: 'input', scope: 'matching' }],
        outputs: { format: 'json', pattern: 'chars/{{item_id}}.json' },
        runner: { tool: 'llm.generate', config: {} },
      },
      {
        id: 'character_image',
        kind: 'collection',
        itemSource: 'character_image_prompt',
        inputs: [{ from: 'character_image_prompt', usage: 'input', scope: 'matching' }],
        outputs: { format: 'image', pattern: 'chars/{{item_id}}.png' },
        runner: { tool: 'comfy.image', config: {} },
      },
      {
        id: 'setting_image',
        kind: 'collection',
        itemSource: 'settings_plan',
        inputs: [],
        outputs: { format: 'image', pattern: 'sets/{{item_id}}.png' },
        runner: { tool: 'comfy.image', config: {} },
      },
      {
        id: 'shot_image',
        kind: 'collection',
        itemSource: 'shot_image_prompt',
        inputs: [
          { from: 'character_image', usage: 'reference', scope: 'all' },
          { from: 'setting_image', usage: 'reference', scope: 'all' },
          { from: 'shot_image', usage: 'context', scope: 'previousN', n: 3 },
        ],
        outputs: { format: 'image', pattern: 'shots/{{item_id}}.png' },
        runner: { tool: 'comfy.image', config: {} },
      },
      {
        id: 'shot_video',
        kind: 'collection',
        itemSource: 'shot_image',
        inputs: [{ from: 'shot_image', usage: 'input', scope: 'matching' }],
        outputs: { format: 'video', pattern: 'shots/{{item_id}}.mp4' },
        runner: { tool: 'comfy.image', config: {} },
      },
    ],
  } as DagBundle;
}

function makeEntries(): EntriesByBundleNode {
  const m: EntriesByBundleNode = new Map();
  m.set('plot', [{ itemId: undefined }]);
  m.set('characters_plan', [{ itemId: undefined }]);
  m.set('character_image_prompt', [{ itemId: 'lara' }, { itemId: 'beth' }]);
  m.set('character_image', [{ itemId: 'lara' }, { itemId: 'beth' }]);
  m.set('setting_image', [{ itemId: 'cave' }, { itemId: 'dawn' }]);
  m.set('shot_image_prompt', [{ itemId: 'shot_1' }, { itemId: 'shot_2' }, { itemId: 'shot_3' }]);
  m.set('shot_image', [{ itemId: 'shot_1' }, { itemId: 'shot_2' }, { itemId: 'shot_3' }]);
  m.set('shot_video', [{ itemId: 'shot_1' }, { itemId: 'shot_2' }, { itemId: 'shot_3' }]);
  return m;
}

// ── extractRefs ──────────────────────────────────────────────────────

describe('extractRefs', () => {
  it('1. empty / null / non-object input → []', () => {
    expect(extractRefs(null)).toEqual([]);
    expect(extractRefs(undefined)).toEqual([]);
    expect(extractRefs('not a json')).toEqual([]);
    expect(extractRefs(42)).toEqual([]);
    expect(extractRefs({})).toEqual([]);
  });

  it('2. flat {id, type} passthrough', () => {
    const refs = extractRefs({
      references: [
        { id: 'lara', type: 'character' },
        { id: 'cave', type: 'setting' },
      ],
    });
    expect(refs).toEqual([
      { id: 'lara', type: 'character' },
      { id: 'cave', type: 'setting' },
    ]);
  });

  it('3. nested frames.first_frame.references with refId → parses', () => {
    const refs = extractRefs({
      frames: {
        first_frame: {
          references: [
            { refId: 'character_image:lara_croft', imageNumber: 2 },
            { refId: 'setting_image:cathedral_cave', imageNumber: 1 },
          ],
        },
      },
    });
    expect(refs).toContainEqual({ id: 'lara_croft', type: 'character' });
    expect(refs).toContainEqual({ id: 'cathedral_cave', type: 'setting' });
  });

  it('4. multiple frames → refs from each', () => {
    const refs = extractRefs({
      frames: {
        first_frame: { references: [{ refId: 'character_image:lara' }] },
        last_frame: { references: [{ refId: 'character_image:beth' }] },
      },
    });
    expect(refs.map((r) => r.id).sort()).toEqual(['beth', 'lara']);
  });

  it('5. mixed flat + nested → both collected', () => {
    const refs = extractRefs({
      references: [{ id: 'x', type: 'character' }],
      frames: { first_frame: { references: [{ refId: 'setting_image:y' }] } },
    });
    expect(refs).toContainEqual({ id: 'x', type: 'character' });
    expect(refs).toContainEqual({ id: 'y', type: 'setting' });
  });

  it('6. malformed entries silently skipped', () => {
    const refs = extractRefs({
      references: [
        { id: 'good', type: 'character' },
        { whatever: 'bad' },
        null,
        'string',
        42,
      ],
    });
    expect(refs).toEqual([{ id: 'good', type: 'character' }]);
  });

  it('7. refId with no colon → no entry pushed', () => {
    const refs = extractRefs({
      references: [{ refId: 'bareNoColon' }],
    });
    expect(refs).toEqual([]);
  });

  it('8. explicit type on refId entry wins over inferred', () => {
    const refs = extractRefs({
      references: [{ refId: 'character_image:foo', type: 'custom_kind' }],
    });
    expect(refs).toEqual([{ id: 'foo', type: 'custom_kind' }]);
  });
});

// ── deriveDeps ───────────────────────────────────────────────────────

describe('deriveDeps', () => {
  const bundle = makeBundle();
  const entries = makeEntries();

  it('9. stage upstream → exactly one dep with no itemId', () => {
    const deps = deriveDeps(bundle, 'characters_plan', undefined, entries);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ nodeId: 'plot' });
    expect(deps[0]?.itemId).toBeUndefined();
  });

  it('10. scope=matching → 1:1 if same-itemId upstream exists', () => {
    const deps = deriveDeps(bundle, 'character_image', 'lara', entries);
    // character_image's only input is character_image_prompt (matching)
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ nodeId: 'character_image_prompt', itemId: 'lara' });
  });

  it('10b. scope=matching → 0 deps when no matching upstream itemId', () => {
    const deps = deriveDeps(bundle, 'character_image', 'unknown_id', entries);
    expect(deps).toEqual([]);
  });

  it('11. scope=previousN → N priors by shot number desc, excluding self', () => {
    // shot_image has previousN from shot_image, n=3. For shot_3 we
    // expect priors shot_2, shot_1 (only 2 exist). For shot_1 → none.
    const depsShot3 = deriveDeps(bundle, 'shot_image', 'shot_3', entries)
      .filter((d) => d.nodeId === 'shot_image');
    expect(depsShot3.map((d) => d.itemId)).toEqual(['shot_2', 'shot_1']);

    const depsShot1 = deriveDeps(bundle, 'shot_image', 'shot_1', entries)
      .filter((d) => d.nodeId === 'shot_image');
    expect(depsShot1).toEqual([]);
  });

  it('12. scope=all with no referenceMap → fan-out', () => {
    const deps = deriveDeps(bundle, 'shot_image', 'shot_1', entries);
    const charDeps = deps.filter((d) => d.nodeId === 'character_image');
    expect(charDeps.map((d) => d.itemId).sort()).toEqual(['beth', 'lara']);
    const setDeps = deps.filter((d) => d.nodeId === 'setting_image');
    expect(setDeps.map((d) => d.itemId).sort()).toEqual(['cave', 'dawn']);
  });

  it('13. scope=all with referenceMap → narrows by id + type', () => {
    const refMap: ReferenceMap = new Map();
    refMap.set('shot_image:shot_1', [
      { id: 'lara', type: 'character' },
      { id: 'cave', type: 'setting' },
    ]);
    const deps = deriveDeps(bundle, 'shot_image', 'shot_1', entries, refMap);
    const charDeps = deps.filter((d) => d.nodeId === 'character_image');
    expect(charDeps.map((d) => d.itemId)).toEqual(['lara']);
    const setDeps = deps.filter((d) => d.nodeId === 'setting_image');
    expect(setDeps.map((d) => d.itemId)).toEqual(['cave']);
  });

  it('14. referenceMap missing type for an upstream → that upstream stays fan-out', () => {
    // Only character refs given; setting upstream should stay fan-out.
    const refMap: ReferenceMap = new Map();
    refMap.set('shot_image:shot_1', [{ id: 'lara', type: 'character' }]);
    const deps = deriveDeps(bundle, 'shot_image', 'shot_1', entries, refMap);
    const charDeps = deps.filter((d) => d.nodeId === 'character_image');
    expect(charDeps.map((d) => d.itemId)).toEqual(['lara']);
    const setDeps = deps.filter((d) => d.nodeId === 'setting_image');
    // No setting refs → not narrowed → full fan-out
    expect(setDeps.map((d) => d.itemId).sort()).toEqual(['cave', 'dawn']);
  });

  it('15. previousN with no shot-numbered downstream → []', () => {
    const deps = deriveDeps(bundle, 'shot_image', 'no_shot_num_here', entries)
      .filter((d) => d.nodeId === 'shot_image');
    expect(deps).toEqual([]);
  });

  it('roles propagate from bundle inputs[].usage', () => {
    const deps = deriveDeps(bundle, 'shot_image', 'shot_1', entries);
    const charDep = deps.find((d) => d.nodeId === 'character_image');
    expect(charDep?.role).toBe('reference');
  });
});

// ── synthesizeMissingPromptEntries ───────────────────────────────────

describe('synthesizeMissingPromptEntries', () => {
  it('16. adds prompt-tier entries with itemIds from image-tier', () => {
    const entries: EntriesByBundleNode = new Map();
    entries.set('character_image', [{ itemId: 'lara' }, { itemId: 'beth' }]);
    // bundle declares character_image_prompt; entries.map doesn't
    const added = synthesizeMissingPromptEntries(makeBundle(), entries);
    expect(added).toBe(2);
    const prompt = entries.get('character_image_prompt');
    expect(prompt?.map((e) => e.itemId).sort()).toEqual(['beth', 'lara']);
  });

  it('17. skips pairs where bundle doesn\'t declare the prompt node', () => {
    // Bundle has no `setting_image_prompt` if we don't include it; in
    // makeBundle() it doesn't exist. So that pair should be skipped.
    const entries: EntriesByBundleNode = new Map();
    entries.set('setting_image', [{ itemId: 'cave' }]);
    const added = synthesizeMissingPromptEntries(makeBundle(), entries);
    // Only character_image_prompt + shot_image_last_frame_prompt pairs
    // are checked. Setting pair is skipped (no prompt node in bundle).
    // Since no character_image / shot_image_last_frame entries either,
    // nothing is added.
    expect(added).toBe(0);
    expect(entries.has('setting_image_prompt')).toBe(false);
  });

  it('18. doesn\'t duplicate existing entries', () => {
    const entries: EntriesByBundleNode = new Map();
    entries.set('character_image', [{ itemId: 'lara' }]);
    entries.set('character_image_prompt', [{ itemId: 'lara' }]); // already exists
    const added = synthesizeMissingPromptEntries(makeBundle(), entries);
    expect(added).toBe(0);
    expect(entries.get('character_image_prompt')).toHaveLength(1);
  });

  it('19. count reflects number of synthetic entries added', () => {
    const entries: EntriesByBundleNode = new Map();
    entries.set('character_image', [{ itemId: 'a' }, { itemId: 'b' }, { itemId: 'c' }]);
    const added = synthesizeMissingPromptEntries(makeBundle(), entries);
    expect(added).toBe(3);
  });

  it('20. synthetic entries are flagged', () => {
    const entries: EntriesByBundleNode = new Map();
    entries.set('character_image', [{ itemId: 'lara' }]);
    synthesizeMissingPromptEntries(makeBundle(), entries);
    expect(entries.get('character_image_prompt')?.[0]?.synthetic).toBe(true);
  });
});
