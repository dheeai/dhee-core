/**
 * Normalize a shot's image-prompt frame.
 *
 * Two independent passes, applied in order by `normalizeShotImagePromptWithRefs`:
 *
 * 1. INJECT missing character/setting refs (`injectMissingShotRefs`).
 *    The LLM frequently names a character in prose ("Parvati standing
 *    frozen...") but forgets to add "from image N" and/or forgets to
 *    list her in the `references` array. Measured on a real project:
 *    ~39% of frames dropped the "from image N" phrase for a character,
 *    ~43% dropped the character from the references array entirely.
 *    This pass scans the prose against the canonical available-refs
 *    list (same list the prompt gave the LLM), and for every ref whose
 *    label appears in prose:
 *      - if "from image N" with the canonical N is absent → inject it
 *        after the first name mention
 *      - if the ref is absent from the references array → append it
 *
 * 2. REORDER refs so settings come before characters (`reorderShotRefs`).
 *    Klein's edit workflow has 4 LoadImage nodes (base_image +
 *    reference_image_1..3). Whatever ref is at index 0 of the upload
 *    list lands in `base_image`, which Klein weights heavily for
 *    compositional framing. When characters sit at index 0, characters
 *    dominate the frame and the environment gets weak. Pushing
 *    settings to index 0 fixes that. Reordering happens here (not at
 *    the upload layer) because the prompt text says "from image 1",
 *    "from image 2", etc., and those numbers MUST track the final
 *    upload order — so this pass also renumbers both the refs array
 *    and every `from image N` phrase in `imagePrompt` to stay in
 *    lockstep.
 */

export interface ShotImagePromptRef {
  imageNumber: number;
  type: 'character' | 'setting' | string;
  refId: string;
  [k: string]: unknown;
}

export interface ShotImagePromptFrame {
  imagePrompt: string;
  references: ShotImagePromptRef[];
  [k: string]: unknown;
}

/**
 * The canonical reference list the prompt gave to the LLM. Label is the
 * itemId form (snake_case, e.g. "parvati", "mrs._singh",
 * "district_sports_complex"); we convert it to prose form ("mrs. singh")
 * for matching. Same shape as `AvailableRef` in shotReferenceMapping.ts.
 */
export interface AvailableRefMinimal {
  imageNumber: number;
  type: 'character' | 'setting' | 'object' | string;
  refId: string;
  label: string;
}

export interface InjectionEvent {
  /** The canonical label we matched in prose. */
  label: string;
  /** The canonical image number assigned by availableRefs. */
  imageNumber: number;
  /** What we actually injected. */
  kind: 'phrase' | 'array' | 'both';
}

const WORD_BOUNDARY_PREFIX = '(?<![A-Za-z0-9])';
const WORD_BOUNDARY_SUFFIX = '(?![A-Za-z0-9])';

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert an itemId label ("mrs._singh") to the form likely to appear
 * in prose ("mrs. singh"). Underscores → spaces; casing is handled at
 * the regex level (case-insensitive).
 */
function labelToProseForm(label: string): string {
  return label.replace(/_/g, ' ').trim();
}

/**
 * Scan the prose for mentions of each availableRef's label. For each
 * label found in prose:
 *   - if "from image <canonical N>" is absent anywhere in prose, inject
 *     it immediately after the first name mention
 *   - if the ref is missing from the references array (matched by
 *     refId), append it
 *
 * Pure function: returns a new frame + a log of what was injected.
 */
