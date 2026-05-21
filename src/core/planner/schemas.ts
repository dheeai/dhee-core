/**
 * Zod schemas for all JSON-output node types.
 *
 * Single source of truth — used for:
 * 1. Runtime validation of LLM JSON output (replaces hardcoded if/else chains)
 * 2. Generating <json_schema> blocks injected into system prompts
 * 3. Auto-normalization (e.g., videoGenerationMode → generationStrategy)
 */

import { z } from 'zod';
import { enforceSceneBoundaryTransition } from './enforceSceneBoundaryTransition.js';

// ── Frame description (shared by firstFrame / lastFrame / midFrame) ──────────

const frameDescriptionSchema = z.object({
  description: z.string().min(1),
  characters: z.array(z.string()).optional().default([]),
  setting: z.string().nullable().optional(),
});

// ── Scene Video Prompt ───────────────────────────────────────────────────────

// Shot purpose — WHY this shot exists in the story
export const purposeValues = [
  'set_the_world', 'set_the_mood', 'meet_character', 'show_tension',
  'show_action', 'show_reaction', 'show_dialogue', 'show_clue',
  'show_passage', 'hold_emotion', 'show_change', 'punctuate',
] as const;

const purposeEnum = z.enum(purposeValues);

// Perspective — whose POV the shot is from
export const perspectiveValues = [
  'main_subject',       // POV or OTS of the scene's main subject
  'secondary_subject',  // POV or OTS of the secondary subject
  'overhead',           // high-angle, looking down
  'god',                // impossible omniscient viewpoint (extreme wide / birds_eye)
  'observer',           // neutral third-person, not tied to any character
] as const;

const perspectiveEnum = z.enum(perspectiveValues);

// Continuity role — how the shot bridges to adjacent shots for the main subject
export const continuityRoleValues = [
  'entry',   // main subject enters this shot (new location arrival)
  'exit',    // main subject leaves this shot (rising, walking to door)
  'bridge',  // travel/montage beat between locations
  'none',    // not a bridging shot
] as const;

const continuityRoleEnum = z.enum(continuityRoleValues);

// ── Bharata framework: rasa, narrative mode, abhinaya tags ───────────────────
//
// Rasa = the dominant emotional aesthetic of a scene. One of nine canonical
// rasas from Bharata's Natyashastra (~2nd cent BCE). Used to drive deterministic
// palette/lighting/pacing/lens choices downstream in image and motion prompts.
export const rasaValues = [
  'shringara',  // love, beauty, attraction
  'hasya',      // mirth, comedy
  'karuna',     // sorrow, compassion
  'raudra',     // anger, fury
  'veera',      // heroic resolve, courage
  'bhayanaka',  // fear, dread
  'bibhatsa',   // revulsion, disgust
  'adbhuta',    // wonder, awe
  'shanta',     // peace, stillness
] as const;
const rasaEnum = z.enum(rasaValues);

// Narrative mode — structural shape of the scene/project.
// Drives validator behavior (e.g. only full_arc requires all five pancha-sandhi joints).
export const narrativeModeValues = [
  'full_arc',         // 5-joint complete story, ≥90s typical
  'compressed_arc',   // 3-joint micro-story
  'vignette',         // single sustained beat, one rasa
  'mood',             // pure rasa exposition, no plot arc
] as const;
const narrativeModeEnum = z.enum(narrativeModeValues);

// Sthayi-bhava — the persistent emotional substrate beneath a rasa.
// Optional; declared on a scene and/or per-character at project level.
export const sthayiValues = [
  'rati',     // love (→ shringara)
  'hasa',     // mirth (→ hasya)
  'soka',     // grief (→ karuna)
  'krodha',   // anger (→ raudra)
  'utsaha',   // heroic resolve (→ veera)
  'bhaya',    // fear (→ bhayanaka)
  'jugupsa',  // disgust (→ bibhatsa)
  'vismaya',  // wonder (→ adbhuta)
  'sama',     // calm (→ shanta)
] as const;
const sthayiEnum = z.enum(sthayiValues);

