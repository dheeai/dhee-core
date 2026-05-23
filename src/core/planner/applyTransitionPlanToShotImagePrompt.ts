/**
 * Phase 2 Stage 3 — boundary-plan mutation of shot_image_prompt JSON.
 *
 * Reads the shot's `incomingTransition` (set earlier by the boundary
 * planner via `applyBoundaryPlanToScene`) and the NEXT shot's
 * `incomingTransition` (for LF-injection lookahead), and mutates the
 * JSON accordingly:
 *
 *   incomingTransition.operation:
 *     - shared_frame  → first_frame.generationMode = 'edit_previous_shot',
 *                       imagePrompt gets a strong "exactly match the
 *                       prior shot's last frame" preamble. Klein will
 *                       render a near-pixel-perfect continuation of the
 *                       prior LF.
 *     - reuse_intent  → same mode change with a softer "near-identical"
 *                       preamble that permits small intentional changes.
 *     - reframe       → mode unchanged; imagePrompt gets a "blocking
 *                       diverges from prior shot's last frame" preamble
 *                       so the prompt writer doesn't lazily reuse the
 *                       prior framing.
 *     - cut / missing → first_frame untouched.
 *
 *   next-shot incomingTransition.operation (THIS shot's outgoing side):
 *     - shared_frame / reuse_intent → last_frame.imagePrompt gets a
 *                       lookahead injection: "this frame sets up shot
 *                       N+1: <description>" so the LF is co-designed
 *                       with the next FF. Skipped when last_frame has
 *                       already been stripped (skip-LF for holding beat).
 *     - other / missing → last_frame untouched.
 *
 * Returns the mutated JSON string when any mutation fired, or null
 * when nothing changed (cleaner than producing a re-serialized but
 * semantically-equal blob).
 *
 * Pure: takes the JSON content + a project-like object + scene/shot
 * numbers. No I/O. Returns null on parse failure, missing scene, or
 * missing shot — the caller falls back to the original content.
 */

import type {
  TransitionDecision,
  TransitionOperation,
} from '../project/projectSchema.js';

interface ShotMinimal {
  shotNumber?: number;
  description?: string;
  incomingTransition?: { operation?: string };
}

interface SceneMinimal {
  sceneNumber?: number;
  shots?: ShotMinimal[];
}

interface ProjectMinimal {
  scenes?: SceneMinimal[];
}

interface FrameSlot {
  imagePrompt?: string;
  generationMode?: string;
  references?: unknown;
}

interface ShotImagePromptShape {
  shotNumber?: number;
  generationStrategy?: string;
  frames?: {
    first_frame?: FrameSlot;
    last_frame?: FrameSlot;
    mid_frame?: FrameSlot;
  };
}

function parseJsonContent(jsonContent: string): ShotImagePromptShape | null {
  let raw = (jsonContent ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ShotImagePromptShape;
  } catch {
    return null;
  }
}

function findScene(project: ProjectMinimal, sceneNumber: number): SceneMinimal | undefined {
  return project.scenes?.find((s) => s.sceneNumber === sceneNumber);
}

function findShot(scene: SceneMinimal | undefined, shotNumber: number): ShotMinimal | undefined {
  return scene?.shots?.find((sh) => sh.shotNumber === shotNumber);
}

const PREAMBLES: Record<TransitionOperation, (priorShotN: number) => string> = {
  shared_frame: (n) =>
    `[boundary planner: shared_frame] This frame must EXACTLY MATCH the prior shot's last frame (shot ${n}). Reuse the same composition, the same character poses, the same lighting, the same camera position. The renderer will use shot ${n}'s last frame as the Klein base — your prose must read as a precise description of that ending state, NOT a fresh shot. Then below:`,
  reuse_intent: (n) =>
    `[boundary planner: reuse_intent] This frame is NEAR-IDENTICAL to the prior shot's last frame (shot ${n}) with only small intentional changes. Same location, same characters, same lighting; a minor shift (a head turn, a small framing tighten, a hand lifting). The renderer chains from shot ${n}'s last frame via Klein edit — describe what stays the same first, then the small change. Then below:`,
  reframe: (n) =>
    `[boundary planner: reframe] Blocking or pose DIVERGES from the prior shot's last frame (shot ${n}). Do NOT reuse the prior framing — a character has moved (sat / stood / left frame / entered frame), or the camera has changed position. The renderer generates this frame FRESH (not chained from prior LF) — set up the new state explicitly from the references. Then below:`,
  cut: (n) =>
    `[boundary planner: cut] Hard break from shot ${n} — new location, POV, or time. Do NOT borrow framing, lighting, or composition from the prior shot. The renderer generates this frame FRESH (not chained from prior LF). Establish the new scene independently. Then below:`,
};

