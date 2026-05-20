/**
 * Video-render strategy resolver.
 *
 * Two strategies coexist:
 *
 *   - `prompt_relay` (default) — render a whole scene as one mp4 via
 *     LTX 2.3 + kijai/ComfyUI-PromptRelay. Each shot in the scene is a
 *     segment anchored by its first_frame; the model is patched with a
 *     temporal prompt schedule. Last frames are NOT generated in this
 *     mode (they're useless for relay rendering).
 *
 *   - `per_shot` — the existing FL2V flow: each shot is rendered
 *     independently with first + last frame anchors and a motion
 *     directive, then the per-shot mp4s are concatenated by FFmpeg.
 *
 * Selection: `dhee_VIDEO_STRATEGY=per_shot` opts out of the default.
 * Anything else (including the empty string and typos) resolves to
 * prompt_relay so a stray env value never crashes the pipeline.
 */

export type VideoStrategy = 'prompt_relay' | 'per_shot';

const DEFAULT_STRATEGY: VideoStrategy = 'prompt_relay';

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