// Sattvika — involuntary internal cue visible on the body. Curated subset
// from Bharata's 8 sattvika-bhavas. Optional per-shot tag; surfaces a
// micro-physical signal current AI video typically underspecifies.
export const sattvikaValues = [
  'vepathu',    // trembling
  'sveda',      // sweat
  'stambha',    // stillness / paralysis
  'romancha',   // gooseflesh
  'vaivarnya',  // pallor or flush
  'ashru',      // tears
] as const;
const sattvikaEnum = z.enum(sattvikaValues);

// Drishti — character gaze direction. Curated subset of Bharata's 36 drishtis.
// Optional per-shot tag; used when the face is the focal element.
export const drishtiValues = [
  'sama',       // level, direct, unblinking
  'alokita',    // sidelong glance
  'sachi',      // over-shoulder back-look
  'nimilita',   // half-closed, inward
  'unmilita',   // wide, alert
  'kuncita',    // shrinking, fearful
  'roudri',     // fierce, predatory
  'lalita',     // soft, affectionate
] as const;
const drishtiEnum = z.enum(drishtiValues);

// Vyabhichari-bhava — transient emotion that flickers against the scene's sthayi.
// Curated subset. Use only on shots where a micro-emotion shifts.
export const vyabhichariValues = [
  'smriti',     // memory flash
  'cinta',      // worry
  'sanka',      // suspicion
  'nirveda',    // despair
  'harsha',     // joy-flash
  'autsukya',   // longing
  'garva',      // pride
  'glani',      // weariness
  'lajja',      // shame
] as const;
const vyabhichariEnum = z.enum(vyabhichariValues);

// Focus — what's sharp vs blurred in the frame
const focusSchema = z.object({
  primary: z.string().min(1),                              // razor-sharp subject (refId or prose name)
  background: z.array(z.string()).optional().default([]), // visible but blurred elements
  lurking: z.string().nullable().optional(),              // planted defocused element for a later focus-pull
});

// Anchor for first-frame visual continuity. Populated DETERMINISTICALLY
// by the scene_video_prompt assembler (Stage C) — not by the LLM. Tells
// the shot_image generator which prior frame to chain on:
//
//   - `fresh`         — no chain. First shot of scene, or a deliberate
//                       hard-cut transition (fade/dip_to_black/flash/etc.)
//                       resets the visual context. Generate from setting
//                       + character refs.
//   - `continuity`    — edit the immediate prior shot's last frame
//                       (sourceShotNumber = N-1). Default for smooth
//                       within-scene flow.
//   - `view_reuse`    — return to an EARLIER shot's view (same setting +
//                       perspective + framing + characters). Re-uses
//                       that shot's last frame as the input image,
//                       avoiding fresh generation that would visibly
//                       drift from the established look.
export const firstFrameAnchorSchema = z.discriminatedUnion('reason', [
  z.object({ reason: z.literal('fresh') }),
  z.object({
    // Same chain as `reuse_prior` but the VIEW SIGNATURE differs —
    // typically because the writer cut to a new camera angle. We still
    // anchor on the prior last frame, but we EDIT it into a new image
    // (camera shift, recompose) rather than reusing it verbatim. That
    // edit is what produces the visual "almost-the-same" jump cut you
    // see at conventional shot boundaries.
    reason: z.literal('continuity'),
    sourceShotNumber: z.number(),
    // Cross-scene chain: when set, the source frame lives in
    // `shot_image_last_frame:<sourceSceneId>_shot_<sourceShotNumber>`
    // instead of the current scene's namespace. Used for "exits door
    // A in scene N → enters door B in scene N+1" — the assembler
    // picks the prior scene's last shot and stamps that id here, so
    // addShotImageNodes wires the dependency across the boundary
    // (rather than within the current scene, which would 404).
    sourceSceneId: z.string().optional(),
  }),
  z.object({
    // Legacy: "shot 5 returns to shot 2's setup". Same view signature
    // as a non-immediate prior. Today treated identically to
    // `reuse_prior` at runtime — kept in the schema only so projects
    // saved by older builds still parse.
    reason: z.literal('view_reuse'),
    sourceShotNumber: z.number(),
    sourceSceneId: z.string().optional(),
  }),
  z.object({
    // NEW canonical "same view" reason. The source shot's view
    // signature matches this shot's view signature, so the prior
    // last_frame IS this shot's first_frame — no new image needed.
    // The executor copies the file directly instead of running the
    // image-edit pipeline. Emitted whenever the anchor computer
    // finds a matching view (immediate prior OR earlier), replacing
    // both the same-view `continuity` and the `view_reuse` cases for
    // newly-computed anchors.
    reason: z.literal('reuse_prior'),
    sourceShotNumber: z.number(),
    sourceSceneId: z.string().optional(),
  }),
]);

