/**
 * Shared stage vocabulary — the canonical user-facing stage names and the
 * typeId expansions behind them.
 *
 * Consumers:
 *   - `scripts/reset-project.ts` — uses STAGE_ALIASES + TEMPLATE_DEPS to
 *     compute which nodes to invalidate for `/reset <stage>`.
 *   - `src/core/planner/ExecutorAgent.ts` — uses resolveStageToTypeIds to
 *     gate `/run-to <stage>` (stop when every node of the resolved typeIds
 *     is terminal).
 *
 * Both consumers MUST agree on what a stage means. Lifting this out of
 * reset-project.ts is the single source of truth that keeps them in sync.
 *
 * A stage value is always an array of typeIds (even for single-type
 * aliases like 'plot' → ['plot']). Callers in reset-project.ts that
 * expected `string | string[]` get an array-normalized form here.
 */

/**
 * User-facing stage name → typeIds the stage covers.
 *
 * Multi-typeId aliases like `character_image` bundle sibling types
 * (character_image, setting_image, object_image) that belong together
 * in the same pipeline phase. Resetting or gating at the alias applies
 * to all members.
 */
export const STAGE_ALIASES: Record<string, string[]> = {
  plot: ['plot'],
  story: ['story'],
  story_essence: ['story_essence'],         // editorial-intent JSON (genre / throughline / tonal notes)
  characters: ['character', 'setting'],     // both character + setting (siblings)
  character: ['character'],
  setting: ['setting'],
  scene: ['scene'],
  world_style: ['world_style'],
  character_image: ['character_image', 'setting_image', 'object_image'],  // all three reference-image siblings
  reference_images: ['character_image', 'setting_image', 'object_image'], // explicit alias for all three
  setting_image: ['setting_image'],
  // The user-facing "scene_video_prompt" stage covers all three layers of
  // the hierarchical breakdown: the lightweight plan (Stage A), the
  // per-shot expansions (Stage B), and the deterministic assembler
  // (Stage C). Resetting at this stage clears the upstream LLM stages
  // so the user gets a fresh breakdown — not just a re-stitch of the
  // existing plan + shots.
  scene_video_prompt: ['scene_shot_plan', 'shot_breakdown', 'scene_video_prompt'],
  scene_shot_plan: ['scene_shot_plan'],
  shot_breakdown: ['shot_breakdown'],
  shot_image_prompt: ['shot_image_prompt'],
  shot_motion_directive: ['shot_motion_directive'],
  shot_image: ['shot_image'],
  shot_video: ['shot_video'],
  final_video: ['final_video'],
};

/**
 * Template dependency map: typeId → required upstream typeIds.
 *
 * Used by the reset script to compute the downstream closure of a stage
 * (BFS over the inverse edges). Kept here so other tooling can reuse
 * the same graph without re-parsing the template.
 */
export const TEMPLATE_DEPS: Record<string, string[]> = {
  plot: [],
  story: ['plot'],
  story_essence: ['story'],
  character: ['story', 'story_essence'],
  setting: ['story', 'story_essence'],
  scene: ['story', 'character', 'setting', 'story_essence'],
  world_style: ['story', 'scene', 'setting'],
  object: ['story'],
  character_image: ['character', 'world_style'],
  setting_image: ['setting', 'world_style'],
  object_image: ['object', 'world_style'],
  scene_shot_plan: ['scene', 'world_style'],
  shot_breakdown: ['scene_shot_plan', 'world_style'],
  scene_video_prompt: ['scene_shot_plan', 'shot_breakdown'],
  shot_image_prompt: ['scene_video_prompt'],
  shot_motion_directive: ['scene_video_prompt', 'shot_image_prompt', 'world_style'],
  shot_image: ['shot_image_prompt', 'character_image', 'setting_image', 'object_image'],
  // shot_image_last_frame was previously absent from this map. Its omission
  // meant `pnpm reset <stage>` (and the desktop reset path that calls the
  // same resetProjectStage) never invalidated last_frame nodes via the BFS
  // that walks TEMPLATE_DEPS — so after a reset the executor's
  // "outputPath exists on disk" short-circuit in executeShotImageLastFrame.ts
  // returned the stale prior render as the node's output, and last frames
  // silently survived across resets. Adding it puts last frames on the same
  // invalidation chain as first frames so resets are symmetric.
  shot_image_last_frame: ['shot_image_prompt', 'shot_image', 'character_image', 'setting_image', 'object_image'],
  shot_video: ['shot_image', 'shot_image_last_frame', 'shot_motion_directive'],
  final_video: ['shot_video'],
};

