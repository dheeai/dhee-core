/**
 * pickSceneVideoPrompt — per-scene global prompt matching.
 *
 * When scene_video_prompt is a per-scene COLLECTION, a scene_clip must
 * read its OWN scene's brief (scene_clip:scene_N → scene_video_prompt:
 * scene_N). The old walker took svpInsts[0] unconditionally, so every
 * clip got scene 1's brief — the bug behind the repeating spoken title.
 *
 * It must also stay backward-compatible: bundles that keep
 * scene_video_prompt as a single `stage` node (one global prompt, no
 * per-scene instances / no sceneNumber) fall back to the first instance.
 */
import { describe, it, expect } from 'vitest';
import { pickSceneVideoPrompt } from '../../src/dag/walker.js';

type Inst = { itemId?: string; sceneNumber?: number; outputRel?: string };

const perScene: Inst[] = [
  { itemId: 'scene_1', sceneNumber: 1, outputRel: 'prompts/videos/scenes/scene_1.md' },
  { itemId: 'scene_2', sceneNumber: 2, outputRel: 'prompts/videos/scenes/scene_2.md' },
  { itemId: 'scene_3', sceneNumber: 3, outputRel: 'prompts/videos/scenes/scene_3.md' },
];

describe('pickSceneVideoPrompt', () => {
  it('matches a clip to its own scene', () => {
    expect(pickSceneVideoPrompt(perScene, 2)?.itemId).toBe('scene_2');
    expect(pickSceneVideoPrompt(perScene, 3)?.itemId).toBe('scene_3');
    expect(pickSceneVideoPrompt(perScene, 1)?.itemId).toBe('scene_1');
  });

  it('falls back to the first instance for a single-stage (one-global) bundle', () => {
    // Legacy: one scene_video_prompt stage node, no per-scene instances.
    const single: Inst[] = [{ outputRel: 'prompts/scene_video_prompt.md' }];
    expect(pickSceneVideoPrompt(single, 2)).toBe(single[0]);
    // Even when the clip has a scene number, an instance without one → fallback.
    expect(pickSceneVideoPrompt(single, undefined)).toBe(single[0]);
  });

  it('falls back to the first instance when no scene matches', () => {
    expect(pickSceneVideoPrompt(perScene, 9)?.itemId).toBe('scene_1');
  });

  it('returns undefined when there are no instances', () => {
    expect(pickSceneVideoPrompt([], 2)).toBeUndefined();
  });
});
