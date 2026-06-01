/**
 * bundleDisplay — pure helpers for bundle picker display fields.
 *
 * `titleizeBundleId` turns snake_case / kebab-case ids into a Title-
 * Case display label so the chat panel doesn't show raw snake_case
 * bundle ids to the user. Acronym-aware: known tokens (LTX, ZIT, VLM)
 * keep their uppercase form so we don't read "Ltx Prompt Relay" out
 * loud.
 *
 * `summaryOf` derives a tagline from a bundle's metadata for the
 * picker card. Explicit `summary` wins; else first sentence of
 * `description`; else empty.
 *
 * These exist so a bundle author can ship a bundle.json without
 * hand-authoring display fields and still get a reasonable card.
 * Authors who care about polish set `displayName` + `summary` to
 * override.
 */

/** Acronyms we preserve as-is when titleizing. Lowercase keys. */
const ACRONYMS = new Set(['ltx', 'zit', 'vlm', 'llm', 'sdxl', 'sdtxt', 'i2v', 't2v']);

export function titleizeBundleId(id: string): string {
  if (!id) return '';
  const tokens = id.split(/[_\-]+/).filter(Boolean);
  return tokens
    .map((tok) => {
      const lower = tok.toLowerCase();
      if (ACRONYMS.has(lower)) return lower.toUpperCase();
      // Capitalize every token (Title Case, not sentence case) so
      // "Narrative Shot By Shot" reads naturally as a label.
      return tok.charAt(0).toUpperCase() + tok.slice(1);
    })
    .join(' ');
}

export interface BundleDisplayLike {
  summary?: string;
  description?: string;
}

export function summaryOf(bundle: BundleDisplayLike): string {
  if (typeof bundle.summary === 'string' && bundle.summary.trim().length > 0) {
    return bundle.summary.trim();
  }
  const desc = typeof bundle.description === 'string' ? bundle.description.trim() : '';
  if (!desc) return '';
  // First sentence (split on the first period followed by space or end).
  const match = desc.match(/^(.+?[.!?])(\s|$)/);
  let first = match ? match[1]!.trim() : desc;
  // Cap at 120 chars; mark truncation with an ellipsis so the UI
  // signals there's more in the long description if the user wants it.
  if (first.length > 120) {
    first = first.slice(0, 120) + '…';
  }
  return first;
}
