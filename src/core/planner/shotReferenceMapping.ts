/**
 * Shot reference mapping: gathers available reference images from the
 * executor graph and formats them for LLM injection.
 *
 * Replaces the old approach of reading characters/settings from
 * scene_video_prompt JSON. Now simply gathers ALL completed
 * character_image, setting_image, and object_image nodes — the LLM
 * decides which to reference based on the shot description.
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';

export interface AvailableRef {
  imageNumber: number;
  type: 'character' | 'setting' | 'object';
  refId: string;
  label: string;
}

interface MinimalExecutor {
  getAllNodes(): Array<{
    id: string;
    typeId: string;
    itemId?: string;
    status: string;
    outputPath?: string;
  }>;
}

const REF_TYPE_IDS = ['character_image', 'setting_image', 'object_image'] as const;

function typeIdToRefType(typeId: string): 'character' | 'setting' | 'object' {
  if (typeId === 'character_image') return 'character';
  if (typeId === 'setting_image') return 'setting';
  return 'object';
}

/**
 * Gather all completed reference image nodes from the executor graph.
 * Returns them numbered sequentially (image 1, 2, 3...).
 */
export function buildAvailableReferences(executor: MinimalExecutor): { refs: AvailableRef[] } {
  // Include ALL ref nodes (not just completed) — shot_image_prompt only needs
  // the refId identifiers, not actual .png files. Image resolution happens
  // later at shot_image generation time.
  const nodes = executor.getAllNodes().filter(n =>
    (REF_TYPE_IDS as readonly string[]).includes(n.typeId)
    && n.itemId, // Must have an itemId (expanded collection node)
  );

  let imageNum = 1;
  const refs: AvailableRef[] = nodes.map(n => ({
    imageNumber: imageNum++,
    type: typeIdToRefType(n.typeId),
    refId: n.id,
    label: n.itemId ?? n.id.split(':')[1] ?? n.id,
  }));

  return { refs };
}

/**
 * Format available references as an XML block for LLM injection.
 */
export function formatReferencesForPrompt(refs: AvailableRef[]): string {
  if (refs.length === 0) {
    return '\n\n<available_references>\nNo reference images available. Set generationMode to "text_to_image" and references to [].\n</available_references>';
  }

  const refList = refs.map(r =>
    `- image ${r.imageNumber}: ${r.type} "${r.label}" (ref_id: "${r.refId}")`,
  ).join('\n');

  return `\n\n<available_references>\nAvailable reference images for this shot:\n${refList}\n\nUse "from image N" in your imagePrompt. Include each used reference in the "references" array with its ref_id.\n</available_references>`;
}

/**
 * Read the prior shot's last_frame imagePrompt text out of disk.
 *
 * Why: the first-frame LLM call already gets the prior shot's last_frame
 * *image* as the edit base (via FLUX Klein's edit workflow), but it
 * doesn't see the prior last_frame *text*. Without the text, the LLM
 * tends to write a fresh composition prompt that contradicts the base
 * image (e.g., shot 2.1's last frame had Lena at the wall, but shot 2.2's
 * first frame described "Lena mid-stride wide tracking in forest" — the
 * editor then has to invent the forest from a wall, and the result drifts).
 * Showing the LLM the prior text anchors the delta.
 *
 * Convention: prompt files live at
 *   prompts/images/shots/scene-<N>-shot-<M>.json
 * Returns null for shot 1 (no prior in scene), missing files, or JSON
 * parse errors. Falls back to first_frame.imagePrompt when last_frame is
 * absent (single-frame shots).
 */
export function readPriorLastFrameText(
  projectDir: string,
  sceneId: string,
  currentShotNumber: number,
): string | null {
  if (currentShotNumber <= 1) return null;

  const sceneNum = sceneId.replace(/^scene_/, '');
  const prevShotNum = currentShotNumber - 1;
  const path = join(
    projectDir,
    'prompts/images/shots',
    `scene-${sceneNum}-shot-${prevShotNum}.json`,
  );
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const last = parsed?.frames?.last_frame?.imagePrompt;
  if (typeof last === 'string' && last.trim().length > 0) return last;

  const first = parsed?.frames?.first_frame?.imagePrompt;
  if (typeof first === 'string' && first.trim().length > 0) return first;

  return null;
}

