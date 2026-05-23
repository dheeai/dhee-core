/**
 * Tests for `applyTransitionPlanToShotImagePrompt` — Phase 2 Stage 3
 * mutation pass.
 *
 * Given a shot_image_prompt JSON, the shot's `incomingTransition`
 * from project.scenes, and (lookahead) the NEXT shot's incoming
 * transition for LF-injection, the mutator:
 *
 *   - shared_frame:   first_frame.generationMode → edit_previous_shot,
 *                     imagePrompt gets a "exactly match the prior
 *                     shot's last frame" preamble.
 *   - reuse_intent:   same mode change with "near-identical" preamble.
 *   - reframe:        FF imagePrompt gets "blocking diverges from
 *                     prior shot's last frame" preamble; mode left.
 *   - cut / missing:  no-op (returns null).
 *
 * Plus: when THIS shot's outgoing boundary is shared_frame or
 * reuse_intent (read from next-shot's incomingTransition), the LF
 * prompt gets a "this frame sets up shot N+1: <description>" preamble
 * so the LF is co-designed with the next FF.
 *
 * Failure modes:
 *   - malformed JSON
 *   - scene not in project.scenes
 *   - shot not in scene
 *   - no incomingTransition + no next-shot transition → null (no-op)
 */

import { describe, it, expect } from 'vitest';

const baseJson = (): string =>
  JSON.stringify({
    shotNumber: 2,
    generationStrategy: 'flfv',
    frames: {
      first_frame: {
        imagePrompt: 'Ruby (setting) from image 1. A wide shot of the bus station.',
        generationMode: 'image_text_to_image',
        references: [
          { imageNumber: 1, type: 'setting', refId: 'setting_image:bus_station' },
          { imageNumber: 2, type: 'character', refId: 'character_image:ruby' },
        ],
      },
      last_frame: {
        imagePrompt: 'Ruby has turned to face the camera.',
        generationMode: 'edit_first_frame',
        references: [],
      },
    },
    negativePrompt: 'blurry',
    aspectRatio: '16:9',
  });

function projectWithShot(opts: {
  incomingTransition?: { operation: string };
  nextIncomingTransition?: { operation: string };
  nextDescription?: string;
}): {
  scenes: Array<{
    sceneNumber: number;
    shots: Array<{
      shotNumber: number;
      description?: string;
      incomingTransition?: { operation: string };
    }>;
  }>;
} {
  return {
    scenes: [
      {
        sceneNumber: 1,
        shots: [
          { shotNumber: 1, description: 'shot 1' },
          {
            shotNumber: 2,
            description: 'shot 2',
            ...(opts.incomingTransition
              ? { incomingTransition: opts.incomingTransition }
              : {}),
          },
          {
            shotNumber: 3,
            description: opts.nextDescription ?? 'shot 3 follow-up action',
            ...(opts.nextIncomingTransition
              ? { incomingTransition: opts.nextIncomingTransition }
              : {}),
          },
        ],
      },
    ],
  };
}

