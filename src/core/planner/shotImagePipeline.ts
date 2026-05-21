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

/**
 * Holding-beat purposes — shots where the LF visually matches the FF
 * (subject still, camera static). LTX i2v handles these with subtle
 * ambient improvisation; generating a distinct LF prompt + Klein edit
 * costs ~$0.02-0.03/shot for no perceptual gain. See skip-wasted-LF
 * todo and skip-lf branch.
 */
const HOLDING_BEAT_PURPOSES = new Set<string>([
  'set_the_world',
  'set_the_mood',
  'hold_emotion',
  'show_reaction',
  'show_dialogue',
  'show_clue',
  'punctuate',
]);

/**
 * Motion verbs in `cameraWork` that veto the holding-beat classification.
 * If the camera is moving, the LF can't be the same frame as the FF —
 * the camera's position has changed even if the subject hasn't.
 */
const CAMERA_MOTION_VERBS = [
  'push in', 'push-in', 'pushin',
  'pull back', 'pull-back', 'pullback',
  'pan',
  'dolly',
  'tracking', 'track ',
  'tilt',
  'zoom',
  'follow',
  'crane',
  'orbit',
  'whip',
  'swirl',
  'rack focus', 'rack-focus',
  'arc shot', 'arc ',
];

/**
 * Decide whether a shot is a "holding beat" — its LF should be skipped
 * and the video gen falls back to i2v (FF only).
 *
 * Triggers when:
 *   - purpose ∈ HOLDING_BEAT_PURPOSES, AND
 *   - cameraWork prose lacks any camera-motion verb.
 *
 * Be conservative: if either signal is unclear, return false so the
 * default FL2V path runs.
 */
