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

  const lines = entries
    .map(e => `- ${e.refId}: ${e.description}`)
    .join('\n\n');

  return `\n\n<character_descriptions>
THIS SHOT'S CHARACTERS — CANONICAL PHYSICAL DESCRIPTIONS.

The reference image(s) listed in <available_references> ARE the visual
truth for each character. Klein will use those images to render the
character. Your prose only needs to NAME the character and describe
their ACTION / POSE / EXPRESSION / POSITION — not their appearance.

**HARD RULES — VIOLATING THESE BREAKS CHARACTER CONTINUITY:**

1. DO NOT write physical attribute parentheticals next to character
   names. Forbidden patterns include:
     ✗ "Malachor (Black man, coiled hair, dark hoodie)"
     ✗ "Sera (white woman with red hair)"
     ✗ "Malachor (lean, dark-skinned, angular face)"
   These INVENT attributes that contradict the reference image. Klein
   then follows the prose, not the image — the wrong person is
   rendered.

2. DO NOT mention any of these attributes in your prose unless the
   canonical description below explicitly lists them:
     - race / ethnicity / skin tone
     - hair color, length, or style
     - age in years or decade
     - eye color
     - facial hair / scars / glasses / marks
     - height / build / body type
     - specific clothing (color, garment type, accessories)

3. When you write a character into a scene, use ONLY their NAME plus
   action/pose/expression. Example:
     ✓ "Malachor leans forward, hand on the rim of his coffee mug."
     ✓ "Sera's gaze drops to the datapad, jaw tightening."
     ✗ "Malachor (tall, lean man with a scar) leans forward..."

4. If you absolutely must describe a character's appearance (e.g. to
   contrast two characters at a glance), use the canonical phrasing
   from the descriptions below — VERBATIM — and only the attributes
   present there. Never add new ones.

CANONICAL DESCRIPTIONS (read-only — for your awareness so you don't
invent contradicting attributes; do NOT copy these into your prose
unless rule 4 applies):

${lines}

Bottom line: the reference image carries the look. Your prose carries
the action. Mixing the two is what produces hallucinated wrong
characters.
</character_descriptions>`;
}