const shotSchema = z.object({
  shotNumber: z.number(),
  purpose: purposeEnum.optional(),
  // shotType removed — cameraWork already contains framing info as natural prose
  // secondaryPurpose removed — description captures dual-intent naturally
  shotType: z.string().optional(), // legacy compat only, not used by code
  duration: z.number().optional(),
  generationStrategy: z.string().optional(),
  videoGenerationMode: z.string().optional(),
  firstFrame: frameDescriptionSchema.optional(),
  lastFrame: frameDescriptionSchema.optional(),
  // Legacy format: description at top level
  description: z.string().optional(),
  cameraWork: z.string().optional(),
  soundCue: z.string().optional(),
  audio: z.string().optional(),
  transition: z.string().optional(),
  dialogue: z.string().nullable().optional(),
  characters: z.array(z.string()).optional(),
  setting: z.string().nullable().optional(),
  // Perspective: whose POV this shot is from (required for show_action/meet_character)
  perspective: perspectiveEnum.optional(),
  // refId of whose POV/OTS — defaults to scene.mainSubject when perspective is main_subject
  perspectiveOf: z.string().nullable().optional(),
  // Focus: what's sharp vs blurred in the frame
  focus: focusSchema.optional(),
  // How this shot bridges locations for the main subject (prevents teleporting)
  continuityRole: continuityRoleEnum.optional().default('none'),
  // First-frame visual-continuity anchor — see firstFrameAnchorSchema.
  // Populated by the deterministic assembler, not the LLM. Nullable so
  // legacy/pre-anchor breakdowns still parse.
  firstFrameAnchor: firstFrameAnchorSchema.nullable().optional(),
  // Bharata optional tags — surface micro-cues for downstream image/video prompt injection.
  sattvika: sattvikaEnum.nullable().optional(),
  drishti: drishtiEnum.nullable().optional(),
  vyabhichariBhava: vyabhichariEnum.nullable().optional(),
}).refine(
  (shot) => shot.firstFrame?.description || shot.description,
  { message: 'Shot must have either firstFrame.description or description' },
).refine(
  (shot) => {
    // show_action and meet_character shots must specify perspective
    if (shot.purpose === 'show_action' || shot.purpose === 'meet_character') {
      return !!shot.perspective;
    }
    return true;
  },
  { message: 'show_action and meet_character shots must specify perspective' },
);

// Stage B output: a single fully-expanded shot. Same shape as the entries
// in sceneVideoPromptSchema.shots; exported so the executor can validate
// per-shot LLM output without going through the full scene wrapper.
export const singleShotSchema = shotSchema;

// Stage A output: the lightweight shot plan emitted by the scene_shot_plan
// LLM call. One entry per shot — pacing/structure decisions only, no prose.
// The collection-expansion step uses this to spawn one shot_breakdown node
// per planned shot.
export const shotPlanEntrySchema = z.object({
  shotNumber: z.number(),
  purpose: purposeEnum,
  duration: z.number(),
  oneLineSummary: z.string().min(1),
  perspective: perspectiveEnum.optional(),
  continuityRole: continuityRoleEnum.optional(),
  // Bharata optional tags at Stage A — propagate to assembled shot.
  sattvika: sattvikaEnum.nullable().optional(),
  drishti: drishtiEnum.nullable().optional(),
  vyabhichariBhava: vyabhichariEnum.nullable().optional(),
});