/**
 * All recognized user-facing stage names. Frontend can use this to
 * validate `/run-to` / `/reset` arguments before sending the message.
 */
export const VALID_STAGES: readonly string[] = Object.keys(STAGE_ALIASES);

/**
 * Resolve a user-facing stage name to the typeIds it covers.
 * Returns null for unknown stages — the caller decides how to report.
 *
 * Case-sensitive: stage names are canonically lowercase to match the
 * frontend command input and reset-project's alias table.
 */
export function resolveStageToTypeIds(stage: string): string[] | null {
  const match = STAGE_ALIASES[stage];
  return match ? [...match] : null;
}

/**
 * Minimal projection of an ExecutionNode needed for gate evaluation.
 * Kept in this module (instead of importing the full type) so the
 * helper has zero coupling to the executor — unit tests feed it
 * plain objects.
 */
export interface GateNode {
  typeId: string;
  status: string;
  /** Full node id (`typeId:itemId` or just `typeId` for singletons).
   *  Optional so existing call sites that only checked typeId-level
   *  gates keep compiling; required when the per-node gate is in use. */
  id?: string;
}

/**
 * Decide whether a `/run-to <stage>` gate should fire: stop the
 * executor because every node of the gated typeIds is terminal.
 *
 * Semantics:
 *   - If no gate is configured (`stopAtStageTypeIds === null`) → false.
 *   - If redo-isolation is active, redo-isolation wins — the gate is
 *     silenced so a `redo_node` doesn't falsely trip the pause.
 *   - If zero nodes in the graph belong to the gated typeIds, we haven't
 *     expanded yet (the executor runs `expandPendingCollections` before
 *     each ready-check) → false; let the loop keep going.
 *   - Otherwise: true iff every gated node is in a terminal status
 *     (`completed`, `skipped`, or `failed`). Treating `failed` as
 *     terminal prevents self-repair from infinite-looping past the gate.
 *
 * Kept as a pure function so it's trivially testable without spinning
 * up a real ExecutorAgent or LLM. `ExecutorAgent.shouldStopForStageGate`
 * is a thin wrapper that marshals node state into this shape.
 */
export function isStageGateSatisfied(
  nodes: GateNode[],
  stopAtStageTypeIds: Set<string> | null,
  hasRedoIsolation: boolean,
): boolean {
  if (!stopAtStageTypeIds) return false;
  if (hasRedoIsolation) return false;
  const inGate = nodes.filter(n => stopAtStageTypeIds.has(n.typeId));
  if (inGate.length === 0) return false;
  const TERMINAL = new Set(['completed', 'skipped', 'failed']);
  return inGate.every(n => TERMINAL.has(n.status));
}

/**
 * Single-node sister of `isStageGateSatisfied`. Fires the moment a
 * specific node id reaches a terminal status — without waiting for
 * the rest of its stage. Drives `pnpm run-to <project> <node-id>`
 * so the pi agent can pause after one shot's image generates,
 * before its sibling shots run.
 *
 * Semantics:
 *   - No gate set (`null`) → false.
 *   - Redo-isolation active → false (matches stage gate; redos must
 *     not trip pauses).
 *   - Target id not in the graph (pre-expansion) → false; let the
 *     loop run and expand.
 *   - Otherwise → true iff that node is in a terminal status
 *     (`completed`, `skipped`, or `failed`).
 */
export function isNodeGateSatisfied(
  nodes: GateNode[],
  stopAfterNodeId: string | null,
  hasRedoIsolation: boolean,
): boolean {
  if (!stopAfterNodeId) return false;
  if (hasRedoIsolation) return false;
  const target = nodes.find(n => n.id === stopAfterNodeId);
  if (!target) return false;
  const TERMINAL = new Set(['completed', 'skipped', 'failed']);
  return TERMINAL.has(target.status);
}
