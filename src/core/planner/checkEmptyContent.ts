/**
 * Empty-content guard for LLM output.
 *
 * Why this exists: 2026-05-19 Soft Seinen incident. The LLM returned
 * an empty string for `shot_motion_directive:scene_2_shot_2`. The
 * executor wrote 0 bytes to disk (`contentResolver.writeOutput` does
 * no content validation), marked the node `status=completed`, and the
 * downstream `shot_video` step read the empty file, fell through the
 * JSON-parse catch with `motionPrompt = ''`, and LTX-V generated a
 * 5-second video with NO motion direction. The UI's preview pane
 * then showed "MOTION DIRECTIVE: (no prompt recorded)" alongside an
 * already-generated video — silently shipping a broken shot.
 *
 * The JSON-validation gate in ExecutorAgent only covers structured
 * node types (scene_shot_plan, shot_breakdown, scene_video_prompt,
 * shot_image_prompt, character_image, setting_image). Plain-text node
 * outputs (shot_motion_directive, world_style, story, scene narrative,
 * etc.) had NO post-LLM guard at all — an empty response went straight
 * to disk.
 *
 * This module is the missing universal guard. Called at the LLM →
 * writeOutput boundary in `ExecutorAgent.persistGeneratedContent`.
 *
 * Pure — no I/O, no executor coupling. Fully unit-testable.
 */

export interface EmptyContentResult {
  /** True when the LLM returned only whitespace (or literally nothing). */
  isEmpty: boolean;
  /** Length of `content.trim()`. Surfaced for log messages and tests. */
  trimmedLength: number;
  /** Original content's length BEFORE trim — distinguishes "nothing
   *  at all" (0) from "whitespace soup" (>0). */
  rawLength: number;
}

/**
 * Test whether LLM output is substantive. Whitespace-only counts as
 * empty because no downstream consumer can do anything useful with
 * leading newlines or tabs alone.
 */
export function checkEmptyContent(content: string): EmptyContentResult {
  const rawLength = content.length;
  const trimmed = content.trim();
  return {
    isEmpty: trimmed.length === 0,
    trimmedLength: trimmed.length,
    rawLength,
  };
}

/**
 * Build a uniform failure message for the executor to attach when
 * `markFailed` fires. Keeps the wire-up site tidy and the message
 * format consistent across node types — easier to grep in
 * `executor.log` and easier for downstream tooling (the Redo menu,
 * the failure-handler supervisor task) to pattern-match.
 */
export function buildEmptyContentFailureReason(
  nodeId: string,
  result: EmptyContentResult,
): string {
  if (result.rawLength === 0) {
    return (
      `LLM returned an empty response (0 chars) for ${nodeId}. ` +
      `Not writing the file — invalidate this node and re-run to retry.`
    );
  }
  return (
    `LLM returned only whitespace (${result.rawLength} chars raw, ` +
    `${result.trimmedLength} after trim) for ${nodeId}. ` +
    `Not writing the file — invalidate this node and re-run to retry.`
  );
}
