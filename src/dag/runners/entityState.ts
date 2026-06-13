/**
 * Entity state continuity — pure projection layer.
 *
 * A production's continuity is modelled as an append-only LEDGER
 * (`plans/continuity_plan.json`): per ENTITY (a character, a setting, or a
 * key object), an ordered list of state-change EVENTS anchored to the shot
 * where they first apply. The "current state" of an entity at any shot is a
 * deterministic FOLD of the events whose anchor shot is at or before it.
 *
 * Entities carry an OPEN facet bag — the continuity planner names whatever
 * matters for that entity: a character has `outfit`/`condition`/`hair`, a
 * setting has `lighting`/`time_of_day`/`weather`/`damage`, an object has
 * `state`/`powered`/`open`. A global TRANSIENT_FACET_KEYS set
 * (props/posture/expression/…) is excluded from the reference-variant key,
 * so a held torch or a pose never mints a new reference image, but a
 * wardrobe / lighting / damage change does.
 *
 * Fold semantics:
 *   - Each facet is LAST-WRITE-WINS: the most recent event that sets it
 *     wins; facets a later event doesn't mention CARRY FORWARD unchanged.
 *   - A list-valued facet (e.g. `props`) is a FULL-SET REPLACEMENT — the
 *     event that touches it declares the complete current set.
 *   - Shot ordering is canonical NUMERIC (scene, shot), never lexicographic
 *     ("scene_1_shot_10" sorts AFTER "scene_1_shot_9").
 *
 * The module is free of filesystem / project access so it is trivially
 * unit-testable; runners source the ledger from a declared `continuity_plan`
 * input and call buildEntityStateContext() / refKeyForEntityAtShot() /
 * enumerateStateVariants().
 *
 * PER-KIND HANDLERS (declared by the bundle, not this module). Each kind maps
 * to: a base-asset input, a MINT node, a shot-reference `type`, and a
 * TRANSIENT facet set. Visual kinds (character/setting/object/creature/…)
 * share the "edit the base image" mint (comfy.klein) and resolve in the image
 * runner. A NON-VISUAL kind like `voice` (a narrator whose register evolves)
 * uses the SAME ledger/fold/refKey here, but a different mint (TTS /
 * voice-design) and resolves in the audio runner. Because "material vs
 * transient" is itself per-kind — a character's facial `expression` is
 * transient, yet a voice's emotional `register` is MATERIAL — the transient
 * set is a per-call parameter (default = the visual set); each kind's runner
 * passes its own.
 */
import { createHash } from 'node:crypto';

/**
 * Entity kind — an OPEN, bundle-declared string, NOT a fixed enum. Common
 * kinds today are 'character', 'setting', 'object', but the engine is
 * content-agnostic: new modalities add their own ('creature', 'vehicle',
 * 'voice', 'chart', …) WITHOUT touching this module. The core treats kind as
 * an opaque tag and never branches on it; per-kind base asset, mint node, and
 * shot-reference `type` live in bundle/runner config keyed by the kind string.
 * (Note: the universal ledger/fold/refKey covers any kind, but a non-visual
 * kind like 'voice' needs its own mint — the edit-a-base-image mint is
 * visual-only.)
 */
export type EntityKind = string;

/** Open bag of state facets. Scalar facets are strings; list facets are string[]. */
export type EntityFacets = Record<string, string | string[]>;

/**
 * DEFAULT (visual-kind) transient facet keys — per-shot details that should
 * NOT mint a distinct reference image (a held torch, a pose, a glance). These
 * are excluded from the reference-variant key (refKey) for visual kinds.
 *
 * "Transient vs material" is per-kind, so this is only the DEFAULT: a
 * non-visual kind (e.g. `voice`, where emotional `register` is material, not
 * transient) passes its own set to computeRefKey / materialFacets /
 * enumerateStateVariants / refKeyForEntityAtShot.
 */
export const DEFAULT_TRANSIENT_FACET_KEYS = new Set<string>([
  'props',
  'posture',
  'pose',
  'expression',
  'gaze',
  'action',
  'gesture',
  'holding',
]);

export interface EntityStateEvent {
  /** Canonical shot id (scene_N_shot_M) from which this change applies. */
  atShot: string;
  /** The facets that change at this anchor. Unspecified facets carry forward. */
  facets: EntityFacets;
  /** Optional continuity annotation (why). Not part of any key. */
  note?: string;
}

export interface EntityLedgerEntry {
  /** Entity id — matches the id in its plan (characters_plan / settings_plan / objects_plan). */
  id: string;
  kind: EntityKind;
  events: EntityStateEvent[];
}

export interface ContinuityLedger {
  entities: EntityLedgerEntry[];
}

/** The folded current state of one entity at a specific shot. */
export interface EntityStateAtShot {
  id: string;
  kind: EntityKind;
  /** Folded facets (empty == base / no divergence from the entity's plan). */
  facets: EntityFacets;
  /** Stable key for the FULL state (incl. transient facets). */
  stateKey: string;
  /** Stable key for the MATERIAL state (transient facets removed) — drives reference variants. */
  refKey: string;
  changedThisShot: boolean;
  note?: string;
}

