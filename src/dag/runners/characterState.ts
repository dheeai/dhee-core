/**
 * Character state continuity — pure projection layer.
 *
 * A production's continuity is modelled as an append-only LEDGER
 * (`plans/continuity_plan.json`): per character, an ordered list of
 * state-change EVENTS anchored to the shot where they first apply. The
 * "current state" of a character at any shot is a deterministic FOLD of
 * the events whose anchor shot is at or before that shot.
 *
 * This replaces the lossy alternative — having the shot-prompt LLM
 * re-derive "what is she wearing / holding now" from a sliding window of
 * prior prompts, which forgets state set long ago and drifts. Here the
 * state is computed, not remembered.
 *
 * Fold semantics:
 *   - Each visual facet (outfit / condition / hair / posture) is
 *     LAST-WRITE-WINS: the most recent event that sets it wins; facets a
 *     later event doesn't mention CARRY FORWARD unchanged.
 *   - `props` is a FULL-SET REPLACEMENT: an event that touches props
 *     declares the complete current prop set (the continuity planner is
 *     responsible for restating it), so picking something up or dropping
 *     it is a single declarative event, not a fragile add/remove diff.
 *   - Shot ordering is canonical NUMERIC (scene, shot) — never the
 *     lexicographic order of the id string ("scene_1_shot_10" must sort
 *     AFTER "scene_1_shot_9").
 *
 * The module is intentionally free of filesystem / project access so it
 * is trivially unit-testable; the llm.generate runner sources the ledger
 * from a declared `continuity_plan` input and calls
 * buildCharacterStateContext() to fold it for the current shot.
 */
import { createHash } from 'node:crypto';

/** Mutable, per-shot-variable visual facets layered over a character's base identity. */
export interface CharacterStateFacets {
  /** Wardrobe — e.g. "torn, mud-streaked tank top and cargo shorts". */
  outfit?: string;
  /** Gross physical condition — e.g. "wet", "bloodied, left arm", "covered in dust". */
  condition?: string;
  /** Hair state when it materially differs from base — e.g. "wet, plastered down", "tied up". */
  hair?: string;
  /** Persistent posture when it carries across shots — e.g. "seated", "limping". */
  posture?: string;
  /** Held / worn items. A FULL-SET replacement at each event that touches it. */
  props?: string[];
}

/** A single anchored state change for one character. */
export interface CharacterStateEvent {
  /** Canonical shot id (scene_N_shot_M) from which this change applies. */
  atShot: string;
  /** The facets that change at this anchor. Unspecified facets carry forward. */
  facets: CharacterStateFacets;
  /** Optional continuity annotation (why the change happened). Not part of the state key. */
  note?: string;
}

export interface ContinuityLedgerCharacter {
  /** Character id — matches characters_plan[].id. */
  id: string;
  events: CharacterStateEvent[];
}

export interface ContinuityLedger {
  characters: ContinuityLedgerCharacter[];
}

/** The folded current state of one character at a specific shot. */
export interface CharacterStateAtShot {
  id: string;
  /** Folded facets (empty object == base / no divergence from characters_plan). */
  facets: CharacterStateFacets;
  /** Stable key for the visually-material facets — "base" or `<slug>__<hash8>`. */
  stateKey: string;
  /** True iff a state event is anchored exactly at this shot. */
  changedThisShot: boolean;
  /** Note of the most recent applicable event, if any. */
  note?: string;
}

export interface CharacterStateContext {
  itemId?: string;
  characters: CharacterStateAtShot[];
}

/** A distinct character APPEARANCE that warrants its own minted reference image. */
export interface StateVariant {
  /** Collection item id: `${charId}__${refKey}`. */
  id: string;
  charId: string;
  /** Appearance-only key (see computeRefKey). Never "base". */
  refKey: string;
  /** The appearance facets that define this variant (outfit / condition / hair only). */
  facets: { outfit?: string; condition?: string; hair?: string };
}

/** Derived-input dependency edge (structurally compatible with the walker's edge shape). */
export interface CharacterStateDependency {
  nodeId: string;
  itemId?: string;
  role?: 'input' | 'context' | 'reference' | 'aggregate';
}

// ── Shot ordering ───────────────────────────────────────────────────────

function parseShotId(id: string): { scene: number; shot: number } | undefined {
  const m = /^scene_(\d+)_shot_(\d+)$/.exec(id);
  if (!m) return undefined;
  return { scene: parseInt(m[1]!, 10), shot: parseInt(m[2]!, 10) };
}

/**
 * Total order over canonical shot ids by (scene, shot) numerically.
 * Parseable ids sort before unparseable ones; two unparseable ids fall
 * back to a stable lexical compare.
 */
