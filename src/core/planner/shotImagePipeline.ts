/**
 * 3-call pipeline for shot_image_prompt generation.
 *
 * Splits the monolithic single-call approach into:
 *   Call 1: Mode decision (classification) → { mode, refs }
 *   Call 2: First frame prompt (creative) → imagePrompt string
 *   Call 3: Last frame prompt (creative) → imagePrompt string
 *   Assembly: deterministic JSON construction
 *
 * Each call uses a focused guide loaded via resolveGuide() — independently
 * optimizable via autoresearch.
 */

import { filterRefsByPurpose } from './shotReferenceMapping.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Layer B1 (locked): no FRESH purposes carve-out. Every mid-scene shot
 * chains on the prior last_frame. Only scene-boundary shots are fresh.
 * Kept as an empty set for backward compat with the canForceEditPrevious
 * check below — every mid-scene shot now passes the gate.
 */
const FRESH_PURPOSES = new Set<string>();

// ── Types ────────────────────────────────────────────────────────────────────

export interface Reference {
  imageNumber: number;
  type: 'character' | 'setting' | 'object';
  refId: string;
  /**
   * Over-the-shoulder framing marker (Phase A). When present:
   *   A = in-frame subject (face visible, the one being looked at)
   *   B = OTS silhouette (back of head / shoulder in foreground)
   * Omitted for non-OTS shots. Set by the turn-2 ref-extraction LLM
   * pass after it has seen the prose's framing, NOT by the upstream
   * scene_video_prompt that authored the shot brief.
   */
  side?: 'A' | 'B';
  /**
   * Lazy-creation marker (Phase B). 'existing' means the refId matches
   * a `character_image` / `setting_image` node already in the project;
   * 'new' means the LLM is requesting the executor expand the
   * corresponding collection to create this ref before the shot proceeds.
   * Omitted (treated as 'existing') in legacy single-pass output.
   */
  status?: 'existing' | 'new';
  /**
   * Phase B. Required when status === 'new'. A 1-2 sentence visual
   * description suitable for downstream image generation (clothing,
   * build, hair, distinguishing marks for characters; lighting, time
   * of day, key elements for settings).
   */
  newRefDescription?: string;
}

export interface AvailableRef extends Reference {
  label: string;
}

// ── Turn-2 reference extraction (multi-turn pipeline) ───────────────────────

/**
 * Menu item for turn 2's user message. The LLM picks refIds from this
 * menu (status='existing') or proposes new ones (status='new'). Built
 * from the project's current `character_image` and `setting_image`
 * nodes via `buildReferenceMenu`.
 */
export interface ReferenceMenuItem {
  refId: string;
  type: 'character' | 'setting' | 'object';
  label: string;
  description: string;
}

/**
 * Format a list of existing project refs as a menu for the turn-2
 * ref-extraction LLM call.
 *
 * Source: project.json's executorState. Look for `character_image:*`,
 * `setting_image:*`, `object_image:*` nodes with status === 'completed'
 * (lazy uncompleted nodes don't count — they'd be circular).
 *
 * `descFor` is injected because the description for a character lives
 * on its `character:*` collection item, not the `character_image` node
 * itself. Caller passes a resolver from the project's character/setting
 * collections.
 */
export function buildReferenceMenu(
  imageNodes: Array<{ id: string; typeId: string; itemId?: string; status?: string }>,
  descFor: (typeId: 'character' | 'setting' | 'object', itemId: string) => { label: string; description: string },
): ReferenceMenuItem[] {
  const menu: ReferenceMenuItem[] = [];
  for (const n of imageNodes) {
    if (!n.itemId) continue;
    if (n.status && n.status !== 'completed') continue;
    let type: 'character' | 'setting' | 'object';
    if (n.typeId === 'character_image') type = 'character';
    else if (n.typeId === 'setting_image') type = 'setting';
    else if (n.typeId === 'object_image') type = 'object';
    else continue;
    const meta = descFor(type, n.itemId);
    menu.push({
      refId: n.id, // canonical: `character_image:ruby`
      type,
      label: meta.label,
      description: meta.description,
    });
  }
  return menu;
}