export function injectMissingShotRefs(
  frame: ShotImagePromptFrame,
  availableRefs: AvailableRefMinimal[],
): { frame: ShotImagePromptFrame; injected: InjectionEvent[] } {
  const injected: InjectionEvent[] = [];
  if (!availableRefs || availableRefs.length === 0) return { frame, injected };

  let prose = frame.imagePrompt ?? '';
  const refsArr: ShotImagePromptRef[] = [...(frame.references ?? [])];

  // Track the max imageNumber currently in use so we can allocate
  // unique numbers for any ref we ADD (never colliding with the
  // frame's existing local numbering).
  let maxN = 0;
  for (const r of refsArr) {
    if (typeof r.imageNumber === 'number' && r.imageNumber > maxN) maxN = r.imageNumber;
  }

  for (const ar of availableRefs) {
    const proseForm = labelToProseForm(ar.label);
    if (proseForm.length < 2) continue;

    // Case-insensitive, numeric/alpha word-boundary match. Allows labels
    // containing spaces or dots ("mrs. singh") because we don't require
    // `\b` (which treats `.` as a non-word char and would split).
    const nameRe = new RegExp(
      `${WORD_BOUNDARY_PREFIX}${escapeRegex(proseForm)}${WORD_BOUNDARY_SUFFIX}`,
      'i',
    );
    const match = nameRe.exec(prose);
    if (!match) continue; // Label not used in this frame's prose.

    // Adjacency check: is the FIRST occurrence of the name immediately
    // followed by `from image N` for ANY N (with optional possessive
    // `'s`)? If yes, the LLM already wrote a tag — even if N is wrong,
    // a downstream pass (reorder + renumber, or alignFramesToFirstFrame)
    // will fix the number. Re-injecting `from image canonicalN` here
    // would create a duplicate like "Parvati from image 2 from image 1"
    // because the existing wrong tag stays in place.
    const adjacencyRe = new RegExp(
      `${WORD_BOUNDARY_PREFIX}${escapeRegex(proseForm)}${WORD_BOUNDARY_SUFFIX}(?:'s)?\\s+from\\s+image\\s+\\d+\\b`,
      'i',
    );
    const hasAdjacentTag = adjacencyRe.test(prose);

    // refId is the stable identity (e.g. "character_image:parvati").
    // We don't match on imageNumber because the LLM sometimes uses a
    // different one — we trust the canonical.
    const existingRef = refsArr.find(r => r.refId === ar.refId);
    const hasRef = !!existingRef;

    if (hasAdjacentTag && hasRef) continue;

    // Decide which imageNumber to use for the injected tag/ref.
    //   - If the ref is ALREADY in this frame's refsArr (under any
    //     number — possibly placed by the LLM), use that local number.
    //     This keeps prose consistent with the frame's own numbering.
    //   - Else, allocate the next free number (maxN + 1). NEVER use
    //     `ar.imageNumber` directly — that's the project-wide canonical
    //     from buildAvailableRefsForShot, which has nothing to do with
    //     the frame's shot-specific numbering and would inject a stale
    //     tag like "Singh bungalow from image 5" into a frame where
    //     the setting is actually at local image 1.
    const targetN = existingRef ? (existingRef.imageNumber) : ++maxN;

    if (!hasAdjacentTag) {
      const insertAt = match.index + match[0].length;
      prose = prose.slice(0, insertAt) + ` from image ${targetN}` + prose.slice(insertAt);
    }

    if (!hasRef) {
      refsArr.push({
        imageNumber: targetN,
        type: ar.type,
        refId: ar.refId,
      });
    }

    const kind: InjectionEvent['kind'] =
      (!hasAdjacentTag && !hasRef) ? 'both' : (!hasAdjacentTag ? 'phrase' : 'array');
    injected.push({ label: ar.label, imageNumber: targetN, kind });
  }

  return {
    frame: { ...frame, imagePrompt: prose, references: refsArr },
    injected,
  };
}

/**
 * Reorder refs so settings sit at index 0 (Klein's base_image slot),
 * renumber the array to 1..N, and rewrite every `from image N` phrase
 * in prose to match the new numbering.
 *
 * No-op if there are no setting refs, or if there's nothing to reorder.
 */