export function isHoldingBeat(purpose: string, cameraWork: string): boolean {
  if (!purpose || !HOLDING_BEAT_PURPOSES.has(purpose)) return false;
  const cw = (cameraWork ?? '').toLowerCase();
  if (!cw) return true; // no cameraWork prose → trust the purpose
  for (const verb of CAMERA_MOTION_VERBS) {
    if (cw.includes(verb)) return false;
  }
  return true;
}

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
  /**
   * Phase D — when status === 'new' AND this ref is a reframe or
   * alternate angle of an existing ref, the existing ref's canonical
   * refId. Triggers chained-edit generation: the parent's outputPath
   * becomes the base canvas, the new ref's description becomes the
   * reframe prompt. Most common case: Side B (over-the-shoulder
   * reverse) of a setting that already exists for Side A.
   */
  derivedFrom?: string;
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
    ? [
        ``,
        `**OTS / dialogue framing detected.** Side A and Side B are the TWO`,
        `CAMERA ANGLES of one OTS exchange. They are NOT character properties —`,
        `they're a property of THIS SHOT. Decide which side this shot is by`,
        `reading your own prose: who is the camera looking AT (face visible),`,
        `and who is the camera looking PAST (silhouette in foreground)?`,
        ``,
        `Once you decide the side, the setting variant and the character role`,
        `assignment MUST agree — they are two consequences of the same camera`,
        `position. Here is the interlock:`,
        ``,
        `  Side A (camera at one end of the room):`,
        `    - Setting: the BASE setting (the existing menu entry, no _reverse suffix)`,
        `    - Character side='A' = the face we see (in-frame subject)`,
        `    - Character side='B' = the back of the head we see in foreground (OTS silhouette)`,
        ``,
        `  Side B (camera at the OPPOSITE end, looking back):`,
        `    - Setting: the REVERSE setting (existing \`_reverse\` entry, OR propose a new one)`,
        `    - Character side='A' = the face we see (was side='B' in the paired Side-A shot)`,
        `    - Character side='B' = the OTS silhouette (was side='A' in the paired Side-A shot)`,
        ``,
        `In other words: the two characters swap foreground/silhouette roles`,
        `between paired shots, AND the setting flips to the reverse canvas.`,
        `Picking the base setting with a side='B' character framing — or the`,
        `reverse setting with side='A' framing — produces eyelines and`,
        `backgrounds that don't line up.`,
        ``,
        `**If you choose Side B and no \`_reverse\` setting is in the menu, propose one:**`,
        `  - \`refId\`: \`setting_image:<base_setting_id>_reverse\` (deterministic — paired shots in the same scene MUST land on this same refId)`,
        `  - \`status\`: 'new'`,
        `  - \`derivedFrom\`: \`<base_setting_id>\` (the canonical refId of the Side A setting from the menu — the executor uses its rendered canvas as the Klein base)`,
        `  - \`newRefDescription\`: write a 1-2 sentence reframe brief grounded in the BASE setting's description above. State explicitly what's now in frame (what was previously behind the camera). Same lighting, same time of day, same color palette — just the opposite camera angle.`,
      ].join('\n')
    : '';
  return [
    `Now extract the reference image list this shot needs to render.`,
    ``,
    `**Read your own prose from the previous turn carefully.** For every`,
    `character, setting, or object named in the prose, output one`,
    `references[] entry. Prefer existing refs from the menu below;`,
    `propose a new one only if no menu entry matches.`,
    ``,
    `**Use the menu \`description\` field to ground your decisions.** Each`,
    `entry below carries the actual visual description of that character /`,
    `setting / object. For OTS framing especially, the setting's description`,
    `tells you what's physically in the location — what's at the entrance vs.`,
    `the back wall, where the windows are, which direction faces the street —`,
    `so you can reason about what the camera sees when it pivots to the`,
    `reverse angle. Don't guess; read the description and base your shotSide`,
    `+ setting-variant choice on it.`,
    ``,
    `**Naming convention for new refs — STABLE so cross-shot dedup works:**`,
    `  - Character: \`character_image:<snake_case_name>\` (e.g. \`character_image:pawn_broker\`)`,
    `  - Setting: \`setting_image:<snake_case_name>\` (e.g. \`setting_image:bus_station_morning\`)`,
    `  - Reverse angle of an existing setting: \`setting_image:<base>_reverse\``,
    `  - Object: \`object_image:<snake_case_name>\``,
    `If another shot proposes the same conceptual ref later, it must land on the SAME refId — name things by what they ARE, not by which shot introduced them.`,
    ``,
    `**Existing reference menu (refId + label + description):**`,
    `\`\`\`json`,
    menuJson,
    `\`\`\``,
    otsNote,
    ``,
    `Output JSON only, wrapped in \`{ "references": [...] }\`. Each entry:`,
    `  - \`refId\`: snake-case canonical key (e.g. \`character_image:ruby\`)`,
    `  - \`type\`: 'character' | 'setting' | 'object'`,
    `  - \`imageNumber\`: 1 for setting/canvas, 2..4 for characters/objects in prominence order`,
    `  - \`status\`: 'existing' (refId from menu) or 'new' (propose to create)`,
    `  - \`side\`: 'A' or 'B' for OTS framing (omit otherwise)`,
    `  - \`newRefDescription\`: required when status='new', 1-2 sentence visual description`,
    `  - \`derivedFrom\`: optional. When status='new', the canonical refId of a parent ref this is a reframe / variant of. Triggers image-edit generation against the parent canvas.`,
    ``,
    `Hard rules: ≤ 4 total refs; exactly one setting at imageNumber 1; no duplicate refIds; no duplicate imageNumbers.`,
  ].join('\n');
}

/**
 * Map a `type` value to its canonical image-typeId prefix. Used for
 * auto-prefixing bare refIds the LLM emits without a typeId.
 */
function imageTypeIdForRefType(type: 'character' | 'setting' | 'object'): string {
  return type === 'character' ? 'character_image' :
    type === 'setting' ? 'setting_image' :
    'object_image';
}

/**
 * Coerce a refId into its canonical `<imageTypeId>:<itemId>` form. Used
 * by turn-2 normalization to absorb common LLM mistakes (bare itemId,
 * upstream-typed prefix) so downstream code never has to defend against
 * them.
 */
function canonicalizeRefId(raw: string, type: 'character' | 'setting' | 'object'): string {
  const imageTypeId = imageTypeIdForRefType(type);
  if (raw.startsWith(`${imageTypeId}:`)) return raw;
  if (raw.includes(':')) {
    const after = raw.split(':')[1]!;
    return `${imageTypeId}:${after}`;
  }
  return `${imageTypeId}:${raw}`;
}