/**
 * Build the turn-2 user message. The LLM has the shot brief + prose in
 * its context already (from turn 1's user message + assistant response).
 * This message hands it the existing ref menu and asks for a structured
 * references[] back.
 */
export function buildTurn2UserMessage(
  menu: ReferenceMenuItem[],
  options?: { otsHint?: boolean },
): string {
  const menuJson = JSON.stringify(menu, null, 2);
  const otsNote = options?.otsHint
    ? `\n\nThis shot's brief suggests over-the-shoulder / dialogue framing — mark the in-frame subject as side='A' and the OTS silhouette as side='B' in your output.`
    : '';
  return [
    `Now extract the reference image list this shot needs to render.`,
    ``,
    `**Read your own prose from the previous turn carefully.** For every`,
    `character, setting, or object named in the prose, output one`,
    `references[] entry. Prefer existing refs from the menu below;`,
    `propose a new one only if no menu entry matches.`,
    ``,
    `**Existing reference menu:**`,
    `\`\`\`json`,
    menuJson,
    `\`\`\``,
    `${otsNote}`,
    ``,
    `Output JSON only, wrapped in \`{ "references": [...] }\`. Each entry:`,
    `  - \`refId\`: snake-case canonical key (e.g. \`character_image:ruby\`)`,
    `  - \`type\`: 'character' | 'setting' | 'object'`,
    `  - \`imageNumber\`: 1 for setting/canvas, 2..4 for characters/objects in prominence order`,
    `  - \`status\`: 'existing' (refId from menu) or 'new' (propose to create)`,
    `  - \`side\`: 'A' or 'B' for OTS framing (omit otherwise)`,
    `  - \`newRefDescription\`: required when status='new', 1-2 sentence visual description`,
    ``,
    `Hard rules: ≤ 4 total refs; exactly one setting at imageNumber 1; no duplicate refIds; no duplicate imageNumbers.`,
  ].join('\n');
}

/**
 * Parse turn 2's LLM output into a Reference[]. Forgiving: accepts
 * either `{ "references": [...] }` or a bare array. Falls back to []
 * on parse failure (caller treats this as "no refs — keep whatever
 * turn 1 emitted").
 */
export function parseTurn2RefsJson(rawText: string): Reference[] {
  try {
    // Strip markdown fences in case the LLM wrapped despite instructions.
    const cleaned = rawText.trim().replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned) as unknown;
    const arr = Array.isArray(parsed)
      ? parsed
      : (parsed as { references?: unknown[] })?.references;
    if (!Array.isArray(arr)) return [];
    const out: Reference[] = [];
    const seenSlot = new Set<number>();
    const seenRef = new Set<string>();
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const r = item as Record<string, unknown>;
      const refId = typeof r['refId'] === 'string' ? r['refId'] : null;
      const type = r['type'];
      const imageNumber = typeof r['imageNumber'] === 'number' ? r['imageNumber'] : null;
      if (!refId || !imageNumber) continue;
      if (type !== 'character' && type !== 'setting' && type !== 'object') continue;
      if (seenSlot.has(imageNumber) || seenRef.has(refId)) continue;
      seenSlot.add(imageNumber);
      seenRef.add(refId);
      const ref: Reference = { refId, type, imageNumber };
      if (r['side'] === 'A' || r['side'] === 'B') ref.side = r['side'];
      if (r['status'] === 'existing' || r['status'] === 'new') ref.status = r['status'];
      if (typeof r['newRefDescription'] === 'string') ref.newRefDescription = r['newRefDescription'];
      out.push(ref);
    }
    return out;
  } catch {
    return [];
  }
}

export interface ModeDecision {
  mode: 'image_text_to_image' | 'edit_previous_shot' | 'text_to_image';
  references: Reference[];
}

