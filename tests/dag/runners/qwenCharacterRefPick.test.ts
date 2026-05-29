/**
 * Regression: BUG-024 — comfy.qwen_edit_chain's character-ref picker
 * only matched verbatim character IDs (snake_case), so any prompt
 * using natural language ("pawn shop owner", "the owner") got the
 * wrong character reference image attached. The runner silently fell
 * back to alphabetic order, sending Angel's portrait as the
 * "reference" for the pawn shop owner shot — producing pawn shop
 * owners that look like Angel.
 *
 * Real-world repro on Ruby V4 refined:
 *   - scene_2_shot_3 (pawn shop owner, gold chain): charRefs sent
 *     was ['angel.png']. The model rendered a lean dark-haired man
 *     in a leather jacket instead of the canonical bald/heavyset/50s
 *     owner.
 *   - scene_2_shot_6 (Ruby points gun at owner): charRefs sent was
 *     ['ruby.png'] — owner reference missing entirely. Composition
 *     drifted, gun direction reversed.
 *
 * Failure modes covered:
 *  - Exact ID in prompt → matched ('ruby', 'angel')
 *  - Natural-language ID with spaces in prompt → matched
 *    ('pawn shop owner' → pawn_shop_owner)
 *  - Last distinctive token in prompt → matched ('owner' →
 *    pawn_shop_owner)
 *  - Regression-guard: short generic tokens (≤4 chars) MUST NOT
 *    spuriously match. 'red' shouldn't match 'red_herring'.
 *  - Cap at 2 refs preserved (Qwen Edit takes max 2 extras).
 *  - Mentioned order is preserved when picking the 2.
 */
import { describe, expect, it } from 'vitest';
import { pickCharacterRefs } from '../../../src/dag/runners/comfyQwenEditChain.js';

describe('pickCharacterRefs — natural-language character matching', () => {
  const charIds = ['ruby', 'angel', 'pawn_shop_owner', 'lamborghini_driver'];

  it('matches verbatim character id', () => {
    const prompt = '<sks> front view, Ruby holds the revolver against Angel\'s temple.';
    expect(pickCharacterRefs(prompt, charIds)).toEqual(['ruby', 'angel']);
  });

  it('matches natural-language phrase (underscores → spaces)', () => {
    const prompt =
      '<sks> medium shot, The pawn shop owner stands behind the scarred wooden counter, frozen mid-motion.';
    expect(pickCharacterRefs(prompt, charIds)).toContain('pawn_shop_owner');
  });

  it('matches distinctive last token of multi-word id', () => {
    // "owner" alone unambiguously references pawn_shop_owner.
    const prompt =
      '<sks> close-up, The revolver muzzle presses against the owner\'s forehead, Ruby\'s eyes cold.';
    const picks = pickCharacterRefs(prompt, charIds);
    expect(picks).toContain('pawn_shop_owner');
    expect(picks).toContain('ruby');
  });

  it('returns at most 2 refs (Qwen Edit Multi-Angle constraint)', () => {
    const prompt =
      '<sks> wide shot, Ruby, Angel, the pawn shop owner, and the lamborghini driver all visible.';
    const picks = pickCharacterRefs(prompt, charIds);
    expect(picks.length).toBeLessThanOrEqual(2);
  });

  it('does NOT spuriously match short generic tokens (regression-guard)', () => {
    // If the heuristic was too greedy ('red' matches 'red_herring'),
    // a prompt about a 'red neon sign' would elevate red_herring
    // ahead of characters that are genuinely mentioned. Verify the
    // mentioned characters win.
    const picks = pickCharacterRefs(
      '<sks> wide shot, Ruby walks past a red neon sign toward the pawn shop owner.',
      ['ruby', 'red_herring', 'pawn_shop_owner'],
    );
    expect(picks).toContain('ruby');
    expect(picks).toContain('pawn_shop_owner');
    expect(picks).not.toContain('red_herring');
  });

  it('falls back to alphabetical only when ZERO mentions found', () => {
    // Backward compat: if the prompt doesn't mention any character
    // by id/spaces/last-token, we still need to send SOMETHING (the
    // Qwen workflow has 2 ref slots and needs files). Alphabetical
    // is the existing fallback; preserve it.
    const picks = pickCharacterRefs(
      '<sks> wide shot, An empty bus depot under fluorescent lights.',
      charIds,
    );
    // First 2 alphabetical: angel, lamborghini_driver
    expect(picks).toEqual(['angel', 'lamborghini_driver']);
  });

  it('preserves order-of-mention when multiple match', () => {
    // Important for predictability: the first character to appear
    // in the prompt should be the first ref slot, so the model's
    // Multi-Angle weighting hits the primary subject.
    const promptRubyFirst =
      '<sks> close-up, Ruby raises the gun. The owner trembles.';
    expect(pickCharacterRefs(promptRubyFirst, charIds)[0]).toBe('ruby');

    const promptOwnerFirst =
      '<sks> close-up, The owner trembles. Ruby raises the gun.';
    expect(pickCharacterRefs(promptOwnerFirst, charIds)[0]).toBe('pawn_shop_owner');
  });
});
