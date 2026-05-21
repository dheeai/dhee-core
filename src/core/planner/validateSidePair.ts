/**
 * Side A/B pairing invariant validator (Bug 3 — Ruby V3 s3s6).
 *
 * Side A/B labels are camera-angle markers for an OTS (over-the-shoulder)
 * exchange. They are only meaningful when a true PAIR exists — exactly two
 * characters in the same shot, one foreground (A) and one silhouette (B).
 *
 * Pre-fix: parseTurn2RefsJson applied this rule on turn-2 LLM output, but
 * later normalizer passes (alignFramesToFirstFrame in particular) could
 * mutate references[] and leave a half-specified pair behind. Klein then
 * rendered the half-pair as asymmetric framing — exactly the OTS-with-
 * single-char anti-pattern Should 6.1 was supposed to prevent.
 *
 * This helper is the missing re-validation pass. Call it after ANY
 * mutation to references[] that touches side labels or character refs.
 *
 * Rules:
 *   6.2: side on a setting/object → strip (only characters get sides)
 *   6.1: two characters both side='A' (or both 'B') → keep first, strip dupes
 *   6.3: only one character ref total → strip its side label (no OTS solo)
 *   combined: half-specified pair (only one of two chars labelled) → strip
 *
 * Pure, in-place. Returns the input array for chaining.
 */
interface SideRef {
  type?: string;
  side?: string | undefined;
}

export function validateSidePair<T extends SideRef>(refs: T[]): T[] {
  // 6.2 — strip side from non-characters.
  for (const ref of refs) {
    if (ref.type !== 'character' && ref.side !== undefined) {
      delete ref.side;
    }
  }

  // 6.1 — at most one side='A' and at most one side='B' (keep first).
  let seenA = false;
  let seenB = false;
  for (const ref of refs) {
    if (ref.type !== 'character' || ref.side === undefined) continue;
    if (ref.side === 'A') {
      if (seenA) delete ref.side;
      else seenA = true;
    } else if (ref.side === 'B') {
      if (seenB) delete ref.side;
      else seenB = true;
    }
  }

  // 6.3 + combined — OTS pairing requires BOTH foreground (A) AND
  // silhouette (B). If either is missing OR there's <2 characters, strip.
  const characters = refs.filter(r => r.type === 'character');
  if (characters.length < 2) {
    for (const ref of characters) delete ref.side;
  } else {
    const hasA = characters.some(r => r.side === 'A');
    const hasB = characters.some(r => r.side === 'B');
    if (!(hasA && hasB)) {
      for (const ref of characters) delete ref.side;
    }
  }

  return refs;
}
