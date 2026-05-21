/**
 * Compute per-shot first-frame visual-continuity anchors.
 *
 * Goal: every shot in a scene should visually flow from the prior shot,
 * not jump-cut. The shot_image generator's `edit_previous_shot` mode
 * exists for this, but until now whether to use it was decided by the
 * LLM. This module makes the decision DETERMINISTICALLY from the
 * shot_breakdown metadata, so the image-edit pipeline can be wired
 * correctly without hoping the model spotted the continuity itself.
 *
 * Decision rules (in order):
 *
 *   1. Shot 1 of the scene → `fresh`. No prior frame to anchor on.
 *
 *   2. Hard-cut transition (`fade`, `dip_to_black`, `flash_to_white`,
 *      `circle_close`, `circle_open`, `wipe_left`, `wipe_right`) →
 *      `fresh`. The writer asked for an explicit visual reset.
 *
 *   3. View-reuse: walk shots 1..N-2 in reverse. If any has the same
 *      "view signature" as shot N (setting, perspective, framing class,
 *      focus.primary, characters in frame), anchor on that shot's last
 *      frame. Returns the latest matching shot — visually closest in
 *      time. This is the user's "if a new shot needs the same view as
 *      an already-generated one, use the already-generated shot" rule.
 *
 *   4. Default → `continuity`: anchor on the immediate prior shot's
 *      last frame. Smooth flow even when the view changes a bit.
 *
 * Pure: array of shots in, array of `firstFrameAnchor` decisions out.
 * No I/O, no executor coupling, no LLM.
 */

import type { z } from 'zod';
import type { firstFrameAnchorSchema } from './schemas.js';

// We only need a narrow slice of the shot shape — keep this loose so
// either Stage A's plan entry or Stage B's full breakdown can feed in.
interface ShotForAnchor {
  shotNumber: number;
  transition?: string;
  perspective?: string;
  cameraWork?: string;
  setting?: string | null;
  focus?: {
    primary?: string;
    background?: string[];
    lurking?: string | null;
  };
}

export type FirstFrameAnchor = z.infer<typeof firstFrameAnchorSchema>;

/**
 * Transitions that imply a visual reset — first frame should be fresh,
 * not chained on the previous shot.
 *
 * `cut` is intentionally NOT here. A `cut` is a hard CAMERA cut but
 * the visual context (setting, who's in frame, lighting) is meant to
 * continue. The image-edit chain is the right behavior for `cut` —
 * it produces a different angle of the same world.
 *
 * `crossfade` also stays out: it's a soft transition that explicitly
 * blends frames, so chaining is exactly right.
 */
const HARD_CUT_TRANSITIONS = new Set<string>([
  'fade',
  'dip_to_black',
  'flash_to_white',
  'circle_close',
  'circle_open',
  'wipe_left',
  'wipe_right',
]);

/** Group `cameraWork` prose into framing buckets. Two shots can have
 *  identical settings/characters but a different framing — and they're
 *  visually different views (close-up of face vs wide shot of same
 *  person are not the same view). */
export function framingClass(cameraWork: string | undefined | null): string {
  if (!cameraWork) return 'unknown';
  const cw = cameraWork.toLowerCase();
  // Check most-specific first — "extreme close-up" must beat "close-up".
  if (/extreme[^a-z]{0,3}close[^a-z]{0,3}up|extreme[^a-z]{0,3}close|macro/.test(cw)) return 'extreme_close';
  if (/extreme[^a-z]{0,3}wide|birds[^a-z]{0,3}eye/.test(cw)) return 'extreme_wide';
  if (/medium[^a-z]{0,3}close/.test(cw)) return 'medium_close';
  if (/medium[^a-z]{0,3}wide/.test(cw)) return 'medium_wide';
  if (/close[^a-z]{0,3}up|close[^a-z]{0,3}on|close shot/.test(cw)) return 'close';
  if (/wide[^a-z]{0,3}shot|wide establishing|establishing|wide angle/.test(cw)) return 'wide';
  if (/medium/.test(cw)) return 'medium';
  if (/insert|cutaway/.test(cw)) return 'insert';
  return 'unknown';
}

/** Best-effort set of characters that should appear in the shot,
 *  derived from breakdown metadata alone (no LLM, no shot state).
 *  Used as a stable input to the view signature — two shots with the
 *  same character set are MORE likely to be the same view. */
function inFrameCharacters(
  shot: ShotForAnchor,
  sceneMainSubject: string | null | undefined,
  sceneSecondarySubject: string | null | undefined,
): string[] {
  const chars = new Set<string>();
  const focus = shot.focus ?? {};

  // god / overhead perspectives don't auto-include scene subjects —
  // mirrors the atmosphere-shot guard in buildShotAwareReferences.
  const perspective = shot.perspective ?? '';
  const nonCharacterPov = perspective === 'god' || perspective === 'overhead';
  if (!nonCharacterPov) {
    if (perspective === 'main_subject' && sceneMainSubject) chars.add(sceneMainSubject);
    if (perspective === 'secondary_subject' && sceneSecondarySubject) chars.add(sceneSecondarySubject);
    if (perspective === 'observer') {
      if (sceneMainSubject) chars.add(sceneMainSubject);
      if (sceneSecondarySubject) chars.add(sceneSecondarySubject);
    }
  }

  // Focus refs are always in frame (they're the focal subject by definition).
  if (focus.primary) chars.add(focus.primary);
  for (const bg of focus.background ?? []) chars.add(bg);
  if (focus.lurking) chars.add(focus.lurking);

  return [...chars].sort();
}

/**
 * Compose a deterministic "view signature" string for a shot. Two shots
 * with identical signatures are visually the same view — same setting,
 * same camera angle, same framing, same characters. Exposed for tests.
 */
