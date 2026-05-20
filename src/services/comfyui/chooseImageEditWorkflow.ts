/**
 * Pick the workflow for image_editing.
 *
 * Default: the built-in FLUX 2 Klein edit workflow shipped with
 * dhee-core. Selection is mode-aware — `flux2_klein_edit_local`
 * when running against a local ComfyUI, `flux2_klein_edit_cloud`
 * when targeting ComfyUI Cloud.
 *
 * If the user pins a different workflow via the WorkflowModeRegistry,
 * the override wins.
 *
 * `totalImages` is left in the signature for future heuristics, but
 * is currently unused — kept so callers don't have to refactor when
 * the policy changes back to count-based routing.
 */
export function chooseImageEditWorkflow(input: {
  totalImages: number;
  modeOverride?: string | null;
}): string {
  if (input.modeOverride) return input.modeOverride;
  const isCloud = process.env['COMFY_MODE'] === 'cloud';
  return isCloud ? 'flux2_klein_edit_cloud' : 'flux2_klein_edit_local';
}