export const shotPlanSchema = z.object({
  sceneNumber: z.number(),
  sceneTitle: z.string(),
  totalDuration: z.number(),
  mainSubject: z.string(),
  secondarySubject: z.string().nullable().optional(),
  entry: z.string().optional(),
  exit: z.string().optional(),
  // Bharata scene-level classification — drives downstream prompt steering.
  rasa: rasaEnum.nullable().optional(),
  narrativeMode: narrativeModeEnum.nullable().optional(),
  sthayi: sthayiEnum.nullable().optional(),
  shotPlan: z.array(shotPlanEntrySchema).min(1, 'shotPlan must not be empty'),
});

export const sceneVideoPromptSchema = z.object({
  sceneNumber: z.number().optional(),
  sceneTitle: z.string().optional(),
  totalDuration: z.number().optional(),
  // The character whose arc this scene follows — shot perspectives are relative to this
  mainSubject: z.string().optional(),
  // Optional second pivotal character (for dialogue/reaction reversals)
  secondarySubject: z.string().nullable().optional(),
  // Scene transitions (Layer C1). Each scene declares how it visually
  // picks up from the prior scene (`entry`) and how it sets up the next
  // (`exit`). The image pipeline uses these to chain scene_N_shot_1's
  // first_frame on scene_(N-1)'s last shot's last_frame.
  entry: z.string().optional(),
  exit: z.string().optional(),
  // Bharata scene-level classification (propagated from Stage A).
  rasa: rasaEnum.nullable().optional(),
  narrativeMode: narrativeModeEnum.nullable().optional(),
  sthayi: sthayiEnum.nullable().optional(),
  shots: z.array(shotSchema).min(1, 'shots array must not be empty'),
}).refine(
  (svp) => {
    // If any shot uses main_subject perspective, scene must declare mainSubject
    const needsMain = svp.shots.some(s => s.perspective === 'main_subject');
    if (needsMain && !svp.mainSubject) return false;
    // Same for secondary_subject
    const needsSecondary = svp.shots.some(s => s.perspective === 'secondary_subject');
    if (needsSecondary && !svp.secondarySubject) return false;
    return true;
  },
  { message: 'Scene must declare mainSubject/secondarySubject when shots reference those perspectives' },
);

// ── Shot Image Prompt (single-frame) ─────────────────────────────────────────

const referenceSchema = z.object({
  imageNumber: z.number(),
  type: z.enum(['character', 'setting', 'object']),
  refId: z.string(),
});

// Bug 5: generationMode used to be `z.string()` — anything the LLM wrote
// got through, including hallucinated modes the renderer didn't handle.
// Enumerate the modes the executor actually implements:
//   - image_text_to_image: fresh render from refs (no chain base)
//   - text_to_image:        fresh render with no refs (rare)
//   - edit_previous_shot:   first_frame chained on prior shot's last_frame
//   - edit_first_frame:     last_frame chained on THIS shot's first_frame
//   - reuse_prior_frame:    first_frame is a verbatim copy of the source
//                           shot's last_frame (no Klein render). Real mode;
//                           implemented at ExecutorAgent.ts:7156-area.
// Unknown values are coerced to `image_text_to_image` (the safest default —
// fresh render with refs) by the post-validation pass; the schema itself
// stays narrow so audits can spot drift early.
const generationModeSchema = z.enum([
  'image_text_to_image',
  'text_to_image',
  'edit_previous_shot',
  'edit_first_frame',
  'reuse_prior_frame',
]);
export type GenerationMode = z.infer<typeof generationModeSchema>;

const KNOWN_MODES: ReadonlySet<string> = new Set(generationModeSchema.options);

/**
 * Normalize an LLM-emitted generationMode string. Returns a canonical
 * mode for the recognized forms (including a few common typos) or
 * `image_text_to_image` as the safe fallback for anything else —
 * fresh render with refs, no chain base.
 */