/**
 * Policy: should the executor override the LLM's chosen generationMode and
 * force `edit_previous_shot` for this shot's first frame?
 *
 * Background: in real runs the LLM frequently picks `image_text_to_image`
 * even when a prior shot exists and the user's continuity rule says we
 * should chain (we observed this on every mid-scene shot of The Village
 * after the regen). The shot_context DIRECTIVE is advisory; the LLM
 * sometimes ignores it. This helper encodes the deterministic policy so
 * the executor can stop trusting the LLM and just do the right thing
 * before calling FLUX Klein.
 *
 * Force chain when:
 *   - prior shot is available (within scene OR via cross-scene chain)
 *   - shot is NOT scene_1_shot_1 (no prior at project start)
 *   - continuityRole is NOT in {entry, exit, bridge}
 *     (those are explicit transitions — fresh framing wanted)
 *   - purpose is NOT show_clue
 *     (fresh detail insert — chaining produces face-shaped clock artifacts)
 *   - if it's shot 1 of scene N>1, the scene must declare an `entry`
 *     transition (otherwise it's a true cut, not a continuation)
 *
 * The same-setting check from the policy table is implicit: per the
 * one-setting-per-scene validator (Layer A5), a scene that respects the
 * rule has the same setting in every shot. If the breakdown violates
 * that rule we already warn upstream — chaining still works because the
 * base canvas comes from the prior frame, not from a setting refId.
 */
export interface ShouldForceEditPreviousOpts {
  itemId: string;
  previousShotAvailable: boolean;
  continuityRole?: string;
  purpose?: string;
  /** Scene-level `entry` field — populated for shot 1 of scene N>1 to signal a
   *  declared visual handoff from scene N-1's last frame. */
  sceneEntry?: string | null;
}

const FORCE_FRESH_PURPOSES = new Set(['show_clue']);
const TRANSITION_ROLES = new Set(['entry', 'exit', 'bridge']);

export function shouldForceEditPrevious(opts: ShouldForceEditPreviousOpts): boolean {
  if (!opts.previousShotAvailable) return false;

  if (opts.continuityRole && TRANSITION_ROLES.has(opts.continuityRole)) return false;

  if (opts.purpose && FORCE_FRESH_PURPOSES.has(opts.purpose)) return false;

  const m = opts.itemId.match(/^scene_(\d+)_shot_(\d+)$/);
  if (!m) return false;
  const sceneNum = parseInt(m[1]!, 10);
  const shotNum = parseInt(m[2]!, 10);

  // Scene 1 shot 1 — no prior anywhere.
  if (sceneNum === 1 && shotNum === 1) return false;

  // Mid-scene shot (shot 2+ within any scene) → always chain.
  if (shotNum > 1) return true;

  // Shot 1 of scene N>1 — chain only when scene declares an `entry` field.
  // A blank/whitespace string counts as not declared.
  const entry = (opts.sceneEntry ?? '').trim();
  return entry.length > 0;
}

/**
 * Build a shot context hint block with generation mode directives for the
 * image-anchored shot chain strategy.
 *
 * Policy (locked: no FRESH purpose carve-out — see plan
 * /Users/ganaraj/.claude/plans/i-am-not-really-virtual-wren.md, Layer B1):
 *
 * - Shot 1 of any scene → fresh (no base image to chain from).
 * - Mid-scene shot with continuityRole entry/exit/bridge → fresh (explicit
 *   location transition; force a new composition). These are rare —
 *   the one-setting-per-scene validator pushes location changes to a
 *   new scene boundary.
 * - **All other mid-scene shots → HARD directive to use edit_previous_shot.**
 *   This includes set_the_world, show_change, meet_character, set_the_mood
 *   purposes that previously reset to fresh. The user's rule: within a
 *   scene only camera angle and character-following are permitted; a
 *   fresh location image mid-scene breaks continuity.
 *   The base is the previous shot's last_frame, and character refs are
 *   layered on top by FLUX Klein.
 */
