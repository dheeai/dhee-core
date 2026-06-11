/**
 * deriveItemId — the single source of truth for turning a plan-array
 * entry into its instance itemId.
 *
 * Collection instances are materialized from an upstream plan JSON
 * (e.g. characters_plan → character_image:concept_car). The walker, the
 * plan-item diff, and the dhee_add_item / dhee_remove_item tools must
 * ALL derive the same itemId from the same item, or invalidation and
 * materialization disagree (you'd clear `character_image:concept_car`
 * while the walker re-creates `character_image:Concept Car`). This used
 * to live inline in walker.ts's materializeCollection; it's extracted
 * here so every caller shares one rule.
 *
 * Rule (unchanged from the original walker logic):
 *   - string item:        the string itself, spaces→underscores, lower
 *   - object item:        String(item.id ?? item.name ?? ''), same norm
 */

/** A plan-array entry: either a bare string or an object with id/name. */
export type PlanItem = string | { id?: unknown; name?: unknown; [k: string]: unknown };

function normalize(raw: string): string {
  return raw.replace(/\s+/g, '_').toLowerCase();
}

/**
 * Derive the instance itemId for a plan-array entry. Returns '' when the
 * item carries no id/name — callers decide whether that's an error
 * (the walker throws; the diff treats '' as "skip").
 */
export function deriveItemId(item: PlanItem): string {
  if (typeof item === 'string') return normalize(item);
  const raw = item.id ?? item.name;
  // Only string/number ids are keyable; an object/array id can't form a
  // path segment, so treat it as unkeyable ('').
  return typeof raw === 'string' || typeof raw === 'number' ? normalize(String(raw)) : '';
}