export function coerceGenerationMode(raw: unknown): GenerationMode {
  if (typeof raw !== 'string') return 'image_text_to_image';
  const s = raw.toLowerCase().trim();
  if (KNOWN_MODES.has(s)) return s as GenerationMode;
  // Common LLM slips:
  if (s === 'reuse_previous_frame' || s === 'copy_prior_frame') return 'reuse_prior_frame';
  if (s === 'edit_prior_shot' || s === 'edit_prev_shot') return 'edit_previous_shot';
  if (s === 'fresh' || s === 'text2img' || s === 'txt2img') return 'image_text_to_image';
  return 'image_text_to_image';
}

const singleFrameImagePromptSchema = z.object({
  imagePrompt: z.string().min(1),
  negativePrompt: z.string().optional().default(''),
  aspectRatio: z.string().optional().default('16:9'),
  generationMode: generationModeSchema,
  references: z.array(referenceSchema).optional().default([]),
});

// ── Shot Image Prompt (multi-frame: FLFV / FMLFV) ───────────────────────────

const framePromptSchema = z.object({
  imagePrompt: z.string().min(1),
  generationMode: generationModeSchema,
  references: z.array(referenceSchema).optional().default([]),
});

const multiFrameImagePromptSchema = z.object({
  shotNumber: z.number().optional(),
  generationStrategy: z.string().optional(),
  frames: z.object({
    first_frame: framePromptSchema,
    mid_frame: framePromptSchema.optional(),
    last_frame: framePromptSchema.optional(),
  }),
  negativePrompt: z.string().optional().default(''),
  aspectRatio: z.string().optional().default('16:9'),
});

// Combined: accepts either single-frame or multi-frame
export const shotImagePromptSchema = z.union([
  multiFrameImagePromptSchema,
  singleFrameImagePromptSchema,
]);

// ── Character / Setting Image ────────────────────────────────────────────────

export const imagePromptSchema = z.object({
  imagePrompt: z.string().min(1, 'imagePrompt is required'),
  negativePrompt: z.string().min(1, 'negativePrompt is required'),
  aspectRatio: z.string().min(1, 'aspectRatio is required'),
});

// ── Collection Extraction ────────────────────────────────────────────────────

export const collectionExtractionSchema = z.object({
  characters: z.array(z.string()).optional().default([]),
  settings: z.array(z.string()).optional().default([]),
  objects: z.array(z.string()).optional().default([]),
  scenes: z.array(z.object({
    sceneNumber: z.number(),
    title: z.string(),
    summary: z.string().optional(),
  })).optional().default([]),
});

// ── Schema registry ──────────────────────────────────────────────────────────

export const JSON_SCHEMAS: Record<string, z.ZodSchema> = {
  scene_video_prompt: sceneVideoPromptSchema,
  scene_shot_plan: shotPlanSchema,
  shot_breakdown: singleShotSchema,
  shot_image_prompt: shotImagePromptSchema,
  character_image: imagePromptSchema,
  setting_image: imagePromptSchema,
};

// ── Prompt schema text generation ────────────────────────────────────────────

/**
 * Generate a <json_schema> block for injection into LLM system prompts.
 * Derived from the Zod schemas — always in sync with validation.
 */
