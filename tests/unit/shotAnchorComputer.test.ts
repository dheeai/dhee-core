/**
 * GIVEN a scene's shot list (post-Stage-B breakdown)
 * WHEN computeAnchorsForScene runs
 * THEN each shot gets a firstFrameAnchor matching the visual-continuity
 *      rules:
 *        - Shot 1 → fresh
 *        - Hard-cut transition → fresh
 *        - View matches the source (immediate prior OR earlier shot) → reuse_prior
 *        - Otherwise → continuity (chain on prior shot's last frame
 *          via an edit, producing a new image)
 */
import { describe, it, expect } from 'vitest';
import {
  computeAnchorForShot,
  computeAnchorsForScene,
  framingClass,
  viewSignature,
} from '../../src/core/planner/shotAnchorComputer.js';

describe('framingClass', () => {
  it('classifies extreme close-ups and macro shots', () => {
    expect(framingClass('extreme close-up')).toBe('extreme_close');
    expect(framingClass('macro, static, shallow DOF')).toBe('extreme_close');
    expect(framingClass('extreme close up on bell')).toBe('extreme_close');
  });

  it('classifies extreme wides and birds-eye', () => {
    expect(framingClass('extreme wide, static')).toBe('extreme_wide');
    expect(framingClass("birds-eye view from above")).toBe('extreme_wide');
  });

  it('classifies medium-close and medium-wide', () => {
    expect(framingClass('medium close-up on face')).toBe('medium_close');
    expect(framingClass('medium-wide, tracking right')).toBe('medium_wide');
  });

  it('classifies close, wide, medium, insert', () => {
    expect(framingClass('close-up, slight low angle')).toBe('close');
    expect(framingClass('wide shot, dolly in')).toBe('wide');
    expect(framingClass('medium shot, side angle')).toBe('medium');
    expect(framingClass('insert: hand reaching for bell')).toBe('insert');
  });

  it('falls back to "unknown" for unmatched prose', () => {
    expect(framingClass('drone aerial pull-back')).toBe('unknown');
    expect(framingClass('')).toBe('unknown');
    expect(framingClass(undefined)).toBe('unknown');
  });
});

describe('viewSignature', () => {
  it('two shots with identical setting/perspective/framing/focus + chars are the same view', () => {
    const a = {
      shotNumber: 2,
      setting: 'singh_bungalow',
      perspective: 'main_subject',
      cameraWork: 'medium shot, side angle',
      focus: { primary: 'parvati_face', background: ['kitchen_stove'] },
    };
    const b = {
      shotNumber: 5,
      setting: 'singh_bungalow',
      perspective: 'main_subject',
      cameraWork: 'medium, side angle, slight push-in',
      focus: { primary: 'parvati_face', background: ['kitchen_stove'] },
    };
    expect(viewSignature(a, 'parvati', null)).toBe(viewSignature(b, 'parvati', null));
  });

  it('different framing class → different view (close-up vs wide)', () => {
    const closeUp = {
      shotNumber: 1,
      setting: 'arena',
      perspective: 'main_subject',
      cameraWork: 'close-up on face',
      focus: { primary: 'protagonist' },
    };
    const wide = {
      shotNumber: 2,
      setting: 'arena',
      perspective: 'main_subject',
      cameraWork: 'wide establishing shot',
      focus: { primary: 'protagonist' },
    };
    expect(viewSignature(closeUp, 'protagonist', null))
      .not.toBe(viewSignature(wide, 'protagonist', null));
  });

  it('different setting → different view', () => {
    const a = { shotNumber: 1, setting: 'kitchen', perspective: 'main_subject', cameraWork: 'medium', focus: { primary: 'parvati' } };
    const b = { shotNumber: 2, setting: 'bedroom', perspective: 'main_subject', cameraWork: 'medium', focus: { primary: 'parvati' } };
    expect(viewSignature(a, 'parvati', null)).not.toBe(viewSignature(b, 'parvati', null));
  });

  it('god/overhead perspective does NOT auto-include scene subjects in the signature', () => {
    // Mirrors the atmosphere-shot guard: a god shot of "blue seam"
    // has no characters, even if the scene has a mainSubject.
    const shot = {
      shotNumber: 3,
      setting: 'chamber',
      perspective: 'god',
      cameraWork: 'extreme close-up, macro on seam',
      focus: { primary: 'blue_phosphorescent_seam' },
    };
    const sig = viewSignature(shot, 'protagonist', null);
    expect(sig).not.toContain('protagonist');
  });
});

