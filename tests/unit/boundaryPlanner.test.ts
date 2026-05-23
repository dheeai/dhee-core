/**
 * Tests for the transition boundary planner.
 *
 * The planner runs ONCE per scene, after scene_breakdown produced the
 * shot list and BEFORE any image generation. It classifies each
 * shot-to-shot boundary into {shared_frame, reuse_intent, reframe,
 * cut} and flags shots whose LF must be generated as a video-drift
 * anchor.
 *
 * Tests below pin the contract — failure modes brainstormed first
 * (per TDD memory):
 *   - malformed JSON, code-fenced JSON
 *   - top-level missing `transitions` / `anchors`
 *   - unknown operation enum
 *   - transitions for nonexistent shotNumbers
 *   - transitions for shotNumber 1 (no predecessor)
 *   - duplicate toShotNumber entries
 *   - single-shot scenes (no transitions at all)
 *   - anchors with non-boolean / unknown shotNumbers
 *   - applyBoundaryPlanToScene wires the right fields onto the right shots
 *   - feature flag helper is strict-boolean
 */

import { describe, it, expect } from 'vitest';
import type { Scene } from '../../src/core/project/projectSchema.js';

// ── Feature flag ─────────────────────────────────────────────────────────────

describe('isTransitionBoundaryPlannerEnabled', () => {
  it('returns false on missing project', async () => {
    const { isTransitionBoundaryPlannerEnabled } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    expect(isTransitionBoundaryPlannerEnabled(undefined)).toBe(false);
    expect(isTransitionBoundaryPlannerEnabled(null)).toBe(false);
  });

  it('returns false on missing features block', async () => {
    const { isTransitionBoundaryPlannerEnabled } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    expect(isTransitionBoundaryPlannerEnabled({})).toBe(false);
  });

  it('returns false on missing flag', async () => {
    const { isTransitionBoundaryPlannerEnabled } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    expect(isTransitionBoundaryPlannerEnabled({ features: {} })).toBe(false);
  });

  it('returns true only on strict boolean true', async () => {
    const { isTransitionBoundaryPlannerEnabled } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    expect(
      isTransitionBoundaryPlannerEnabled({ features: { transitionBoundaryPlanner: true } }),
    ).toBe(true);
    // Hand-edit typo: string "true" — must NOT enable the feature.
    expect(
      isTransitionBoundaryPlannerEnabled({
        features: { transitionBoundaryPlanner: 'true' as unknown as boolean },
      }),
    ).toBe(false);
    expect(
      isTransitionBoundaryPlannerEnabled({
        features: { transitionBoundaryPlanner: 1 as unknown as boolean },
      }),
    ).toBe(false);
    expect(
      isTransitionBoundaryPlannerEnabled({ features: { transitionBoundaryPlanner: false } }),
    ).toBe(false);
  });
});

// ── parseBoundaryPlannerOutput ───────────────────────────────────────────────