export function normalizeShotImagePrompt(frame: ShotImagePromptFrame): ShotImagePromptFrame {
  const refs = frame.references ?? [];
  if (refs.length === 0) return frame;

  // Bucket by type, stable within bucket.
  const settings: ShotImagePromptRef[] = [];
  const characters: ShotImagePromptRef[] = [];
  const others: ShotImagePromptRef[] = [];
  for (const r of refs) {
    if (r.type === 'setting') settings.push(r);
    else if (r.type === 'character') characters.push(r);
    else others.push(r);
  }

  // If nothing to reorder (all settings, or no settings), bail early.
  if (settings.length === 0 || (characters.length === 0 && others.length === 0)) {
    return frame;
  }

  const ordered = [...settings, ...characters, ...others];

  // Build oldNumber → newNumber map. Skip any ref whose new position
  // matches its old position (so the prompt rewrite doesn't touch it).
  const remap = new Map<number, number>();
  ordered.forEach((r, i) => {
    const newNumber = i + 1;
    if (r.imageNumber !== newNumber) remap.set(r.imageNumber, newNumber);
  });

  // Rewrite refs with new imageNumbers.
  const rewrittenRefs: ShotImagePromptRef[] = ordered.map((r, i) => ({
    ...r,
    imageNumber: i + 1,
  }));

  // Rewrite `from image N` in prose. Single pass with a callback avoids
  // the cascading-substitution trap (e.g. rewriting 1→2 then rewriting
  // THAT 2→1 back to where it started).
  const pattern = /\bfrom image (\d+)\b/gi;
  const rewrittenPrompt = frame.imagePrompt.replace(pattern, (match, nStr: string) => {
    const oldN = parseInt(nStr, 10);
    const newN = remap.get(oldN);
    if (newN === undefined) return match; // number not in refs → leave alone
    // Preserve the caller's "From Image" casing of the word "image"
    const keyword = match.slice(0, match.lastIndexOf(' ')); // "from image" or "From Image"
    return `${keyword} ${newN}`;
  });

  return {
    ...frame,
    references: rewrittenRefs,
    imagePrompt: rewrittenPrompt,
  };
}

/**
 * Rewrite `<name> from image M` to `<name> from image targetN`
 * whenever the prose tagged a known label with the wrong number.
 *
 * Common LLM failure mode: the LLM was given shot-specific numbering
 * via `<available_references>` but mixes in project-wide numbers, or
 * the reorder pass renumbered refs and the prose lags behind. The
 * targetN is read from the FRAME's CURRENT references[] (matched by
 * refId via availableRefs.label) — NOT from availableRefs.imageNumber,
 * which is the project-wide canonical and won't match the frame's
 * shot-specific numbering.
 *
 * If a label has no entry in the frame's references[], we leave it
 * alone (could be a setting whose label doesn't appear in the prose
 * for this frame, or a hallucinated mention of a different character).
 */
export function correctProseNumbersByName(
  frame: ShotImagePromptFrame,
  availableRefs: AvailableRefMinimal[],
): ShotImagePromptFrame {
  if (!availableRefs || availableRefs.length === 0) return frame;
  const refs = Array.isArray(frame.references) ? frame.references : [];
  if (refs.length === 0) return frame;

  // Build refId → current imageNumber from THIS frame's refs.
  const currentNumberByRefId = new Map<string, number>();
  for (const r of refs) {
    if (typeof r.refId === 'string' && typeof r.imageNumber === 'number') {
      currentNumberByRefId.set(r.refId, r.imageNumber);
    }
  }

  let prose = frame.imagePrompt ?? '';

  for (const ar of availableRefs) {
    const proseForm = labelToProseForm(ar.label);
    if (proseForm.length < 2) continue;

    const targetN = currentNumberByRefId.get(ar.refId);
    if (targetN === undefined) continue; // Ref not in this frame's refs.

    // Capture group 1: the name + optional possessive + " from image ".
    // Capture group 2: the number M to validate.
    const re = new RegExp(
      `(${WORD_BOUNDARY_PREFIX}${escapeRegex(proseForm)}${WORD_BOUNDARY_SUFFIX}(?:'s)?\\s+from\\s+image\\s+)(\\d+)\\b`,
      'gi',
    );
    prose = prose.replace(re, (_match, prefix: string, mStr: string) => {
      const m = parseInt(mStr, 10);
      if (m === targetN) return `${prefix}${m}`;
      return `${prefix}${targetN}`;
    });
  }

  return { ...frame, imagePrompt: prose };
}

/**
 * Convenience: inject missing refs (pass 1), then reorder + renumber
 * (pass 2), then correct any name-tagged wrong numbers (pass 3). This
 * is what ExecutorAgent should call at the output boundary. Returns
 * both the final frame and the injection log so the caller can emit
 * telemetry / debug logs.
 */