export function buildShotContextHint(
  itemId: string,
  previousShotAvailable: boolean,
  opts: {
    /** Current shot's perspective ('main_subject', 'observer', etc.) */
    currentPerspective?: string;
    /** Previous shot's perspective, if we could read it */
    previousPerspective?: string;
    /** Current shot's continuityRole ('none', 'entry', 'exit', 'bridge') */
    continuityRole?: string;
    /** Current shot's purpose (affects whether to chain or reset) */
    purpose?: string;
  } = {},
): string {
  const shotMatch = itemId.match(/shot_(\d+)/);
  const shotNum = shotMatch?.[1] ? parseInt(shotMatch[1], 10) : 1;

  const lines: string[] = [];
  lines.push(`Shot ${shotNum} of this scene.`);

  if (shotNum === 1 && !previousShotAvailable) {
    lines.push('This is the first shot in the scene. Use "image_text_to_image" or "text_to_image" — there is no previous shot to chain from.');
    lines.push('last_frame should use generationMode "edit_first_frame".');
  } else if (previousShotAvailable) {
    const isBridge =
      opts.continuityRole === 'entry' ||
      opts.continuityRole === 'exit' ||
      opts.continuityRole === 'bridge';

    if (isBridge) {
      lines.push(
        `continuityRole="${opts.continuityRole}" — location transition shot. ` +
        `Use "image_text_to_image" with fresh generation for first_frame.`,
      );
    } else {
      // HARD DIRECTIVE — enforce image-anchored shot chain for continuity + consistency.
      lines.push(`Previous shot (shot ${shotNum - 1}) is available.`);
      lines.push(
        `DIRECTIVE: For first_frame you MUST use generationMode "edit_previous_shot". ` +
        `The base image will be the previous shot's last_frame; layer character/setting ` +
        `references on top via the references array. This guarantees visual continuity ` +
        `and character consistency. DO NOT use "image_text_to_image" for this shot.`,
      );
      lines.push(
        `Include every character/setting reference that should remain on screen in the ` +
        `"references" array with format { imageNumber, type, refId }. Use "from image N" ` +
        `phrasing in the imagePrompt for every named subject.`,
      );
    }

    lines.push('last_frame should use generationMode "edit_first_frame".');
  } else {
    lines.push('last_frame should use generationMode "edit_first_frame".');
  }

  lines.push('aspectRatio: "16:9"');
  lines.push('generationStrategy: "flfv" (FML2V is disabled — never emit "fmlfv").');

  return `\n\n<shot_context>\n${lines.join('\n')}\n</shot_context>`;
}

/**
 * Build a fallback motion prompt from shot fields when no motion directive exists.
 * Combines description + cameraWork + audio/soundCue.
 */
export function buildFallbackMotionPrompt(shot: {
  description?: string;
  cameraWork?: string;
  audio?: string;
  soundCue?: string;
  firstFrame?: { description?: string };
}): string {
  const desc = shot.firstFrame?.description ?? shot.description ?? '';
  let prompt = desc;
  if (shot.cameraWork) prompt += ' ' + shot.cameraWork;
  const audioContent = shot.audio || shot.soundCue;
  if (audioContent) prompt += ' ' + audioContent;
  return prompt;
}

/**
 * Validate that no node has dependencies pointing to non-existent nodes.
 * Returns a list of orphaned references.
 */
export function validateNoDanglingDeps(
  nodes: Record<string, { id: string; dependencies: string[] }>,
): Array<{ nodeId: string; missingDep: string }> {
  const orphans: Array<{ nodeId: string; missingDep: string }> = [];
  for (const [nodeId, node] of Object.entries(nodes)) {
    for (const dep of node.dependencies) {
      if (!(dep in nodes)) {
        orphans.push({ nodeId, missingDep: dep });
      }
    }
  }
  return orphans;
}

/**
 * Pick the per-shot reference list to send to the prompt LLM.
 *
 * Why this exists: Flux Klein has 4 input slots, and "from image N" in our
 * prose maps directly onto slot N. Slot 1 is always the base canvas
 * (setting in fresh mode, prior last_frame in edit_previous_shot mode).
 * The earlier global-numbering approach produced prompts like "forest from
 * image 8" — meaningless to a 4-slot model — and let two settings compete
 * for slot 1. This helper pins the contract:
 *
 *   - At most 4 refs.
 *   - At most 1 setting; it always lands in slot 1.
 *   - mainSubject is always preserved (drops happen on lower-priority chars).
 *   - imageNumbers are renumbered 1..N for THIS shot only — not global.
 *
 * Pure: takes the global ref pool + a shot-context bag and returns the
 * shot-local list. The caller (ExecutorAgent) reads scene_video_prompt
 * to fill the bag.
 */
