/**
 * Extract short visual tags for characters in a shot.
 *
 * Purpose: motion directives go to a video model (LTX) that has no idea
 * who "Parvati" or "Isha" are. When a shot contains >=2 characters, the
 * directive needs to disambiguate them with a SHORT visual description
 * ("the older woman in a dusty blue salwar kameez") rather than by
 * name. This module builds those tags from character profile files.
 *
 * Input contract:
 * - refIds list — set of character identifiers visible in the shot
 * - a lookup that resolves refId → character.md file path on disk
 *
 * Output: a prompt-injectable block like
 *   <character_tags>
 *   When naming characters in motion, use these visual descriptions:
 *   - parvati: 35-year-old woman, faded blue salwar kameez, graying bun, canvas bag
 *   - isha: 16-year-old girl, red athletic vest, black shorts, high ponytail
 *   </character_tags>
 *
 * Or an empty string if no tags could be built (file missing, <2 chars,
 * etc.) — motion directive prompts stay as-is in that case.
 */

import { readFileSync, existsSync } from 'fs';

/**
 * Strip markdown formatting and whitespace from a paragraph — turn
 * "**Physical Description:**  \nIsha is a 16-year-old..." into plain
 * prose ready for truncation.
 */
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pull the first N characters of the character's visual-description
 * paragraph. Looks for a header like "Physical Description", then
 * extracts the following block until the next blank line or next header.
 *
 * Returns null if no physical-description section is found — callers
 * skip this character rather than guessing.
 */