describe('computeAnchorForShot', () => {
  const noShots: never[] = [];
  const main = 'parvati';

  it('shot 1 of a scene → fresh', () => {
    const shot = {
      shotNumber: 1, setting: 'bungalow', perspective: 'main_subject',
      cameraWork: 'medium', focus: { primary: 'parvati' }, transition: 'fade',
    };
    expect(computeAnchorForShot(shot, noShots, main, null)).toEqual({ reason: 'fresh' });
  });

  it('hard-cut transition (fade) → fresh, even when prior shots exist', () => {
    const priors = [{ shotNumber: 1, setting: 'kitchen', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'parvati' } }];
    const shot = {
      shotNumber: 2, setting: 'kitchen', perspective: 'main_subject',
      cameraWork: 'medium', focus: { primary: 'parvati' }, transition: 'fade',
    };
    expect(computeAnchorForShot(shot, priors, main, null)).toEqual({ reason: 'fresh' });
  });

  it('hard-cut transition: dip_to_black, flash_to_white, circle_close, wipe_left all reset', () => {
    const priors = [{ shotNumber: 1, setting: 'a', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'x' } }];
    for (const t of ['dip_to_black', 'flash_to_white', 'circle_close', 'circle_open', 'wipe_left', 'wipe_right']) {
      const shot = {
        shotNumber: 2, setting: 'a', perspective: 'main_subject',
        cameraWork: 'wide', focus: { primary: 'x' }, transition: t,
      };
      expect(computeAnchorForShot(shot, priors, main, null).reason).toBe('fresh');
    }
  });

  it('soft `cut` transition does NOT reset — defaults to continuity', () => {
    const priors = [{ shotNumber: 1, setting: 'kitchen', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'parvati' } }];
    const shot = {
      shotNumber: 2, setting: 'kitchen', perspective: 'main_subject',
      cameraWork: 'close-up', focus: { primary: 'parvati_face' }, transition: 'cut',
    };
    expect(computeAnchorForShot(shot, priors, main, null)).toEqual({
      reason: 'continuity', sourceShotNumber: 1,
    });
  });

  it('crossfade transition also does NOT reset — visual blend, not a reset', () => {
    const priors = [{ shotNumber: 1, setting: 'kitchen', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'parvati' } }];
    const shot = {
      shotNumber: 2, setting: 'kitchen', perspective: 'main_subject',
      cameraWork: 'medium', focus: { primary: 'parvati' }, transition: 'crossfade',
    };
    expect(computeAnchorForShot(shot, priors, main, null).reason).toBe('continuity');
  });

  it('default (no special transition, prior exists) → continuity on prior shot number', () => {
    const priors = [
      { shotNumber: 1, setting: 'a', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'parvati' } },
      { shotNumber: 2, setting: 'a', perspective: 'main_subject', cameraWork: 'close-up', focus: { primary: 'parvati_face' } },
    ];
    const shot = {
      shotNumber: 3, setting: 'a', perspective: 'main_subject',
      cameraWork: 'medium', focus: { primary: 'parvati' }, transition: 'cut',
    };
    expect(computeAnchorForShot(shot, priors, main, null)).toEqual({
      reason: 'continuity', sourceShotNumber: 2,
    });
  });

  it('same view as a non-immediate prior → reuse_prior on that earlier shot (was: view_reuse)', () => {
    // Scene flow: wide → medium-protag → close-protag → wide-observer
    // → back to medium-protag. Shot 5's view matches shot 2's, but
    // shot 4 in between is a different view. Anchor on shot 2 and
    // emit `reuse_prior` — the source's last frame IS this shot's
    // first frame.
    const priors = [
      { shotNumber: 1, setting: 'arena', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'protagonist' } },
      { shotNumber: 2, setting: 'arena', perspective: 'main_subject', cameraWork: 'medium', focus: { primary: 'protagonist' } }, // distinctive view
      { shotNumber: 3, setting: 'arena', perspective: 'main_subject', cameraWork: 'close-up', focus: { primary: 'protagonist_face' } },
      { shotNumber: 4, setting: 'arena', perspective: 'observer', cameraWork: 'wide establishing', focus: { primary: 'arena' } },
    ];
    const shot5 = {
      shotNumber: 5, setting: 'arena', perspective: 'main_subject',
      cameraWork: 'medium', focus: { primary: 'protagonist' }, transition: 'cut',
    };
    expect(computeAnchorForShot(shot5, priors, 'protagonist', null)).toEqual({
      reason: 'reuse_prior', sourceShotNumber: 2,
    });
  });

  it('reuse_prior picks the MOST RECENT matching prior when multiple shots share the view', () => {
    const priors = [
      { shotNumber: 1, setting: 'a', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'x' } },
      { shotNumber: 2, setting: 'a', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'x' } }, // matches
      { shotNumber: 3, setting: 'a', perspective: 'main_subject', cameraWork: 'close-up', focus: { primary: 'y' } },
      { shotNumber: 4, setting: 'a', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'x' } }, // also matches — more recent
      { shotNumber: 5, setting: 'b', perspective: 'observer', cameraWork: 'medium', focus: { primary: 'z' } },
    ];
    const shot6 = {
      shotNumber: 6, setting: 'a', perspective: 'main_subject',
      cameraWork: 'wide', focus: { primary: 'x' }, transition: 'cut',
    };
    expect(computeAnchorForShot(shot6, priors, 'x', null)).toEqual({
      reason: 'reuse_prior', sourceShotNumber: 4,
    });
  });

  it('immediate prior shot match → reuse_prior (NOT continuity — same view means reuse the file)', () => {
    // The user-stated rule: when the next shot's view matches the
    // prior shot, reuse the prior last_frame verbatim instead of
    // generating a new (slightly different) first_frame. The
    // executor short-circuits ComfyUI for these.
    const priors = [
      { shotNumber: 1, setting: 'a', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'x' } },
      { shotNumber: 2, setting: 'a', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'x' } },
    ];
    const shot3 = {
      shotNumber: 3, setting: 'a', perspective: 'main_subject',
      cameraWork: 'wide', focus: { primary: 'x' }, transition: 'cut',
    };
    expect(computeAnchorForShot(shot3, priors, 'x', null)).toEqual({
      reason: 'reuse_prior', sourceShotNumber: 2,
    });
  });
});