export function normalizeShotImagePromptWithRefs(
  frame: ShotImagePromptFrame,
  availableRefs: AvailableRefMinimal[],
): { frame: ShotImagePromptFrame; injected: InjectionEvent[] } {
  const after1 = injectMissingShotRefs(frame, availableRefs);
  const after2 = normalizeShotImagePrompt(after1.frame);
  const after3 = correctProseNumbersByName(after2, availableRefs);
  return { frame: after3, injected: after1.injected };
}

/**
 * Force every non-first frame to use first_frame's (refId → imageNumber)
 * mapping as canonical. Fixes two LLM failure modes seen in practice:
 *
 *   1. Renumbering — last_frame uses N=1 for a refId that first_frame
 *      had at N=2. We rewrite the frame's `from image N` tags so they
 *      match first_frame, and fix the `references[]` numbers to match.
 *
 *   2. Dropped refs — last_frame omits one of first_frame's refs
 *      (commonly the setting, because last_frame prose mentions only
 *      "gate" or "mudroom" rather than the canonical setting label).
 *      We append the missing first_frame ref at its canonical number.
 *
 * For genuinely NEW refs introduced ONLY in a non-first frame
 * (e.g., a character entering the scene), we keep their imageNumber
 * unless it collides with a canonical first_frame number — in which
 * case we move the new ref to the next free number and rewrite its
 * `from image N` tag in prose accordingly.
 *
 * Mutates `parsed` in place.
 */
