/**
 * Pure assembler for the hierarchical scene_video_prompt flow.
 *
 *   Stage A (LLM, scene_shot_plan node) → shot plan JSON
 *   Stage B (LLM, shot_breakdown nodes, one per shot, parallel) → per-shot JSONs
 *   Stage C (this module, deterministic) → assembled sceneVideoPromptSchema
 *
 * The output of `assembleSceneVideoPrompt` is byte-shape-identical to the
 * legacy single-call scene_video_prompt LLM output, so downstream consumers
 * (shot_image_prompt builder, shot_motion_directive, ProjectManager,
 *  SceneBreakdownCard) are untouched.
 *
 * Pure — no LLM, no I/O.
 */

import { z } from 'zod';
import {
  shotPlanSchema,
  singleShotSchema,
  sceneVideoPromptSchema,
} from './schemas.js';
import { computeAnchorsForScene, type PriorSceneLastShot } from './shotAnchorComputer.js';
import { synthesizeCameraTransitions } from './cameraTransitionSynth.js';

export type ShotPlan = z.infer<typeof shotPlanSchema>;
export type SingleShot = z.infer<typeof singleShotSchema>;
export type AssembledSceneVideoPrompt = z.infer<typeof sceneVideoPromptSchema>;

/**
 * Assemble a Stage A plan + N Stage B per-shot outputs into the existing
 * sceneVideoPromptSchema shape. Throws on contract violations the executor
 * needs to know about (missing shots, mismatched numbers, schema-fail).
 *
 * Sorts shots by `shotNumber` ascending — Stage B nodes run in parallel
 * and their output ordering on disk is not guaranteed.
 */
export function assembleSceneVideoPrompt(
  plan: ShotPlan,
  shots: SingleShot[],
  /**
   * Cross-scene chain hint. When set, the first shot's anchor will
   * point at this prior-scene shot's last_frame instead of starting
   * `fresh` — implementing the "exits door A in scene N → enters door
   * B in scene N+1" rule. Null for scene 1 or when the prior scene
   * hasn't run yet. ExecutorAgent computes this from the graph and
   * passes it in when calling the assembler.
   */
  priorSceneLastShot: PriorSceneLastShot | null = null,
): AssembledSceneVideoPrompt {
  if (!Array.isArray(shots) || shots.length === 0) {
    throw new Error('assembleSceneVideoPrompt: shots array is empty');
  }

  // Cross-check: every plan entry has a matching shot, and vice versa.
  const planNumbers = new Set(plan.shotPlan.map(p => p.shotNumber));
  const shotNumbers = new Set(shots.map(s => s.shotNumber));

  for (const planNum of planNumbers) {
    if (!shotNumbers.has(planNum)) {
      throw new Error(
        `assembleSceneVideoPrompt: plan lists shotNumber ${planNum} but no matching shot output was provided`,
      );
    }
  }
  for (const shotNum of shotNumbers) {
    if (!planNumbers.has(shotNum)) {
      throw new Error(
        `assembleSceneVideoPrompt: shot output has shotNumber ${shotNum} but the plan does not list it`,
      );
    }
  }

  // Sort by shotNumber so the assembled JSON has a stable order regardless
  // of the parallel Stage B completion order.
  const sortedShots = [...shots].sort((a, b) => a.shotNumber - b.shotNumber);

  // Compute first-frame visual-continuity anchors. The assembler is the
  // right place for this: it sees the full scene-level context (sorted
  // shot list + main/secondary subjects) and is deterministic — no LLM
  // call, just rules over the breakdown metadata. Each shot's anchor
  // tells the shot_image generator downstream WHICH prior frame to
  // edit (continuity / view_reuse) or whether to start fresh.
  const anchors = computeAnchorsForScene(
    sortedShots,
    plan.mainSubject,
    plan.secondarySubject ?? null,
    priorSceneLastShot,
  );
  const anchorByShot = new Map(anchors.map(a => [a.shotNumber, a.anchor]));
  for (const shot of sortedShots) {
    const a = anchorByShot.get(shot.shotNumber);
    if (a) shot.firstFrameAnchor = a;
  }

  // Propagate Stage A Bharata tags (sattvika / drishti / vyabhichariBhava)
  // onto shots that lack them. Stage B may refine or omit; Stage A's
  // assignment is the fallback so the tag survives into downstream
  // image/video prompt builders that read these fields.
  const planByShot = new Map(plan.shotPlan.map(p => [p.shotNumber, p] as const));
  for (const shot of sortedShots) {
    const planEntry = planByShot.get(shot.shotNumber);
    if (!planEntry) continue;
    if (!shot.sattvika && planEntry.sattvika) shot.sattvika = planEntry.sattvika;
    if (!shot.drishti && planEntry.drishti) shot.drishti = planEntry.drishti;
    if (!shot.vyabhichariBhava && planEntry.vyabhichariBhava) {
      shot.vyabhichariBhava = planEntry.vyabhichariBhava;
    }
  }

  // Camera-transition synthesis. For each shot whose anchor is
  // `continuity` AND whose camera position has shifted vs the source,
  // prepend a smooth-movement verb to its cameraWork. Prevents the
  // image-edit + video models from producing what reads as a hard cut
  // when we actually want a flowing camera move. `fresh` shots are
  // deliberate resets so we leave them alone; `view_reuse` chains
  // back to a familiar setup so the existing cameraWork lands fine.
  synthesizeCameraTransitions(sortedShots);

  const assembled: AssembledSceneVideoPrompt = {
    sceneNumber: plan.sceneNumber,
    sceneTitle: plan.sceneTitle,
    totalDuration: plan.totalDuration,
    mainSubject: plan.mainSubject,
    ...(plan.secondarySubject !== undefined && plan.secondarySubject !== null
      ? { secondarySubject: plan.secondarySubject }
      : {}),
    ...(plan.entry ? { entry: plan.entry } : {}),
    ...(plan.exit ? { exit: plan.exit } : {}),
    // Bharata propagation — Stage A's scene-level classification flows
    // into the assembled scene_video_prompt so downstream image/video
    // prompt builders can read it via scene.rasa et al.
    ...(plan.rasa ? { rasa: plan.rasa } : {}),
    ...(plan.narrativeMode ? { narrativeMode: plan.narrativeMode } : {}),
    ...(plan.sthayi ? { sthayi: plan.sthayi } : {}),
    shots: sortedShots,
  };

  // Final guard: the assembled object MUST satisfy sceneVideoPromptSchema.
  // If it doesn't, that's an upstream contract bug (a shot_breakdown node
  // produced something the scene-level refinements reject — e.g., a shot
  // with main_subject perspective when the plan's mainSubject is missing).
  // Surface it as a clear error rather than letting downstream consumers
  // see malformed JSON.
  const result = sceneVideoPromptSchema.safeParse(assembled);
  if (!result.success) {
    const errors = result.error.issues.map(i => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    });
    throw new Error(
      `assembleSceneVideoPrompt: assembled output failed sceneVideoPromptSchema validation: ${errors.join('; ')}`,
    );
  }
  return result.data as AssembledSceneVideoPrompt;
}