function prependPreamble(prompt: string, preamble: string): string {
  if (!preamble) return prompt;
  return `${preamble}\n\n${prompt}`;
}

export function applyTransitionPlanToShotImagePrompt(
  jsonContent: string,
  project: ProjectMinimal,
  sceneNumber: number,
  shotNumber: number,
): string | null {
  const scene = findScene(project, sceneNumber);
  if (!scene) return null;
  const shot = findShot(scene, shotNumber);
  if (!shot) return null;

  const incomingOp = shot.incomingTransition?.operation as TransitionOperation | undefined;
  const nextShot = findShot(scene, shotNumber + 1);
  const nextIncomingOp = nextShot?.incomingTransition?.operation as
    | TransitionOperation
    | undefined;
  const nextDescription = nextShot?.description;

  const wantsIncomingMutation =
    incomingOp === 'shared_frame' ||
    incomingOp === 'reuse_intent' ||
    incomingOp === 'reframe' ||
    incomingOp === 'cut';
  const wantsOutgoingInjection =
    (nextIncomingOp === 'shared_frame' || nextIncomingOp === 'reuse_intent') &&
    typeof nextDescription === 'string' &&
    nextDescription.trim().length > 0;

  if (!wantsIncomingMutation && !wantsOutgoingInjection) return null;

  const parsed = parseJsonContent(jsonContent);
  if (!parsed) return null;
  const frames = parsed.frames;
  if (!frames) return null;

  let mutated = false;

  // ── Incoming mutation on first_frame ───────────────────────────────────────
  // The upstream pipeline (canForceEditPrevious in shotImagePipeline.ts)
  // currently forces `edit_previous_shot` for EVERY mid-scene shot,
  // which the boundary planner intentionally overrides on `reframe` /
  // `cut`. We branch on the operation and either flip TO
  // edit_previous_shot (chain) or AWAY from it (break the chain).
  if (frames.first_frame && incomingOp && incomingOp !== undefined) {
    const priorShotN = shotNumber - 1;
    const preambleBuilder = PREAMBLES[incomingOp];
    const preamble = preambleBuilder ? preambleBuilder(priorShotN) : '';

    if (incomingOp === 'shared_frame') {
      // Literal file reuse — no Klein call. The executor's
      // `reuse_prior_frame` path byte-copies the prior shot's
      // last_frame into this shot's first_frame slot. This is the
      // only way to guarantee character identity is preserved across
      // the cut (no re-render means no opportunity for the model to
      // hallucinate). See ExecutorAgent.executeMediaGeneration for
      // the copy implementation.
      if (frames.first_frame.generationMode !== 'reuse_prior_frame') {
        frames.first_frame.generationMode = 'reuse_prior_frame';
        mutated = true;
      }
    } else if (incomingOp === 'reuse_intent') {
      // Chain via Klein edit — N+1's FF derives from N's LF with
      // small intentional changes. Klein conditioning uses the prior
      // LF as base canvas.
      if (frames.first_frame.generationMode !== 'edit_previous_shot') {
        frames.first_frame.generationMode = 'edit_previous_shot';
        mutated = true;
      }
    } else if (incomingOp === 'reframe' || incomingOp === 'cut') {
      // Break the chain — the prior LF is misleading (blocking shift)
      // or irrelevant (hard cut). Force a fresh image generation from
      // refs only, not from the prior frame.
      if (frames.first_frame.generationMode === 'edit_previous_shot') {
        // `image_text_to_image` keeps the reference list active (so
        // characters stay identity-locked via slots 2..N) but uses
        // slot 1 from the setting ref, not the prior shot's LF.
        frames.first_frame.generationMode = 'image_text_to_image';
        mutated = true;
      }
    }
    if (preamble && typeof frames.first_frame.imagePrompt === 'string') {
      frames.first_frame.imagePrompt = prependPreamble(
        frames.first_frame.imagePrompt,
        preamble,
      );
      mutated = true;
    }
  }

  // ── Outgoing injection on last_frame (LF lookahead) ────────────────────────
  if (
    wantsOutgoingInjection &&
    frames.last_frame &&
    typeof frames.last_frame.imagePrompt === 'string'
  ) {
    const injection = `[boundary planner: this LF sets up the next shot's first frame] Next shot (${shotNumber + 1}) opens on: ${nextDescription!.trim()} — write this last frame so it lands as a natural opening visual for that action, not a closing one. The renderer will use this exact LF as shot ${shotNumber + 1}'s base.\n\n`;
    frames.last_frame.imagePrompt = `${injection}${frames.last_frame.imagePrompt}`;
    mutated = true;
  }

  if (!mutated) return null;
  return JSON.stringify(parsed, null, 2);
}

// Re-export the discriminator for callers that want to introspect.
export type { TransitionOperation, TransitionDecision };
