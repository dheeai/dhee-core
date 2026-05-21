/**
 * Hard post-anchor for the Stage A / Stage B LLM prompts (scene_shot_plan
 * and shot_breakdown).
 *
 * Why this exists: the loaded skill guides (`scene_breakdown_plan_guide.md`,
 * `scene_breakdown_shot_guide.md`, and other co-loaded guides) include
 * demonstration tokens — placeholder names, anti-pattern examples — that
 * the LLM has repeatedly latched onto and emitted as if they were real
 * project entities. We hit this on the Dream project: a redo from
 * "Scene scripts" regenerated `scene_1.plan.json` with characters
 * ("Vikram", "Laila") that exist nowhere in the project's scene script
 * — only in legacy example content the model had been trained against.
 *
 * Sanitising the guides removes most of the surface area; this block
 * adds an explicit final-word directive AFTER the scene content, so the
 * most-recent input the model sees is "use only what's grounded in the
 * scene above; ignore any example name from the guides."
 *
 * Returns an empty string for node types that don't need the anchor —
 * caller can splice unconditionally without guarding the type.
 */

const STAGE_A_B_TYPES = new Set(['scene_shot_plan', 'shot_breakdown']);

const CONTRACT = `<output_contract>
HARD RULE — the ONLY characters, settings, and objects that may appear
in your output are those that:
  (a) are explicitly named in the scene script above, AND
  (b) have a matching refId in <available_refs>.

Examples, demonstration tables, and placeholder tokens shown anywhere
in the <model_skills> guide (e.g. <charA>, <refid_with_apostrophe>, or
any concrete name like "glitch" or "lazarus_drive") are illustrative
ONLY — they are NOT part of this project. Do NOT copy any name, refId,
or noun-phrase from those examples into your output.

If the scene script names a character or setting that is NOT in
<available_refs>, describe it in prose inside oneLineSummary /
description — never invent a refId, and never substitute a name from
an example or guide.

Before emitting JSON: re-read the scene script above one more time
and verify every mainSubject / secondarySubject / focus.* value you
plan to emit is grounded in that script's prose.
</output_contract>`;

export function buildOutputContractBlock(nodeTypeId: string): string {
  if (!STAGE_A_B_TYPES.has(nodeTypeId)) return '';
  return `\n\n${CONTRACT}`;
}