export function alignFramesToFirstFrame(
  parsed: unknown,
  availableRefs: AvailableRefMinimal[] = [],
): void {
  if (!parsed || typeof parsed !== 'object') return;
  const p = parsed as { frames?: Record<string, ShotImagePromptFrame | undefined> };
  if (!p.frames || typeof p.frames !== 'object') return;

  const firstFrame = p.frames['first_frame'];
  const firstRefs = Array.isArray(firstFrame?.references)
    ? (firstFrame.references)
    : [];
  if (firstRefs.length === 0) return;

  // Canonical: refId → imageNumber from first_frame.
  const canonicalNumberByRefId = new Map<string, number>();
  for (const r of firstRefs) {
    if (typeof r.refId === 'string' && typeof r.imageNumber === 'number') {
      canonicalNumberByRefId.set(r.refId, r.imageNumber);
    }
  }
  const canonicalNumbers = new Set(canonicalNumberByRefId.values());

  for (const [frameKey, frame] of Object.entries(p.frames)) {
    if (frameKey === 'first_frame' || !frame) continue;
    if (typeof frame.imagePrompt !== 'string') continue;

    const localRefs: ShotImagePromptRef[] = Array.isArray(frame.references)
      ? frame.references
      : [];

    // Build renumber map: localN → newN. Two sources of remap:
    //   (a) refId is in first_frame at a different N — local must move to canonical.
    //   (b) refId is local-only and its number collides with a canonical — move
    //       to the next free number above the canonicals.
    const renumber = new Map<number, number>();
    const usedNumbers = new Set<number>(canonicalNumbers);

    // Pass (a): shared refIds.
    for (const r of localRefs) {
      const canonicalN = canonicalNumberByRefId.get(r.refId);
      if (canonicalN !== undefined && r.imageNumber !== canonicalN) {
        renumber.set(r.imageNumber, canonicalN);
      }
    }

    // Pass (b): local-only refs that collide with a canonical N. Pick the
    // next free number, scanning above the highest canonical so we never
    // reuse a canonical number for a different refId.
    let nextFree = (usedNumbers.size > 0 ? Math.max(...usedNumbers) : 0) + 1;
    for (const r of localRefs) {
      if (canonicalNumberByRefId.has(r.refId)) continue;
      if (canonicalNumbers.has(r.imageNumber)) {
        renumber.set(r.imageNumber, nextFree);
        usedNumbers.add(nextFree);
        nextFree += 1;
      } else {
        usedNumbers.add(r.imageNumber);
      }
    }

    // Rewrite prose `from image N` using the renumber map. Single-pass
    // callback replace prevents cascading double-substitution on swaps.
    let prose = frame.imagePrompt;
    if (renumber.size > 0) {
      prose = prose.replace(/\bfrom\s+image\s+(\d+)\b/gi, (match, mStr: string) => {
        const m = parseInt(mStr, 10);
        const newN = renumber.get(m);
        if (newN === undefined) return match;
        const keyword = match.slice(0, match.lastIndexOf(' '));
        return `${keyword} ${newN}`;
      });
    }

    // Name-based correction against first_frame canonical: rewrite any
    // `<name> from image M` to `<name> from image canonicalN` where the
    // name matches an availableRefs label. Without this, a tag like
    // "Parvati from image 1" (when canonical Parvati = 2) leaves a
    // false-positive `from image 1` in tagsInProse — and align's
    // inheritance loop would then INCORRECTLY think "image 1 is
    // tagged" and inherit the setting (canonical N = 1), producing a
    // genuine ORPHAN_REF when the post-correction prose no longer
    // mentions image 1 anywhere.
    for (const ar of availableRefs) {
      const proseForm = labelToProseForm(ar.label);
      if (proseForm.length < 2) continue;
      const targetN = canonicalNumberByRefId.get(ar.refId);
      if (targetN === undefined) continue;
      const re = new RegExp(
        `(${WORD_BOUNDARY_PREFIX}${escapeRegex(proseForm)}${WORD_BOUNDARY_SUFFIX}(?:'s)?\\s+from\\s+image\\s+)(\\d+)\\b`,
        'gi',
      );
      prose = prose.replace(re, (_match, prefix: string, mStr: string) => {
        const m = parseInt(mStr, 10);
        return m === targetN ? `${prefix}${m}` : `${prefix}${targetN}`;
      });
    }

    // After the renumber and name-correction passes, prose `from image N`
    // tags use canonical numbering. Collect every N still tagged.
    let tagsInProse = new Set<number>(
      [...prose.matchAll(/\bfrom\s+image\s+(\d+)\b/gi)].map(m => parseInt(m[1]!, 10)),
    );

    // Heuristic: rewrite a hallucinated orphan tag to the canonical N
    // of an inferable first_frame ref. A tag is "covered" if it
    // corresponds to either:
    //   (a) a local ref's (renumbered) number, OR
    //   (b) a first_frame ref whose canonical N is tagged in prose
    //       (will be inherited in the loop below).
    // Anything else is an orphan. A first_frame ref is "uncovered" if
    // it's not in localRefs AND its canonical N isn't in prose tags.
    // When there's exactly ONE orphan tag and ONE uncovered first_frame
    // ref, the mapping is unambiguous — rewrite the orphan to the
    // uncovered ref's canonical N so it gets inherited correctly.
    //
    // s4sh1 case: localRefs=[], prose has "Parvati from image 2 ...
    // mudroom from image 5". After name-correction, image 2 covers
    // parvati (will be inherited). image 5 is orphan. Setting is the
    // sole uncovered first_frame ref → remap 5→1.
    {
      const coveredNumbers = new Set<number>();
      for (const r of localRefs) {
        coveredNumbers.add(renumber.get(r.imageNumber) ?? r.imageNumber);
      }
      for (const r of firstRefs) {
        if (tagsInProse.has(r.imageNumber)) coveredNumbers.add(r.imageNumber);
      }
      const orphanTags = [...tagsInProse].filter(n => !coveredNumbers.has(n));
      const localRefIds = new Set<string>(localRefs.map(r => r.refId));
      const uncoveredFirstRefs = firstRefs.filter(r =>
        !localRefIds.has(r.refId) && !tagsInProse.has(r.imageNumber),
      );
      if (orphanTags.length === 1 && uncoveredFirstRefs.length === 1) {
        const orphanN = orphanTags[0]!;
        const target = uncoveredFirstRefs[0]!;
        prose = prose.replace(
          new RegExp(`\\bfrom\\s+image\\s+${orphanN}\\b`, 'gi'),
          `from image ${target.imageNumber}`,
        );
        // Recompute tagsInProse so the gating below sees the new state.
        tagsInProse = new Set<number>(
          [...prose.matchAll(/\bfrom\s+image\s+(\d+)\b/gi)].map(m => parseInt(m[1]!, 10)),
        );
      }
    }

    // Build the final references[]:
    //   1. Keep a local ref ONLY if its (renumbered) N appears tagged
    //      in prose. A local ref whose number is never tagged means
    //      the character/setting isn't actually in this frame's beat
    //      (e.g., Isha walked off in last_frame) — the LLM left a
    //      stale entry. Dropping it prevents ORPHAN_REF audit hits.
    //   2. INHERIT a first_frame ref only if its canonical N appears
    //      tagged in prose AND it's not already locally present.
    const finalRefs: ShotImagePromptRef[] = [];
    const seen = new Set<string>();
    for (const r of localRefs) {
      const remappedN = renumber.get(r.imageNumber) ?? r.imageNumber;
      if (!tagsInProse.has(remappedN)) continue;
      finalRefs.push({ ...r, imageNumber: remappedN });
      seen.add(r.refId);
    }
    for (const r of firstRefs) {
      if (seen.has(r.refId)) continue;
      if (!tagsInProse.has(r.imageNumber)) continue;
      finalRefs.push({ ...r });
      seen.add(r.refId);
    }

    frame.references = finalRefs;
    frame.imagePrompt = prose;
  }
}