export interface EntityStateContext {
  itemId?: string;
  entities: EntityStateAtShot[];
}

/** A distinct entity STATE that warrants its own minted reference image. */
export interface StateVariant {
  /** Collection item id: `${entityId}__${refKey}`. */
  id: string;
  entityId: string;
  kind: EntityKind;
  /** Material-state key (see computeRefKey). Never "base". */
  refKey: string;
  /** The material facets that define this variant. */
  facets: EntityFacets;
}

/** Derived-input dependency edge (structurally compatible with the walker's edge shape). */
export interface EntityStateDependency {
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

/** Total order over canonical shot ids by (scene, shot) numerically. */
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

function normalizeKind(value: unknown): EntityKind {
  // Any non-empty string is a valid (bundle-declared) kind; default to character.
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'character';
}

function normalizeFacets(value: unknown): EntityFacets {
  const obj = asRecord(value) ?? {};
  const out: EntityFacets = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      if (v.trim().length > 0) out[k] = v;
    } else if (Array.isArray(v)) {
      const arr = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
      if (arr.length > 0) out[k] = arr;
    }
  }
  return out;
}

/**
 * Coerce arbitrary parsed JSON into a well-formed ledger, dropping junk.
 * Accepts the canonical `{entities:[{id,kind,events}]}` shape AND the legacy
 * `{characters:[{id,events}]}` shape (mapped to kind=character) so projects
 * created before the generalization still fold.
 */