export interface AssembleInput {
  shotNumber: number;
  generationStrategy: string;
  firstFrameMode: string;
  firstFramePrompt: string;
  firstFrameRefs: Reference[];
  lastFramePrompt: string;
  negativePrompt: string;
}

export interface ShotImagePromptJson {
  shotNumber: number;
  generationStrategy: string;
  frames: {
    first_frame: {
      imagePrompt: string;
      generationMode: string;
      references: Reference[];
    };
    mid_frame?: {
      imagePrompt: string;
      generationMode: string;
      references: Reference[];
    };
    last_frame?: {
      imagePrompt: string;
      generationMode: string;
      references: Reference[];
    };
  };
  negativePrompt: string;
  aspectRatio: string;
}

// ── Assembly (deterministic, no LLM) ─────────────────────────────────────────

/**
 * Build the deterministic slot manifest line that gets prepended to the
 * imagePrompt. Format: `<Label1> from image 1. <Label2> from image 2. ...`
 *
 * `references` is the authoritative slot list — the LLM-emitted prose's
 * "from image N" markers will be stripped and replaced by this manifest.
 * Setting refs get a "(setting)" suffix on their label so the LLM-rendered
 * image generator knows slot 1 is the base canvas.
 */
export function buildSlotManifestLine(references: Reference[]): string {
  if (!references || references.length === 0) return '';
  const labelFor = (r: Reference) => {
    const after = r.refId.includes(':') ? r.refId.split(':')[1] : r.refId;
    const rawName = after ?? r.refId;
    const name = rawName
      .split('_')
      .map(p => p.charAt(0).toUpperCase() + p.slice(1))
      .join(' ');
    return r.type === 'setting' ? `${name} (setting)` : name;
  };
  const sorted = [...references].sort((a, b) => a.imageNumber - b.imageNumber);
  return sorted.map(r => `${labelFor(r)} from image ${r.imageNumber}.`).join(' ');
}

/**
 * Strip every inline `from image N` token from LLM-generated prose. The
 * deterministic slot manifest at the top of the prompt is the single source
 * of truth for slot binding; inline markers from the LLM are noise that
 * sometimes mis-numbers refs or refers to slots that don't exist.
 *
 * Conservative pattern: matches ` from image <digits>` exactly. Leaves
 * unrelated "image" mentions (e.g. "she stares at the image of her
 * mother") untouched.
 */
