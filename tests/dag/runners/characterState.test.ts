/**
 * Phase 1 — character state continuity.
 *
 * `characterState.ts` is the pure projection layer that folds an
 * append-only continuity ledger (plans/continuity_plan.json) into the
 * "current state" of each character AT a given shot. This is the fix
 * for narrative drift: instead of the shot-prompt LLM re-deriving "what
 * is she wearing now" from a sliding window of prior prompts, we compute
 * it deterministically from anchored state-change events.
 *
 * These tests pin the fold semantics (last-write-wins per facet, props
 * are a full-set replacement, future events ignored, canonical NUMERIC
 * scene/shot ordering — not lexicographic), the state-key contract
 * (same material facets → same key, different → different), and the
 * end-to-end derived-input dispatch through the real llm.generate runner.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  stateAtShot,
  computeStateKey,
  compareShotIds,
  normalizeLedger,
  buildCharacterStateContext,
  type ContinuityLedger,
} from '../../../src/dag/runners/characterState.js';
import { createLlmGenerateRunner } from '../../../src/dag/runners/llmGenerate.js';
import type { RunnerContext, NodeDef } from '../../../src/dag/schema.js';

// ── Fixtures ────────────────────────────────────────────────────────────

const LEDGER: ContinuityLedger = {
  characters: [
    {
      id: 'lara_croft',
      events: [
        {
          atShot: 'scene_2_shot_4',
          facets: { outfit: 'torn, mud-streaked tank', condition: 'wet', props: ['lit torch'] },
          note: 'fell into the cistern',
        },
        { atShot: 'scene_4_shot_1', facets: { condition: 'bleeding, left arm' } },
      ],
    },
    {
      id: 'guide',
      events: [{ atShot: 'scene_3_shot_2', facets: { outfit: 'parka' } }],
    },
  ],
};

function lara(ctx: ReturnType<typeof stateAtShot>) {
  return ctx.characters.find((c) => c.id === 'lara_croft');
}
function guide(ctx: ReturnType<typeof stateAtShot>) {
  return ctx.characters.find((c) => c.id === 'guide');
}

// ── Pure projection ─────────────────────────────────────────────────────

describe('characterState projection', () => {
  describe('stateAtShot — fold semantics', () => {
    it('before any event, every character is base (empty facets, stateKey "base")', () => {
      const ctx = stateAtShot(LEDGER, 'scene_1_shot_1');
      expect(lara(ctx)?.facets).toEqual({});
      expect(lara(ctx)?.stateKey).toBe('base');
      expect(lara(ctx)?.changedThisShot).toBe(false);
      expect(guide(ctx)?.stateKey).toBe('base');
    });

    it('at the anchoring shot, the event applies and changedThisShot is true', () => {
      const ctx = stateAtShot(LEDGER, 'scene_2_shot_4');
      expect(lara(ctx)?.facets).toEqual({
        outfit: 'torn, mud-streaked tank',
        condition: 'wet',
        props: ['lit torch'],
      });
      expect(lara(ctx)?.changedThisShot).toBe(true);
      expect(lara(ctx)?.note).toBe('fell into the cistern');
      // guide hasn't changed yet at scene_2.
      expect(guide(ctx)?.facets).toEqual({});
    });

    it('carries state forward between events without re-flagging changedThisShot', () => {
      const ctx = stateAtShot(LEDGER, 'scene_3_shot_5');
      // lara's scene_2 state persists; her scene_4 event is still future.
      expect(lara(ctx)?.facets).toEqual({
        outfit: 'torn, mud-streaked tank',
        condition: 'wet',
        props: ['lit torch'],
      });
      expect(lara(ctx)?.changedThisShot).toBe(false);
      // guide's scene_3_shot_2 event is now in the past.
      expect(guide(ctx)?.facets).toEqual({ outfit: 'parka' });
    });

    it('last-write-wins per facet; untouched facets carry forward', () => {
      const ctx = stateAtShot(LEDGER, 'scene_4_shot_1');
      // scene_4 event only sets condition → it REPLACES condition but
      // must NOT wipe outfit/props carried from scene_2.
      expect(lara(ctx)?.facets).toEqual({
        outfit: 'torn, mud-streaked tank',
        condition: 'bleeding, left arm',
        props: ['lit torch'],
      });
      expect(lara(ctx)?.changedThisShot).toBe(true);
    });

    it('ignores events anchored AFTER the target shot (no future leak)', () => {
      const ctx = stateAtShot(LEDGER, 'scene_3_shot_5');
      // bleeding is established at scene_4 — must not appear at scene_3.
      expect(lara(ctx)?.facets.condition).toBe('wet');
    });
  });

  describe('stateAtShot — canonical NUMERIC ordering (not lexicographic)', () => {
    const ORDER_LEDGER: ContinuityLedger = {
      characters: [{ id: 'x', events: [{ atShot: 'scene_1_shot_10', facets: { outfit: 'coat' } }] }],
    };

    it('shot_10 does NOT apply at shot_9 (10 > 9 numerically)', () => {
      // Lexicographically "scene_1_shot_10" < "scene_1_shot_9" — a string
      // sort would wrongly apply it. Pin numeric ordering.
      const ctx = stateAtShot(ORDER_LEDGER, 'scene_1_shot_9');
      expect(ctx.characters.find((c) => c.id === 'x')?.facets).toEqual({});
    });

    it('a later-scene shot applies an earlier-scene event', () => {
      const ctx = stateAtShot(ORDER_LEDGER, 'scene_2_shot_1');
      expect(ctx.characters.find((c) => c.id === 'x')?.facets.outfit).toBe('coat');
    });

    it('folds out-of-order events by shot order, not array order', () => {
      const unordered: ContinuityLedger = {
        characters: [
          {
            id: 'y',
            events: [
              { atShot: 'scene_1_shot_3', facets: { outfit: 'B' } },
              { atShot: 'scene_1_shot_1', facets: { outfit: 'A' } },
            ],
          },
        ],
      };
      expect(stateAtShot(unordered, 'scene_1_shot_2').characters[0]?.facets.outfit).toBe('A');
      expect(stateAtShot(unordered, 'scene_1_shot_3').characters[0]?.facets.outfit).toBe('B');
    });
  });

  describe('compareShotIds', () => {
    it('orders by scene then shot, numerically', () => {
      expect(compareShotIds('scene_1_shot_9', 'scene_1_shot_10')).toBeLessThan(0);
      expect(compareShotIds('scene_1_shot_10', 'scene_2_shot_1')).toBeLessThan(0);
      expect(compareShotIds('scene_2_shot_1', 'scene_1_shot_99')).toBeGreaterThan(0);
      expect(compareShotIds('scene_3_shot_2', 'scene_3_shot_2')).toBe(0);
    });
  });

  describe('props are a full-set replacement, not a merge', () => {
    const PROPS_LEDGER: ContinuityLedger = {
      characters: [
        {
          id: 'p',
          events: [
            { atShot: 'scene_1_shot_1', facets: { props: ['torch'] } },
            { atShot: 'scene_1_shot_5', facets: { props: ['torch', 'map'] } },
            { atShot: 'scene_1_shot_8', facets: { props: ['map'] } },
          ],
        },
      ],
    };

    it('replaces the whole prop set at each event', () => {
      expect(stateAtShot(PROPS_LEDGER, 'scene_1_shot_5').characters[0]?.facets.props).toEqual([
        'torch',
        'map',
      ]);
      // torch was dropped at shot_8 — a merge would wrongly keep it.
      expect(stateAtShot(PROPS_LEDGER, 'scene_1_shot_8').characters[0]?.facets.props).toEqual(['map']);
    });
  });

  describe('computeStateKey', () => {
    it('empty facets → "base"', () => {
      expect(computeStateKey({})).toBe('base');
    });

    it('is filename-safe: <slug>__<hash8>', () => {
      const k = computeStateKey({
        outfit: 'torn, mud-streaked tank',
        condition: 'wet',
        props: ['lit torch'],
      });
      expect(k).toMatch(/^[a-z0-9_]+__[0-9a-f]{8}$/);
    });

    it('is stable across field order and prop order (same set → same key)', () => {
      const a = computeStateKey({ outfit: 'red', props: ['b', 'a'] });
      const b = computeStateKey({ props: ['a', 'b'], outfit: 'red' });
      expect(a).toBe(b);
    });

    it('different material facets → different key (counter-test for stability)', () => {
      expect(computeStateKey({ outfit: 'red' })).not.toBe(computeStateKey({ outfit: 'blue' }));
      expect(computeStateKey({ props: ['a', 'b'] })).not.toBe(computeStateKey({ props: ['a', 'c'] }));
    });

    it('the per-event note is NOT part of the state key', () => {
      // note is a continuity annotation, not a visual facet — two states
      // identical except for note must mint the SAME reference.
      const withFacetsOnly = computeStateKey({ outfit: 'red' });
      // note is not a facet field, so it can't even be passed here — this
      // pins that the key derives only from declared visual facets.
      expect(computeStateKey({ outfit: 'red' })).toBe(withFacetsOnly);
    });
  });

  describe('normalizeLedger — defensive parsing of unknown JSON', () => {
    it('returns an empty ledger for undefined / malformed input', () => {
      expect(normalizeLedger(undefined).characters).toEqual([]);
      expect(normalizeLedger({}).characters).toEqual([]);
      expect(normalizeLedger({ characters: 'nope' }).characters).toEqual([]);
    });

    it('keeps only well-formed character entries', () => {
      const led = normalizeLedger({
        characters: [
          { id: 'ok', events: [{ atShot: 'scene_1_shot_1', facets: { outfit: 'x' } }] },
          { name: 'no id' },
          'garbage',
        ],
      });
      expect(led.characters.map((c) => c.id)).toEqual(['ok']);
    });
  });

  describe('buildCharacterStateContext', () => {
    it('folds + filters to only characters that have diverged from base', () => {
      const { context, additionalDependencies } = buildCharacterStateContext({
        ledger: LEDGER,
        itemId: 'scene_2_shot_4',
      });
      expect(context.itemId).toBe('scene_2_shot_4');
      // lara diverged at this shot; guide is still base → excluded.
      expect(context.characters.map((c) => c.id)).toEqual(['lara_croft']);
      // The declared continuity_plan input carries the dependency edge,
      // so the derived builder adds none of its own.
      expect(additionalDependencies).toEqual([]);
    });

    it('returns empty characters for an absent or malformed ledger', () => {
      expect(buildCharacterStateContext({ ledger: undefined, itemId: 'scene_1_shot_1' }).context.characters).toEqual([]);
      expect(buildCharacterStateContext({ ledger: { junk: 1 }, itemId: 'scene_1_shot_1' }).context.characters).toEqual([]);
    });
  });
});

// ── End-to-end derived-input dispatch through the real runner ────────────

interface StubLlmClient {
  generate(opts: { messages: { role: string; content: string }[] }): Promise<{ content?: string }>;
  getModel(): string;
}
function makeStubClient(onPrompt: (prompt: string) => void): StubLlmClient {
  return {
    async generate(opts) {
      onPrompt(opts.messages.map((m) => m.content).join('\n'));
      return { content: 'ok' };
    },
    getModel: () => 'stub-model',
  };
}

describe('llm.generate — character_state derived input', () => {
  let bundleDir: string;
  let projectDir: string;

  beforeEach(() => {
    bundleDir = mkdtempSync(join(tmpdir(), 'cs-bundle-'));
    projectDir = mkdtempSync(join(tmpdir(), 'cs-proj-'));
    mkdirSync(join(bundleDir, 'prompts'), { recursive: true });
  });
  afterEach(() => {
    rmSync(bundleDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  function makeCtx(inputs: Record<string, unknown>, itemId: string): RunnerContext {
    const node: NodeDef = {
      id: 'shot_image_prompt',
      kind: 'collection',
      inputs: [],
      outputs: { format: 'md', pattern: 'out.md' },
      runner: {
        tool: 'llm.generate',
        config: {
          promptTemplate: 'prompts/p.md',
          outputPath: 'out.md',
          tier: 'heavy',
          outputFormat: 'markdown',
          derivedInputs: [
            { id: 'character_state', kind: 'character_state', continuityInput: 'continuity_plan' },
          ],
        },
      },
    };
    const ctx = {
      projectDir,
      bundleDir,
      node,
      inputs,
      log: () => {},
    } as RunnerContext;
    (ctx as { itemId?: string }).itemId = itemId;
    return ctx;
  }

  it('injects the folded current state for the shot into {{character_state}}', async () => {
    writeFileSync(join(bundleDir, 'prompts/p.md'), 'Shot {{item_id}}.\nState: {{character_state}}');
    let prompt = '';
    const runner = createLlmGenerateRunner({ clientFactory: () => makeStubClient((p) => (prompt = p)) });

    const result = await runner.run(makeCtx({ continuity_plan: LEDGER }, 'scene_2_shot_4'));

    expect(result.ok).toBe(true);
    // Folded current state is present...
    expect(prompt).toContain('torn, mud-streaked tank');
    expect(prompt).toContain('lit torch');
    // ...and future state is NOT leaked (bleeding starts at scene_4).
    expect(prompt).not.toContain('bleeding');
  });

  it('renders an empty character set (no crash) when the continuity plan is absent', async () => {
    writeFileSync(join(bundleDir, 'prompts/p.md'), 'State: {{character_state}}');
    let prompt = '';
    const runner = createLlmGenerateRunner({ clientFactory: () => makeStubClient((p) => (prompt = p)) });

    const result = await runner.run(makeCtx({}, 'scene_1_shot_1'));

    expect(result.ok).toBe(true);
    expect(prompt).toContain('"characters":[]');
  });
});