export function getPromptSchema(nodeTypeId: string): string | null {
  // Schemas are GENERATED from shared constants (purposeValues, shotTypeValues)
  // so they can never drift from the guide or validation logic.
  const PROMPT_SCHEMAS: Record<string, string> = {
    scene_video_prompt: `<json_schema>
{
  "sceneNumber": number,
  "sceneTitle": "string",
  "totalDuration": number,
  "mainSubject": "string (refId of the character whose arc this scene follows — e.g., 'vikram')",
  "secondarySubject": "string (optional refId of a second pivotal character — e.g., 'laila')",
  "shots": [
    {
      "shotNumber": number,
      "purpose": "${purposeValues.join(' | ')}",
      "duration": number,
      "description": "string (1-2 sentence brief of what happens in this shot)",
      "cameraWork": "string (start with framing: wide/medium/close-up/extreme close-up, then angle and movement)",
      "perspective": "${perspectiveValues.join(' | ')} (REQUIRED for show_action and meet_character; whose POV we see the shot from)",
      "perspectiveOf": "string (optional refId — who owns the POV/OTS; defaults to mainSubject for main_subject perspective)",
      "focus": {
        "primary": "string (refId or prose — what is razor-sharp in the frame)",
        "background": ["string (visible but blurred elements)"],
        "lurking": "string | null (defocused element planted for a later focus-pull — optional)"
      },
      "continuityRole": "${continuityRoleValues.join(' | ')} (entry/exit/bridge for location transitions of mainSubject; 'none' otherwise)",
      "audio": "string (dialogue prefixed with CHARACTER NAME: + ambient sounds)",
      "transition": "cut | crossfade | fade | dip_to_black | flash_to_white | circle_close | circle_open | wipe_left | wipe_right"
    }
  ]
}
</json_schema>`,
    shot_image_prompt: `<json_schema>
{
  "shotNumber": number,
  "generationStrategy": "flfv",
  "frames": {
    "first_frame": {
      "imagePrompt": "string (flowing prose, frozen instant, no motion verbs)",
      "generationMode": "image_text_to_image | edit_previous_shot | text_to_image",
      "references": [{ "imageNumber": number, "type": "character | setting | object", "refId": "string" }]
    },
    "last_frame": {
      "imagePrompt": "string (describe the END STATE — what has changed by the end of this shot, per <last_frame_changes>)",
      "generationMode": "edit_first_frame",
      "references": []
    }
  },
  "negativePrompt": "string",
  "aspectRatio": "16:9"
}
</json_schema>`,
    character_image: `<json_schema>
{
  "imagePrompt": "string (80-250 words, flowing prose, full character description)",
  "negativePrompt": "string",
  "aspectRatio": "1:1"
}
</json_schema>`,
    setting_image: `<json_schema>
{
  "imagePrompt": "string (flowing prose, full environment description with 3 spatial layers)",
  "negativePrompt": "string",
  "aspectRatio": "1:1"
}
</json_schema>`,
    scene_shot_plan: `<json_schema>
{
  "sceneNumber": number,
  "sceneTitle": "string",
  "totalDuration": number,
  "mainSubject": "string (refId of the character whose arc this scene follows — e.g., 'vikram')",
  "secondarySubject": "string | null (optional refId of a second pivotal character — e.g., 'laila'; null/omit if none)",
  "entry": "string (one-sentence description of how this scene visually picks up from the prior scene)",
  "exit": "string (one-sentence description of how this scene sets up the next scene)",
  "rasa": "${rasaValues.join(' | ')} (REQUIRED — the scene's dominant emotional aesthetic per Bharata)",
  "narrativeMode": "${narrativeModeValues.join(' | ')} (REQUIRED — the structural shape of this scene)",
  "sthayi": "${sthayiValues.join(' | ')} (optional — the protagonist's persistent emotional ground)",
  "shotPlan": [
    {
      "shotNumber": number,
      "purpose": "${purposeValues.join(' | ')}",
      "duration": number,
      "oneLineSummary": "string (one sentence: what happens in this shot)",
      "perspective": "${perspectiveValues.join(' | ')} (optional at plan stage; required for show_action / meet_character)",
      "continuityRole": "${continuityRoleValues.join(' | ')} (optional — entry/exit/bridge for location transitions of mainSubject; 'none' otherwise)",
      "sattvika": "${sattvikaValues.join(' | ')} (optional — involuntary body cue; tag 1–3 shots per scene only)",
      "drishti": "${drishtiValues.join(' | ')} (optional — gaze direction, only when face is the focal element)",
      "vyabhichariBhava": "${vyabhichariValues.join(' | ')} (optional — transient emotion flicker; use sparingly)"
    }
  ]
}
</json_schema>`,
    shot_breakdown: `<json_schema>
{
  "shotNumber": number,
  "purpose": "${purposeValues.join(' | ')}",
  "duration": number,
  "description": "string (1-2 sentence brief of what happens in this shot — expand the plan's oneLineSummary)",
  "cameraWork": "string (start with framing: wide/medium/close-up/extreme close-up, then angle and movement)",
  "perspective": "${perspectiveValues.join(' | ')} (REQUIRED for show_action and meet_character; whose POV we see the shot from)",
  "perspectiveOf": "string (optional refId — who owns the POV/OTS; defaults to mainSubject for main_subject perspective)",
  "focus": {
    "primary": "string (refId or prose — what is razor-sharp in the frame)",
    "background": ["string (visible but blurred elements)"],
    "lurking": "string | null (defocused element planted for a later focus-pull — optional)"
  },
  "continuityRole": "${continuityRoleValues.join(' | ')} (entry/exit/bridge for location transitions of mainSubject; 'none' otherwise)",
  "audio": "string (dialogue prefixed with CHARACTER NAME: + ambient sounds)",
  "transition": "cut | crossfade | fade | dip_to_black | flash_to_white | circle_close | circle_open | wipe_left | wipe_right",
  "sattvika": "${sattvikaValues.join(' | ')} (optional — preserve from Stage A plan if set; you may add when prose obviously contains the cue)",
  "drishti": "${drishtiValues.join(' | ')} (optional — preserve from Stage A plan if set; only when face is focal)",
  "vyabhichariBhava": "${vyabhichariValues.join(' | ')} (optional — preserve from Stage A plan if set; transient micro-emotion only)"
}
</json_schema>`,
  };

  return PROMPT_SCHEMAS[nodeTypeId] ?? null;
}