// ── OTS single-character validator ──────────────────────────────────────────

export interface OTSIssue {
  frame: string;
  characterRefCount: number;
  reason: string;
}

/**
 * Scan a parsed shot_image_prompt for frames that combine OTS
 * (over-the-shoulder) prose with fewer than two character refs.
 *
 * OTS is inherently a two-character composition: foreground anchor
 * blurred + focal subject sharp. With one character, image models
 * react badly:
 *   - Klein: produces a regular medium shot, ignoring the OTS hint.
 *   - Seedream: invents a phantom second character to fill the anchor
 *     slot (real bug from sun_hadnt_yet_cleared-2 s4sh2).
 *
 * Regex deliberately narrow — `\b(over[-\s]the[-\s]shoulder|OTS)\b`.
 * Matches the cinematographic phrase only, NOT unrelated prose like
 * "a bag slung over her shoulder" (false-positive from earlier audit).
 */
export function scanOTSWithSingleChar(parsed: unknown): OTSIssue[] {
  const issues: OTSIssue[] = [];
  if (!parsed || typeof parsed !== 'object') return issues;
  const p = parsed as { frames?: Record<string, ShotImagePromptFrame | undefined> };
  if (!p.frames || typeof p.frames !== 'object') return issues;

  // Three patterns covering the cinematographic uses without false-positive
  // matching of casual prose ("a bag slung over her shoulder"):
  //   (1) `over-the-shoulder` / `OTS` — explicit framing terms.
  //   (2) `Over <Name>['s] shoulder` AT a sentence/clause start — the way
  //       cinematographers describe OTS framings ("Over Parvati's shoulder,
  //       her hand reaches..."). Sentence-start anchor excludes "...slung
  //       over her shoulder" because that's preceded by a verb, not a
  //       boundary.
  const explicitRe = /\b(over[-\s]the[-\s]shoulder|OTS)\b/i;
  const sentenceStartOTSRe = /(?:^|[\n.!?])\s*Over\s+[\w'.]+(?:\s+from\s+image\s+\d+)?'s\s+shoulder/;

  for (const [frameKey, frame] of Object.entries(p.frames)) {
    if (!frame || typeof frame.imagePrompt !== 'string') continue;
    const prose = frame.imagePrompt;
    if (!explicitRe.test(prose) && !sentenceStartOTSRe.test(prose)) continue;

    const refs = Array.isArray(frame.references) ? frame.references : [];
    const characterCount = refs.filter(r => r.type === 'character').length;
    if (characterCount >= 2) continue;

    issues.push({
      frame: frameKey,
      characterRefCount: characterCount,
      reason: `over-the-shoulder framing requires 2+ character refs — found ${characterCount}. OTS is inherently two-character (anchor blurred + focal subject sharp); a single-character OTS shot will either invent a phantom second character or break focus. Use insert / extreme_close_up / close_up framing instead, with the focal element (hands, object, face) as the subject.`,
    });
  }

  return issues;
}