export function compareShotIds(a: string, b: string): number {
  const pa = parseShotId(a);
  const pb = parseShotId(b);
  if (pa && pb) {
    if (pa.scene !== pb.scene) return pa.scene - pb.scene;
    return pa.shot - pb.shot;
  }
  if (pa) return -1;
  if (pb) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

// ── Defensive normalization (input is untrusted JSON) ────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeFacets(value: unknown): CharacterStateFacets {
  const obj = asRecord(value) ?? {};
  const out: CharacterStateFacets = {};
  for (const key of ['outfit', 'condition', 'hair', 'posture'] as const) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim().length > 0) out[key] = v;
  }
  const props = obj['props'];
  if (Array.isArray(props)) {
    const arr = props.filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    if (arr.length > 0) out.props = arr;
  }
  return out;
}

/** Coerce arbitrary parsed JSON into a well-formed ledger, dropping junk. */
export function normalizeLedger(value: unknown): ContinuityLedger {
  const rawChars = asRecord(value)?.['characters'];
  if (!Array.isArray(rawChars)) return { characters: [] };
  const characters: ContinuityLedgerCharacter[] = [];
  for (const rc of rawChars) {
    const r = asRecord(rc);
    const id = r?.['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    const events: CharacterStateEvent[] = [];
    const rawEvents = r?.['events'];
    if (Array.isArray(rawEvents)) {
      for (const re of rawEvents) {
        const e = asRecord(re);
        const atShot = e?.['atShot'];
        if (typeof atShot !== 'string') continue;
        const ev: CharacterStateEvent = { atShot, facets: normalizeFacets(e?.['facets']) };
        if (typeof e?.['note'] === 'string') ev.note = e['note'] as string;
        events.push(ev);
      }
    }
    characters.push({ id, events });
  }
  return { characters };
}

// ── Fold ─────────────────────────────────────────────────────────────────

function foldFacets(
  events: CharacterStateEvent[],
  uptoShotId: string,
): { facets: CharacterStateFacets; changedThisShot: boolean; note?: string } {
  const applicable = events
    .filter((e) => compareShotIds(e.atShot, uptoShotId) <= 0)
    .sort((a, b) => compareShotIds(a.atShot, b.atShot));

  const facets: CharacterStateFacets = {};
  for (const e of applicable) {
    const f = e.facets;
    if (typeof f.outfit === 'string') facets.outfit = f.outfit;
    if (typeof f.condition === 'string') facets.condition = f.condition;
    if (typeof f.hair === 'string') facets.hair = f.hair;
    if (typeof f.posture === 'string') facets.posture = f.posture;
    if (Array.isArray(f.props)) facets.props = [...f.props];
  }

  const changedThisShot = applicable.some((e) => e.atShot === uptoShotId);
  const last = applicable[applicable.length - 1];
  const result: { facets: CharacterStateFacets; changedThisShot: boolean; note?: string } = {
    facets,
    changedThisShot,
  };
  if (last?.note !== undefined) result.note = last.note;
  return result;
}

// ── State key ─────────────────────────────────────────────────────────────

const SLUG_MAX = 48;

/**
 * Stable, filename-safe key for a character's visually-material state.
 * Empty facets → "base". Otherwise `<readable-slug>__<sha256-8>`. The
 * hash guarantees uniqueness (the slug is truncated for readability);
 * the slug makes minted reference filenames legible in Phase 2.
 *
 * The key is order-independent: same facet values in any field order,
 * with props in any order, yield the same key. The per-event `note` is
 * deliberately NOT an input — two states that differ only in their
 * annotation must share one reference image.
 */
export function computeStateKey(facets: CharacterStateFacets): string {
  const canonical: Record<string, string | string[]> = {};
  for (const key of ['condition', 'hair', 'outfit', 'posture'] as const) {
    const v = facets[key];
    if (typeof v === 'string' && v.trim().length > 0) canonical[key] = v.trim();
  }
  if (facets.props) {
    const arr = facets.props.filter((p) => typeof p === 'string' && p.trim().length > 0);
    if (arr.length > 0) canonical['props'] = [...arr].sort();
  }
  if (Object.keys(canonical).length === 0) return 'base';

  const hash8 = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 8);

  const parts: string[] = [];
  for (const key of ['outfit', 'condition', 'hair', 'posture'] as const) {
    const v = canonical[key];
    if (typeof v === 'string') parts.push(v);
  }
  if (Array.isArray(canonical['props'])) parts.push(canonical['props'].join(' '));
  let slug = parts
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug.length > SLUG_MAX) slug = slug.slice(0, SLUG_MAX).replace(/_+$/g, '');
  if (slug.length === 0) slug = 'state';
  return `${slug}__${hash8}`;
}