/**
 * Parse + normalize + validate turn 2's LLM output.
 *
 * **Reference resolution is load-bearing.** A missing or misbound ref
 * silently drops a character or setting from Klein's conditioning — the
 * rendered image is wrong but no error fires. So this function is
 * deliberately strict:
 *
 *   1. **Auto-fix unambiguous mistakes** so the LLM's first slip
 *      doesn't cost a regen:
 *        - bare refId (`ruby`) or upstream-typed (`character:ruby`)
 *          → canonical `character_image:ruby`
 *        - imageNumber out of 1..4 → drop the entry
 *        - status='new' missing newRefDescription → drop the entry
 *        - >4 refs → keep first 4 by declared order (after slot 1 = setting)
 *
 *   2. **Reject ambiguous outputs** by returning `[]`. The caller
 *      MUST treat `[]` as "keep turn-1 refs" — better to ship turn-1's
 *      best guess than a half-built refs array:
 *        - two settings in the same array
 *        - setting at a slot other than 1 AND slot 1 is occupied by
 *          something else (no clean swap available)
 *        - no setting at all when at least one ref is character/object
 *          (Klein needs slot 1 = base canvas)
 *
 * Forgiving: accepts either `{ "references": [...] }` or a bare array.
 * Returns `[]` on parse failure or validation failure.
 */