export function normalizeLedger(value: unknown): ContinuityLedger {
  const obj = asRecord(value);
  let raw = obj?.['entities'];
  const legacy = obj?.['characters'];
  if (!Array.isArray(raw) && Array.isArray(legacy)) {
    raw = legacy.map((c) => {
      const r = asRecord(c) ?? {};
      return { ...r, kind: 'character' };
    });
  }
  if (!Array.isArray(raw)) return { entities: [] };

  const entities: EntityLedgerEntry[] = [];
  for (const rawEntity of raw) {
    const r = asRecord(rawEntity);
    const id = r?.['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    const events: EntityStateEvent[] = [];
    const rawEvents = r?.['events'];
    if (Array.isArray(rawEvents)) {
      for (const re of rawEvents) {
        const e = asRecord(re);
        const atShot = e?.['atShot'];
        if (typeof atShot !== 'string') continue;
        const ev: EntityStateEvent = { atShot, facets: normalizeFacets(e?.['facets']) };
        const note = e?.['note'];
        if (typeof note === 'string') ev.note = note;
        events.push(ev);
      }
    }
    entities.push({ id, kind: normalizeKind(r?.['kind']), events });
  }
  return { entities };
}

// ── Fold ─────────────────────────────────────────────────────────────────

function foldFacets(
  events: EntityStateEvent[],
  uptoShotId: string,
): { facets: EntityFacets; changedThisShot: boolean; note?: string } {
  const applicable = events
    .filter((e) => compareShotIds(e.atShot, uptoShotId) <= 0)
    .sort((a, b) => compareShotIds(a.atShot, b.atShot));

  const facets: EntityFacets = {};
  for (const e of applicable) {
    for (const [k, v] of Object.entries(e.facets)) {
      facets[k] = Array.isArray(v) ? [...v] : v; // last-write-wins; list = full replace
    }
  }

  const changedThisShot = applicable.some((e) => e.atShot === uptoShotId);
  const last = applicable[applicable.length - 1];
  const result: { facets: EntityFacets; changedThisShot: boolean; note?: string } = { facets, changedThisShot };
  if (last?.note !== undefined) result.note = last.note;
  return result;
}

/** The material subset of a facet bag — everything that isn't transient for this kind. */
function materialFacets(
  facets: EntityFacets,
  transientKeys: ReadonlySet<string> = DEFAULT_TRANSIENT_FACET_KEYS,
): EntityFacets {
  const out: EntityFacets = {};
  for (const [k, v] of Object.entries(facets)) {
    if (!transientKeys.has(k)) out[k] = v;
  }
  return out;
}

// ── State keys ─────────────────────────────────────────────────────────────

const SLUG_MAX = 48;

/**
 * Stable, filename-safe key for a facet bag. Empty → "base"; otherwise
 * `<readable-slug>__<sha256-8>`. Order-independent (keys sorted, list values
 * sorted), so the same state in any field/list order yields the same key.
 */
export function computeStateKey(facets: EntityFacets): string {
  const canonical: Record<string, string | string[]> = {};
  for (const k of Object.keys(facets).sort()) {
    const v = facets[k];
    if (typeof v === 'string') {
      const s = v.trim();
      if (s.length > 0) canonical[k] = s;
    } else if (Array.isArray(v)) {
      const arr = v.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
      if (arr.length > 0) canonical[k] = [...arr].sort();
    }
  }
  if (Object.keys(canonical).length === 0) return 'base';

  const hash8 = createHash('sha256').update(JSON.stringify(canonical)).digest('hex').slice(0, 8);

  const parts: string[] = [];
  for (const k of Object.keys(canonical)) {
    const v = canonical[k]!;
    parts.push(Array.isArray(v) ? v.join(' ') : v);
  }
  let slug = parts
    .join(' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (slug.length > SLUG_MAX) slug = slug.slice(0, SLUG_MAX).replace(/_+$/g, '');
  if (slug.length === 0) slug = 'state';
  return `${slug}__${hash8}`;
}

/**
 * Key for the reference ASSET an entity needs in a given state — derived ONLY
 * from MATERIAL facets (the kind's transient facets removed). "base" when the
 * entity hasn't materially diverged from its plan. Pass the kind's transient
 * set; defaults to the visual set.
 */
export function computeRefKey(
  facets: EntityFacets,
  transientKeys: ReadonlySet<string> = DEFAULT_TRANSIENT_FACET_KEYS,
): string {
  return computeStateKey(materialFacets(facets, transientKeys));
}

// ── Projection ─────────────────────────────────────────────────────────────

/** Fold every entity in the ledger to its current state at `shotId`. */
export function stateAtShot(ledger: ContinuityLedger, shotId: string): EntityStateContext {
  const entities: EntityStateAtShot[] = ledger.entities.map((e) => {
    const { facets, changedThisShot, note } = foldFacets(e.events, shotId);
    const entry: EntityStateAtShot = {
      id: e.id,
      kind: e.kind,
      facets,
      stateKey: computeStateKey(facets),
      refKey: computeRefKey(facets),
      changedThisShot,
    };
    if (note !== undefined) entry.note = note;
    return entry;
  });
  return { itemId: shotId, entities };
}

/**
 * The reference-image key for ONE entity at a given shot. "base" when it
 * hasn't materially diverged (or isn't in the ledger). The shot renderer
 * uses this to pick a state-variant reference (`${entityId}__${refKey}`)
 * over the entity's base asset.
 */
export function refKeyForEntityAtShot(
  ledgerInput: unknown,
  shotId: string,
  entityId: string,
  transientKeys: ReadonlySet<string> = DEFAULT_TRANSIENT_FACET_KEYS,
): string {
  const ledger = normalizeLedger(ledgerInput);
  const e = ledger.entities.find((x) => x.id === entityId);
  if (!e) return 'base';
  return computeRefKey(foldFacets(e.events, shotId).facets, transientKeys);
}

export interface BuildEntityStateContextOptions {
  /** The continuity ledger as loaded from the declared input (untrusted shape). */
  ledger: unknown;
  /** The current shot id. */
  itemId?: string;
  /** Optional: restrict to one entity kind. */
  kind?: EntityKind;
}

export interface BuildEntityStateContextResult {
  context: EntityStateContext;
  additionalDependencies: EntityStateDependency[];
}

/**
 * Runner-facing entry point: normalize the ledger, fold to the current shot,
 * and return only the entities that have DIVERGED from their base (those the
 * shot-prompt LLM needs reminding about). No dependency edges are emitted —
 * the bundle declares `continuity_plan` as a normal input, so the walker
 * already tracks the edge for ordering and invalidation.
 */
export function buildEntityStateContext(opts: BuildEntityStateContextOptions): BuildEntityStateContextResult {
  const ledger = normalizeLedger(opts.ledger);
  if (opts.itemId === undefined) {
    return { context: { entities: [] }, additionalDependencies: [] };
  }
  const full = stateAtShot(ledger, opts.itemId);
  let diverged = full.entities.filter((e) => Object.keys(e.facets).length > 0);
  if (opts.kind) diverged = diverged.filter((e) => e.kind === opts.kind);
  return { context: { itemId: opts.itemId, entities: diverged }, additionalDependencies: [] };
}

/**
 * The distinct reference variants to mint. For each entity (optionally
 * filtered to one kind), fold at every event anchor, collect the distinct
 * non-base MATERIAL states (deduped by refKey), and return one StateVariant
 * each. Transient-only changes collapse to no variant, so the count is
 * bounded by material (appearance/lighting/damage) changes.
 */
export function enumerateStateVariants(
  ledgerInput: unknown,
  kind?: EntityKind,
  transientKeys: ReadonlySet<string> = DEFAULT_TRANSIENT_FACET_KEYS,
): StateVariant[] {
  const ledger = normalizeLedger(ledgerInput);
  const variants: StateVariant[] = [];
  for (const e of ledger.entities) {
    if (kind && e.kind !== kind) continue;
    const anchors = e.events.map((ev) => ev.atShot).sort((a, b) => compareShotIds(a, b));
    const seen = new Set<string>();
    for (const anchor of anchors) {
      const facets = foldFacets(e.events, anchor).facets;
      const refKey = computeRefKey(facets, transientKeys);
      if (refKey === 'base' || seen.has(refKey)) continue;
      seen.add(refKey);
      variants.push({
        id: `${e.id}__${refKey}`,
        entityId: e.id,
        kind: e.kind,
        refKey,
        facets: materialFacets(facets, transientKeys),
      });
    }
  }
  return variants;
}