/** The appearance subset a reference image should depict — outfit / condition
 * / hair. Excludes props (a character sets them down) and posture (per-shot). */
function pickAppearance(facets: CharacterStateFacets): {
  outfit?: string;
  condition?: string;
  hair?: string;
} {
  const out: { outfit?: string; condition?: string; hair?: string } = {};
  if (typeof facets.outfit === 'string') out.outfit = facets.outfit;
  if (typeof facets.condition === 'string') out.condition = facets.condition;
  if (typeof facets.hair === 'string') out.hair = facets.hair;
  return out;
}

/**
 * Key for the reference IMAGE a character needs in a given state — derived
 * ONLY from persistent appearance (outfit / condition / hair). Held props and
 * posture are deliberately excluded: they're per-shot (the character picks a
 * torch up and sets it down; posture is framing), so they belong in the shot
 * prompt, not in a minted portrait. "base" when appearance matches the intro.
 */
export function computeRefKey(facets: CharacterStateFacets): string {
  return computeStateKey(pickAppearance(facets));
}

// ── Projection ─────────────────────────────────────────────────────────────

/** Fold every character in the ledger to its current state at `shotId`. */
export function stateAtShot(ledger: ContinuityLedger, shotId: string): CharacterStateContext {
  const characters: CharacterStateAtShot[] = ledger.characters.map((c) => {
    const { facets, changedThisShot, note } = foldFacets(c.events, shotId);
    const entry: CharacterStateAtShot = {
      id: c.id,
      facets,
      stateKey: computeStateKey(facets),
      changedThisShot,
    };
    if (note !== undefined) entry.note = note;
    return entry;
  });
  return { itemId: shotId, characters };
}

/**
 * The reference-image key for ONE character at a given shot: fold that
 * character's ledger events up to the shot, then reduce to the appearance
 * key. "base" when the character hasn't visually diverged (or isn't in the
 * ledger at all). The shot renderer uses this to pick a state-variant
 * reference (`${charId}__${refKey}`) over the base portrait.
 */
export function refKeyForCharacterAtShot(ledgerInput: unknown, shotId: string, charId: string): string {
  const ledger = normalizeLedger(ledgerInput);
  const char = ledger.characters.find((c) => c.id === charId);
  if (!char) return 'base';
  return computeRefKey(foldFacets(char.events, shotId).facets);
}

export interface BuildCharacterStateContextOptions {
  /** The continuity ledger as loaded from the declared input (untrusted shape). */
  ledger: unknown;
  /** The current shot id. */
  itemId?: string;
}

export interface BuildCharacterStateContextResult {
  context: CharacterStateContext;
  additionalDependencies: CharacterStateDependency[];
}

/**
 * Runner-facing entry point: normalize the ledger, fold to the current
 * shot, and return only the characters that have DIVERGED from base
 * (those the shot-prompt LLM needs reminding about — base characters are
 * already covered by characters_plan).
 *
 * No dependency edges are emitted: the bundle declares `continuity_plan`
 * as a normal input of the consuming node, so the walker already tracks
 * the edge for ordering and invalidation.
 */
export function buildCharacterStateContext(
  opts: BuildCharacterStateContextOptions,
): BuildCharacterStateContextResult {
  const ledger = normalizeLedger(opts.ledger);
  if (opts.itemId === undefined) {
    return { context: { characters: [] }, additionalDependencies: [] };
  }
  const full = stateAtShot(ledger, opts.itemId);
  const diverged = full.characters.filter((c) => Object.keys(c.facets).length > 0);
  return {
    context: { itemId: opts.itemId, characters: diverged },
    additionalDependencies: [],
  };
}

/**
 * The distinct reference variants to mint for a production. For each
 * character, fold the ledger at every event anchor, collect the distinct
 * non-base APPEARANCE states (deduped by refKey), and return one StateVariant
 * each. Events that change only props/posture collapse to no new variant, so
 * the number of minted references is bounded by appearance changes — not by
 * shot count or every event.
 */
export function enumerateStateVariants(ledgerInput: unknown): StateVariant[] {
  const ledger = normalizeLedger(ledgerInput);
  const variants: StateVariant[] = [];
  for (const c of ledger.characters) {
    const anchors = c.events.map((e) => e.atShot).sort((a, b) => compareShotIds(a, b));
    const seen = new Set<string>();
    for (const anchor of anchors) {
      const { facets } = foldFacets(c.events, anchor);
      const refKey = computeRefKey(facets);
      if (refKey === 'base' || seen.has(refKey)) continue;
      seen.add(refKey);
      variants.push({ id: `${c.id}__${refKey}`, charId: c.id, refKey, facets: pickAppearance(facets) });
    }
  }
  return variants;
}
