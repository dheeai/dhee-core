/**
 * Scene State Tracker
 *
 * Tracks character positions, poses, hands, legs, expressions, and object states
 * across shots within a scene. The state accumulates shot by shot and is injected
 * into each shot's LLM context to maintain visual continuity.
 */

import { existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';
import { atomicWriteFileSync } from '../../utils/atomicWrite.js';

/**
 * Character-kind discriminator. Controls which pose fields apply.
 *
 * `human` — humanoid; tracks leftHand/rightHand/legs/headTilt.
 * `animal` — quadruped (cat, dog, horse, etc.); tracks `bodyPose` only.
 *            Never leftHand/rightHand/legs — cats don't have hands.
 * `unknown` — not yet determined; fields remain optional.
 *
 * The LLM extractor assigns `kind` based on the character profile or
 * shot description (e.g., "Glitch nuzzles his lap" → animal).
 */
export type CharacterKind = 'human' | 'animal' | 'unknown';

export interface CharacterState {
  position: string;      // "lying_in_bed", "standing_left", "seated_at_table", "off_screen", "on_lap", "at_window"
  pose: string;          // "lying_down", "sitting_upright", "leaning_forward", "curled_up", "standing"
  expression: string;    // "peaceful", "anxious", "smiling" (human); "alert", "calm", "content" (animal)
  facing: string;        // "camera", "left", "right", "away"
  inFrame: boolean;
  inFocus?: boolean;     // whether this character is the sharp/focal subject of the current shot
  kind?: CharacterKind;  // humanoid vs animal — controls which pose fields apply (default 'unknown')

  // Humanoid-only fields. Optional because non-human characters (cats,
  // dogs, etc.) don't have hands/legs in the humanoid sense. Required
  // schema forced the LLM to invent "right hand touching face" for cats —
  // see lazarus_drive Glitch-in-bar bug. For `kind: 'animal'`, omit these.
  leftHand?: string;     // "resting_on_lap", "holding_ring", "at_side"
  rightHand?: string;    // "on_table", "touching_face", "holding_cup"
  legs?: string;         // "under_duvet", "crossed", "standing_apart"
  headTilt?: string;     // "neutral", "tilted_left", "looking_down"

  // Non-human fields — present only for kind: 'animal'.
  bodyPose?: string;     // "curled_up", "stalking", "alert_standing", "sitting_on_haunches"
  tail?: string;         // "curled_around_body", "flicking", "low_and_still" — optional, describe if relevant
}

export interface ObjectState {
  state: string;         // "on_table", "held_by_keerti", "broken", "lit", "off"
  position: string;      // "bedside_table", "floor", "off_screen"
}

export interface SceneState {
  sceneId: string;
  shotNumber: number;    // Last shot that updated this state
  characters: Record<string, CharacterState>;
  objects: Record<string, ObjectState>;
  environment: {
    lighting: string;
    timeProgression: string;
  };
  focusedEntity?: string | null;  // refId of the currently focused character/object (one per shot)
}

/**
 * Describes a character for initial scene state.
 *
 * `refId` — canonical character ID (matches character:<refId> node).
 * `kind` — humanoid vs animal. Drives which pose fields are tracked and
 *          injected into the prompt. Default 'unknown' if the caller
 *          can't determine it.
 */
export interface SceneCharacterInit {
  refId: string;
  kind?: CharacterKind;
}

/**
 * Create initial scene state with the given characters off-screen.
 *
 * Accepts either:
 *   - `SceneCharacterInit[]` — characters with kind (humanoid/animal). Preferred.
 *   - `string[]` — legacy: plain refIds, all treated as `kind: 'unknown'`.
 *
 * Only characters ACTUALLY IN THIS SCENE should be passed in. Including
 * characters from other scenes (e.g. Glitch in the bar scene) causes the
 * state tracker to carry them across shots and the image-prompt LLM to
 * hallucinate their presence — the lazarus_drive root cause.
 */
export function initializeSceneState(
  sceneId: string,
  characters: SceneCharacterInit[] | string[],
  _settingId: string,
): SceneState {
  const normalized: SceneCharacterInit[] = characters.map(c =>
    typeof c === 'string' ? { refId: c, kind: 'unknown' } : c,
  );

  const characterMap: Record<string, CharacterState> = {};
  for (const { refId, kind = 'unknown' } of normalized) {
    const base: CharacterState = {
      position: 'off_screen',
      pose: 'unknown',
      expression: 'unknown',
      facing: 'unknown',
      inFrame: false,
      kind,
    };
    if (kind === 'human' || kind === 'unknown') {
      // Humanoid fields start as 'unknown' so the LLM fills them on first in-frame shot
      base.leftHand = 'unknown';
      base.rightHand = 'unknown';
      base.legs = 'unknown';
      base.headTilt = 'unknown';
    }
    if (kind === 'animal') {
      base.bodyPose = 'unknown';
      // tail is optional — only populated if visible in a shot
    }
    characterMap[refId] = base;
  }

  return {
    sceneId,
    shotNumber: 0,
    characters: characterMap,
    objects: {},
    environment: {
      lighting: 'default',
      timeProgression: 'start',
    },
  };
}

/**
 * Save scene state to disk.
 */
export function saveSceneState(projectDir: string, sceneId: string, state: SceneState): void {
  const stateDir = join(projectDir, 'prompts', 'videos', 'scenes');
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const statePath = join(stateDir, `${sceneId}.state.json`);
  atomicWriteFileSync(statePath, JSON.stringify(state, null, 2));
}

/**
 * Load scene state from disk. Returns null if not found.
 */
export function loadSceneState(projectDir: string, sceneId: string): SceneState | null {
  const statePath = join(projectDir, 'prompts', 'videos', 'scenes', `${sceneId}.state.json`);
  if (!existsSync(statePath)) return null;
  try {
    return JSON.parse(readFileSync(statePath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Format scene state as a human-readable text block for LLM injection.
 *
 * Renders humanoid-specific fields (hands, legs, head tilt) only for
 * `kind === 'human'` or `'unknown'`. For animals, renders `bodyPose`
 * and `tail` instead — a cat's state never includes "right hand".
 */
export function formatStateForPrompt(state: SceneState): string {
  const lines: string[] = [];
  lines.push(`CURRENT SCENE STATE (after shot ${state.shotNumber}):`);
  lines.push('');

  // Characters
  for (const [id, char] of Object.entries(state.characters)) {
    if (!char.inFrame) {
      const kindTag = char.kind && char.kind !== 'unknown' ? ` (${char.kind})` : '';
      lines.push(`- ${id}${kindTag}: off screen`);
      continue;
    }
    const parts: string[] = [];
    if (char.kind && char.kind !== 'unknown') parts.push(`kind: ${char.kind}`);
    if (char.position && char.position !== 'unknown') parts.push(`position: ${char.position}`);
    if (char.pose && char.pose !== 'unknown') parts.push(`pose: ${char.pose}`);
    if (char.expression && char.expression !== 'unknown') parts.push(`expression: ${char.expression}`);
    if (char.facing && char.facing !== 'unknown') parts.push(`facing: ${char.facing}`);

    if (char.kind === 'animal') {
      // Animal-specific fields
      if (char.bodyPose && char.bodyPose !== 'unknown') parts.push(`body: ${char.bodyPose}`);
      if (char.tail && char.tail !== 'unknown') parts.push(`tail: ${char.tail}`);
    } else {
      // Humanoid fields (or unknown — default to humanoid)
      if (char.leftHand && char.leftHand !== 'unknown') parts.push(`left hand: ${char.leftHand}`);
      if (char.rightHand && char.rightHand !== 'unknown') parts.push(`right hand: ${char.rightHand}`);
      if (char.legs && char.legs !== 'unknown') parts.push(`legs: ${char.legs}`);
      if (char.headTilt && char.headTilt !== 'unknown') parts.push(`head: ${char.headTilt}`);
    }

    if (char.inFocus) parts.push('IN FOCUS');
    lines.push(`- ${id}: ${parts.join(', ')}`);
  }

  // Objects
  if (Object.keys(state.objects).length > 0) {
    lines.push('');
    for (const [id, obj] of Object.entries(state.objects)) {
      lines.push(`- ${id}: ${obj.state} (${obj.position})`);
    }
  }

  // Focus
  if (state.focusedEntity) {
    lines.push('');
    lines.push(`- FOCUS: ${state.focusedEntity}`);
  }

  // Environment
  if (state.environment.lighting !== 'default') {
    lines.push('');
    lines.push(`- Lighting: ${state.environment.lighting}`);
    if (state.environment.timeProgression !== 'start') {
      lines.push(`- Time: ${state.environment.timeProgression}`);
    }
  }

  return lines.join('\n');
}

// ── Zod schema for validating LLM state output ─────────────────────────────

export const characterStateSchema = z.object({
  position: z.string(),
  pose: z.string(),
  expression: z.string(),
  facing: z.string(),
  inFrame: z.boolean(),
  inFocus: z.boolean().optional().default(false),
  // Discriminator — tells downstream which pose fields apply.
  kind: z.enum(['human', 'animal', 'unknown']).optional().default('unknown'),

  // Humanoid fields — optional. Required schema forced the LLM to invent
  // "right hand touching face" for cats. Now optional, and for
  // `kind: 'animal'` we tell the LLM to omit them entirely.
  leftHand: z.string().optional(),
  rightHand: z.string().optional(),
  legs: z.string().optional(),
  headTilt: z.string().optional(),

  // Animal-only fields
  bodyPose: z.string().optional(),
  tail: z.string().optional(),
});

export const sceneStateSchema = z.object({
  characters: z.record(z.string(), characterStateSchema),
  objects: z.record(z.string(), z.object({
    state: z.string(),
    position: z.string(),
  })).optional().default({}),
  environment: z.object({
    lighting: z.string(),
    timeProgression: z.string(),
  }).optional().default({ lighting: 'default', timeProgression: 'start' }),
  focusedEntity: z.string().nullable().optional(),
});

/**
 * Extract new scene state from an LLM given previous state + shot prompt content.
 * This is the same function called by both production (ExecutorAgent) and E2E tests.
 */
export async function extractStateFromLLM(
  llm: { generateStream: (opts: any) => AsyncGenerator<{ content?: string; thinking?: string; done?: boolean }, any, any> },
  previousState: SceneState | null,
  shotPromptContent: string,
): Promise<{ state: SceneState | null; raw: string; error?: string }> {
  const stateJson = previousState
    ? JSON.stringify(previousState, null, 2)
    : '{ "characters": {}, "objects": {}, "environment": { "lighting": "default", "timeProgression": "start" } }';

  const systemMsg = `You extract scene state from shot descriptions. Return ONLY valid JSON with the full updated state.

Each character has a \`kind\`: "human", "animal", or "unknown". The previous state tells you the kind for each character — preserve it. If kind is "animal" (cat, dog, horse, etc.), the character has NO hands, NO human legs, NO humanoid head tilt. Those fields do NOT apply. Do not invent them.

The JSON must have this structure:
{
  "characters": {
    "<character_id>": {
      "kind": "human | animal | unknown (copy from previous state)",
      "position": "string (where in the scene: lying_in_bed, standing_left, seated_at_table, on_lap, at_window, off_screen)",
      "pose": "string (overall body pose)",
      "expression": "string (facial expression)",
      "facing": "string (direction: camera, left, right, away, down)",
      "inFrame": boolean,
      "inFocus": "boolean (true only if this character is the sharp/focal subject of THIS shot)",

      // ── ONLY for kind: 'human' or 'unknown' — OMIT for kind: 'animal' ──
      "leftHand": "string (what left hand is doing: at_side, on_lap, holding_cup)",
      "rightHand": "string (what right hand is doing: at_side, touching_face, holding_cup)",
      "legs": "string (leg position: standing_apart, crossed, under_duvet)",
      "headTilt": "string (head angle: neutral, tilted_left, looking_down)",

      // ── ONLY for kind: 'animal' — OMIT for kind: 'human' ──
      "bodyPose": "string (animal posture: curled_up, stalking, alert_standing, sitting_on_haunches, walking)",
      "tail": "string OPTIONAL (tail position if visible: curled_around_body, flicking, low_and_still)"
    }
  },
  "objects": {
    "<object_id>": { "state": "string", "position": "string" }
  },
  "environment": {
    "lighting": "string (warm_golden, dim_evening, harsh_overhead)",
    "timeProgression": "string (early_morning, midday, evening)"
  },
  "focusedEntity": "string | null (refId of the character or object that is razor-sharp in this shot — exactly ONE or null)"
}

IMPORTANT:
- Include ALL characters from previous state (even off-screen ones).
- NEVER add a character that is not in the previous state. If the shot description mentions someone not in the state, they are not in this scene — ignore them or describe as prose only.
- Preserve each character's \`kind\` from the previous state verbatim.
- For kind: 'animal' characters, use bodyPose/tail — do NOT emit leftHand/rightHand/legs/headTilt.
- Only ONE character or object should have inFocus=true per shot — and it must match focusedEntity.
- Return ONLY the JSON — no markdown, no explanation.`;

  const userMsg = `Previous scene state:\n${stateJson}\n\nShot prompt content:\n${shotPromptContent}\n\nReturn the NEW complete state after this shot.`;

  let rawContent = '';
  try {
    for await (const chunk of llm.generateStream({
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.1,
    })) {
      if (chunk.content) rawContent += chunk.content;
    }
  } catch (err) {
    return { state: null, raw: rawContent, error: `LLM call failed: ${(err as Error).message}` };
  }

  // Parse and validate
  try {
    let cleaned = rawContent.trim();
    if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    const parsed = JSON.parse(cleaned);
    const validated = sceneStateSchema.safeParse(parsed);

    if (!validated.success) {
      return { state: null, raw: rawContent, error: `Schema validation failed: ${validated.error.issues.map(i => i.message).join('; ')}` };
    }

    const state: SceneState = {
      sceneId: previousState?.sceneId ?? 'unknown',
      shotNumber: (previousState?.shotNumber ?? 0) + 1,
      characters: validated.data.characters as Record<string, CharacterState>,
      objects: validated.data.objects as Record<string, ObjectState>,
      environment: validated.data.environment,
    };

    return { state, raw: rawContent };
  } catch (err) {
    return { state: null, raw: rawContent, error: `JSON parse failed: ${(err as Error).message}` };
  }
}

/**
 * Compute a human-readable diff between two states.
 * Shows only what changed — empty string if identical.
 */
export function computeStateDiff(
  before: Pick<SceneState, 'characters' | 'objects' | 'environment' | 'focusedEntity'>,
  after: Pick<SceneState, 'characters' | 'objects' | 'environment' | 'focusedEntity'>,
): string {
  const lines: string[] = [];

  // Focus pull — the camera's focus target changed
  const beforeFocus = before.focusedEntity ?? null;
  const afterFocus = after.focusedEntity ?? null;
  if (beforeFocus !== afterFocus && afterFocus) {
    if (beforeFocus) {
      lines.push(`◉ focus: ${beforeFocus} → ${afterFocus}`);
    } else {
      lines.push(`◉ focus → ${afterFocus}`);
    }
  }

  // Character changes
  for (const [id, afterChar] of Object.entries(after.characters ?? {})) {
    const beforeChar = before.characters?.[id];

    if (!beforeChar || (!beforeChar.inFrame && afterChar.inFrame)) {
      // Character entered frame
      const parts: string[] = [];
      if (afterChar.position !== 'unknown') parts.push(`position: ${afterChar.position}`);
      if (afterChar.pose !== 'unknown') parts.push(`pose: ${afterChar.pose}`);
      if (afterChar.expression !== 'unknown') parts.push(`expression: ${afterChar.expression}`);
      lines.push(`▶ ${id}: ENTERED frame — ${parts.join(', ')}`);
      continue;
    }

    if (beforeChar.inFrame && !afterChar.inFrame) {
      lines.push(`◀ ${id}: LEFT frame`);
      continue;
    }

    // Field-by-field diff — pick fields based on character kind so we
    // don't produce noise like "leftHand: unknown → unknown" for a cat.
    const kind = afterChar.kind ?? beforeChar.kind ?? 'unknown';
    const fields: Array<keyof CharacterState> = kind === 'animal'
      ? ['position', 'pose', 'expression', 'facing', 'bodyPose', 'tail']
      : ['position', 'pose', 'expression', 'facing', 'leftHand', 'rightHand', 'legs', 'headTilt'];
    const changes: string[] = [];
    for (const field of fields) {
      const bVal = beforeChar[field];
      const aVal = afterChar[field];
      if (bVal !== aVal && aVal !== 'unknown' && aVal !== undefined) {
        changes.push(`${field}: ${bVal ?? 'unknown'} → ${aVal}`);
      }
    }
    if (changes.length > 0) {
      lines.push(`△ ${id}: ${changes.join(', ')}`);
    }
  }

  // Object changes
  for (const [id, afterObj] of Object.entries(after.objects ?? {})) {
    const beforeObj = before.objects?.[id];
    if (!beforeObj) {
      lines.push(`+ ${id}: ${afterObj.state} (${afterObj.position})`);
    } else if (beforeObj.state !== afterObj.state || beforeObj.position !== afterObj.position) {
      const parts: string[] = [];
      if (beforeObj.state !== afterObj.state) parts.push(`state: ${beforeObj.state} → ${afterObj.state}`);
      if (beforeObj.position !== afterObj.position) parts.push(`position: ${beforeObj.position} → ${afterObj.position}`);
      lines.push(`△ ${id}: ${parts.join(', ')}`);
    }
  }

  // Environment changes
  if (before.environment?.lighting !== after.environment?.lighting) {
    lines.push(`☀ lighting: ${before.environment?.lighting ?? 'default'} → ${after.environment?.lighting ?? 'default'}`);
  }
  if (before.environment?.timeProgression !== after.environment?.timeProgression) {
    lines.push(`⏱ time: ${before.environment?.timeProgression ?? 'start'} → ${after.environment?.timeProgression ?? 'start'}`);
  }

  return lines.join('\n');
}

/**
 * Compute target state BEFORE generating the image prompt.
 *
 * Flow: previous state + shot description → LLM computes target state →
 * returns both states formatted for prompt injection.
 *
 * The image prompt LLM sees BOTH the previous state and the target state,
 * so it knows exactly what to render. No post-generation state extraction needed.
 */
export async function buildStateContext(
  llm: { generateStream: (opts: any) => AsyncGenerator<{ content?: string; thinking?: string; done?: boolean }, any, any> },
  previousState: SceneState | null,
  shotDescription: string,
): Promise<{ targetState: SceneState | null; promptContext: string; diff: string }> {
  // Compute target state from shot description
  const stateResult = await extractStateFromLLM(llm, previousState, shotDescription);

  if (!stateResult.state) {
    // LLM failed — fall back to previous state only
    if (previousState && previousState.shotNumber > 0) {
      return {
        targetState: null,
        promptContext: `\n\n<scene_state>\nPREVIOUS STATE (before this shot):\n${formatStateForPrompt(previousState)}\n\nYour shot MUST be consistent with this state.\n</scene_state>`,
        diff: '',
      };
    }
    return { targetState: null, promptContext: '', diff: '' };
  }

  const targetState = stateResult.state;
  const diff = previousState ? computeStateDiff(previousState, targetState) : '';

  const prevSection = previousState
    ? `PREVIOUS STATE (before this shot):\n${formatStateForPrompt(previousState)}\n\n`
    : '';

  const targetSection = `TARGET STATE (what this shot must show):\n${formatStateForPrompt(targetState)}`;
  const diffSection = diff ? `\n\nCHANGES:\n${diff}` : '';

  const promptContext = `\n\n<scene_state>\n${prevSection}${targetSection}${diffSection}\n\nYour image prompt MUST render the TARGET STATE. Characters cannot teleport — if a character's position changed, show the transition.\n</scene_state>`;

  return { targetState, promptContext, diff };
}

/**
 * Save per-shot state diff (previous + target) so motion directive can read it.
 */
export function saveShotStateDiff(
  projectDir: string,
  sceneId: string,
  shotNumber: number,
  previous: SceneState,
  target: SceneState,
): void {
  const stateDir = join(projectDir, 'prompts', 'videos', 'scenes');
  if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
  const diffPath = join(stateDir, `${sceneId}_shot_${shotNumber}.state_diff.json`);
  atomicWriteFileSync(diffPath, JSON.stringify({ previous, target }, null, 2));
}

/**
 * Load per-shot state diff saved by shot_image_prompt step.
 */
export function loadShotStateDiff(
  projectDir: string,
  sceneId: string,
  shotNumber: number,
): { previous: SceneState; target: SceneState } | null {
  const diffPath = join(projectDir, 'prompts', 'videos', 'scenes', `${sceneId}_shot_${shotNumber}.state_diff.json`);
  if (!existsSync(diffPath)) return null;
  try {
    return JSON.parse(readFileSync(diffPath, 'utf-8'));
  } catch {
    return null;
  }
}

/**
 * Build a `<last_frame_changes>` block from state diff.
 * Tells the LLM what MUST be different in the last frame.
 * Returns empty string if no changes.
 */
export function buildLastFrameChanges(
  previousState: SceneState,
  targetState: SceneState,
): string {
  const diff = computeStateDiff(previousState, targetState);
  if (!diff) return '';

  return `\n\n<last_frame_changes>\nThese changes MUST be visible in the last frame:\n${diff}\n\nDescribe the END STATE showing these changes. Do NOT write "No visible change."\n</last_frame_changes>`;
}

/**
 * Format state context specifically for motion directive generation.
 * Emphasizes the DELTA — what needs to MOVE between previous and target state.
 * The motion directive describes the transition, not the static frame.
 */
export function buildMotionStateContext(
  previousState: SceneState,
  targetState: SceneState,
): string {
  const diff = computeStateDiff(previousState, targetState);

  if (!diff) {
    return `\n\n<scene_state>\nNo state changes — this is a static/atmospheric shot. Describe subtle environmental motion only (wind, particles, light shifts).\n</scene_state>`;
  }

  return `\n\n<scene_state>\nSTATE CHANGES (what needs to MOVE in this shot):\n${diff}\n\nDescribe the MOTION that transitions from previous to target state. Each change above is something that should be visible movement in the video.\n</scene_state>`;
}
