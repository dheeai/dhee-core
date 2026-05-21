/**
 * Camera-transition synthesis for visually-chained shots.
 *
 * When shot N anchors on shot N-1 (continuity), but the two shots
 * sit at different perspectives or framing classes, the unmodified
 * cameraWork prose tends to read like a hard cut even though we WANT
 * a smooth visual flow:
 *
 *   shot 1 cameraWork: "wide establishing, static"
 *   shot 2 cameraWork: "extreme close-up on hands, static"
 *
 * A video that opens with the wide and abruptly jumps to the close-
 * up reads as a cut, not a flow. We can do better with a small
 * deterministic patch to shot 2's cameraWork that introduces a
 * camera move — "slow push-in to extreme close-up on hands" —
 * which the downstream image-edit + video models translate into a
 * smooth movement.
 *
 * This module computes one such patch per shot whose anchor is
 * `continuity` AND whose camera position has shifted vs. the source.
 * `fresh` and `view_reuse` anchors are skipped — `fresh` means a
 * deliberate reset (the writer asked for it), and `view_reuse` cuts
 * back to a familiar setup where the existing cameraWork is meant
 * to land directly.
 *
 * Pure — input shots in, patched copies out. The assembler calls
 * this AFTER computeAnchorsForScene so anchor reasons are available.
 */

import type { FirstFrameAnchor } from './shotAnchorComputer.js';
import { framingClass } from './shotAnchorComputer.js';

interface ShotForSynth {
  shotNumber: number;
  perspective?: string;
  cameraWork?: string;
  firstFrameAnchor?: FirstFrameAnchor | null;
}

export interface CameraTransitionPatch {
  shotNumber: number;
  /** Original cameraWork before patching (for logging / rollback). */
  before: string;
  /** Patched cameraWork. Same shape — still a short prose line. */
  after: string;
  /** Short reason: "perspective_shift" | "framing_shift" |
   *  "perspective_and_framing_shift". For logs. */
  reason: string;
}

/** When the camera position should sweep from one POV to another,
 *  this is the verb we prepend to the existing cameraWork. */
const PERSPECTIVE_TRANSITION_VERBS: Record<string, Record<string, string>> = {
  main_subject: {
    overhead: 'slow tilt up and pull back to ',
    god: 'pull back and rise to ',
    secondary_subject: 'reverse to ',
    observer: 'pull back to a wider neutral angle, ',
  },
  secondary_subject: {
    main_subject: 'reverse to ',
    overhead: 'slow tilt up and pull back to ',
    god: 'pull back and rise to ',
    observer: 'pull back to a wider neutral angle, ',
  },
  observer: {
    main_subject: 'push in to ',
    secondary_subject: 'push in to ',
    overhead: 'rise to ',
    god: 'rise to ',
  },
  overhead: {
    main_subject: 'tilt down and push in to ',
    secondary_subject: 'tilt down and push in to ',
    observer: 'tilt down to ',
    god: 'pull back further to ',
  },
  god: {
    main_subject: 'descend and push in to ',
    secondary_subject: 'descend and push in to ',
    observer: 'descend to ',
    overhead: 'descend to ',
  },
};

/** Framing transitions (within the same perspective). Less dramatic
 *  than perspective changes but still benefit from a camera move
 *  rather than an implied cut. */
const FRAMING_TRANSITION_VERBS: Record<string, Record<string, string>> = {
  wide: {
    medium: 'slow push-in to ',
    medium_close: 'slow push-in to ',
    close: 'slow push-in to ',
    extreme_close: 'rack focus and push-in to ',
  },
  extreme_wide: {
    wide: 'gradual push-in to ',
    medium: 'gradual push-in to ',
    close: 'rapid push-in to ',
  },
  medium: {
    close: 'slight push-in to ',
    extreme_close: 'rack to ',
    wide: 'pull back to ',
  },
  medium_close: {
    close: 'tighten on ',
    extreme_close: 'rack to ',
    wide: 'pull back to ',
    medium: 'pull back to ',
  },
  close: {
    extreme_close: 'rack to ',
    wide: 'pull back to ',
    medium: 'pull back to ',
  },
  extreme_close: {
    close: 'pull back to ',
    medium: 'pull back to ',
    wide: 'pull back to ',
  },
};

function pickPerspectiveTransition(
  prevPersp: string,
  currPersp: string,
): string | null {
  if (!prevPersp || !currPersp || prevPersp === currPersp) return null;
  return PERSPECTIVE_TRANSITION_VERBS[prevPersp]?.[currPersp] ?? null;
}

function pickFramingTransition(
  prevFraming: string,
  currFraming: string,
): string | null {
  if (!prevFraming || !currFraming || prevFraming === currFraming) return null;
  if (prevFraming === 'unknown' || currFraming === 'unknown') return null;
  return FRAMING_TRANSITION_VERBS[prevFraming]?.[currFraming] ?? null;
}

/**
 * Walk a sorted shot list. For each shot whose anchor is
 * `continuity`, compare its perspective + framing class against the
 * source shot's; when either differs and a transition verb is in our
 * table, prepend that verb to the shot's cameraWork.
 *
 * Returns a list of patches (one per actually-modified shot) for
 * logging / inspection. Modifies the supplied shots in place — same
 * mutation pattern the assembler uses for `firstFrameAnchor`.
 */
export function synthesizeCameraTransitions<T extends ShotForSynth>(
  shots: T[],
): CameraTransitionPatch[] {
  const patches: CameraTransitionPatch[] = [];
  const sorted = [...shots].sort((a, b) => a.shotNumber - b.shotNumber);
  const byNumber = new Map(sorted.map(s => [s.shotNumber, s]));

  for (const shot of sorted) {
    const anchor = shot.firstFrameAnchor;
    if (!anchor || anchor.reason !== 'continuity') continue;

    const source = byNumber.get(anchor.sourceShotNumber);
    if (!source) continue;

    const prevPersp = source.perspective ?? '';
    const currPersp = shot.perspective ?? '';
    const prevFraming = framingClass(source.cameraWork);
    const currFraming = framingClass(shot.cameraWork);

    const perspVerb = pickPerspectiveTransition(prevPersp, currPersp);
    const framingVerb = perspVerb ? null : pickFramingTransition(prevFraming, currFraming);
    const verb = perspVerb ?? framingVerb;
    if (!verb) continue;

    const before = shot.cameraWork ?? '';

    // Avoid double-patching: if the existing cameraWork already starts
    // with a recognised transition verb (idempotency check), skip.
    const lower = before.toLowerCase();
    const TRANSITION_HINTS = ['push-in', 'pull back', 'tilt up', 'tilt down', 'rack focus', 'rack to', 'descend', 'rise to', 'reverse to', 'pull back'];
    if (TRANSITION_HINTS.some(h => lower.includes(h))) continue;

    const after = `${verb}${before}`;
    shot.cameraWork = after;

    patches.push({
      shotNumber: shot.shotNumber,
      before,
      after,
      reason: perspVerb
        ? framingVerb
          ? 'perspective_and_framing_shift'
          : 'perspective_shift'
        : 'framing_shift',
    });
  }

  return patches;
}