export function parseTurn2RefsJson(rawText: string): Reference[] {
  let arr: unknown[];
  try {
    const cleaned = rawText.trim().replace(/^```(?:json)?\s*/, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned) as unknown;
    const candidate = Array.isArray(parsed)
      ? parsed
      : (parsed as { references?: unknown[] })?.references;
    if (!Array.isArray(candidate)) return [];
    arr = candidate;
  } catch {
    return [];
  }

  // ── Stage 1: per-entry normalization. Drop malformed entries; keep
  // structurally-valid ones with canonical refIds.
  const normalized: Reference[] = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const rawRefId = typeof r['refId'] === 'string' ? r['refId'].trim() : '';
    const type = r['type'];
    const imageNumber = typeof r['imageNumber'] === 'number' ? r['imageNumber'] : null;
    if (!rawRefId) continue;
    if (type !== 'character' && type !== 'setting' && type !== 'object') continue;
    if (imageNumber === null || !Number.isInteger(imageNumber)) continue;
    if (imageNumber < 1 || imageNumber > 4) continue; // 2.7 — out of slot range
    const status = r['status'] === 'existing' || r['status'] === 'new' ? r['status'] : undefined;
    const newRefDescription = typeof r['newRefDescription'] === 'string' ? r['newRefDescription'].trim() : '';
    // 2.8 — status='new' MUST carry a description so downstream gen has
    // something to render from. Without it, drop the entry.
    if (status === 'new' && newRefDescription.length === 0) continue;
    const ref: Reference = {
      refId: canonicalizeRefId(rawRefId, type),
      type,
      imageNumber,
    };
    if (r['side'] === 'A' || r['side'] === 'B') ref.side = r['side'];
    if (status) ref.status = status;
    if (newRefDescription) ref.newRefDescription = newRefDescription;
    if (typeof r['derivedFrom'] === 'string' && r['derivedFrom'].trim().length > 0) {
      ref.derivedFrom = r['derivedFrom'].trim();
    }
    normalized.push(ref);
  }

  // ── Stage 2: dedup by refId AND by imageNumber, keeping the FIRST
  // occurrence. Settings get priority to claim slot 1 even if a non-
  // setting tried to grab it first.
  // We dedup refIds first so two refs with the same refId can't both
  // race for a slot; then we resolve slot collisions.
  const byRefId = new Map<string, Reference>();
  for (const ref of normalized) {
    if (!byRefId.has(ref.refId)) byRefId.set(ref.refId, ref);
  }
  let candidates = Array.from(byRefId.values());

  // ── Stage 3: 2.3 — at most ONE setting. If two settings exist, the
  // refs array is ambiguous; we can't pick which one to drop without
  // narrative knowledge. Reject and fall back to turn-1.
  const settings = candidates.filter(r => r.type === 'setting');
  if (settings.length > 1) return [];

  // ── Stage 4: 2.2 — setting must occupy slot 1. If it isn't and slot
  // 1 is free, coerce. If it isn't and slot 1 is occupied, swap.
  if (settings.length === 1) {
    const setting = settings[0]!;
    if (setting.imageNumber !== 1) {
      const occupant = candidates.find(r => r.imageNumber === 1 && r !== setting);
      if (occupant) {
        const oldSettingSlot = setting.imageNumber;
        setting.imageNumber = 1;
        occupant.imageNumber = oldSettingSlot;
      } else {
        setting.imageNumber = 1;
      }
    }
  }

  // ── Stage 5: 2.4 — if the array names any character or object refs
  // but has NO setting, Klein has no base canvas. Reject.
  const hasNonSetting = candidates.some(r => r.type !== 'setting');
  if (hasNonSetting && settings.length === 0) return [];

  // ── Stage 6: resolve slot collisions. After the setting swap above,
  // multiple refs may still share an imageNumber (e.g. LLM put two
  // characters both at slot 2). Keep the first claimant per slot; drop
  // the rest. Settings always win their slot (handled above).
  const seenSlot = new Set<number>();
  const slotResolved: Reference[] = [];
  // Iterate settings first to ensure they keep their slot.
  for (const r of candidates.filter(r => r.type === 'setting')) {
    if (seenSlot.has(r.imageNumber)) continue;
    seenSlot.add(r.imageNumber);
    slotResolved.push(r);
  }
  for (const r of candidates.filter(r => r.type !== 'setting')) {
    if (seenSlot.has(r.imageNumber)) continue;
    seenSlot.add(r.imageNumber);
    slotResolved.push(r);
  }
  candidates = slotResolved;

  // ── Stage 7: 2.1 — cap at 4. Sort by imageNumber so the lowest
  // slots survive (slot 1 setting is always preserved).
  candidates.sort((a, b) => a.imageNumber - b.imageNumber);
  if (candidates.length > 4) candidates = candidates.slice(0, 4);

  // ── Stage 8: 6.x — side A/B pairing invariants.
  //
  // Side A/B labels are camera-angle markers for an OTS exchange. They
  // are only meaningful when a true PAIR exists — exactly two characters
  // in the same shot, one foreground (A) and one silhouette (B).
  // Anything else is either nonsense or an LLM slip:
  //
  //   - 6.2: side on a setting/object → strip (only characters get sides;
  //          settings carry the angle via derivedFrom)
  //   - 6.1: two characters both side='A' (or both 'B') → keep the first,
  //          strip the duplicate (no double-foreground / double-silhouette)
  //   - 6.3: only one character ref → strip its side label (an OTS pair
  //          needs two characters; lone framing is solo, not OTS)
  //   - combined: half-specified pair (only one of two chars labelled) →
  //          strip the lone label rather than ship asymmetric framing
  //
  // Extras beyond the pair (three+ chars) are fine — the A/B labels mark
  // the two who define the angle; the rest stay unlabelled.

  // 6.2 — strip side from non-characters.
  for (const ref of candidates) {
    if (ref.type !== 'character' && ref.side !== undefined) {
      delete ref.side;
    }
  }

  // 6.1 — at most one side='A' and at most one side='B' (keep first).
  let seenA = false;
  let seenB = false;
  for (const ref of candidates) {
    if (ref.type !== 'character' || ref.side === undefined) continue;
    if (ref.side === 'A') {
      if (seenA) delete ref.side;
      else seenA = true;
    } else if (ref.side === 'B') {
      if (seenB) delete ref.side;
      else seenB = true;
    }
  }

  // 6.3 + combined — OTS pairing requires BOTH a foreground (A) AND a
  // silhouette (B). If either is missing, the labels are half-specified;
  // strip them so prose framing speaks for itself.
  const characters = candidates.filter(r => r.type === 'character');
  if (characters.length < 2) {
    for (const ref of characters) delete ref.side;
  } else {
    const hasA = characters.some(r => r.side === 'A');
    const hasB = characters.some(r => r.side === 'B');
    if (!(hasA && hasB)) {
      for (const ref of characters) delete ref.side;
    }
  }

  return candidates;
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
 * Pin the slot manifest at the top of every frame's `imagePrompt` and
 * strip stale inline `from image N` tokens — driven off each frame's
 * current `references[]`. Mutates the passed JSON in-place; returns the
 * same object for convenience.
 *
 * Run this AFTER any step that changes a frame's references (e.g. the
 * shot_image_prompt turn-2 refinement that swaps the array). Without
 * this re-run, the manifest line baked in by turn-1 — built from
 * turn-1's possibly incomplete refs — survives and the setting (slot 1)
 * can be silently dropped from Klein's conditioning even though
 * references[] lists it.
 *
 * Pure: no I/O, no LLM. Safe to call repeatedly (idempotent because the
 * strip pass removes the previous manifest's tokens before the new
 * manifest is prepended).
 */
/**
 * Strip the leading manifest paragraph if present — a contiguous run
 * of "Name [(setting)] from image N." sentences separated by spaces,
 * followed by a blank line (or end of string). Conservative: only
 * strips when the leading block looks ENTIRELY like a manifest. Leaves
 * narrative prose that happens to contain "from image N" untouched.
 *
 * Without this, re-running the post-pass corrupts the previously-
 * prepended manifest (the inline-token strip kicks "from image N" out
 * of the manifest's own sentences, leaving residue like "Ruby. Bus
 * (setting)." stranded at the top of the prose).
 */
function stripLeadingManifestParagraph(prose: string): string {
  const m = prose.match(
    /^(?:[A-Z][\w ]*?(?:\s*\(setting\))?\s+from image \d+\.\s*)+(?:\n+|$)/,
  );
  if (!m) return prose;
  return prose.slice(m[0].length).trimStart();
}

// ── Phase D — derivedFrom helpers ────────────────────────────────────────────

/**
 * Coerce a `derivedFrom` value (as emitted by the turn-2 ref-extraction
 * LLM) into a canonical image-node refId. The LLM may emit:
 *   - the bare itemId (`bus_station_morning`)
 *   - the image-typed refId (`setting_image:bus_station_morning`) — pass-through
 *   - the upstream-typed refId (`setting:bus_station_morning`) — re-prefix
 *
 * Output is always `<imageTypeId>:<itemId>` so the executor's `getNode`
 * lookup hits the right cascaded image node.
 */
export function normalizeDerivedFromRefId(
  raw: string,
  refType: 'character' | 'setting' | 'object',
): string {
  const imageTypeId =
    refType === 'character' ? 'character_image' :
    refType === 'setting' ? 'setting_image' :
    'object_image';
  if (raw.startsWith(`${imageTypeId}:`)) return raw;
  if (raw.includes(':')) {
    const after = raw.split(':')[1]!;
    return `${imageTypeId}:${after}`;
  }
  return `${imageTypeId}:${raw}`;
}

/**
 * What the renderer needs to switch a `setting_image` / `character_image`
 * from text-to-image to Klein image-edit using a parent ref as the base.
 */
export interface ChainedEditRef {
  artifactId: string;
  type: 'character' | 'setting';
  name: string;
  parentOutputPath: string;
}

export interface DerivedFromResolution {
  ref: ChainedEditRef | null;
  /** When `ref` is null, why we couldn't resolve — caller logs and falls back. */
  reason?: 'no-derived-from' | 'missing-parent' | 'no-output' | 'no-artifact' | 'cycle' | 'depth-exceeded';
}

interface DerivedFromNodeShape {
  typeId: string;
  itemId?: string;
  outputPath?: string;
  artifactId?: string;
  metadata?: { derivedFrom?: string };
}

/**
 * Resolve a chained-edit base from a node's `metadata.derivedFrom` value.
 *
 * Walks the derivedFrom chain to detect cycles (A→B→A would otherwise
 * deadlock the planner if both shots resolved each other) but only
 * returns the IMMEDIATE parent as the Klein base — Klein composes the
 * full ancestry naturally via successive edits.
 *
 * Falls back to `{ ref: null, reason: ... }` whenever the parent isn't
 * ready or the chain is malformed. Callers MUST treat null as "render
 * via plain text_to_image" — never block on a half-built parent.
 *
 * Pure: takes a `getNode` accessor so it's trivially testable without
 * spinning up a DependencyGraphExecutor.
 */
export function resolveDerivedFromBase(
  derivedFromRefId: string | undefined,
  getNode: (id: string) => DerivedFromNodeShape | undefined,
  options?: { maxDepth?: number },
): DerivedFromResolution {
  if (!derivedFromRefId) return { ref: null, reason: 'no-derived-from' };
  const maxDepth = options?.maxDepth ?? 8;
  const visited = new Set<string>();
  let cur: string | undefined = derivedFromRefId;
  let depth = 0;
  let immediateParent: DerivedFromNodeShape | undefined;
  let immediateParentId: string | undefined;
  while (cur) {
    if (visited.has(cur)) return { ref: null, reason: 'cycle' };
    visited.add(cur);
    depth++;
    if (depth > maxDepth) return { ref: null, reason: 'depth-exceeded' };
    const parent = getNode(cur);
    if (!parent) return { ref: null, reason: 'missing-parent' };
    if (depth === 1) {
      immediateParent = parent;
      immediateParentId = cur;
    }
    // Walk further to detect transitive cycles.
    cur = parent.metadata?.derivedFrom;
  }
  if (!immediateParent || !immediateParentId) {
    return { ref: null, reason: 'missing-parent' };
  }
  if (!immediateParent.outputPath) return { ref: null, reason: 'no-output' };
  if (!immediateParent.artifactId) return { ref: null, reason: 'no-artifact' };
  const parentType: 'character' | 'setting' =
    immediateParent.typeId === 'setting_image' ? 'setting' : 'character';
  return {
    ref: {
      artifactId: immediateParent.artifactId,
      type: parentType,
      name: immediateParent.itemId ?? immediateParentId,
      parentOutputPath: immediateParent.outputPath,
    },
  };
}

/**
 * Invariant I3 — edit_first_frame frames carry no setting ref.
 *
 * When a frame's `generationMode === 'edit_first_frame'`, Klein uses
 * the PRIOR frame's rendered image (first_frame.png) as slot 1 — the
 * base canvas. The setting was already baked into that image during
 * first_frame's render. Carrying a separate `setting_image:X` ref on
 * an edit_first_frame frame is at best redundant and at worst
 * confusing: Klein sees two slot-1 candidates and the binding becomes
 * undefined.
 *
 * Deterministic rule: walk every frame in the parsed JSON, and for
 * any frame with `generationMode === 'edit_first_frame'`, remove all
 * refs of `type === 'setting'` from its `references[]`. Character
 * and object refs are untouched — Klein still needs those bound to
 * slots 2..N so the characters stay identity-locked through the edit.
 *
 * Pure: mutates the passed object in place, returns it for chaining.
 *
 * This replaces the prose-tag-based drop heuristic in
 * `alignFramesToFirstFrame` for the setting-on-last-frame case. That
 * heuristic was non-deterministic — whether the setting survived
 * depended on whether the LLM's turn-1 prose happened to mention the
 * slot. Under the Phase-A regime where the guide tells the LLM NOT
 * to write slot tokens, the prose-tag check became a coin flip.
 */
export function stripSettingFromEditFirstFrameFrames<
  T extends {
    frames?: Record<
      string,
      { generationMode?: string; references?: Reference[] } | undefined
    >;
  },
>(parsed: T): T {
  const frames = parsed.frames;
  if (!frames) return parsed;
  for (const key of Object.keys(frames)) {
    const f = frames[key];
    if (!f || typeof f !== 'object') continue;
    if (f.generationMode !== 'edit_first_frame') continue;
    if (!Array.isArray(f.references)) continue;
    f.references = f.references.filter(r => r.type !== 'setting');
  }
  return parsed;
}

export function applyShotImageManifestPostPass<
  T extends {
    frames?: Record<
      string,
      { imagePrompt?: string; references?: Reference[] } | undefined
    >;
  },
>(parsed: T): T {
  const frames = parsed.frames;
  if (!frames) return parsed;
  for (const key of Object.keys(frames)) {
    const f = frames[key];
    if (!f || typeof f !== 'object') continue;
    if (typeof f.imagePrompt !== 'string' || !Array.isArray(f.references)) continue;
    const manifestLine = buildSlotManifestLine(f.references);
    // Single structural replace: drop the leading manifest paragraph
    // (a contiguous run of "Name from image N." sentences terminated by
    // a blank line) and prepend a fresh one built from `references[]`.
    //
    // We deliberately DO NOT grep the body for inline "from image N"
    // tokens. The guide no longer instructs the LLM to write them, and
    // if the LLM emits some anyway, Klein still binds via the manifest
    // at the top — the body's "from image N" becomes harmless prose,
    // not a competing slot directive. Trying to launder it after the
    // fact is busywork that risks damaging legitimate narrative
    // ("she stares at the image of her mother").
    const withoutLeadingManifest = stripLeadingManifestParagraph(f.imagePrompt);
    f.imagePrompt = manifestLine ? `${manifestLine}\n\n${withoutLeadingManifest}` : withoutLeadingManifest;
  }
  return parsed;
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
  const composed = (line: string, prose: string) => (line ? `${line}\n\n${prose}` : prose);

  // Skip-LF mode: when the pipeline emitted an empty LF prompt (holding
  // beat detected upstream), omit last_frame from the frames map. The
  // bridge node + executor + provider all read this absence and route
  // shot_video to i2v. Effective video strategy becomes 'i2v' instead
  // of 'flfv'. See skip-lf branch + isHoldingBeat() for the heuristic.
  const lastFrameSkipped = !input.lastFramePrompt || !input.lastFramePrompt.trim();
  const frames: ShotImagePromptJson['frames'] = {
    first_frame: {
      imagePrompt: composed(manifestLine, firstFrameProse),
      generationMode: input.firstFrameMode,
      references: input.firstFrameRefs,
    },
  };
  if (!lastFrameSkipped) {
    const lastFrameProse = enforceFrozenInstant(stripInlineFromImageTokens(input.lastFramePrompt));
    frames.last_frame = {
      imagePrompt: composed(manifestLine, lastFrameProse),
      generationMode: 'edit_first_frame',
      references: [],
    };
  }

  return {
    shotNumber: input.shotNumber,
    // When LF is skipped, downstream video strategy must be i2v (see
    // executor strategy override and ltx23_i2v_* manifests). Force it
    // here so persisted JSON matches what the renderer will actually do.
    generationStrategy: lastFrameSkipped ? 'i2v' : strategy,
    frames,
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

  // ── Call 3: Last Frame Prompt (or skip for holding beats) ──
  // Holding beats (static subject + static camera) get FF=LF treatment:
  // skip the LLM call and emit an empty LF prompt. The assembler omits
  // last_frame from the JSON; the executor's bridge node no-ops; the
  // shot_video resolver flips strategy to i2v. See skip-lf branch.
  const skipLastFrame = isHoldingBeat(ctx.shotPurpose, ctx.shotCameraWork);
  let lastFramePrompt = '';
  if (skipLastFrame) {
    const callId3 = `pipeline_lf_${ctx.itemId}_${Date.now()}`;
    emit?.({ type: 'tool_call', toolCallId: callId3, toolName: 'shot_last_frame', arguments: { shot: ctx.itemId, skipped: true, reason: 'holding_beat' }, agentName: agent });
    emit?.({ type: 'tool_result', toolCallId: callId3, toolName: 'shot_last_frame', result: { skipped: true, reason: 'holding_beat', purpose: ctx.shotPurpose }, agentName: agent });
  } else {
    const lastFrameInput = buildLastFramePrompt({
      firstFramePrompt,
      lastFrameChanges: ctx.lastFrameChanges,
      shotDescription: ctx.shotDescription,
    });

    const callId3 = `pipeline_lf_${ctx.itemId}_${Date.now()}`;
    emit?.({ type: 'tool_call', toolCallId: callId3, toolName: 'shot_last_frame', arguments: { shot: ctx.itemId }, agentName: agent });
    lastFramePrompt = await callLLM(llm, lastFrameInput.system, lastFrameInput.user, 0.3, false);
    emit?.({ type: 'tool_streaming', toolCallId: callId3, chunk: lastFramePrompt.substring(0, 200) + '...', done: true, agentName: agent, toolName: 'shot_last_frame' });
    emit?.({ type: 'tool_result', toolCallId: callId3, toolName: 'shot_last_frame', result: { prompt: lastFramePrompt }, agentName: agent });
  }

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