describe('parseBoundaryPlannerOutput', () => {
  const validShotNumbers = [1, 2, 3, 4];

  it('returns empty plan on malformed JSON', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const plan = parseBoundaryPlannerOutput('this is not json', validShotNumbers);
    expect(plan).toEqual({ transitions: [], anchors: [] });
  });

  it('returns empty plan on empty string', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    expect(parseBoundaryPlannerOutput('', validShotNumbers)).toEqual({
      transitions: [],
      anchors: [],
    });
    expect(parseBoundaryPlannerOutput('   \n  ', validShotNumbers)).toEqual({
      transitions: [],
      anchors: [],
    });
  });

  it('strips ```json fences', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const raw =
      '```json\n{\n  "transitions": [{"toShotNumber": 2, "operation": "cut"}],\n  "anchors": []\n}\n```';
    const plan = parseBoundaryPlannerOutput(raw, validShotNumbers);
    expect(plan.transitions).toHaveLength(1);
    expect(plan.transitions[0]!.operation).toBe('cut');
  });

  it('parses all four operations', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const raw = JSON.stringify({
      transitions: [
        { toShotNumber: 2, operation: 'shared_frame', reason: 'r1' },
        { toShotNumber: 3, operation: 'reuse_intent', reason: 'r2' },
        { toShotNumber: 4, operation: 'reframe', reason: 'r3' },
      ],
      anchors: [],
    });
    const plan = parseBoundaryPlannerOutput(raw, validShotNumbers);
    expect(plan.transitions.map((t) => t.operation)).toEqual([
      'shared_frame',
      'reuse_intent',
      'reframe',
    ]);
    expect(plan.transitions[0]!.reason).toBe('r1');
  });

  it('drops entries with unknown operation', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const raw = JSON.stringify({
      transitions: [
        { toShotNumber: 2, operation: 'merge_clips' },
        { toShotNumber: 3, operation: 'cut', reason: 'kept' },
      ],
      anchors: [],
    });
    const plan = parseBoundaryPlannerOutput(raw, validShotNumbers);
    expect(plan.transitions).toHaveLength(1);
    expect(plan.transitions[0]!.toShotNumber).toBe(3);
  });

  it('drops entries with toShotNumber not in the scene', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const raw = JSON.stringify({
      transitions: [
        { toShotNumber: 99, operation: 'cut' }, // not in scene
        { toShotNumber: 2, operation: 'cut', reason: 'kept' },
      ],
      anchors: [],
    });
    const plan = parseBoundaryPlannerOutput(raw, validShotNumbers);
    expect(plan.transitions).toHaveLength(1);
    expect(plan.transitions[0]!.toShotNumber).toBe(2);
  });

  it('drops entries with toShotNumber=1 (no predecessor inside the scene)', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const raw = JSON.stringify({
      transitions: [
        { toShotNumber: 1, operation: 'shared_frame', reason: 'invalid' },
        { toShotNumber: 2, operation: 'cut' },
      ],
      anchors: [],
    });
    const plan = parseBoundaryPlannerOutput(raw, validShotNumbers);
    expect(plan.transitions.map((t) => t.toShotNumber)).toEqual([2]);
  });

  it('deduplicates by toShotNumber, keeping first', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const raw = JSON.stringify({
      transitions: [
        { toShotNumber: 2, operation: 'shared_frame', reason: 'first' },
        { toShotNumber: 2, operation: 'cut', reason: 'duplicate' },
      ],
      anchors: [],
    });
    const plan = parseBoundaryPlannerOutput(raw, validShotNumbers);
    expect(plan.transitions).toHaveLength(1);
    expect(plan.transitions[0]!.reason).toBe('first');
  });

  it('handles single-shot scene (no transitions expected)', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const raw = JSON.stringify({ transitions: [], anchors: [] });
    const plan = parseBoundaryPlannerOutput(raw, [1]);
    expect(plan.transitions).toEqual([]);
    expect(plan.anchors).toEqual([]);
  });

  it('only keeps anchors marked true with a valid shotNumber', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const raw = JSON.stringify({
      transitions: [],
      anchors: [
        { shotNumber: 2, needsLfAnchor: true, reason: 'expression' },
        { shotNumber: 3, needsLfAnchor: false }, // false means "no anchor" — drop
        { shotNumber: 99, needsLfAnchor: true }, // bad shotNumber — drop
        { shotNumber: 4, needsLfAnchor: 'yes' }, // wrong type — drop
      ],
      anchors_extra: 'ignored',
    });
    const plan = parseBoundaryPlannerOutput(raw, validShotNumbers);
    expect(plan.anchors).toHaveLength(1);
    expect(plan.anchors[0]!).toEqual({
      shotNumber: 2,
      needsLfAnchor: true,
      reason: 'expression',
    });
  });

  it('tolerates missing anchors key (treats as empty)', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const raw = JSON.stringify({
      transitions: [{ toShotNumber: 2, operation: 'cut' }],
    });
    const plan = parseBoundaryPlannerOutput(raw, validShotNumbers);
    expect(plan.transitions).toHaveLength(1);
    expect(plan.anchors).toEqual([]);
  });

  it('returns empty plan when top-level shape is wrong', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    expect(parseBoundaryPlannerOutput('null', validShotNumbers)).toEqual({
      transitions: [],
      anchors: [],
    });
    expect(parseBoundaryPlannerOutput('[]', validShotNumbers)).toEqual({
      transitions: [],
      anchors: [],
    });
    expect(parseBoundaryPlannerOutput('"hello"', validShotNumbers)).toEqual({
      transitions: [],
      anchors: [],
    });
  });

  it('trims and ignores stray prose around JSON when JSON.parse fails on the full text', async () => {
    const { parseBoundaryPlannerOutput } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    // No fence, but extra wrapping prose. parseBoundaryPlannerOutput is
    // deliberately strict — it expects clean JSON. The contract: if the
    // top-level JSON doesn't parse, return empty plan. The system
    // prompt instructs the LLM to emit clean JSON.
    const raw = 'Here is the plan: { "transitions": [], "anchors": [] }';
    expect(parseBoundaryPlannerOutput(raw, validShotNumbers)).toEqual({
      transitions: [],
      anchors: [],
    });
  });
});

// ── applyBoundaryPlanToScene ─────────────────────────────────────────────────

