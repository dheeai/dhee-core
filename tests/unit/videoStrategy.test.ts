/**
 * TDD tests for the video-render strategy resolver.
 *
 * Defaults to `per_shot` (FL2V flow with first+last frame anchors per
 * shot; cross-shot chaining works as designed). Setting
 * `dhee_VIDEO_STRATEGY=prompt_relay` opts into the LTX-2.3 PromptRelay
 * scene-as-one-mp4 rendering path (last frames are NOT generated in
 * that mode).
 *
 * Default was flipped from prompt_relay → per_shot 2026-05-20 after
 * the prompt_relay path was found to silently break cross-shot
 * chaining (see Bug 11 in RUBY_V3_REGEN_NOTES.md).
 *
 * Pure function — no env mutation, takes the env explicitly so tests
 * stay deterministic and parallel-safe.
 */

import { describe, it, expect } from 'vitest';
import { getVideoStrategy, isPromptRelayMode, shouldGenerateExtraFrame } from '../../src/services/providers/videoStrategy.js';

describe('getVideoStrategy', () => {
  it('defaults to per_shot when env var is unset', () => {
    expect(getVideoStrategy({})).toBe('per_shot');
  });

  it('returns per_shot when dhee_VIDEO_STRATEGY=per_shot', () => {
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'per_shot' })).toBe('per_shot');
  });

  it('returns prompt_relay when dhee_VIDEO_STRATEGY=prompt_relay', () => {
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'prompt_relay' })).toBe('prompt_relay');
  });

  it('treats unknown values as per_shot (the default) rather than throwing', () => {
    // We don't want a typo in the env to crash the whole pipeline; default is safest.
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'gibberish' })).toBe('per_shot');
  });

  it('is case-insensitive', () => {
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'PER_SHOT' })).toBe('per_shot');
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'Prompt_Relay' })).toBe('prompt_relay');
  });

  it('treats empty string as unset (per_shot)', () => {
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: '' })).toBe('per_shot');
  });
});

describe('isPromptRelayMode', () => {
  it('false by default (per_shot is default)', () => {
    expect(isPromptRelayMode({})).toBe(false);
  });

  it('true when explicitly opted in via env', () => {
    expect(isPromptRelayMode({ dhee_VIDEO_STRATEGY: 'prompt_relay' })).toBe(true);
  });

  it('false when per_shot', () => {
    expect(isPromptRelayMode({ dhee_VIDEO_STRATEGY: 'per_shot' })).toBe(false);
  });
});

describe('shouldGenerateExtraFrame', () => {
  it('first_frame is always required, in either mode', () => {
    expect(shouldGenerateExtraFrame('first_frame', {})).toBe(true);
    expect(shouldGenerateExtraFrame('first_frame', { dhee_VIDEO_STRATEGY: 'per_shot' })).toBe(true);
    expect(shouldGenerateExtraFrame('first_frame', { dhee_VIDEO_STRATEGY: 'prompt_relay' })).toBe(true);
  });

  it('keeps last_frame in per_shot mode (default)', () => {
    expect(shouldGenerateExtraFrame('last_frame', {})).toBe(true);
    expect(shouldGenerateExtraFrame('last_frame', { dhee_VIDEO_STRATEGY: 'per_shot' })).toBe(true);
  });

  it('keeps mid_frame in per_shot mode (default)', () => {
    expect(shouldGenerateExtraFrame('mid_frame', {})).toBe(true);
  });

  it('skips last_frame and mid_frame in prompt_relay mode (the relay renderer drives video from first_frames only)', () => {
    expect(shouldGenerateExtraFrame('last_frame', { dhee_VIDEO_STRATEGY: 'prompt_relay' })).toBe(false);
    expect(shouldGenerateExtraFrame('mid_frame', { dhee_VIDEO_STRATEGY: 'prompt_relay' })).toBe(false);
  });

  it('keeps arbitrary "extra" frames in per_shot mode (default)', () => {
    expect(shouldGenerateExtraFrame('whatever', {})).toBe(true);
  });
});
