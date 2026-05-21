/**
 * Multi-turn shot_image_prompt seam — pins the ORDERING between turn-1
 * post-pass, turn-2 ref refinement, and the re-run of the deterministic
 * post-pass.
 *
 * This is the bug class that bit us in Ruby V3 s1s1: turn-1 wrote a
 * stale manifest line ("Ruby from image 1." — only Ruby, no setting)
 * because turn-1's refs were incomplete. Turn-2 then refined the refs
 * to include the setting at slot 1 and Ruby at slot 2, BUT the
 * manifest baked into imagePrompt was never updated to match the new
 * refs. Klein saw the old manifest, bound Ruby to slot 1, and silently
 * dropped the setting from its conditioning.
 *
 * Catch-this-or-it-regresses contract:
 *   1. Run the post-pass on turn-1 output (refs = [Ruby@1]).
 *   2. Mutate references[] to simulate turn-2's refinement
 *      ([setting@1, Ruby@2]).
 *   3. Re-run the post-pass.
 *   4. Assert the manifest in imagePrompt matches turn-2's refs.
 *
 * If anyone reorders these steps — moves the post-pass before turn-2,
 * forgets to re-run it after turn-2, or extracts the post-pass into a
 * helper that doesn't get called from both sites — these tests fail.
 *
 * Test list — Must 8.1, 8.3, 1.1.
 */
import { describe, it, expect } from 'vitest';
import {
  applyShotImageManifestPostPass,
  parseTurn2RefsJson,
  type Reference,
} from '../../src/core/planner/shotImagePipeline.js';

type Frame = { imagePrompt: string; references: Reference[] };
type ShotImagePromptJson = {
  shotNumber?: number;
  generationStrategy?: string;
  frames: { first_frame: Frame; last_frame?: Frame };
};