describe('applyBoundaryPlanToScene', () => {
  function makeScene(): Scene {
    return {
      sceneNumber: 1,
      shots: [
        { shotNumber: 1, description: 'shot 1' },
        { shotNumber: 2, description: 'shot 2' },
        { shotNumber: 3, description: 'shot 3' },
      ],
    };
  }

  it('writes incomingTransition onto matching shots', async () => {
    const { applyBoundaryPlanToScene } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const scene = makeScene();
    applyBoundaryPlanToScene(scene, {
      transitions: [
        { toShotNumber: 2, operation: 'shared_frame', reason: 'r2' },
        { toShotNumber: 3, operation: 'cut', reason: 'r3' },
      ],
      anchors: [],
    });
    expect(scene.shots[0]!.incomingTransition).toBeUndefined();
    expect(scene.shots[1]!.incomingTransition).toEqual({
      operation: 'shared_frame',
      reason: 'r2',
    });
    expect(scene.shots[2]!.incomingTransition).toEqual({
      operation: 'cut',
      reason: 'r3',
    });
  });

  it('writes needsLfAnchor onto matching shots', async () => {
    const { applyBoundaryPlanToScene } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const scene = makeScene();
    applyBoundaryPlanToScene(scene, {
      transitions: [],
      anchors: [{ shotNumber: 2, needsLfAnchor: true, reason: 'anchor' }],
    });
    expect(scene.shots[0]!.needsLfAnchor).toBeUndefined();
    expect(scene.shots[1]!.needsLfAnchor).toBe(true);
    expect(scene.shots[2]!.needsLfAnchor).toBeUndefined();
  });

  it('clears prior transition/anchor fields before applying (idempotent re-run)', async () => {
    const { applyBoundaryPlanToScene } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const scene = makeScene();
    // Pre-populate as if a previous planner run wrote stale values.
    scene.shots[1]!.incomingTransition = { operation: 'cut', reason: 'stale' };
    scene.shots[1]!.needsLfAnchor = true;
    applyBoundaryPlanToScene(scene, {
      transitions: [{ toShotNumber: 3, operation: 'reframe' }],
      anchors: [],
    });
    // Shot 2 was not in the new plan — its stale fields must be cleared.
    expect(scene.shots[1]!.incomingTransition).toBeUndefined();
    expect(scene.shots[1]!.needsLfAnchor).toBeUndefined();
    expect(scene.shots[2]!.incomingTransition?.operation).toBe('reframe');
  });

  it('ignores plan entries that don\'t match any shot (defensive)', async () => {
    const { applyBoundaryPlanToScene } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const scene = makeScene();
    applyBoundaryPlanToScene(scene, {
      // toShotNumber 99 isn't in scene — must not throw, must not corrupt scene.
      transitions: [{ toShotNumber: 99, operation: 'cut' }],
      anchors: [{ shotNumber: 99, needsLfAnchor: true }],
    });
    for (const shot of scene.shots) {
      expect(shot.incomingTransition).toBeUndefined();
      expect(shot.needsLfAnchor).toBeUndefined();
    }
  });
});

// ── buildBoundaryPlannerPrompt ───────────────────────────────────────────────

describe('buildBoundaryPlannerPrompt', () => {
  it('returns a system+user pair with the scene\'s shots in playback order', async () => {
    const { buildBoundaryPlannerPrompt } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const out = buildBoundaryPlannerPrompt({
      sceneNumber: 2,
      rasa: 'tense',
      characters: ['Sera', 'Malachor'],
      shots: [
        {
          shotNumber: 1,
          description: 'Sera looks at the datapad.',
          purpose: 'show_clue',
          cameraWork: 'close-up',
        },
        {
          shotNumber: 2,
          description: 'Malachor enters.',
          purpose: 'meet_character',
          cameraWork: 'wide',
        },
      ],
    });
    expect(out.system).toContain('boundary');
    // The user message must surface both shots with their numbers and prose
    // so the LLM can reason about the transitions.
    expect(out.user).toContain('Sera looks at the datapad');
    expect(out.user).toContain('Malachor enters');
    expect(out.user).toMatch(/shot ?1/i);
    expect(out.user).toMatch(/shot ?2/i);
    // Scene-level context surfaces too.
    expect(out.user).toContain('tense');
  });

  it('handles single-shot scenes without crashing', async () => {
    const { buildBoundaryPlannerPrompt } = await import(
      '../../src/core/planner/boundaryPlanner.js'
    );
    const out = buildBoundaryPlannerPrompt({
      sceneNumber: 1,
      rasa: 'calm',
      characters: [],
      shots: [
        {
          shotNumber: 1,
          description: 'Wide of the field.',
          purpose: 'set_the_world',
          cameraWork: 'wide static',
        },
      ],
    });
    expect(out.system).toBeTruthy();
    expect(out.user).toContain('Wide of the field');
  });
});
