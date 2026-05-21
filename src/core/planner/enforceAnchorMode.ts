/**
 * Force `frames.first_frame.generationMode` on a shot_image_prompt
 * output to match the deterministic anchor decision made at scene_video_
 * prompt assembly time.
 *
 * Without this enforcement, the LLM picks generationMode itself:
 *
 *   image_text_to_image — composite from character/setting refs
 *   text_to_image       — pure text-to-image, no refs
 *   edit_previous_shot  — chain on prior shot's last frame
 *
 * The LLM often picks `image_text_to_image` even when a chain mode is
 * more appropriate (or vice-versa). Since the anchor was already
 * decided deterministically by the assembler (see shotAnchorComputer),
 * we ENFORCE the matching generationMode here:
 *
 *   anchor.reason === 'fresh'        →  image_text_to_image
 *                                       (or text_to_image when there
 *                                        are no character/setting
 *                                        refs — atmosphere shots).
 *   anchor.reason === 'continuity'   →  edit_previous_shot
 *   anchor.reason === 'reuse_prior'  →  reuse_prior_frame
 *                                       (executor short-circuits and
 *                                        copies the source's last_frame
 *                                        file directly — no LLM, no
 *                                        ComfyUI call. See
 *                                        executeShotImage for the
 *                                        runtime handler.)
 *   anchor.reason === 'view_reuse'   →  reuse_prior_frame
 *                                       (legacy alias for reuse_prior
 *                                        — old projects may still have
 *                                        this anchor on disk.)
 *
 * Note: today's `edit_previous_shot` workflow implicitly takes the
 * "immediate previous shot". For view_reuse (which points at a NOT-
 * immediate prior), the graph dep wiring (see addShotImageNodes) is
 * already correct — the consumer reads the prior frame from the
 * specific source shot's last_frame node. As long as ComfyUI's
 * generationMode handler routes the input image from the dep graph
 * (not by re-computing "previous shot"), this is sound.
 *
 * Pure — mutates the supplied parsed object, returns a record of
 * what changed for logging.
 */

import type { FirstFrameAnchor } from './shotAnchorComputer.js';

interface FrameLike {
  imagePrompt?: string;
  generationMode?: string;
  references?: Array<{ refId?: string }> | unknown;
}

interface ShotImagePromptShape {
  frames?: Record<string, FrameLike>;
  // (single-frame shape doesn't have a first_frame; we just no-op
  // when frames is missing.)
}

export interface EnforceAnchorModeResult {
  /** True if generationMode was actually changed. */
  changed: boolean;
  /** Mode before enforcement (for logging). null when first_frame
   *  wasn't present at all. */
  previousMode: string | null;
  /** Mode after enforcement (for logging). Same as previousMode when
   *  changed=false. */
  enforcedMode: string | null;
}

/**
 * Pick the right generationMode for first_frame given the anchor and
 * whether the frame currently has any references.
 */
function modeForAnchor(
  anchor: FirstFrameAnchor,
  hasReferences: boolean,
): string {
  if (anchor.reason === 'fresh') {
    // Fresh first frames usually composite from character/setting
    // images. When the shot has no refs at all (atmosphere shot with
    // no character_image or setting_image to attach), drop to pure
    // text_to_image — image_text_to_image with empty refs is a
    // workflow no-op that wastes a step.
    return hasReferences ? 'image_text_to_image' : 'text_to_image';
  }
  if (anchor.reason === 'reuse_prior' || anchor.reason === 'view_reuse') {
    // Same view as the source — REUSE the source's last_frame file
    // verbatim. No image generation. executeShotImage short-circuits
    // on this mode and copies the file from the source's last_frame
    // node instead of invoking ComfyUI. Saves an edit pass per
    // matching shot and produces byte-identical cut points.
    return 'reuse_prior_frame';
  }
  // continuity (different view from the source) → edit prior frame.
  return 'edit_previous_shot';
}

/**
 * Apply the anchor's required generationMode to the parsed shot_image_
 * prompt output. No-op when the parsed object doesn't carry the
 * expected `frames.first_frame` shape (e.g. legacy single-frame
 * outputs).
 */
export function enforceAnchorMode(
  parsed: ShotImagePromptShape | unknown,
  anchor: FirstFrameAnchor | null | undefined,
): EnforceAnchorModeResult {
  if (!anchor) return { changed: false, previousMode: null, enforcedMode: null };
  if (!parsed || typeof parsed !== 'object') {
    return { changed: false, previousMode: null, enforcedMode: null };
  }
  const root = parsed as ShotImagePromptShape;
  const firstFrame = root.frames?.['first_frame'];
  if (!firstFrame || typeof firstFrame !== 'object') {
    return { changed: false, previousMode: null, enforcedMode: null };
  }

  const refs = Array.isArray(firstFrame.references) ? firstFrame.references : [];
  const hasReferences = refs.length > 0;
  const target = modeForAnchor(anchor, hasReferences);
  const previousMode = typeof firstFrame.generationMode === 'string'
    ? firstFrame.generationMode
    : null;

  if (previousMode === target) {
    return { changed: false, previousMode, enforcedMode: target };
  }

  firstFrame.generationMode = target;
  return { changed: true, previousMode, enforcedMode: target };
}