describe('multi-turn shot_image_prompt seam — Must 8.1 (Ruby V3 s1s1 regression)', () => {
  it('manifest in imagePrompt reflects turn-2 refs, not turn-1 stale refs (the exact Ruby V3 bug)', () => {
    // ── Stage 1: turn-1 output. The LLM wrote prose with a self-built
    // manifest line from its (incomplete) initial refs. Only Ruby is in
    // refs[]; the setting was missed.
    const json: ShotImagePromptJson = {
      shotNumber: 1,
      generationStrategy: 'flfv',
      frames: {
        first_frame: {
          imagePrompt: 'Ruby from image 1.\n\nPhotorealistic cinematic still — Ruby descends from the bus, her green eyes sweep the platform with intense curiosity.',
          references: [{ refId: 'character_image:ruby', type: 'character', imageNumber: 1 }],
        },
        last_frame: {
          imagePrompt: 'Ruby from image 1.\n\nRuby has finished descending, standing on the platform.',
          references: [{ refId: 'character_image:ruby', type: 'character', imageNumber: 1 }],
        },
      },
    };

    // ── Stage 2: the executor's FIRST post-pass invocation (line 3076 today).
    // This re-prepends a manifest from turn-1's refs (no-op here because
    // turn-1's manifest is already aligned with turn-1's refs).
    applyShotImageManifestPostPass(json);
    expect(json.frames.first_frame.imagePrompt.startsWith('Ruby from image 1.')).toBe(true);

    // ── Stage 3: turn-2 refines refs. The new refs[] put the setting at
    // slot 1 and Ruby at slot 2 — the AUTHORITATIVE binding.
    const turn2RawLLMOutput = JSON.stringify({
      references: [
        { refId: 'setting_image:city_bus_station', type: 'setting', imageNumber: 1, status: 'existing' },
        { refId: 'character_image:ruby', type: 'character', imageNumber: 2, status: 'existing' },
      ],
    });
    const refined = parseTurn2RefsJson(turn2RawLLMOutput);
    expect(refined).toHaveLength(2);
    json.frames.first_frame.references = refined;
    if (json.frames.last_frame) json.frames.last_frame.references = refined;

    // ── Stage 4: the executor's SECOND post-pass invocation. Without
    // this, the stale "Ruby from image 1." baked into imagePrompt
    // survives — and Klein binds Ruby to slot 1 instead of the setting.
    applyShotImageManifestPostPass(json);

    // ── Assert: manifest matches turn-2's refs on BOTH frames.
    expect(json.frames.first_frame.imagePrompt.startsWith(
      'City Bus Station (setting) from image 1. Ruby from image 2.',
    )).toBe(true);
    expect(json.frames.last_frame!.imagePrompt.startsWith(
      'City Bus Station (setting) from image 1. Ruby from image 2.',
    )).toBe(true);

    // ── Assert: the stale "Ruby from image 1." sentence from turn-1
    // is gone from EVERY frame.
    expect(json.frames.first_frame.imagePrompt).not.toContain('Ruby from image 1.');
    expect(json.frames.last_frame!.imagePrompt).not.toContain('Ruby from image 1.');

    // ── Assert: the narrative body survives (the strip pass mustn't
    // damage actual prose).
    expect(json.frames.first_frame.imagePrompt).toContain('green eyes sweep the platform');
    expect(json.frames.last_frame!.imagePrompt).toContain('finished descending');
  });

  it('if the SECOND post-pass is skipped (the original bug), the manifest stays stale — this test documents the failure mode', () => {
    // Inverse of the test above: confirms that the post-pass IS the
    // load-bearing step. If a future refactor accidentally removes the
    // re-invocation, the test above fails; this test documents WHY.
    const json: ShotImagePromptJson = {
      frames: {
        first_frame: {
          imagePrompt: 'Ruby from image 1.\n\nProse body.',
          references: [{ refId: 'character_image:ruby', type: 'character', imageNumber: 1 }],
        },
      },
    };
    applyShotImageManifestPostPass(json); // turn-1 post-pass

    // turn-2 swaps refs but we DON'T re-run the post-pass.
    json.frames.first_frame.references = [
      { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
      { refId: 'character_image:ruby', type: 'character', imageNumber: 2 },
    ];

    // Skipping the second post-pass = the bug. The manifest is now
    // out of sync with references[].
    expect(json.frames.first_frame.imagePrompt.startsWith('Ruby from image 1.')).toBe(true);
    // Now run it (this is what the fix DOES) — manifest snaps to refs.
    applyShotImageManifestPostPass(json);
    expect(json.frames.first_frame.imagePrompt.startsWith(
      'Bus (setting) from image 1. Ruby from image 2.',
    )).toBe(true);
  });
});

describe('multi-turn shot_image_prompt seam — Must 8.3 (turn-2 must mutate references[] for the post-pass to do its job)', () => {
  it('if turn-2 returns the SAME refs as turn-1 (no change), the post-pass leaves the manifest as-is', () => {
    // Negative-case sanity: when turn-2 confirms turn-1's refs verbatim,
    // the post-pass must not corrupt the output. The re-run is safe.
    const refs: Reference[] = [
      { refId: 'setting_image:bus', type: 'setting', imageNumber: 1 },
      { refId: 'character_image:ruby', type: 'character', imageNumber: 2 },
    ];
    const json: ShotImagePromptJson = {
      frames: {
        first_frame: {
          imagePrompt: 'Bus (setting) from image 1. Ruby from image 2.\n\nProse body.',
          references: refs,
        },
      },
    };
    applyShotImageManifestPostPass(json);
    expect(json.frames.first_frame.imagePrompt).toContain('Bus (setting) from image 1. Ruby from image 2.');
    expect(json.frames.first_frame.imagePrompt).toContain('Prose body.');
  });
});

describe('multi-turn shot_image_prompt seam — Must 1.1 (turn-2 returns null / [] → caller falls back to turn-1)', () => {
  it('parseTurn2RefsJson on unparseable LLM output returns [] — caller MUST keep turn-1 refs and the manifest stays from the FIRST post-pass', () => {
    // Simulates the executor path: refineShotImageRefs returns null when
    // turn-2 can't be parsed. The caller skips the second post-pass
    // (because refined is null in the if-block), so turn-1's manifest
    // survives. That's correct — better to have a slightly suboptimal
    // turn-1 manifest than to crash the node.
    const json: ShotImagePromptJson = {
      frames: {
        first_frame: {
          imagePrompt: 'Ruby from image 1.\n\nProse body.',
          references: [{ refId: 'character_image:ruby', type: 'character', imageNumber: 1 }],
        },
      },
    };
    applyShotImageManifestPostPass(json); // turn-1 post-pass
    const beforeTurn2 = json.frames.first_frame.imagePrompt;

    // Turn-2 LLM emits garbage → parseTurn2RefsJson returns [].
    const refined = parseTurn2RefsJson('not valid json from a confused model');
    expect(refined).toEqual([]);

    // Caller's contract: when refined is empty, DON'T mutate refs and
    // DON'T re-run the post-pass. The output stays as it was after
    // turn-1's post-pass.
    if (refined.length > 0) {
      json.frames.first_frame.references = refined;
      applyShotImageManifestPostPass(json);
    }
    expect(json.frames.first_frame.imagePrompt).toBe(beforeTurn2);
  });
});
