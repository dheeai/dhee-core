/**
 * comfyLtxDirector pure prompt/frame helpers.
 *
 * These were unexported (reachable only past the runner's live-Comfy
 * network path), so the high-value LTX frame-quantization math and the
 * prompt-shaping logic had no unit coverage. Exported in pass 4 purely
 * for testability — no behavior change.
 */
import { describe, it, expect } from 'vitest';
import {
  alignToLTX,
  buildLocalPrompt,
  stripDialogueParaphrase,
  reformatDialogue,
  type ShotInput,
} from '../../../src/dag/runners/comfyLtxDirector.js';

describe('alignToLTX (latent frame alignment)', () => {
  it('rounds each segment to a multiple of 8, then +1 on the first so (total-1) aligns', () => {
    const out = alignToLTX([100, 200, 300]);
    // 100→104, 200→200, 300→304; first +1 → 105
    expect(out).toEqual([105, 200, 304]);
  });

  it('every non-first segment is a multiple of 8; the first is ≡1 (mod 8)', () => {
    const out = alignToLTX([41, 73, 9, 250]);
    expect(out[0]! % 8).toBe(1);
    for (let i = 1; i < out.length; i++) expect(out[i]! % 8).toBe(0);
  });

  it('floors every segment to at least 8 frames (tiny/zero inputs)', () => {
    // round(4/8)=round(0.5)=1→8, round(0)=0→8. First gets +1.
    expect(alignToLTX([4, 0, 3])).toEqual([9, 8, 8]);
  });

  it('handles a single segment', () => {
    // round(50/8)=6→48; +1 → 49
    expect(alignToLTX([50])).toEqual([49]);
  });
});

describe('stripDialogueParaphrase', () => {
  it('drops pronoun-subject dialogue-paraphrase sentences', () => {
    const out = stripDialogueParaphrase('The hero enters the room. He says he will fight.');
    expect(out).toBe('The hero enters the room.');
  });

  it('keeps dialogue verbs when the subject is a concrete noun, not a pronoun', () => {
    const out = stripDialogueParaphrase('The captain shouts orders.');
    expect(out).toBe('The captain shouts orders.');
  });

  it('keeps sentences with no dialogue verb', () => {
    const out = stripDialogueParaphrase('A bird flies overhead. Rain falls.');
    expect(out).toBe('A bird flies overhead. Rain falls.');
  });
});

describe('reformatDialogue', () => {
  it('rewrites SPEAKER: line into "Name says: \\"line\\"."', () => {
    expect(reformatDialogue('MARCUS: Get down now!')).toBe('Marcus says: "Get down now!".');
  });

  it('returns the input unchanged when there is no speaker pattern', () => {
    expect(reformatDialogue('a quiet ambient hum')).toBe('a quiet ambient hum');
  });
});

describe('buildLocalPrompt', () => {
  const base: ShotInput = { shotNumber: 1, duration: 5 };

  it('joins cleaned description + camera work', () => {
    const out = buildLocalPrompt({
      ...base,
      description: 'A wide shot of the lighthouse.',
      cameraWork: 'slow dolly in',
    });
    expect(out).toBe('A wide shot of the lighthouse. slow dolly in');
  });

  it('prefers explicit dialogue+speaker fields, title-casing the speaker and stripping quotes', () => {
    const out = buildLocalPrompt({
      ...base,
      description: 'Marcus ducks behind a crate.',
      dialogue: '"Get down!"',
      speaker: 'MARCUS',
    });
    expect(out).toContain('Audio: Marcus says: "Get down!".');
  });

  it('falls back to the legacy audio field (reformatted) when no dialogue field', () => {
    const out = buildLocalPrompt({ ...base, audio: 'SARAH: We have to move.' });
    expect(out).toContain('Audio: Sarah says: "We have to move.".');
  });

  it('omits the Audio segment entirely when there is no dialogue or audio', () => {
    const out = buildLocalPrompt({ ...base, description: 'An empty street.' });
    expect(out).toBe('An empty street.');
    expect(out).not.toContain('Audio:');
  });
});