export function extractPhysicalDescription(md: string, maxChars = 220): string | null {
  // Find the Physical Description header. Tolerant of varied formatting:
  //   **Physical Description:**
  //   #### Physical Description (Anime Style)
  //   **Physical Description (Anime Style):**
  const headerMatch = md.match(/(?:^|\n)[*#\s]*Physical Description[^\n]*\n/i);
  if (!headerMatch) return null;

  const start = headerMatch.index! + headerMatch[0].length;
  // Take until the next blank line OR the next markdown header
  // (whichever comes first).
  const rest = md.slice(start);
  const blankLine = rest.search(/\n\s*\n/);
  const nextHeader = rest.search(/\n[*#\s]*[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*[:\n]/);
  let stop = rest.length;
  if (blankLine >= 0) stop = Math.min(stop, blankLine);
  if (nextHeader >= 0) stop = Math.min(stop, nextHeader);

  const paragraph = stripMarkdown(rest.slice(0, stop));
  if (!paragraph) return null;

  if (paragraph.length <= maxChars) return paragraph;

  // Truncate at a sentence or clause boundary near maxChars so the tag
  // ends cleanly rather than mid-word.
  const truncated = paragraph.slice(0, maxChars);
  const lastPeriod = truncated.lastIndexOf('.');
  const lastComma = truncated.lastIndexOf(',');
  const cut = lastPeriod > maxChars * 0.6
    ? lastPeriod + 1
    : lastComma > maxChars * 0.7
      ? lastComma
      : truncated.lastIndexOf(' ');
  return truncated.slice(0, cut > 0 ? cut : maxChars).trim();
}

/**
 * Read a character profile and extract its visual tag, or null if the
 * file is missing/unreadable/has no physical-description section.
 */
export function readCharacterVisualTag(
  mdPath: string,
  maxChars = 220,
): string | null {
  if (!existsSync(mdPath)) return null;
  try {
    const content = readFileSync(mdPath, 'utf-8');
    return extractPhysicalDescription(content, maxChars);
  } catch {
    return null;
  }
}

export interface CharacterRef {
  refId: string;
  mdPath: string; // absolute path to the character's .md file
}

/**
 * Build a <character_tags> prompt block. Only fires when >=2 characters
 * are in the shot — a single character doesn't need disambiguation, and
 * the motion_directive_guide's standing rule is "no appearance
 * descriptions" for solo shots (the image already carries that).
 *
 * Returns an empty string when fewer than 2 characters are visible or
 * when no tags could be extracted.
 */
export function buildCharacterTagsBlock(chars: CharacterRef[]): string {
  if (chars.length < 2) return '';

  const tags: Array<{ refId: string; tag: string }> = [];
  for (const c of chars) {
    const tag = readCharacterVisualTag(c.mdPath);
    if (tag) tags.push({ refId: c.refId, tag });
  }

  if (tags.length < 2) return '';

  const lines = tags.map(t => `- ${t.refId}: ${t.tag}`).join('\n');
  return `\n\n<character_tags>\nThis shot has ${chars.length} characters. The video model does NOT know these characters by name. When you name any of them in the motion directive, use a SHORT visual tag drawn from these descriptions (e.g. "the older woman in the faded blue salwar"), not the proper name. Keep each tag under ~8 words.\n\n${lines}\n</character_tags>`;
}

/**
 * Build a character-descriptions block for shot_image_prompt.
 *
 * The shot_image_prompt LLM gets a list of reference refIds (via the
 * `<available_references>` block), but NOT the physical descriptions
 * those refIds correspond to. Without the descriptions, the LLM
 * invents physical attributes that contradict the canonical character
 * reference, then Klein renders the (wrong) prose instead of the
 * (correct) reference image. The boundary-test run on 2026-05-23
 * showed Malachor rendered as "Black man with coiled hair" when his
 * ref doc says "dark hair graying at temples, charcoal jacket, pale
 * amber eyes, scar through left eyebrow."
 *
 * Unlike `buildCharacterTagsBlock` (which fires at >=2 characters for
 * motion-directive disambiguation), this block fires for ANY shot
 * with at least one character, because even a single character's
 * physical attributes can drift on the prose-writing step.
 *
 * Uses a longer maxChars (400) than the motion tags (220) — the
 * image-prompt LLM writes a richer paragraph and benefits from more
 * physical detail than a short disambiguation tag.
 */
export function buildCharacterDescriptionsForImagePrompt(chars: CharacterRef[]): string {
  if (chars.length < 1) return '';

  const entries: Array<{ refId: string; description: string }> = [];
  for (const c of chars) {
    const description = readCharacterVisualTag(c.mdPath, 400);
    if (description) entries.push({ refId: c.refId, description });
  }
  if (entries.length === 0) return '';

  // Compact 4-8 word visual hooks for each character, distilled from
  // the canonical description. These go directly into the prose's
  // INLINE VISUAL HOOK position (see shot_composition_guide.md). The
  // full description is also provided below for any longer prose
  // attribute the LLM might need; the compact hook is what guards
  // Klein's cross-slot identity binding.
  const hookLines = entries
    .map((e) => `- ${e.refId}: ${e.description}`)
    .join('\n\n');

  return `\n\n<character_descriptions>
CANONICAL PHYSICAL DESCRIPTIONS for the characters in this shot.

**Read this in conjunction with the shot_composition_guide's INLINE
VISUAL HOOK rule** — that rule REQUIRES a 4-8 word parenthetical
visual descriptor on each character's first mention in your prose
(e.g. \`Ruby (red-haired, leather jacket)\`). The hook is what keeps
Klein's cross-attention bound to the correct reference slot;
omitting it causes identity bleed across slots and on close-ups.

**HARD CONTRACT — what you must do:**

1. **You MUST write the inline visual hook** on each character's first
   mention. Do not skip it.

2. **The hook's CONTENT must come from the canonical description
   below** — NEVER invent attributes (race, hair, age, eye color,
   clothing, scars) that the canonical description doesn't list.
   Inventing produces a prose-vs-reference contradiction; Klein
   follows the prose, not the reference image, and renders the wrong
   person. Example failure from bdry2 (2026-05-23):
     ✗ \`Malachor (Black man, coiled hair, dark hoodie)\`
       when the ref says white man with a scar, dark short hair,
       charcoal jacket — Klein rendered a completely different
       character every time.

3. **Compose your hook by picking 4-8 words from the canonical
   description.** Pick the 2-3 most distinguishing visual cues
   (typically: ethnicity / skin tone, hair, one distinctive
   clothing item). Examples of how to distill:
     ✓ Canonical: "Black man, dark hoodie, short coiled hair"
       → Hook: \`(Black man, short coiled hair, dark hoodie)\`
     ✓ Canonical: "white man, scar through left eyebrow, charcoal
       jacket, dark hair graying at temples"
       → Hook: \`(white man, scarred eyebrow, charcoal jacket)\`
     ✓ Canonical: "young Asian woman, neon-blue dyed hair, athletic
       build, denim overalls"
       → Hook: \`(Asian woman, neon-blue hair, denim overalls)\`

4. **Subsequent mentions of the same character** can drop the hook
   (per the composition guide). Only the first mention in the prose
   body needs it.

5. **For brief reference / blurred-background mentions** — when a
   character only appears as a soft silhouette in the background — you
   STILL write the hook on first mention. Klein's cross-attention is
   what tells it which slot the silhouette comes from; without the
   hook it may render a different character or blend features.

CANONICAL DESCRIPTIONS (use these to compose your hooks — DO NOT
invent beyond what's written here):

${hookLines}

Bottom line: the reference image is Klein's visual truth, and the
inline visual hook is what tells Klein which slot to bind to. Compose
the hook from canonical content; never from invention.
</character_descriptions>`;
}