describe('applyTransitionPlanToShotImagePrompt', () => {
  it('returns null when no transition signals exist (no-op)', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({});
    expect(applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2)).toBeNull();
  });

  it('returns null when scene not found', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    expect(applyTransitionPlanToShotImagePrompt(baseJson(), { scenes: [] }, 99, 2)).toBeNull();
  });

  it('returns null when shot not found in scene', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({});
    expect(applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 99)).toBeNull();
  });

  it('returns null on malformed JSON', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'shared_frame' },
    });
    expect(
      applyTransitionPlanToShotImagePrompt('not json', project, 1, 2),
    ).toBeNull();
  });

  // ── shared_frame ───────────────────────────────────────────────────────────

  it('shared_frame: flips first_frame mode to edit_previous_shot', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'shared_frame' },
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.frames.first_frame.generationMode).toBe('edit_previous_shot');
  });

  it('shared_frame: prepends "exactly match the prior" preamble to first_frame imagePrompt', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'shared_frame' },
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    const parsed = JSON.parse(out!);
    expect(parsed.frames.first_frame.imagePrompt.toLowerCase()).toContain('exactly');
    expect(parsed.frames.first_frame.imagePrompt.toLowerCase()).toContain('prior');
    // The original prompt must still be present after the preamble.
    expect(parsed.frames.first_frame.imagePrompt).toContain('Ruby (setting)');
  });

  // ── reuse_intent ───────────────────────────────────────────────────────────

  it('reuse_intent: flips first_frame mode to edit_previous_shot', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'reuse_intent' },
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    const parsed = JSON.parse(out!);
    expect(parsed.frames.first_frame.generationMode).toBe('edit_previous_shot');
  });

  it('reuse_intent: prepends "near-identical" preamble', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'reuse_intent' },
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    const parsed = JSON.parse(out!);
    expect(parsed.frames.first_frame.imagePrompt.toLowerCase()).toContain('near-identical');
  });

  // ── reframe ────────────────────────────────────────────────────────────────

  it('reframe: keeps mode but prepends divergence preamble', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'reframe' },
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    const parsed = JSON.parse(out!);
    // Mode stays as whatever was generated (image_text_to_image here).
    expect(parsed.frames.first_frame.generationMode).toBe('image_text_to_image');
    expect(parsed.frames.first_frame.imagePrompt.toLowerCase()).toContain('diverge');
  });

  // ── cut ────────────────────────────────────────────────────────────────────

  it('cut: prepends "hard break" preamble', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'cut' },
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.frames.first_frame.imagePrompt.toLowerCase()).toContain('hard break');
  });

  it('cut: flips edit_previous_shot mode to image_text_to_image (break the chain)', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'cut' },
    });
    // Simulate the upstream pipeline forcing edit_previous_shot for
    // mid-scene shots (the canForceEditPrevious path).
    const chained = JSON.stringify({
      ...JSON.parse(baseJson()),
      frames: {
        ...JSON.parse(baseJson()).frames,
        first_frame: {
          ...JSON.parse(baseJson()).frames.first_frame,
          generationMode: 'edit_previous_shot',
        },
      },
    });
    const out = applyTransitionPlanToShotImagePrompt(chained, project, 1, 2);
    const parsed = JSON.parse(out!);
    expect(parsed.frames.first_frame.generationMode).toBe('image_text_to_image');
  });

  it('reframe: also flips edit_previous_shot mode to image_text_to_image', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'reframe' },
    });
    const chained = JSON.stringify({
      ...JSON.parse(baseJson()),
      frames: {
        ...JSON.parse(baseJson()).frames,
        first_frame: {
          ...JSON.parse(baseJson()).frames.first_frame,
          generationMode: 'edit_previous_shot',
        },
      },
    });
    const out = applyTransitionPlanToShotImagePrompt(chained, project, 1, 2);
    const parsed = JSON.parse(out!);
    expect(parsed.frames.first_frame.generationMode).toBe('image_text_to_image');
  });

  // ── LF lookahead injection ─────────────────────────────────────────────────

  it('outgoing shared_frame: injects N+1 description into last_frame imagePrompt', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      nextIncomingTransition: { operation: 'shared_frame' },
      nextDescription: 'Ruby reaches into her bag and pulls out a datapad.',
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.frames.last_frame.imagePrompt).toContain('Ruby reaches into her bag');
    expect(parsed.frames.last_frame.imagePrompt.toLowerCase()).toContain('next shot');
  });

  it('outgoing reuse_intent: also injects N+1 description into last_frame', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      nextIncomingTransition: { operation: 'reuse_intent' },
      nextDescription: 'Ruby looks up at the departure board.',
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    const parsed = JSON.parse(out!);
    expect(parsed.frames.last_frame.imagePrompt).toContain('Ruby looks up');
  });

  it('outgoing cut/reframe: does NOT inject N+1 description (no consumer)', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      nextIncomingTransition: { operation: 'cut' },
      nextDescription: 'COMPLETELY DIFFERENT LOCATION',
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    // No transition on shot 2 itself, only outgoing=cut → no-op.
    // (last_frame must not contain the next shot's description.)
    if (out !== null) {
      const parsed = JSON.parse(out);
      expect(parsed.frames.last_frame.imagePrompt).not.toContain(
        'COMPLETELY DIFFERENT',
      );
    }
  });

  // ── Combined: both incoming and outgoing transitions ───────────────────────

  it('combined: shared_frame incoming + shared_frame outgoing applies both mutations', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const project = projectWithShot({
      incomingTransition: { operation: 'shared_frame' },
      nextIncomingTransition: { operation: 'shared_frame' },
      nextDescription: 'Ruby steps off the bus.',
    });
    const out = applyTransitionPlanToShotImagePrompt(baseJson(), project, 1, 2);
    const parsed = JSON.parse(out!);
    expect(parsed.frames.first_frame.generationMode).toBe('edit_previous_shot');
    expect(parsed.frames.first_frame.imagePrompt.toLowerCase()).toContain('exactly');
    expect(parsed.frames.last_frame.imagePrompt).toContain('Ruby steps off the bus');
  });

  // ── Edge: shot has no last_frame (skipLF already fired) ────────────────────

  it('tolerates a shot_image_prompt JSON with no last_frame (skip-LF applied upstream)', async () => {
    const { applyTransitionPlanToShotImagePrompt } = await import(
      '../../src/core/planner/applyTransitionPlanToShotImagePrompt.js'
    );
    const json = JSON.stringify({
      shotNumber: 2,
      generationStrategy: 'i2v',
      frames: {
        first_frame: {
          imagePrompt: 'A wide shot of the bus station.',
          generationMode: 'image_text_to_image',
          references: [
            { imageNumber: 1, type: 'setting', refId: 'setting_image:bus_station' },
          ],
        },
        // no last_frame
      },
      negativePrompt: '',
      aspectRatio: '16:9',
    });
    const project = projectWithShot({
      incomingTransition: { operation: 'shared_frame' },
      // outgoing also shared but no last_frame to inject into — must not crash.
      nextIncomingTransition: { operation: 'shared_frame' },
      nextDescription: 'next shot',
    });
    const out = applyTransitionPlanToShotImagePrompt(json, project, 1, 2);
    const parsed = JSON.parse(out!);
    expect(parsed.frames.first_frame.generationMode).toBe('edit_previous_shot');
    expect(parsed.frames.last_frame).toBeUndefined();
  });
});