// ── Token budget for JSON-output nodes ───────────────────────────────────────

/**
 * maxTokens budget for JSON-output LLM calls.
 *
 * Legacy: scene_video_prompt with 5–7 shots regularly exceeded 5000 tokens,
 * producing mid-stream truncation and "Unexpected end of JSON input" parse
 * errors. Bumped to 12000 specifically for that node type. (To be removed
 * once the hierarchical path is the only path — scene_video_prompt becomes
 * a deterministic assembler with no LLM call.)
 *
 * New (hierarchical):
 *  - scene_shot_plan (Stage A): emits the FULL plan for one scene
 *    (N shots × one-line summaries + scene-level entry/exit/main+secondary
 *    subject metadata). Output is small by content, but reasoning models
 *    (DeepSeek-R / o-series / Gemini-thinking / Claude with extended
 *    thinking) emit chain-of-thought tokens INTO this budget before
 *    the JSON arrives. Reasoning can easily be 3-5k tokens. The
 *    original 3000 cap was eaten by reasoning, output got truncated
 *    mid-stream, and json_repair turned the partial bytes into a
 *    "Default scene / Default shot." stub (see validationErrorClass.ts
 *    for the retry-class re-routing that prevents repair from getting
 *    truncated input now). 50000 is effectively no-cap: max_tokens is
 *    a CEILING, not a target — providers don't charge for unused
 *    headroom and the LLM stops when done. Sized to absorb any
 *    realistic reasoning trace + JSON for the longest-permitted scene.
 *  - shot_breakdown (Stage B): one shot at a time. Same reasoning-budget
 *    concern applies — bumped to 50000 for symmetry.
 *
 * Other JSON nodes (shot_image_prompt, character_image, setting_image) are
 * single-frame or tightly bounded and stay at 5000.
 */
export function maxTokensForJsonNode(nodeTypeId: string): number {
  if (nodeTypeId === 'scene_video_prompt') return 12000;
  if (nodeTypeId === 'scene_shot_plan') return 50000;
  if (nodeTypeId === 'shot_breakdown') return 50000;
  return 5000;
}

// ── Validation helper ────────────────────────────────────────────────────────