export interface ShotContext {
  mainSubject?: string;
  secondarySubject?: string;
  focusPrimary?: string;
  focusBackground?: string[];
  focusLurking?: string | null;
  purpose?: string;
  /** Shot's perspective (POV): 'main_subject' | 'secondary_subject' |
   *  'observer' | 'overhead' | 'god'. Used by buildShotAwareReferences
   *  to detect non-character-POV shots (god / overhead) so the
   *  mainSubject fall-back doesn't force a character into refs for
   *  atmosphere / cutaway shots that deliberately don't include one. */
  perspective?: string;
  /** Shot's `continuityRole` field: 'none' | 'entry' | 'exit' | 'bridge'. */
  continuityRole?: string;
  /** Shot's `perspectiveOf` refId — the character whose POV the shot
   *  follows when perspective is "main_subject" / "secondary_subject".
   *  Used by enforceShotCanonicalRefs to guarantee the POV character
   *  appears in the references list. */
  perspectiveOf?: string | null;
  /** Scene-level `entry` string — declared on the scene_video_prompt to
   *  signal a visual handoff from the previous scene's last frame. */
  sceneEntry?: string | null;
  /** Canonical setting refId for this scene, computed by aggregating the
   *  most-common setting across every shot's `focus.background` and
   *  `shot.setting`. Used by buildShotAwareReferences as a fallback when
   *  a specific shot's focus doesn't name a setting — for example
   *  s2shot3's focus had only `owner` (a character), and without this
   *  fallback the executor produced a slot manifest with no setting at
   *  all, forcing Flux to invent the pawn-shop interior from scratch
   *  shot to shot. Populated by readShotContextFromSvp. */
  canonicalSceneSetting?: string | null;
}

/**
 * Read a shot's context out of `prompts/videos/scenes/<sceneId>.json`.
 *
 * Both the prompt-build path (async, in ExecutorAgent.buildContextBlock)
 * and the post-LLM normalizer (sync, in ExecutorAgent.validateAndNormalize)
 * need the same shot context to produce identical shot-aware ref lists. We
 * read the JSON once here so both paths agree on which character lives in
 * which slot.
 *
 * Returns null when the file is missing or unparseable — callers fall back
 * to the global ref pool in that case.
 */
export function readShotContextFromSvp(
  projectDir: string,
  sceneId: string,
  shotNumber: number,
): ShotContext | null {
  const path = join(projectDir, 'prompts/videos/scenes', `${sceneId}.json`);
  if (!existsSync(path)) return null;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }

  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const shots = Array.isArray(parsed?.shots) ? parsed.shots : Array.isArray(parsed) ? parsed : [];
  const shot = shots.find((s: any) => s?.shotNumber === shotNumber);
  if (!shot) return null;

  // Compute the scene's canonical setting by aggregating across every
  // shot — fallback for shots whose own focus doesn't name a setting.
  const settingCounts = new Map<string, number>();
  for (const s of shots) {
    if (typeof s?.setting === 'string' && s.setting) {
      settingCounts.set(s.setting, (settingCounts.get(s.setting) ?? 0) + 1);
    }
    const bg = Array.isArray(s?.focus?.background) ? s.focus.background : [];
    for (const b of bg) {
      if (typeof b === 'string') settingCounts.set(b, (settingCounts.get(b) ?? 0) + 1);
    }
  }
  // Validate against on-disk setting files.
  const settingsDir = join(projectDir, 'settings');
  const validSettings = existsSync(settingsDir)
    ? new Set(
        readdirSync(settingsDir).filter((f: string) => f.endsWith('.md')).map((f: string) => f.replace('.md', '')),
      )
    : new Set();
  let canonicalSetting: string | null = null;
  let bestN = 0;
  for (const [refId, n] of settingCounts.entries()) {
    if (validSettings.has(refId) && n > bestN) {
      canonicalSetting = refId;
      bestN = n;
    }
  }

  const focus = shot.focus ?? {};
  return {
    mainSubject: parsed?.mainSubject ?? '',
    secondarySubject: parsed?.secondarySubject ?? '',
    focusPrimary: focus.primary ?? '',
    focusBackground: Array.isArray(focus.background) ? focus.background : [],
    focusLurking: focus.lurking ?? null,
    purpose: shot.purpose ?? '',
    perspective: shot.perspective ?? '',
    continuityRole: shot.continuityRole ?? 'none',
    perspectiveOf: typeof shot.perspectiveOf === 'string' ? shot.perspectiveOf : null,
    sceneEntry: typeof parsed?.entry === 'string' ? parsed.entry : null,
    canonicalSceneSetting: canonicalSetting,
  };
}

