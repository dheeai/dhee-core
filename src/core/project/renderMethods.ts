/**
 * Render-method registry. Defines the valid values of
 * `project.json` → `renderMethod` and the user-facing metadata that
 * describes each method (used by the pi-agent skill that lets the
 * user query and switch methods).
 *
 * The render method determines which dispatcher path runs the
 * project end-to-end:
 *   - `shot_by_shot`: runs the existing DependencyGraphExecutor to
 *     completion (LLM stages → Klein image gen → 6 LTX FL2V renders
 *     → ffmpeg assembly with watermark). The original pipeline.
 *   - `prompt_relay`: runs the executor up to `shot_image` (LLM + Klein
 *     first frames only — no last frames), then dispatches to the
 *     DAG bundle `ltx_prompt_relay` for the video stage (LTX Director
 *     workflow renders the whole scene continuously as one or more
 *     chunks, ffmpeg concat + watermark for final).
 *
 * New methods (seedance_relay, wan_relay, mixed_per_shot, …) land
 * here as new enum entries + dispatcher cases. The bundle architecture
 * absorbs them without schema changes.
 *
 * Default for projects missing the field: `shot_by_shot` (preserves
 * legacy behavior for projects created before this field existed).
 */

export type RenderMethod = 'shot_by_shot' | 'prompt_relay';

/** Canonical fallback when `renderMethod` is absent from project.json. */
export const DEFAULT_RENDER_METHOD: RenderMethod = 'shot_by_shot';

export interface RenderMethodInfo {
  id: RenderMethod;
  displayName: string;
  /** One-line description suitable for UI tooltips and agent responses. */
  shortDescription: string;
  /** Longer agent-facing description: when to pick, tradeoffs. */
  longDescription: string;
  /**
   * Hardware requirement hints. Both methods need an LLM endpoint and
   * a Klein-capable Comfy; the relay method also needs a Comfy with
   * the LTX 2.3 Director custom node + matching LoRAs (currently only
   * the user's local box, not cloud).
   */
  requires: {
    /** Always required for any rendering. */
    llmEndpoint: true;
    /** Klein/Z-Image-capable Comfy for first-frame generation. */
    kleinComfy: true;
    /** LTX Director custom node + LoRAs (local-only as of 2026-05-26). */
    ltxDirectorLocal: boolean;
  };
}

export const RENDER_METHODS: Record<RenderMethod, RenderMethodInfo> = {
  shot_by_shot: {
    id: 'shot_by_shot',
    displayName: 'Shot-by-shot (FL2V)',
    shortDescription:
      'Render each shot independently with first + last frame anchors. The original method.',
    longDescription:
      'Generates a first frame and a last frame per shot via Klein, then runs LTX FL2V for each shot independently. The 6+ shot videos are stitched together with FFmpeg into the final cut. Slower per-shot but produces sharper individual frames (1280x720). Best for projects where per-shot iteration matters more than cross-shot motion fidelity. Works on any LTX-capable Comfy (local or cloud).',
    requires: { llmEndpoint: true, kleinComfy: true, ltxDirectorLocal: false },
  },
  prompt_relay: {
    id: 'prompt_relay',
    displayName: 'Prompt relay (LTX Director)',
    shortDescription:
      'Render whole scenes continuously via the LTX Director workflow. Better motion fidelity, lower per-frame resolution.',
    longDescription:
      'Generates first frames per shot via Klein (no last frames). The LTX 2.3 Director workflow renders the entire scene continuously, using the first frames as per-segment anchors and interpolating the motion between them with the transition + OmniNFT-RL LoRA stack. Scenes that exceed the 1000-frame cap auto-chunk and stitch via FFmpeg. Lower resolution per frame (832x448) but visibly better cross-shot motion and identity continuity. Currently REQUIRES the user\'s local Comfy box (cloud Comfy lacks the LTX Director custom nodes + LoRAs).',
    requires: { llmEndpoint: true, kleinComfy: true, ltxDirectorLocal: true },
  },
};

/**
 * Validate + normalize a render method string. Returns null for
 * unknown values so callers can decide the error shape.
 */
export function resolveRenderMethod(input: string | undefined): RenderMethod | null {
  if (!input) return null;
  const normalized = input.trim().toLowerCase().replace(/[-\s]/g, '_');
  if (normalized in RENDER_METHODS) return normalized as RenderMethod;
  return null;
}

/** All registered render method ids, in canonical display order. */
export const RENDER_METHOD_IDS: readonly RenderMethod[] = Object.keys(
  RENDER_METHODS,
) as readonly RenderMethod[];

/**
 * Resolve a project's render method, falling back to the default if
 * the field is missing or invalid. Accepts the loose `ProjectFile`
 * shape so callers don't need to import the full type.
 */
export function getProjectRenderMethod(
  project: { renderMethod?: unknown } & Record<string, unknown>,
): RenderMethod {
  const raw = typeof project.renderMethod === 'string' ? project.renderMethod : undefined;
  return resolveRenderMethod(raw) ?? DEFAULT_RENDER_METHOD;
}