export function stripInlineFromImageTokens(prose: string): string {
  return prose.replace(/\s+from image \d+/gi, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Enforce the frozen-instant rule deterministically.
 *
 * The SCALIST shot_first_frame_guide and shot_last_frame_guide BAN a set
 * of motion verbs (running, falling, crumbling, flickering, streaming,
 * slipping, walking, "beginning to", "starting to", etc.) because they
 * imply motion and break the single-frame assumption. DeepSeek follows
 * most of the rule but consistently slips on a handful of cases —
 * "flickering candle," "crumbling wall," "falling rain" — where the
 * verb describes an inherently dynamic-looking *static* state.
 *
 * Rather than re-roll the LLM, normalize deterministically: replace each
 * banned -ing form with a frozen-pose equivalent. The replacements are
 * imperfect English in a few cases, but Flux ignores grammar and renders
 * what's described — and the audit's banned-words check passes.
 *
 * Patterns are word-boundary case-insensitive. Phrases like "beginning
 * to" and "starting to" are stripped entirely (they don't have a useful
 * frozen form). The remaining -ing → frozen form mapping uses past
 * participle / "mid-" prefixes where possible.
 */
const FROZEN_INSTANT_REPLACEMENTS: Array<[RegExp, string]> = [
  // Phrasal verbs first — strip entire phrase.
  [/\bbeginning to\s+/gi, ''],
  [/\bstarting to\s+/gi, ''],
  // Single banned -ing words → frozen forms.
  [/\bflickering\b/gi, 'flame-lit'],
  [/\bcrumbling\b/gi, 'crumbled'],
  [/\bfalling\b/gi, 'mid-fall'],
  [/\bstreaming\b/gi, 'streamed'],
  [/\bslipping\b/gi, 'mid-slip'],
  [/\bwalking\b/gi, 'mid-stride'],
  [/\brunning\b/gi, 'mid-stride'],
  [/\bsprinting\b/gi, 'mid-stride'],
  [/\bdashing\b/gi, 'mid-dash'],
  [/\bsmoldering\b/gi, 'smoke-stained'],
  [/\bdrifting\b/gi, 'suspended'],
  [/\bfloating\b/gi, 'suspended'],
  [/\bsliding\b/gi, 'mid-slide'],
  [/\bswinging\b/gi, 'mid-swing'],
  [/\blunging\b/gi, 'mid-lunge'],
  [/\bleaping\b/gi, 'mid-leap'],
  [/\bcharging\b/gi, 'mid-charge'],
  [/\bdodging\b/gi, 'angled aside'],
  [/\bstumbling\b/gi, 'mid-stumble'],
  [/\bscrambling\b/gi, 'mid-scramble'],
  [/\berupting\b/gi, 'risen'],
  [/\bexploding\b/gi, 'shattered'],
  [/\bdissolving\b/gi, 'partially dissolved'],
  [/\btransforming\b/gi, 'mid-transformation'],
  [/\bcollapsing\b/gi, 'partially collapsed'],
  [/\brecoiling\b/gi, 'recoiled'],
  [/\bfleeing\b/gi, 'mid-flight'],
  [/\bcrashing\b/gi, 'crashed'],
  [/\bapproaching\b/gi, 'closer'],
  [/\badvancing\b/gi, 'forward'],
  [/\breceding\b/gi, 'distant'],
  [/\bspinning\b/gi, 'mid-spin'],
  [/\bspewing\b/gi, 'mid-spew'],
];

function enforceFrozenInstant(prose: string): string {
  let out = prose;
  for (const [pattern, replacement] of FROZEN_INSTANT_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  // Collapse any double-spaces left by phrasal-verb stripping.
  return out.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Assemble the final shot_image_prompt JSON from pipeline call outputs.
 * Always produces valid JSON matching the shotImagePromptSchema.
 *
 * Phase 2 of the deterministic slot manifest (see task #11): the manifest
 * line built from `input.firstFrameRefs` is prepended to BOTH
 * `firstFramePrompt` and `lastFramePrompt`, and inline `from image N`
 * tokens are stripped from LLM-emitted prose. This makes slot binding
 * authoritative at the executor — the LLM is no longer responsible for
 * mentioning every slot or numbering them correctly. Closes the
 * silent-setting-omission class of bug observed on s2shot2.
 */
export function assembleShotImagePrompt(input: AssembleInput): ShotImagePromptJson {
  // FML2V is disabled — coerce any lingering fmlfv requests to flfv so the
  // downstream provider picks FL2V (2-frame interpolation).
  const strategy = input.generationStrategy === 'fmlfv' ? 'flfv' : input.generationStrategy;

  const manifestLine = buildSlotManifestLine(input.firstFrameRefs);
  // Two deterministic post-LLM passes:
  //   1. Strip inline "from image N" — slot binding is the manifest's job.
  //   2. Enforce frozen-instant — replace banned motion verbs the LLM
  //      slipped past the guide's ban list with frozen-pose equivalents.
  // The order matters slightly: strip refs first (smaller change), then
  // normalize verbs. Both are idempotent.
  const firstFrameProse = enforceFrozenInstant(stripInlineFromImageTokens(input.firstFramePrompt));
  const lastFrameProse = enforceFrozenInstant(stripInlineFromImageTokens(input.lastFramePrompt));
  const composed = (line: string, prose: string) => (line ? `${line}\n\n${prose}` : prose);

  return {
    shotNumber: input.shotNumber,
    generationStrategy: strategy,
    frames: {
      first_frame: {
        imagePrompt: composed(manifestLine, firstFrameProse),
        generationMode: input.firstFrameMode,
        references: input.firstFrameRefs,
      },
      last_frame: {
        imagePrompt: composed(manifestLine, lastFrameProse),
        generationMode: 'edit_first_frame',
        references: [],
      },
    },
    negativePrompt: input.negativePrompt,
    aspectRatio: '16:9',
  };
}

// ── Negative Prompt (template-based, no LLM) ────────────────────────────────

const BASE_NEGATIVES = 'blurry, low quality, deformed, extra limbs, mutated, text, watermark, signature, cartoon, anime, illustration, painting, 3D render';

/**
 * Build a negative prompt from templates. No LLM needed — negatives are formulaic.
 */
export function buildNegativePrompt(_mode: string): string {
  return BASE_NEGATIVES;
}

// ── Mode Decision Parser (with fallback) ─────────────────────────────────────

const VALID_MODES = new Set(['image_text_to_image', 'edit_previous_shot', 'text_to_image']);

/**
 * Parse the mode decision JSON from call 1.
 * Falls back to image_text_to_image with all available refs if parsing fails.
 */
export function parseModeDecision(
  rawResponse: string,
  availableRefs: AvailableRef[],
): ModeDecision {
  const fallback: ModeDecision = {
    mode: 'image_text_to_image',
    references: availableRefs.map(r => ({ imageNumber: r.imageNumber, type: r.type, refId: r.refId })),
  };

  try {
    let cleaned = rawResponse.trim();
    // Strip markdown code fences
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    const parsed = JSON.parse(cleaned);

    if (!parsed.mode || !VALID_MODES.has(parsed.mode)) {
      return fallback;
    }

    // Extract references for new characters (only for edit_previous_shot)
    const references: Reference[] = [];
    if (parsed.mode === 'edit_previous_shot' && Array.isArray(parsed.newCharacterRefs)) {
      for (const ref of parsed.newCharacterRefs) {
        if (ref.refId && ref.imageNumber != null && ref.type) {
          references.push({
            imageNumber: ref.imageNumber,
            type: ref.type,
            refId: ref.refId,
          });
        }
      }
    } else if (parsed.mode === 'image_text_to_image') {
      // For fresh generation, use all available refs (or the LLM's selection if provided)
      if (Array.isArray(parsed.newCharacterRefs) && parsed.newCharacterRefs.length > 0) {
        for (const ref of parsed.newCharacterRefs) {
          if (ref.refId && ref.imageNumber != null && ref.type) {
            references.push({ imageNumber: ref.imageNumber, type: ref.type, refId: ref.refId });
          }
        }
      } else {
        // Fallback: include all available refs for fresh generation
        return {
          mode: 'image_text_to_image',
          references: availableRefs.map(r => ({ imageNumber: r.imageNumber, type: r.type, refId: r.refId })),
        };
      }
    }
    // text_to_image: no references needed

    return { mode: parsed.mode, references };
  } catch {
    return fallback;
  }
}

// ── Prompt Builders ──────────────────────────────────────────────────────────

function loadGuide(guideName: string): string {
  // Read directly from defaults — works in both CJS and ESM contexts
  const path = join(process.cwd(), 'prompts', 'skills', 'defaults', `${guideName}.md`);
  if (existsSync(path)) return readFileSync(path, 'utf-8');
  return '';
}

export interface ModeDecisionInput {
  shotDescription: string;
  shotNumber: number;
  availableRefs: AvailableRef[];
  previousShotAvailable: boolean;
  previousShotCharacters: string[];
}

/**
 * Build system + user prompts for Call 1: Mode Decision.
 */
export function buildModeDecisionPrompt(input: ModeDecisionInput): { system: string; user: string } {
  const guide = loadGuide('shot_mode_decision_guide');
  const system = `You decide the generation mode for a shot's first frame. Output ONLY a JSON object.\n\n${guide}`;

  const refList = input.availableRefs
    .map(r => `- image ${r.imageNumber}: ${r.type} "${r.label}" (ref_id: "${r.refId}")`)
    .join('\n');

  const prevInfo = input.previousShotAvailable
    ? `Previous shot (shot ${input.shotNumber - 1}) exists. Characters in previous shot: ${input.previousShotCharacters.join(', ') || 'none'}.`
    : 'No previous shot (this is shot 1 of the scene).';

  const user = `Shot ${input.shotNumber} of this scene.

${prevInfo}

Available references:
${refList || 'No references available.'}

Shot description: ${input.shotDescription}

Decide the generation mode and which references to include. Output JSON.`;

  return { system, user };
}

export interface FirstFrameInput {
  shotDescription: string;
  cameraWork: string;
  mode: string;
  references: Reference[];
  sceneStateContext: string;
  worldStyle?: string;
}

/**
 * Build system + user prompts for Call 2: First Frame Prompt.
 *
 * Loads the single merged `shot_image_prompt_guide.md` which contains
 * SCALIST common rules + per-mode output sections (image_text_to_image,
 * edit_previous_shot, text_to_image) + the last-frame section. The
 * user message tells the LLM the mode + frame target so it follows
 * the matching section. Replaces the prior 4-file split (one default
 * with `{{MODE_INSTRUCTIONS}}` substitution + three mode-specific
 * files) which had drifted into contradiction over time.
 */
export function buildFirstFramePrompt(input: FirstFrameInput): { system: string; user: string } {
  const guide = loadGuide('shot_image_prompt_guide');
  const system = `You write a single image prompt paragraph. Output ONLY the paragraph — no JSON, no labels.\n\n${guide}\n\n---\n\nThis call is for the FIRST FRAME in mode "${input.mode}". Follow the matching first-frame section above.`;

  const refList = input.references.length > 0
    ? `References available:\n${input.references.map(r => `- image ${r.imageNumber}: ${r.type} (ref_id: "${r.refId}")`).join('\n')}`
    : 'No references — describe everything from text only.';

  let user = `Shot description: ${input.shotDescription}
Camera: ${input.cameraWork}
Mode: ${input.mode}

${refList}`;

  if (input.worldStyle) {
    user += `\n\n<world_style>\n${input.worldStyle}\n</world_style>`;
  }

  if (input.sceneStateContext) {
    user += `\n\n${input.sceneStateContext}`;
  }

  user += `\n\nWrite the image prompt paragraph. Output ONLY the paragraph.`;

  return { system, user };
}

export interface LastFrameInput {
  firstFramePrompt: string;
  lastFrameChanges: string;
  shotDescription: string;
}

/**
 * Build system + user prompts for Call 3: Last Frame Prompt.
 *
 * Loads the same merged `shot_image_prompt_guide.md` as the first
 * frame call; the user message tells the LLM this is the last-frame
 * call so it follows the "Last frame — END STATE delta" section.
 */
export function buildLastFramePrompt(input: LastFrameInput): { system: string; user: string } {
  const guide = loadGuide('shot_image_prompt_guide');
  const system = `You write a last frame description showing the END STATE of a shot. Output ONLY the paragraph — no JSON, no labels.\n\n${guide}\n\n---\n\nThis call is for the LAST FRAME. Follow the "Last frame — END STATE delta" section above.`;

  let user = `First frame prompt:
${input.firstFramePrompt}

Shot description: ${input.shotDescription}`;

  if (input.lastFrameChanges) {
    user += `\n\n<last_frame_changes>\n${input.lastFrameChanges}\n</last_frame_changes>`;
  }

  user += `\n\nDescribe the END STATE — what changed after 3-5 seconds. Output ONLY the paragraph.`;

  return { system, user };
}

// ── Pipeline Context ─────────────────────────────────────────────────────────

export interface PipelineContext {
  shotNumber: number;
  shotDescription: string;
  shotCameraWork: string;
  shotPurpose: string;
  itemId: string;
  availableRefs: AvailableRef[];
  previousShotAvailable: boolean;
  previousShotCharacters: string[];
  sceneStateContext: string;
  lastFrameChanges: string;
  generationStrategy: string;
  worldStyle?: string;
}

interface LLMClient {
  generateStream: (opts: any) => AsyncGenerator<{ content?: string; thinking?: string; done?: boolean }, any, any>;
}

// ── Pipeline Orchestrator ────────────────────────────────────────────────────

/**
 * Orchestrate the 3-call pipeline for shot_image_prompt generation.
 * Returns the assembled JSON string ready to write to disk.
 */
export async function generateShotImagePromptPipeline(
  llm: LLMClient,
  ctx: PipelineContext,
  emit?: (event: any) => void,
  agentName?: string,
): Promise<string> {
  const agent = agentName ?? 'dhee-executor';

  // Deterministic mode override for the image-anchored shot chain.
  // A mid-scene shot whose purpose doesn't force a fresh reset AND has a
  // predecessor available → always chain via edit_previous_shot. This skips
  // the Call 1 mode-decision LLM entirely and guarantees visual continuity.
  const canForceEditPrevious =
    ctx.shotNumber > 1 &&
    !FRESH_PURPOSES.has(ctx.shotPurpose) &&
    ctx.previousShotAvailable;

  let modeDecision: ModeDecision;

  if (canForceEditPrevious) {
    // Pick refs by shot purpose (characters + setting for most narrative
    // purposes). FLUX Klein will layer these on top of the previous shot's
    // last_frame via editImageLayered.
    const { refs: purposeRefs } = filterRefsByPurpose(ctx.availableRefs, ctx.shotPurpose);
    // Fall back to all available refs when the purpose filter returns nothing
    // (e.g., unknown purpose strings) — FLUX Klein benefits from any anchor.
    const pickedRefs = purposeRefs.length > 0 ? purposeRefs : ctx.availableRefs;
    modeDecision = {
      mode: 'edit_previous_shot',
      references: pickedRefs.map(r => ({
        imageNumber: r.imageNumber,
        type: r.type,
        refId: r.refId,
      })),
    };
    const callId1 = `pipeline_mode_${ctx.itemId}_${Date.now()}`;
    emit?.({
      type: 'tool_call',
      toolCallId: callId1,
      toolName: 'shot_mode_decision',
      arguments: { shot: ctx.itemId, override: 'image_anchored_chain' },
      agentName: agent,
    });
    emit?.({
      type: 'tool_result',
      toolCallId: callId1,
      toolName: 'shot_mode_decision',
      result: { ...modeDecision, overridden: true, reason: 'image-anchored chain: mid-scene shot with prior last_frame' },
      agentName: agent,
    });
  } else {
    // ── Call 1: Mode Decision (LLM) ──
    const modePrompt = buildModeDecisionPrompt({
      shotDescription: ctx.shotDescription,
      shotNumber: ctx.shotNumber,
      availableRefs: ctx.availableRefs,
      previousShotAvailable: ctx.previousShotAvailable,
      previousShotCharacters: ctx.previousShotCharacters,
    });

    const callId1 = `pipeline_mode_${ctx.itemId}_${Date.now()}`;
    emit?.({ type: 'tool_call', toolCallId: callId1, toolName: 'shot_mode_decision', arguments: { shot: ctx.itemId }, agentName: agent });
    const modeRaw = await callLLM(llm, modePrompt.system, modePrompt.user, 0.1, true);
    modeDecision = parseModeDecision(modeRaw, ctx.availableRefs);
    emit?.({ type: 'tool_streaming', toolCallId: callId1, chunk: `Mode: ${modeDecision.mode}, refs: ${modeDecision.references.length}`, done: true, agentName: agent, toolName: 'shot_mode_decision' });
    emit?.({ type: 'tool_result', toolCallId: callId1, toolName: 'shot_mode_decision', result: modeDecision, agentName: agent });
  }

  // ── Call 2: First Frame Prompt ──
  const firstFrameInput = buildFirstFramePrompt({
    shotDescription: ctx.shotDescription,
    cameraWork: ctx.shotCameraWork,
    mode: modeDecision.mode,
    references: modeDecision.references,
    sceneStateContext: ctx.sceneStateContext,
    worldStyle: ctx.worldStyle,
  });

  const callId2 = `pipeline_ff_${ctx.itemId}_${Date.now()}`;
  emit?.({ type: 'tool_call', toolCallId: callId2, toolName: 'shot_first_frame', arguments: { shot: ctx.itemId, mode: modeDecision.mode }, agentName: agent });
  const firstFramePrompt = await callLLM(llm, firstFrameInput.system, firstFrameInput.user, 0.3, false);
  emit?.({ type: 'tool_streaming', toolCallId: callId2, chunk: firstFramePrompt.substring(0, 200) + '...', done: true, agentName: agent, toolName: 'shot_first_frame' });
  emit?.({ type: 'tool_result', toolCallId: callId2, toolName: 'shot_first_frame', result: { prompt: firstFramePrompt }, agentName: agent });

  // ── Call 3: Last Frame Prompt ──
  const lastFrameInput = buildLastFramePrompt({
    firstFramePrompt,
    lastFrameChanges: ctx.lastFrameChanges,
    shotDescription: ctx.shotDescription,
  });

  const callId3 = `pipeline_lf_${ctx.itemId}_${Date.now()}`;
  emit?.({ type: 'tool_call', toolCallId: callId3, toolName: 'shot_last_frame', arguments: { shot: ctx.itemId }, agentName: agent });
  const lastFramePrompt = await callLLM(llm, lastFrameInput.system, lastFrameInput.user, 0.3, false);
  emit?.({ type: 'tool_streaming', toolCallId: callId3, chunk: lastFramePrompt.substring(0, 200) + '...', done: true, agentName: agent, toolName: 'shot_last_frame' });
  emit?.({ type: 'tool_result', toolCallId: callId3, toolName: 'shot_last_frame', result: { prompt: lastFramePrompt }, agentName: agent });

  // FML2V disabled: no Call 4 (mid frame). All shots use FL2V (2-frame) video.

  // ── Deterministic Assembly ──
  const assembled = assembleShotImagePrompt({
    shotNumber: ctx.shotNumber,
    generationStrategy: ctx.generationStrategy,
    firstFrameMode: modeDecision.mode,
    firstFramePrompt,
    firstFrameRefs: modeDecision.references,
    lastFramePrompt,
    negativePrompt: buildNegativePrompt(modeDecision.mode),
  });

  return JSON.stringify(assembled, null, 2);
}

// ── LLM Call Helper ──────────────────────────────────────────────────────────

async function callLLM(
  llm: LLMClient,
  system: string,
  user: string,
  temperature: number,
  jsonMode: boolean,
): Promise<string> {
  const options: any = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature,
  };

  // Try with json_object mode first, fall back to raw if model doesn't support it
  if (jsonMode) {
    try {
      options.responseFormat = { type: 'json_object' };
      const chunks: string[] = [];
      for await (const chunk of llm.generateStream(options)) {
        if (chunk.content) chunks.push(chunk.content);
      }
      return chunks.join('');
    } catch (err: any) {
      if (err?.code === 405 || err?.status === 405 || String(err).includes('not supported')) {
        // Model doesn't support json_object — retry without it
        delete options.responseFormat;
      } else {
        throw err;
      }
    }
  }

  const chunks: string[] = [];
  for await (const chunk of llm.generateStream(options)) {
    if (chunk.content) chunks.push(chunk.content);
  }
  return chunks.join('');
}