/**
 * Read the `firstFrameAnchor` for a specific shot out of the assembled
 * scene_video_prompt JSON. Returns null when the file is missing /
 * unparseable / the shot doesn't carry an anchor (legacy projects
 * predating the visual-continuity work).
 *
 * Used by shot_image_prompt's post-validation to enforce the anchor's
 * required generationMode on the LLM's output.
 */
export function readShotAnchorFromSvp(
  projectDir: string,
  sceneId: string,
  shotNumber: number,
): { reason: string; sourceShotNumber?: number; sourceSceneId?: string } | null {
  const path = join(projectDir, 'prompts/videos/scenes', `${sceneId}.json`);
  if (!existsSync(path)) return null;
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8').trim();
  } catch {
    return null;
  }
  if (raw.startsWith('```')) {
    raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const shots = Array.isArray(parsed?.shots) ? parsed.shots : Array.isArray(parsed) ? parsed : [];
  const shot = shots.find((s: any) => s?.shotNumber === shotNumber);
  if (!shot) return null;
  const anchor = shot.firstFrameAnchor;
  if (!anchor || typeof anchor !== 'object' || !anchor.reason) return null;
  return anchor;
}

export function buildShotAwareReferences(
  allRefs: AvailableRef[],
  shot: ShotContext,
): AvailableRef[] {
  // Purpose-based short-circuit: pure mood/sensory shots don't reference
  // anything — they're text-only. Matches filterRefsByPurpose semantics.
  if (shot.purpose === 'set_the_mood') return [];

  const byLabel = new Map<string, AvailableRef>();
  for (const r of allRefs) byLabel.set(r.label, r);

  const focusBg = shot.focusBackground ?? [];

  // 1. Pick the setting (slot 1 if any).
  let chosenSetting: AvailableRef | null = null;
  if (shot.focusPrimary) {
    const r = byLabel.get(shot.focusPrimary);
    if (r?.type === 'setting') chosenSetting = r;
  }
  if (!chosenSetting) {
    for (const name of focusBg) {
      const r = byLabel.get(name);
      if (r?.type === 'setting') {
        chosenSetting = r;
        break;
      }
    }
  }
  // Canonical-scene-setting fallback: when this shot's focus didn't name
  // a setting (e.g. focus.primary is a character and focus.background
  // contains only other characters), fall back to the scene's most-common
  // setting. Prevents shots from rendering with no setting ref at all,
  // which forces Flux to invent the location and breaks shot-to-shot
  // visual continuity. See s2shot3 in the bharata Ruby render: focus
  // had only `owner` (a character), so without this fallback the prompt
  // shipped with three character refs and no pawn-shop reference.
  if (!chosenSetting && shot.canonicalSceneSetting) {
    const r = byLabel.get(shot.canonicalSceneSetting);
    if (r?.type === 'setting') chosenSetting = r;
  }

  // Atmosphere / cutaway / insert shot guard. When the shot has NO
  // character references anywhere (focus.primary isn't a known character
  // ref, focus.background[] / focus.lurking have no character refs)
  // AND its perspective is non-character-POV (god / overhead), the
  // mainSubject fall-back below would force the scene's protagonist into
  // refs even though the shot is deliberately a non-character beat —
  // a macro close-up on a prop, a high-angle establishing shot of an
  // empty room, etc. The validator then demands the LLM mention the
  // protagonist, the LLM correctly omits it (because the shot isn't
  // about them), and we hit a stuck retry loop. Skip the fall-back
  // and return just the setting (if any) for these shots.
  const NON_CHARACTER_POV = new Set(['god', 'overhead']);
  if (NON_CHARACTER_POV.has(shot.perspective ?? '')) {
    const charRefInFocus = (name?: string | null): boolean => {
      if (!name) return false;
      const r = byLabel.get(name);
      return r != null && r.type !== 'setting';
    };
    const anyCharInShotContext =
      charRefInFocus(shot.focusPrimary) ||
      focusBg.some(charRefInFocus) ||
      charRefInFocus(shot.focusLurking ?? null);
    if (!anyCharInShotContext) {
      return chosenSetting
        ? [{ ...chosenSetting, imageNumber: 1 }]
        : [];
    }
  }

  // 2. Pick characters (and objects) in priority order — drop duplicates and
  //    settings (settings are slot 1 only). mainSubject > secondarySubject >
  //    focusPrimary (if char) > focusBackground entries (in order) >
  //    focusLurking. Stop when we hit the cap.
  const charSlots = chosenSetting ? 3 : 4;
  const picked: AvailableRef[] = [];
  const seen = new Set<string>();
  const pushIfChar = (name?: string | null) => {
    if (!name || picked.length >= charSlots) return;
    const r = byLabel.get(name);
    if (!r || r.type === 'setting') return;
    if (seen.has(r.refId)) return;
    seen.add(r.refId);
    picked.push(r);
  };

  // Shot-aware character inclusion: only include the scene's mainSubject /
  // secondarySubject in the slot picks if they're actually in THIS shot's
  // focus. A scene-level mainSubject who walks off-screen for a beat
  // shouldn't keep a permanent slot — that displaces the actual focal
  // character. See the s2shot3 bug from the bharata Ruby render: Ruby
  // (mainSubject) and Angel (secondarySubject) both got slots even though
  // only Ruby was in focus.primary and `owner` was in focus.background;
  // owner got squeezed out and the rendered shot replaced him with Angel.
  const inFocus = new Set<string>();
  if (shot.focusPrimary) inFocus.add(shot.focusPrimary);
  for (const b of focusBg) inFocus.add(b);
  if (shot.focusLurking) inFocus.add(shot.focusLurking);

  if (shot.mainSubject && inFocus.has(shot.mainSubject)) pushIfChar(shot.mainSubject);
  if (shot.secondarySubject && inFocus.has(shot.secondarySubject)) pushIfChar(shot.secondarySubject);
  pushIfChar(shot.focusPrimary);
  for (const name of focusBg) pushIfChar(name);
  pushIfChar(shot.focusLurking ?? undefined);

  // 3. Fallback when shot context yielded nothing — return the first 4 refs
  //    capped, with at most 1 setting. Preserves prior loose behaviour for
  //    cases where the scene_video_prompt couldn't be parsed.
  const hasShotContext =
    !!shot.mainSubject || !!shot.secondarySubject || !!shot.focusPrimary ||
    focusBg.length > 0 || !!shot.focusLurking;
  if (!hasShotContext) {
    const settings = allRefs.filter(r => r.type === 'setting').slice(0, 1);
    const others = allRefs.filter(r => r.type !== 'setting').slice(0, 4 - settings.length);
    return [...settings, ...others].map((r, i) => ({ ...r, imageNumber: i + 1 }));
  }

  // 4. Assemble final list and renumber locally.
  const ordered: AvailableRef[] = [];
  if (chosenSetting) ordered.push(chosenSetting);
  ordered.push(...picked);
  return ordered.slice(0, 4).map((r, i) => ({ ...r, imageNumber: i + 1 }));
}

