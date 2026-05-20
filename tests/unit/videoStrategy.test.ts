/**
 * TDD tests for the video-render strategy resolver.
 *
 * Defaults to `prompt_relay` (one mp4 per scene, rendered via LTX 2.3 +
 * kijai PromptRelay). Setting `dhee_VIDEO_STRATEGY=per_shot` opts out
 * and falls back to the existing per-shot FL2V flow.
 *
 * Pure function — no env mutation, takes the env explicitly so tests
 * stay deterministic and parallel-safe.
 */

import { describe, it, expect } from 'vitest';
import { getVideoStrategy, isPromptRelayMode, shouldGenerateExtraFrame } from '../../src/services/providers/videoStrategy.js';

describe('getVideoStrategy', () => {
  it('defaults to prompt_relay when env var is unset', () => {
    expect(getVideoStrategy({})).toBe('prompt_relay');
  });

  it('returns per_shot when dhee_VIDEO_STRATEGY=per_shot', () => {
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'per_shot' })).toBe('per_shot');
  });

  it('returns prompt_relay when dhee_VIDEO_STRATEGY=prompt_relay', () => {
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'prompt_relay' })).toBe('prompt_relay');
  });

  it('treats unknown values as prompt_relay (the default) rather than throwing', () => {
    // We don't want a typo in the env to crash the whole pipeline; default is safest.
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'gibberish' })).toBe('prompt_relay');
  });

  it('is case-insensitive', () => {
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'PER_SHOT' })).toBe('per_shot');
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: 'Prompt_Relay' })).toBe('prompt_relay');
  });

  it('treats empty string as unset', () => {
    expect(getVideoStrategy({ dhee_VIDEO_STRATEGY: '' })).toBe('prompt_relay');
  });
});

describe('isPromptRelayMode', () => {
  it('true by default', () => {
    expect(isPromptRelayMode({})).toBe(true);
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

  it('skips last_frame in prompt_relay mode (default)', () => {
    expect(shouldGenerateExtraFrame('last_frame', {})).toBe(false);
    expect(shouldGenerateExtraFrame('last_frame', { dhee_VIDEO_STRATEGY: 'prompt_relay' })).toBe(false);
  });

  it('skips mid_frame in prompt_relay mode (default)', () => {
    expect(shouldGenerateExtraFrame('mid_frame', {})).toBe(false);
  });

  it('keeps last_frame and mid_frame in per_shot mode', () => {
    expect(shouldGenerateExtraFrame('last_frame', { dhee_VIDEO_STRATEGY: 'per_shot' })).toBe(true);
    expect(shouldGenerateExtraFrame('mid_frame', { dhee_VIDEO_STRATEGY: 'per_shot' })).toBe(true);
  });

  it('skips arbitrary "extra" frames in prompt_relay mode', () => {
    expect(shouldGenerateExtraFrame('whatever', {})).toBe(false);
  });
});