/**
 * Validate parsed JSON against the schema for a given node type.
 * Returns { valid: true, data } on success, { valid: false, error } on failure.
 */
export function validateWithSchema(
  nodeTypeId: string,
  parsed: unknown,
): { valid: true; data: unknown } | { valid: false; error: string } {
  const schema = JSON_SCHEMAS[nodeTypeId];
  if (!schema) {
    // No schema defined — accept anything
    return { valid: true, data: parsed };
  }

  const result = schema.safeParse(parsed);
  if (result.success) {
    return { valid: true, data: result.data };
  }

  // Format Zod errors into a readable string
  const errors = result.error.issues.map(issue => {
    const path = issue.path.join('.');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  return { valid: false, error: errors.join('; ') };
}

/**
 * Auto-normalize scene_video_prompt data after validation.
 * Copies videoGenerationMode → generationStrategy for backward compat.
 */
export function normalizeSceneVideoPrompt(parsed: z.infer<typeof sceneVideoPromptSchema>): void {
  for (const shot of parsed.shots) {
    // Normalize: copy videoGenerationMode → generationStrategy for backward compat
    if (shot.videoGenerationMode && !shot.generationStrategy) {
      shot.generationStrategy = shot.videoGenerationMode;
    }
    // Note: generationStrategy is now determined by shot_image_prompt, not scene_video_prompt.
    // Don't default to flfv here — let the downstream reader check shot_image_prompt output.
  }
  // Deterministic scene-boundary fix: when the LLM marks a shot with
  // continuityRole='entry' (the canonical signal for "this shot crosses
  // a meaningful visual boundary") but defaults its transition to
  // `cut`, force the transition to `fade`. See
  // enforceSceneBoundaryTransition.ts header for the Soft Seinen
  // 2026-05-19 case and downstream rationale (shotAnchorComputer would
  // otherwise chain frames across a hard setting change).
  enforceSceneBoundaryTransition(parsed.shots as Parameters<typeof enforceSceneBoundaryTransition>[0]);
}

/**
 * Auto-normalize shot_image_prompt data after validation.
 *
 * For edit_first_frame / edit_previous_shot frames, MERGE first_frame's
 * references into the frame's references so that:
 *   - Empty references → inherit all of first_frame's refs
 *   - Non-empty references (e.g., last_frame introducing a NEW character)
 *     → keep the explicit refs AND add first_frame's refs that aren't
 *       already present (preserves continuity of existing subjects).
 *
 * Dedup is by `refId`. Order: last_frame's explicit refs first (preserving
 * their imageNumber for prose correspondence), then inherited refs after.
 */
export function normalizeShotImagePrompt(parsed: unknown): void {
  if (!parsed || typeof parsed !== 'object') return;
  const p = parsed as { frames?: Record<string, { generationMode?: string; references?: unknown[] }> };
  if (!p.frames || typeof p.frames !== 'object') return;

  const firstFrame = p.frames['first_frame'];
  const firstRefs = (Array.isArray(firstFrame?.references) ? firstFrame.references : []) as Array<{ refId?: string }>;
  if (firstRefs.length === 0) return; // nothing to inherit

  for (const [frameId, frame] of Object.entries(p.frames)) {
    if (frameId === 'first_frame' || !frame) continue;
    const mode = frame.generationMode;
    if (mode !== 'edit_first_frame' && mode !== 'edit_previous_shot') continue;

    const currentRefs = (Array.isArray(frame.references) ? frame.references : []) as Array<{ refId?: string }>;
    if (currentRefs.length === 0) {
      // Fully inherit
      frame.references = [...firstRefs];
      continue;
    }

    // Merge: keep explicit refs first, then append first_frame refs missing by refId
    const existingIds = new Set(
      currentRefs.map(r => r?.refId).filter((id): id is string => typeof id === 'string'),
    );
    const toAdd = firstRefs.filter(r => r?.refId && !existingIds.has(r.refId));
    if (toAdd.length > 0) {
      frame.references = [...currentRefs, ...toAdd];
    }
  }
}
