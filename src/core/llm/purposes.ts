/**
 * LLM purpose taxonomy — every LLM call site in the codebase picks one
 * purpose tag. Purposes group into 3 tiers (heavy / medium / light) for
 * bulk configuration; individual purposes can still be overridden.
 *
 * Goal: let the user route expensive creative generation to a strong model
 * (Opus / GPT-5) while sending cheap structured extractions and utility
 * checks to a small fast model (Haiku / Groq Llama). See the routing plan
 * for tier recommendations and cost expectations.
 */

// ── Tiers ────────────────────────────────────────────────────────────────

/** Coarse complexity bucket. */
export type LLMTier = 'heavy' | 'medium' | 'light';

export const LLM_TIERS: readonly LLMTier[] = ['heavy', 'medium', 'light'] as const;

// ── Purposes ────────────────────────────────────────────────────────────

/**
 * Heavy — long-form creative prose. Wants the strongest model.
 */
export const HEAVY_PURPOSES = [
  'content.story',
  'content.plot',
  'content.character',
  'content.setting',
  'content.scene',
  'content.world_style',
  'content.shot_image_prompt',
  'content.shot_motion_directive',
] as const;

/**
 * Medium — structured JSON with meaningful logic.
 */
export const MEDIUM_PURPOSES = [
  'structured.scene_breakdown',
  'structured.collection_extraction',
  'structured.story_essence',
  'structured.scene_state',
  'structured.shot_image_json',
  'structured.workflow_analysis',
  'structured.input_classification',
  'structured.prompt_refinement',
] as const;

/**
 * Light — narrow, cheap, fast. Great candidates for a small model.
 */
export const LIGHT_PURPOSES = [
  'utility.continuity_check',
  'utility.metadata',
  'utility.session_summary',
  'utility.image_review',
  'utility.json_repair',
  'utility.prompt_evaluation',
] as const;

export type HeavyPurpose = (typeof HEAVY_PURPOSES)[number];
export type MediumPurpose = (typeof MEDIUM_PURPOSES)[number];
export type LightPurpose = (typeof LIGHT_PURPOSES)[number];
export type LLMPurpose = HeavyPurpose | MediumPurpose | LightPurpose;

/** Every purpose, flattened. */
export const ALL_PURPOSES: readonly LLMPurpose[] = [
  ...HEAVY_PURPOSES,
  ...MEDIUM_PURPOSES,
  ...LIGHT_PURPOSES,
];

// ── Purpose → tier map ──────────────────────────────────────────────────

/**
 * Built deterministically from the three constants above so it can't drift.
 */
export const PURPOSE_TO_TIER: Record<LLMPurpose, LLMTier> = (() => {
  const map = {} as Record<LLMPurpose, LLMTier>;
  for (const p of HEAVY_PURPOSES) map[p] = 'heavy';
  for (const p of MEDIUM_PURPOSES) map[p] = 'medium';
  for (const p of LIGHT_PURPOSES) map[p] = 'light';
  return map;
})();

/** Return the tier for a purpose. Throws on unknown purpose (should be caught at call site). */
export function tierOf(purpose: LLMPurpose): LLMTier {
  const t = PURPOSE_TO_TIER[purpose];
  if (!t) throw new Error(`Unknown LLM purpose: ${purpose}`);
  return t;
}

/** Type-guard for validation when reading config files / env vars. */
export function isLLMPurpose(value: unknown): value is LLMPurpose {
  return typeof value === 'string' && (ALL_PURPOSES as readonly string[]).includes(value);
}

/** Type-guard for tier validation. */
export function isLLMTier(value: unknown): value is LLMTier {
  return value === 'heavy' || value === 'medium' || value === 'light';
}
