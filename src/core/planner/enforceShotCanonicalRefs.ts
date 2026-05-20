/**
 * Post-LLM enforcement of the canonical reference set on a
 * shot_image_prompt frame.
 *
 * The shot_image_prompt LLM is shown the available references for
 * the shot and asked to list the ones it uses. In practice it often
 * forgets characters that ARE named in the prose (the 2026-05-19
 * Soft Seinen scene 1 shot 3 incident: focus.primary='protagonist',
 * prose said "Kaito Nakamura sits at the news anchor desk…", but
 * the LLM emitted `references: []`. Flux Klein then had no anchor
 * for Kaito and produced a photoreal character instead of the
 * established anime one.)
 *
 * This module enforces the canonical reference set from the
 * scene_video_prompt's focus / perspectiveOf fields. Those name
 * characters by refId (the stable identity slug), are authoritative,
 * and exist for every shot in every project — no name-matching
 * heuristic required.
 *
 * Pure module — no I/O. Caller reads the SVP and passes the shot
 * object + the executor's available-refs list.
 */

import type { AvailableRefMinimal } from './shotImagePromptNormalizer.js';

export interface CanonicalRefsShot {
  /** Optional — perspectiveOf is a refId of a character when set. */
  perspectiveOf?: string | null;
  /** focus has primary (refId), background[] (mixed refId + free text), lurking (refId). */
  focus?: {
    primary?: string | null;
    background?: string[] | null;
    lurking?: string | null;
  } | null;
  /** The canonical scene setting refId (e.g. "city_bus_station"). When set
   *  the enforcer guarantees this setting appears in the references list
   *  even when the LLM forgot to list it — the 2026-05-20 Ruby V3 s1s1
   *  incident, where the prose says "a city bus" but references contained
   *  only the Ruby character. Without a setting slot, Flux Klein has
   *  nothing to anchor the location to and drifts. */
  canonicalSceneSetting?: string | null;
}

export interface ShotImagePromptRefMinimal {
  imageNumber: number;
  type: 'character' | 'setting' | 'object' | string;
  refId: string;
  [k: string]: unknown;
}

export interface EnforcementResult {
  /** New references array (existing entries preserved, missing canonical refs appended). */
  references: ShotImagePromptRefMinimal[];
  /** Which refIds were added by this pass — for log + tool-result telemetry. */
  addedRefIds: string[];
}

/**
 * Merge canonical refs from the scene_video_prompt's focus +
 * perspectiveOf into the LLM-emitted references list.
 *
 * Rules:
 *   - LLM-emitted refs are PRESERVED with their existing imageNumber.
 *   - For each canonical refId that exists in `availableRefs` but
 *     isn't already in `existingRefs` (by refId), append it with a
 *     fresh imageNumber (max-existing + 1).
 *   - Canonical refIds that aren't in `availableRefs` are SKIPPED
 *     silently — that means the shot named a character/setting the
 *     project doesn't have a ref for, and inventing one isn't the
 *     enforcer's job.
 *   - Free-form strings in `focus.background` (e.g. "broadcast booth
 *     with monitors") are skipped — they're prose descriptions, not
 *     refIds. The reference set stays clean.
 *
 * Pure, idempotent, project-agnostic.
 */
export function enforceShotCanonicalRefs(
  shot: CanonicalRefsShot | null | undefined,
  existingRefs: ShotImagePromptRefMinimal[],
  availableRefs: AvailableRefMinimal[],
): EnforcementResult {
  const out = [...existingRefs];
  const addedRefIds: string[] = [];
  if (!shot) return { references: out, addedRefIds };

  // The canonical refIds the SVP named for this shot. Order matters
  // only for "which one gets the lowest imageNumber" — settings first
  // so the base canvas (slot 1) is the scene setting, then characters
  // by narrative weight (perspective > primary > lurking > background).
  const canonicalIds: string[] = [];
  if (shot.canonicalSceneSetting) canonicalIds.push(shot.canonicalSceneSetting);
  if (shot.perspectiveOf) canonicalIds.push(shot.perspectiveOf);
  if (shot.focus?.primary) canonicalIds.push(shot.focus.primary);
  if (shot.focus?.lurking) canonicalIds.push(shot.focus.lurking);
  for (const b of shot.focus?.background ?? []) {
    if (typeof b === 'string') canonicalIds.push(b);
  }

  // Build lookup: refId-suffix → available-refs entry. The executor
  // stores refIds as `<type>:<itemId>` (e.g. "character_image:protagonist")
  // but SVP fields name just the itemId ("protagonist"). Match either
  // form so callers don't need to normalize first.
  const byItemId = new Map<string, AvailableRefMinimal>();
  const byFullRefId = new Map<string, AvailableRefMinimal>();
  for (const ar of availableRefs) {
    byFullRefId.set(ar.refId, ar);
    const itemId = ar.refId.includes(':') ? ar.refId.split(':')[1]! : ar.refId;
    byItemId.set(itemId, ar);
  }

  const existingByRefId = new Set(out.map(r => r.refId));
  let maxN = 0;
  for (const r of out) {
    if (typeof r.imageNumber === 'number' && r.imageNumber > maxN) maxN = r.imageNumber;
  }

  // De-dupe within this pass too — a shot whose perspectiveOf equals
  // focus.primary (common for main_subject shots) shouldn't double-add.
  const addedThisPass = new Set<string>();

  for (const id of canonicalIds) {
    const ar =
      byFullRefId.get(id) ??
      byItemId.get(id);
    if (!ar) continue; // Not a refId we can resolve — likely free-form prose.
    if (existingByRefId.has(ar.refId)) continue;
    if (addedThisPass.has(ar.refId)) continue;
    out.push({
      imageNumber: ++maxN,
      type: ar.type,
      refId: ar.refId,
    });
    existingByRefId.add(ar.refId);
    addedThisPass.add(ar.refId);
    addedRefIds.push(ar.refId);
  }

  return { references: out, addedRefIds };
}