describe('computeAnchorsForScene', () => {
  it('walks a scene and returns one anchor per shot', () => {
    const shots = [
      { shotNumber: 1, setting: 'arena', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'protagonist' }, transition: 'fade' },
      { shotNumber: 2, setting: 'arena', perspective: 'main_subject', cameraWork: 'medium', focus: { primary: 'protagonist' }, transition: 'cut' },
      { shotNumber: 3, setting: 'arena', perspective: 'main_subject', cameraWork: 'close-up', focus: { primary: 'protagonist_face' }, transition: 'cut' },
      { shotNumber: 4, setting: 'arena', perspective: 'main_subject', cameraWork: 'medium', focus: { primary: 'protagonist' }, transition: 'cut' }, // back to shot 2's view
      { shotNumber: 5, setting: 'arena', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'protagonist' }, transition: 'dip_to_black' }, // explicit reset
    ];
    const anchors = computeAnchorsForScene(shots, 'protagonist', null);
    expect(anchors).toEqual([
      { shotNumber: 1, anchor: { reason: 'fresh' } },
      { shotNumber: 2, anchor: { reason: 'continuity', sourceShotNumber: 1 } },
      { shotNumber: 3, anchor: { reason: 'continuity', sourceShotNumber: 2 } },
      // Same view as shot 2 (medium/protagonist) — emit reuse_prior so
      // the executor copies shot 2's last_frame as shot 4's first_frame.
      { shotNumber: 4, anchor: { reason: 'reuse_prior', sourceShotNumber: 2 } },
      { shotNumber: 5, anchor: { reason: 'fresh' } }, // dip_to_black resets
    ]);
  });

  it('handles out-of-order input by sorting first', () => {
    const shots = [
      { shotNumber: 3, setting: 'a', perspective: 'main_subject', cameraWork: 'close-up', focus: { primary: 'x' }, transition: 'cut' },
      { shotNumber: 1, setting: 'a', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'x' }, transition: 'fade' },
      { shotNumber: 2, setting: 'a', perspective: 'main_subject', cameraWork: 'medium', focus: { primary: 'x' }, transition: 'cut' },
    ];
    const anchors = computeAnchorsForScene(shots, 'x', null);
    expect(anchors.map(a => a.shotNumber)).toEqual([1, 2, 3]);
    expect(anchors[0]!.anchor).toEqual({ reason: 'fresh' });
    expect(anchors[1]!.anchor).toEqual({ reason: 'continuity', sourceShotNumber: 1 });
    expect(anchors[2]!.anchor).toEqual({ reason: 'continuity', sourceShotNumber: 2 });
  });

  // ── Cross-scene chaining ────────────────────────────────────────────
  // When the assembler hands us a `priorSceneLastShot`, the FIRST shot
  // of the scene must anchor on that frame instead of starting fresh.
  // This is what implements the "exits door A in scene N → enters door
  // B in scene N+1" continuity rule end-to-end.

  it('shot 1 of scene N>1 anchors on the prior scene\'s last shot when one is supplied', () => {
    const shots = [
      { shotNumber: 1, setting: 'forest', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'protagonist' }, transition: 'cut' },
      { shotNumber: 2, setting: 'forest', perspective: 'main_subject', cameraWork: 'medium', focus: { primary: 'protagonist' }, transition: 'cut' },
    ];
    const anchors = computeAnchorsForScene(shots, 'protagonist', null, {
      sceneId: 'scene_1',
      shotNumber: 8,
    });
    expect(anchors[0]!.anchor).toEqual({
      reason: 'continuity',
      sourceShotNumber: 8,
      sourceSceneId: 'scene_1',
    });
    // Shot 2 is unaffected — still within-scene continuity from shot 1.
    expect(anchors[1]!.anchor).toEqual({
      reason: 'continuity',
      sourceShotNumber: 1,
    });
  });

  it('shot 1 with a hard-cut entry transition still resets to fresh even when a prior scene exists', () => {
    // The writer's hard-cut transition IS the deliberate scene-boundary
    // reset; cross-scene anchoring must defer to it.
    const shots = [
      { shotNumber: 1, setting: 'dream', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'protagonist' }, transition: 'dip_to_black' },
    ];
    const anchors = computeAnchorsForScene(shots, 'protagonist', null, {
      sceneId: 'scene_1',
      shotNumber: 8,
    });
    expect(anchors[0]!.anchor).toEqual({ reason: 'fresh' });
  });

  it('no priorSceneLastShot (scene 1 OR prior scene not yet planned) → first shot is fresh, as before', () => {
    const shots = [
      { shotNumber: 1, setting: 'a', perspective: 'main_subject', cameraWork: 'wide', focus: { primary: 'x' }, transition: 'cut' },
    ];
    const anchors = computeAnchorsForScene(shots, 'x', null, null);
    expect(anchors[0]!.anchor).toEqual({ reason: 'fresh' });
  });
});
