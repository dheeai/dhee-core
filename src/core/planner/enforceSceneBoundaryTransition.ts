/**
 * Post-LLM enforcement of scene-boundary transitions on shot_breakdown.
 *
 * The 2026-05-19 Soft Seinen bug: scene 2 shot 1 was marked
 * `continuityRole: "entry"` (the LLM correctly identified it as a
 * scene-entry shot, anchored on scene 1's last frame for continuity),
 * but its `transition` field was `cut`. Two downstream effects:
 *
 *   1. The video reads as a flat TV-style hard cut where a cinematic
 *      scene-change transition was expected (the guide says
 *      "Last shot's transition to the next scene: `dip_to_black` or
 *      `fade`", but the wording is ambiguous about which shot
 *      carries the field).
 *
 *   2. `shotAnchorComputer.ts:65-73` treats `cut` as a SOFT transition
 *      and asks Flux Klein to chain the new shot's first frame from
 *      the previous shot's last frame. When the setting changes hard
 *      (family living room → ruined Tokyo), this produces a confused
 *      composite image.
 *
 * The rule, applied per-scene in `normalizeSceneVideoPrompt`:
 *
 *   IF shot.continuityRole === 'entry' AND shot.transition === 'cut'
 *   → force shot.transition = 'fade'
 *
 * Why `fade` (not `dip_to_black`): both are valid scene-boundary
 * transitions. `fade` is softer / more universal; `dip_to_black` is a
 * dramatic-beat punctuation the LLM should pick deliberately. As a
 * conservative deterministic default, `fade` is the right choice.
 *
 * Why ONLY `cut` is overridden (not e.g. `crossfade`): the LLM
 * choosing crossfade for an entry is a legitimate soft transition;
 * only `cut` is the path-of-least-resistance default we're correcting.
 *
 * Pure — no I/O. Mutates in place AND returns a change log for the
 * caller to surface in executor.log.
 */

export interface BoundaryShotForNormalization {
  shotNumber: number;
  /** 'none' | 'entry' | 'exit' | 'bridge' — see schemas.continuityRoleValues. */
  continuityRole?: string | null;
  /** 'cut' | 'fade' | 'dip_to_black' | 'crossfade' | etc. */
  transition?: string | null;
}

export interface SceneBoundaryChange {
  shotNumber: number;
  from: string;
  to: string;
}

/**
 * The default soft transition for an `entry`-role shot when the LLM
 * picked `cut`. See module header for rationale.
 */
export const DEFAULT_ENTRY_TRANSITION = 'fade' as const;

/**
 * Mutates `shots` in place. Returns a list of changes for the caller
 * to log; if nothing changed, the list is empty.
 */
export function enforceSceneBoundaryTransition(
  shots: BoundaryShotForNormalization[],
): SceneBoundaryChange[] {
  const changes: SceneBoundaryChange[] = [];
  for (const shot of shots) {
    if (shot.continuityRole !== 'entry') continue;
    if (shot.transition !== 'cut') continue;
    const from = shot.transition;
    shot.transition = DEFAULT_ENTRY_TRANSITION;
    changes.push({ shotNumber: shot.shotNumber, from, to: DEFAULT_ENTRY_TRANSITION });
  }
  return changes;
}