export function viewSignature(
  shot: ShotForAnchor,
  sceneMainSubject: string | null | undefined,
  sceneSecondarySubject: string | null | undefined,
): string {
  return [
    `setting=${shot.setting ?? ''}`,
    `persp=${shot.perspective ?? ''}`,
    `framing=${framingClass(shot.cameraWork)}`,
    `focus=${shot.focus?.primary ?? ''}`,
    `chars=${inFrameCharacters(shot, sceneMainSubject, sceneSecondarySubject).join(',')}`,
  ].join('|');
}

/**
 * The "where does scene N pick up from scene N-1" hint, used when
 * computing anchors for the FIRST shot of a non-first scene. When the
 * assembler can identify the prior scene's final shot, it passes it
 * here so shot 1 anchors on that frame (`{ reason: 'continuity',
 * sourceSceneId, sourceShotNumber }`) instead of restarting fresh —
 * which is what implements the "exits door A in scene N → enters door
 * B in scene N+1" continuity rule for the first-frame generator.
 *
 * Pass null when there is no prior scene (scene 1) or when the prior
 * scene has no completed shots yet.
 */
export interface PriorSceneLastShot {
  sceneId: string;
  shotNumber: number;
}

/**
 * Compute anchors for an entire scene's shot list. Walks shots in
 * order; for each shot, picks the appropriate first-frame source by
 * the rules at the top of this file.
 *
 * Returns the input array shape — caller assigns the anchor to each
 * shot's `firstFrameAnchor` field before persisting the assembled
 * scene_video_prompt.
 */
export function computeAnchorsForScene<T extends ShotForAnchor>(
  shots: T[],
  sceneMainSubject: string | null | undefined,
  sceneSecondarySubject: string | null | undefined,
  priorSceneLastShot: PriorSceneLastShot | null = null,
): Array<{ shotNumber: number; anchor: FirstFrameAnchor }> {
  const out: Array<{ shotNumber: number; anchor: FirstFrameAnchor }> = [];
  // Sort defensively so out-of-order shot inputs still produce a
  // sensible chain.
  const ordered = [...shots].sort((a, b) => a.shotNumber - b.shotNumber);

  for (let i = 0; i < ordered.length; i++) {
    const shot = ordered[i]!;
    const anchor = computeAnchorForShot(
      shot,
      ordered.slice(0, i),
      sceneMainSubject,
      sceneSecondarySubject,
      // Only relevant for the first shot of the scene — the second
      // and beyond have within-scene predecessors and use those.
      i === 0 ? priorSceneLastShot : null,
    );
    out.push({ shotNumber: shot.shotNumber, anchor });
  }
  return out;
}

/**
 * Compute the anchor for ONE shot given the prior shots in the same
 * scene. Exposed for tests + reuse from the assembler.
 */
export function computeAnchorForShot(
  shot: ShotForAnchor,
  priorShots: ShotForAnchor[],
  sceneMainSubject: string | null | undefined,
  sceneSecondarySubject: string | null | undefined,
  priorSceneLastShot: PriorSceneLastShot | null = null,
): FirstFrameAnchor {
  // Rule 1: first shot of the scene.
  if (priorShots.length === 0) {
    // Rule 1a: cross-scene chain. If the assembler told us where the
    // prior scene ended, anchor on that frame so the new scene picks
    // up visually from where the previous one left off — UNLESS the
    // writer asked for a hard-cut transition into this shot, in which
    // case the scene boundary IS the reset and we go fresh.
    if (
      priorSceneLastShot &&
      !(shot.transition && HARD_CUT_TRANSITIONS.has(shot.transition))
    ) {
      return {
        reason: 'continuity',
        sourceShotNumber: priorSceneLastShot.shotNumber,
        sourceSceneId: priorSceneLastShot.sceneId,
      };
    }
    return { reason: 'fresh' };
  }

  // Rule 2: hard-cut transition resets the chain.
  if (shot.transition && HARD_CUT_TRANSITIONS.has(shot.transition)) {
    return { reason: 'fresh' };
  }

  // Rule 3 & 4: view comparison.
  //
  // First check the IMMEDIATE prior shot. If its view signature
  // matches the current shot's, this shot is just the camera HOLDING
  // — same composition, different beat. Reuse the prior last frame
  // verbatim as this shot's first frame (no edit, no new image).
  //
  // If the immediate prior is a DIFFERENT view, look further back for
  // a same-view ancestor (the "shot 5 returns to shot 2's setup"
  // case). Picks the most recent earlier match to minimise drift over
  // the intervening shots — also emitted as `reuse_prior` because by
  // definition the view matches.
  //
  // Otherwise (different view from immediate prior, no earlier match)
  // fall through to `continuity` — chain on immediate prior but EDIT
  // into a new image because the camera angle actually changed.
  const thisSig = viewSignature(shot, sceneMainSubject, sceneSecondarySubject);
  const immediatePrior = priorShots[priorShots.length - 1]!;
  const immediatePriorSig = viewSignature(immediatePrior, sceneMainSubject, sceneSecondarySubject);

  if (thisSig === immediatePriorSig) {
    return { reason: 'reuse_prior', sourceShotNumber: immediatePrior.shotNumber };
  }

  for (let j = priorShots.length - 2; j >= 0; j--) {
    const candidate = priorShots[j]!;
    if (viewSignature(candidate, sceneMainSubject, sceneSecondarySubject) === thisSig) {
      return { reason: 'reuse_prior', sourceShotNumber: candidate.shotNumber };
    }
  }

  // Default — chain on the immediate previous shot's last frame, but
  // produce a new image via edit (different view).
  return { reason: 'continuity', sourceShotNumber: immediatePrior.shotNumber };
}
