/**
 * Video-render strategy resolver.
 *
 * Two strategies coexist:
 *
 *   - `per_shot` (default) — the FL2V flow: each shot is rendered
 *     independently with first + last frame anchors and a motion
 *     directive, then the per-shot mp4s are concatenated by FFmpeg.
 *     This is the path the cross-shot chaining code
 *     (`edit_previous_shot`, `reuse_prior_frame`) was designed for —
 *     last frames are real files and chains land on the right canvas.
 *
 *   - `prompt_relay` — render a whole scene as one mp4 via LTX 2.3 +
 *     kijai/ComfyUI-PromptRelay. Each shot is a segment anchored by
 *     its first_frame; the model is patched with a temporal prompt
 *     schedule. Last frames are NOT generated in this mode (useless
 *     for relay rendering). NOTE: cross-shot chaining handlers
 *     silently fall back to first_frames in this mode — known
 *     compatibility gap.
 *
 * Selection: `dhee_VIDEO_STRATEGY=prompt_relay` opts in. Anything
 * else (including the empty string and typos) resolves to per_shot
 * so a stray env value never crashes the pipeline. Default was
 * flipped from prompt_relay → per_shot 2026-05-20 after the
 * prompt_relay path was discovered to be silently breaking
 * cross-shot chaining (shot 4 with two Rubys, etc.) — see Bug 11 in
 * RUBY_V3_REGEN_NOTES.md.
 */

export type VideoStrategy = 'prompt_relay' | 'per_shot';

const DEFAULT_STRATEGY: VideoStrategy = 'per_shot';

export function getVideoStrategy(env: Record<string, string | undefined> = process.env as Record<string, string | undefined>): VideoStrategy {
  const raw = env['dhee_VIDEO_STRATEGY'];
  if (!raw) return DEFAULT_STRATEGY;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'per_shot') return 'per_shot';
  if (normalized === 'prompt_relay') return 'prompt_relay';
  return DEFAULT_STRATEGY;
}

export function isPromptRelayMode(env?: Record<string, string | undefined>): boolean {
  return getVideoStrategy(env) === 'prompt_relay';
}

/**
 * Decide whether an "extra" frame (last_frame, mid_frame, anything that
 * isn't the first frame) should be generated for a given shot.
 *
 * Per-shot mode: yes — flfv needs last_frame, fmlfv needs mid + last,
 * and so on. The executor's existing logic stays in charge.
 *
 * Prompt-relay mode: no. The relay renders the whole scene as one mp4
 * driven by per-segment first_frames + a temporal prompt schedule;
 * generated last/mid frames are unused and burn image-gen budget for
 * nothing.
 *
 * `first_frame` always returns true regardless of mode — every segment
 * in relay mode is anchored by its first frame, and per-shot mode
 * obviously needs it too.
 */
export function shouldGenerateExtraFrame(
  frameId: string,
  env?: Record<string, string | undefined>,
): boolean {
  if (frameId === 'first_frame') return true;
  return !isPromptRelayMode(env);
}
