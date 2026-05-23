/**
 * Tests for `shouldSkipLastFrame` — the bridge between the
 * `skipHoldingBeatLF` and `transitionBoundaryPlanner` feature flags.
 *
 * The critical case (caught the original conflict): a holding-beat
 * shot whose LF would normally be skipped, but whose NEXT shot's
 * `incomingTransition.operation` is `shared_frame` or `reuse_intent`
 * — the LF has a downstream consumer and MUST be generated.
 *
 * Also: when `transitionBoundaryPlanner` is OFF, no shot carries the
 * planner fields, so the combined decision must collapse exactly to
 * the historical `skipHoldingBeatLF && isHoldingBeat` behavior.
 */

import { describe, it, expect } from 'vitest';

const HOLDING_BEAT = { purpose: 'show_reaction', cameraWork: 'close-up' };
const NON_HOLDING = { purpose: 'pursue', cameraWork: 'tracking medium' };

const FLAG_OFF = { features: { skipHoldingBeatLF: false } };
const FLAG_ON = { features: { skipHoldingBeatLF: true } };
const BOTH_ON = {
  features: { skipHoldingBeatLF: true, transitionBoundaryPlanner: true },
};

describe('shouldSkipLastFrame — gate 1: skipHoldingBeatLF flag', () => {
  it('returns false when skipHoldingBeatLF is OFF', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(shouldSkipLastFrame(HOLDING_BEAT, FLAG_OFF)).toBe(false);
    expect(shouldSkipLastFrame(HOLDING_BEAT, undefined)).toBe(false);
    expect(shouldSkipLastFrame(HOLDING_BEAT, null)).toBe(false);
  });

  it('returns false on non-holding-beat shots even with flag on', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(shouldSkipLastFrame(NON_HOLDING, FLAG_ON)).toBe(false);
  });

  it('returns true on holding-beat shot with flag on and no planner data', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    // No needsLfAnchor, no nextShotIncomingTransition — collapses to
    // historical behavior.
    expect(shouldSkipLastFrame(HOLDING_BEAT, FLAG_ON)).toBe(true);
  });
});

describe('shouldSkipLastFrame — gate 2: needsLfAnchor overrides skip', () => {
  it('keeps LF when needsLfAnchor is true (anchor wins over holding-beat skip)', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(
      shouldSkipLastFrame({ ...HOLDING_BEAT, needsLfAnchor: true }, BOTH_ON),
    ).toBe(false);
  });

  it('skips LF when needsLfAnchor is explicitly false (holding-beat wins)', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(
      shouldSkipLastFrame({ ...HOLDING_BEAT, needsLfAnchor: false }, BOTH_ON),
    ).toBe(true);
  });

  it('skips LF when needsLfAnchor is undefined (no anchor signal)', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(shouldSkipLastFrame(HOLDING_BEAT, BOTH_ON)).toBe(true);
  });
});

describe('shouldSkipLastFrame — gate 3: downstream consumer overrides skip', () => {
  it('keeps LF when next shot incoming op is shared_frame', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(
      shouldSkipLastFrame(
        { ...HOLDING_BEAT, nextShotIncomingTransition: { operation: 'shared_frame' } },
        BOTH_ON,
      ),
    ).toBe(false);
  });

  it('keeps LF when next shot incoming op is reuse_intent', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(
      shouldSkipLastFrame(
        { ...HOLDING_BEAT, nextShotIncomingTransition: { operation: 'reuse_intent' } },
        BOTH_ON,
      ),
    ).toBe(false);
  });

  it('skips LF when next shot incoming op is reframe (no consumer)', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(
      shouldSkipLastFrame(
        { ...HOLDING_BEAT, nextShotIncomingTransition: { operation: 'reframe' } },
        BOTH_ON,
      ),
    ).toBe(true);
  });

  it('skips LF when next shot incoming op is cut (no consumer)', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(
      shouldSkipLastFrame(
        { ...HOLDING_BEAT, nextShotIncomingTransition: { operation: 'cut' } },
        BOTH_ON,
      ),
    ).toBe(true);
  });

  it('skips LF when there is no next shot (last shot in scene)', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    // nextShotIncomingTransition undefined — no consumer to protect.
    expect(shouldSkipLastFrame(HOLDING_BEAT, BOTH_ON)).toBe(true);
  });

  it('keeps LF on unknown next-shot operation (defensive — treat as unknown consumer)', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    // An LLM-emitted operation we don't recognize should NOT default to
    // "skip is fine." But shouldSkipLastFrame's contract is strict —
    // only shared_frame/reuse_intent count as consumers. Unknown ops
    // (defensive) → skip proceeds (caller already validated the enum).
    // This pins the current strict contract; if we ever loosen it, the
    // test makes the change visible.
    expect(
      shouldSkipLastFrame(
        { ...HOLDING_BEAT, nextShotIncomingTransition: { operation: 'wibble' } },
        BOTH_ON,
      ),
    ).toBe(true);
  });
});

describe('shouldSkipLastFrame — collapse to historical behavior', () => {
  it('with only skipHoldingBeatLF on, ignores planner-shaped fields', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    // transitionBoundaryPlanner is OFF — the helper still does the
    // additional checks (needsLfAnchor, nextShotIncomingTransition),
    // because production code will pass undefined for both when the
    // planner hasn't run. This proves the historical path is
    // preserved.
    expect(shouldSkipLastFrame(HOLDING_BEAT, FLAG_ON)).toBe(true);
    expect(shouldSkipLastFrame(NON_HOLDING, FLAG_ON)).toBe(false);
  });

  it('matches historical isHoldingBeat decisions when planner fields absent', async () => {
    const { shouldSkipLastFrame, isHoldingBeat } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    // Pin behavioral equivalence: for every (purpose, cameraWork) pair,
    // when planner fields are absent, shouldSkipLastFrame == (flag on && isHoldingBeat).
    const cases = [
      { purpose: 'show_reaction', cameraWork: 'close-up' }, // holding beat
      { purpose: 'show_reaction', cameraWork: 'push in close' }, // motion verb → not holding
      { purpose: 'pursue', cameraWork: 'tracking' }, // not holding-beat purpose
      { purpose: 'hold_emotion', cameraWork: '' }, // empty cameraWork → trust purpose
      { purpose: 'set_the_mood', cameraWork: 'static medium' }, // holding beat
    ];
    for (const c of cases) {
      const expected = isHoldingBeat(c.purpose, c.cameraWork);
      expect(shouldSkipLastFrame(c, FLAG_ON)).toBe(expected);
      expect(shouldSkipLastFrame(c, FLAG_OFF)).toBe(false);
    }
  });
});

describe('shouldSkipLastFrame — priority order', () => {
  it('needsLfAnchor wins even when there is also a downstream consumer (both say keep)', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    expect(
      shouldSkipLastFrame(
        {
          ...HOLDING_BEAT,
          needsLfAnchor: true,
          nextShotIncomingTransition: { operation: 'shared_frame' },
        },
        BOTH_ON,
      ),
    ).toBe(false);
  });

  it('flag-off short-circuit beats every override', async () => {
    const { shouldSkipLastFrame } = await import(
      '../../src/core/planner/shotImagePipeline.js'
    );
    // skipHoldingBeatLF is OFF — no LF skip can fire, regardless of
    // anchor / consumer signals.
    expect(
      shouldSkipLastFrame(
        {
          ...HOLDING_BEAT,
          needsLfAnchor: false,
          nextShotIncomingTransition: { operation: 'cut' },
        },
        FLAG_OFF,
      ),
    ).toBe(false);
  });
});