/**
 * Filter available references based on shot purpose.
 * Returns filtered refs and the suggested generation mode.
 */
export function filterRefsByPurpose(
  allRefs: AvailableRef[],
  purpose: string,
): { refs: AvailableRef[]; generationMode: string } {
  switch (purpose) {
    case 'set_the_world':
    case 'show_passage':
      return { refs: allRefs.filter(r => r.type === 'setting'), generationMode: 'image_text_to_image' };

    case 'set_the_mood':
      return { refs: [], generationMode: 'text_to_image' };

    case 'show_clue':
      // Clue shots may still reference characters/settings (e.g., a phantom, a hand holding an object)
      return { refs: allRefs.filter(r => r.type === 'character' || r.type === 'setting'), generationMode: 'image_text_to_image' };

    case 'meet_character':
      return { refs: allRefs.filter(r => r.type !== 'object'), generationMode: 'image_text_to_image' };

    case 'show_dialogue':
    case 'show_reaction':
    case 'hold_emotion':
    case 'show_tension':
      return { refs: allRefs.filter(r => r.type === 'character' || r.type === 'setting'), generationMode: 'image_text_to_image' };

    case 'show_action':
    case 'show_change':
    case 'punctuate':
    default:
      return { refs: allRefs, generationMode: 'image_text_to_image' };
  }
}
