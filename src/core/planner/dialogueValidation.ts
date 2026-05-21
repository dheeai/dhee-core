/**
 * Dialogue validators for scene_video_prompt + shot_motion_directive.
 *
 * Two soft-warn scanners that detect drift from the dialogue-handling
 * rules in the guides:
 *
 *   1. `scanMultiSpeakerShots` — a shot's `audio` field may contain at
 *      most ONE `NAME:` pattern. Two speakers in one shot cause the
 *      video model to mis-attribute dialogue to the wrong mouth.
 *
 *   2. `scanAmbiguousSpeakerTag` — a motion directive's `says` subject
 *      must be a unique visual descriptor, never a bare pronoun or
 *      generic class noun when 2+ characters are in the shot. The video
 *      model can't tell which character "the woman" refers to when two
 *      women are in frame.
 *
 * Both functions return a list of warnings. Callers decide what to do
 * with them: log, fail validation, inject a retry hint, etc. Keeping
 * these as pure functions so tests can exercise the detection logic
 * without pulling in the executor.
 */

// ─────────────────────────────────────────────────────────────────
// Scanner 1: multi-speaker shot detection
// ─────────────────────────────────────────────────────────────────

export interface ShotAudioLike {
  shotNumber?: number;
  audio?: string;
  [k: string]: unknown;
}

export interface MultiSpeakerWarning {
  shotNumber: number;
  speakers: string[];
  audioPreview: string;
}

/**
 * Match speaker markers at a word boundary. Same pattern we use in
 * `shotDurationFit.ts` so both scanners agree on what "a speaker" is.
 *
 * A speaker is a Capitalized-word prefix (with optional dotted titles
 * like "MRS." or "DR.") followed by a colon:
 *   PARVATI:            → match
 *   Mrs. Singh:         → match
 *   MR. O'HARA:         → match
 *   later, it:          → no match (lowercase first letter)
 */
const SPEAKER_REGEX = /(?:^|[^A-Za-z])([A-Z][A-Za-z.']*(?:\s+[A-Z][A-Za-z.']*)*):\s*/g;

function extractSpeakers(audio: string): string[] {
  const speakers = new Set<string>();
  let m: RegExpExecArray | null;
  SPEAKER_REGEX.lastIndex = 0;
  while ((m = SPEAKER_REGEX.exec(audio)) !== null) {
    const name = m[1]!.trim().toLowerCase().replace(/\./g, '');
    if (name.length >= 2) speakers.add(name);
  }
  return [...speakers];
}

/**
 * Find shots whose audio field has two or more distinct speakers.
 * Callers should split these into separate shots — see
 * `scene_breakdown_plan_guide.md` Step 2a (one speaker per shot).
 */
export function scanMultiSpeakerShots(shots: ShotAudioLike[]): MultiSpeakerWarning[] {
  const warnings: MultiSpeakerWarning[] = [];
  for (const shot of shots) {
    const audio = typeof shot.audio === 'string' ? shot.audio : '';
    if (!audio) continue;
    const speakers = extractSpeakers(audio);
    if (speakers.length >= 2) {
      warnings.push({
        shotNumber: typeof shot.shotNumber === 'number' ? shot.shotNumber : 0,
        speakers,
        audioPreview: audio.length > 120 ? audio.slice(0, 117) + '...' : audio,
      });
    }
  }
  return warnings;
}

// ─────────────────────────────────────────────────────────────────
// Scanner 2: ambiguous speaker-tag detection in motion directives
// ─────────────────────────────────────────────────────────────────

export interface AmbiguousSpeakerWarning {
  /** The exact substring that matched an ambiguous tag pattern. */
  match: string;
  /** The dialogue string that followed the ambiguous `says`. */
  quotedDialogue: string;
  /** The characters present in the shot (informational). */
  charsInShot: string[];
  reason: string;
}

/**
 * Bare speaker tags that DON'T disambiguate between multiple visible
 * characters:
 *   - pronouns: `She says`, `He says`
 *   - bare class nouns (with definite/indefinite article):
 *     `The woman says`, `A man says`, etc.
 *
 * The regex has two semantically-distinct shapes merged with
 * alternation:
 *
 *   (1) pronoun path — `She|He` preceded by a sentence boundary
 *       (start-of-string or terminal punctuation), followed by
 *       optional non-sentence-breaking filler, then `says`.
 *
 *   (2) class-noun path — `The|A|An` DIRECTLY adjacent to the class
 *       word (no adjective between them). This rules out `"The tall
 *       woman says..."` — "tall" sits between "The" and "woman",
 *       breaking adjacency; treated as a proper visual descriptor.
 *
 * The sentence-boundary prefix (`(?:^|[.!?"'])`) ensures we don't
 * match mid-sentence fragments like `"…the tall woman says…"`
 * embedded in a larger clause.
 *
 * The `[^.!?"'\n]{0,120}` window between subject and `says` lets
 * us catch split cases like `"The woman at the dining table,
 * lowering her gaze, says …"` while still rejecting text that
 * crosses a sentence boundary.
 */
// Lookbehind (`(?<=…)`) preserves the sentence-boundary character so
// the global regex can find matches in back-to-back sentences — e.g.
//   "The woman says 'Go.' The man says 'Wait.'"
// If we consumed the boundary, lastIndex would land mid-whitespace and
// the second `The man` wouldn't see a boundary char to its left.
// The article is OPTIONAL in the class-noun path so we also catch
// sentence-starting bare nouns like `"Woman says …"` (seen in the
// wild — some LLMs drop the article). An adjective between article
// and class noun (`"The tall woman says"`) still won't match because
// `(?:The|A|An)\s+(Woman|…)` requires direct adjacency; falling
// through to the article-less branch then fails because there's no
// sentence boundary immediately before "woman".
const AMBIGUOUS_SUBJECT = /(?<=^|[.!?"'])\s*(?:(She|He)|(?:(?:The|A|An)\s+)?(Woman|Man|Figure|Person|Girl|Boy|Lady|Guy))(?:[^.!?"'\n]{0,120})?\s*says\s*["'“‘]([^"'”’]{0,200})["'”’]/gi;

/**
 * Scan a motion-directive string for ambiguous speaker tags.
 *
 * `charsInShot` is the list of character refIds present in the shot
 * (from the matching shot_image_prompt JSON's references array). If
 * fewer than 2 characters are in the shot, ambiguity doesn't matter
 * — bare pronouns are fine for a solo character, and we return an
 * empty array.
 */
export function scanAmbiguousSpeakerTag(
  motionDirective: string,
  charsInShot: string[],
): AmbiguousSpeakerWarning[] {
  if (charsInShot.length < 2) return [];
  if (!motionDirective) return [];

  const warnings: AmbiguousSpeakerWarning[] = [];
  AMBIGUOUS_SUBJECT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AMBIGUOUS_SUBJECT.exec(motionDirective)) !== null) {
    const full = m[0].trim();
    // One of groups 1 (pronoun) or 2 (class noun) fires per alternation branch.
    const subject = m[1] ?? m[2] ?? '';
    const quoted = m[3] ?? '';
    warnings.push({
      match: full,
      quotedDialogue: quoted,
      charsInShot,
      reason: `Speaker tag "${subject}" is too generic. ${charsInShot.length} characters in shot (${charsInShot.join(', ')}) — the video model cannot tell which one is speaking. Replace with a unique visual descriptor (clothing, age, posture, position) from <character_tags>.`,
    });
  }
  return warnings;
}
