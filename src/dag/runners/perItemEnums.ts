/**
 * Per-item enum binding for `llm.generate` — turn a COLLECTION ITEM's allowlist
 * into something the DECODER enforces, instead of a paragraph asking a model to
 * behave.
 *
 * ── Why this is engine work and not a runner ──────────────────────────────
 *
 * A collection node fans out over items, and each item is licensed to use a
 * DIFFERENT set of ids — the section's entities, this chapter's cast, this
 * shot's props. `cfg.outputSchema` is one static path resolved once against
 * `bundleDir`, so every item of the fan-out gets a byte-identical schema and
 * the model is free to write an id belonging to a different item. That is not
 * a property of any one bundle; it is a hole in llm.generate's own contract
 * for structured output over collections, which is why it belongs here.
 *
 * The binding has three layers, weakest last:
 *
 *   1. ENUM — the item's allowlist is injected into a COPY of the output schema
 *      and travels as `response_format.json_schema`. A llama.cpp gateway
 *      compiles that to GBNF, so an out-of-allowlist id becomes UNDECODABLE.
 *   2. CHECK — every id is re-read from the parsed document, for providers that
 *      honour a schema loosely.
 *   3. REPAIR — violations go back into the retry loop that already
 *      self-corrects schema failures, in the same shape of corrective hint.
 *
 * Everything here is PURE — no LLM, no filesystem, no clock. `llmGenerate.ts`
 * does the I/O and calls these; the tests exercise them directly.
 */

/** A path into an authored document. `[]` steps into every element of an array. */
export type IdPath = string;

/**
 * Read every string a path selects, with the concrete path it was found at.
 *
 * `shots[].acting[].subjectId` over a two-shot document yields
 * `shots[0].acting[0].subjectId`, `shots[1].acting[0].subjectId`, … so a
 * violation can name its own location the way the render gate does.
 *
 * `skipWhen` drops a whole object before its leaf is read. It exists for the
 * case where a field is legitimately allowed to sit outside the allowlist —
 * e.g. an H3 off-screen speaker, who
 * has no visual and therefore needs no reference
 * plate. Enforcing the allowlist there would be STRICTER than the consumer's
 * own gate, which is its own kind of broken — a film died three times on that
 * exact over-reach before the H3 runner exempted it.
 */
export function collectIds(
  doc: unknown,
  path: IdPath,
  skipWhen?: (holder: Record<string, unknown>) => boolean,
): Array<{ path: string; value: string }> {
  const steps = path.split('.').filter(Boolean);
  const found: Array<{ path: string; value: string }> = [];

  const walk = (node: unknown, stepIndex: number, trail: string): void => {
    if (node === undefined || node === null) return;
    const step = steps[stepIndex];
    if (step === undefined) {
      if (typeof node === 'string' && node.trim()) found.push({ path: trail, value: node.trim() });
      return;
    }
    const isArrayStep = step.endsWith('[]');
    const key = isArrayStep ? step.slice(0, -2) : step;

    let next: unknown = node;
    let nextTrail = trail;
    if (key) {
      if (typeof node !== 'object' || Array.isArray(node)) return;
      const holder = node as Record<string, unknown>;
      if (skipWhen && skipWhen(holder)) return;
      next = holder[key];
      nextTrail = trail ? `${trail}.${key}` : key;
    }

    if (isArrayStep) {
      if (!Array.isArray(next)) return;
      next.forEach((element, index) => {
        if (skipWhen && element && typeof element === 'object' && !Array.isArray(element)
          && skipWhen(element as Record<string, unknown>)) return;
        walk(element, stepIndex + 1, `${nextTrail}[${index}]`);
      });
      return;
    }
    walk(next, stepIndex + 1, nextTrail);
  };

  walk(doc, 0, '');
  return found;
}

/**
 * Every id the document uses that the item is not licensed to use.
 *
 * Comparison is case-insensitive and whitespace-trimmed, matching the H3
 * runner's own gate — an id that differs only in case is a typo, not a new
 * entity, and failing on it would be a distinction without a difference.
 */
export function findUnlicensedIds(
  doc: unknown,
  paths: readonly IdPath[],
  allowlist: readonly string[],
  skipWhen?: (holder: Record<string, unknown>) => boolean,
): Array<{ path: string; value: string }> {
  const allowed = new Set(allowlist.map((id) => String(id).trim().toLowerCase()).filter(Boolean));
  if (!allowed.size) return [];
  const violations: Array<{ path: string; value: string }> = [];
  for (const path of paths) {
    for (const hit of collectIds(doc, path, skipWhen)) {
      if (!allowed.has(hit.value.toLowerCase())) violations.push(hit);
    }
  }
  return violations;
}

/**
 * The corrective message fed back into the authoring retry loop.
 *
 * Shaped like the schema-validation hint the built-in `llm.generate` already
 * sends, because that loop demonstrably self-corrects on that shape (its own
 * comments cite enum drift — "medium close-up" for a strict `close-up` enum —
 * as the case it was built for). Naming the legal values matters more than
 * naming the offence: a model told only "that id is wrong" invents a second
 * wrong one.
 */
export function violationHint(
  violations: ReadonlyArray<{ path: string; value: string }>,
  allowlist: readonly string[],
): string {
  const offenders = violations.map((v) => `${v.path}="${v.value}"`).join(', ');
  return (
    `Reference id validation failed: ${offenders}. ` +
    `The ONLY ids you may use are: ${allowlist.join(', ')}. ` +
    `These come from this section's own entity list; there is no other source. ` +
    `Rewrite the document using only those ids — do not invent an id, do not borrow ` +
    `one from another section, and do not rename one to make it fit. If a thing you ` +
    `wanted to stage has no id in that list, write the beat without it.`
  );
}

/**
 * Resolve a JSON-Schema location like
 * `properties/references/items/properties/id` to the object that owns the
 * `enum` keyword, cloning as it descends so the bundle's schema file on disk is
 * never mutated (a collection fans out concurrently; a shared mutated schema
 * would race).
 *
 * Returns undefined when the path does not exist — the caller treats that as a
 * CONFIG error and refuses to run, because a silently-missed enum injection
 * would look exactly like a working one right up until a bad id shipped.
 */
function resolveSchemaSlot(
  schema: Record<string, unknown>,
  pointer: string,
): Record<string, unknown> | undefined {
  const steps = pointer.split('/').filter(Boolean);
  let node: Record<string, unknown> = schema;
  for (const step of steps) {
    const next = node[step];
    if (!next || typeof next !== 'object' || Array.isArray(next)) return undefined;
    node[step] = { ...(next as Record<string, unknown>) };
    node = node[step] as Record<string, unknown>;
  }
  return node;
}

/**
 * Constrain id-valued fields to the item's allowlist, in a COPY of the schema.
 *
 * This is the part that makes the guarantee structural rather than another
 * request. The schema travels to the provider as
 * `response_format.json_schema`, and the local llama.cpp gateway compiles it to
 * a GBNF grammar — so on a local run an out-of-allowlist id is not discouraged,
 * it is undecodable. Remote providers honour it more loosely, which is why the
 * post-call check in `findUnlicensedIds` exists as well; neither replaces the
 * other.
 *
 * Deliberately NOT applied to every id-valued field: a grammar cannot express
 * "unless this flag is set", so a field with a legitimate exemption is CHECKED
 * (with `skipWhen`) and never enum-bound.
 */
export function injectEnums(
  schema: Record<string, unknown>,
  pointers: readonly string[],
  allowlist: readonly string[],
): { ok: true; schema: Record<string, unknown> } | { ok: false; error: string } {
  const values = [...new Set(allowlist.map((id) => String(id).trim()).filter(Boolean))];
  if (!values.length) return { ok: false, error: 'empty allowlist — refusing to author with an unconstrained schema' };
  const copy = JSON.parse(JSON.stringify(schema)) as Record<string, unknown>;
  for (const pointer of pointers) {
    const slot = resolveSchemaSlot(copy, pointer);
    if (!slot) {
      return {
        ok: false,
        error:
          `enumSchemaPaths entry '${pointer}' does not exist in the output schema. ` +
          `A path that silently misses injects nothing and the run looks correct until a bad id ships.`,
      };
    }
    slot['enum'] = values;
  }
  return { ok: true, schema: copy };
}

/**
 * Pull this item's allowlist out of the plan artifact.
 *
 * The plan is the SAME document the downstream render gate reads its expected
 * ids from, which is the property that makes this work: authoring and rendering
 * are then constrained by one list, not by two lists that agree today.
 */
export function allowlistForItem(
  plan: unknown,
  opts: { itemsKey: string; matchField: string; valuesField: string; itemId: string },
): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
    return { ok: false, error: 'allowlist source is not an object' };
  }
  const items = (plan as Record<string, unknown>)[opts.itemsKey];
  if (!Array.isArray(items)) {
    return { ok: false, error: `allowlist source has no array at '${opts.itemsKey}'` };
  }
  const match = items.find((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    return (item as Record<string, unknown>)[opts.matchField] === opts.itemId;
  });
  if (!match) {
    return { ok: false, error: `no ${opts.itemsKey} entry whose ${opts.matchField} is '${opts.itemId}'` };
  }
  const raw = (match as Record<string, unknown>)[opts.valuesField];
  if (!Array.isArray(raw)) {
    return { ok: false, error: `${opts.itemsKey} entry '${opts.itemId}' has no array at '${opts.valuesField}'` };
  }
  const ids = raw
    .flatMap((value) => {
      if (typeof value === 'string') return [value];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const id = (value as Record<string, unknown>)['id'];
        return typeof id === 'string' ? [id] : [];
      }
      return [];
    })
    .map((id) => id.trim())
    .filter(Boolean);
  if (!ids.length) {
    return { ok: false, error: `${opts.itemsKey} entry '${opts.itemId}' licenses no ids at all` };
  }
  return { ok: true, ids: [...new Set(ids)] };
}

/**
 * Reject ids that are in the RIGHT scene but the WRONG SLOT.
 *
 * The enum binds every id field to the same allowlist, so nothing in it stops a
 * CHARACTER id landing in `sceneryIds` or a location in `acting`. That is a
 * different failure from an invented id and the render gate treats it as fatal
 * ("putting one in acting, or a character in sceneryIds, is rejected"), so it
 * has to be caught here too.
 *
 * Checked against the document's OWN `references[].type`, which makes it
 * self-consistent: no external type source to drift from.
 *
 * Measured on `ashfall_crown` scene_3 — `ash_sworn_riders`, a character, sat in
 * `shots[0].sceneryIds`. Licensed, spelled right, in the wrong slot.
 */
export function findMisslottedIds(
  doc: unknown,
  opts: { characterPaths: readonly string[]; sceneryPaths: readonly string[] },
): Array<{ path: string; value: string; expected: 'character' | 'scenery' }> {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
  const refs = (doc as Record<string, unknown>)['references'];
  if (!Array.isArray(refs)) return [];
  const typeById = new Map<string, string>();
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const r = ref as Record<string, unknown>;
    if (typeof r['id'] === 'string' && typeof r['type'] === 'string') {
      typeById.set(r['id'].trim().toLowerCase(), r['type'].trim().toLowerCase());
    }
  }
  const out: Array<{ path: string; value: string; expected: 'character' | 'scenery' }> = [];
  for (const path of opts.characterPaths) {
    for (const hit of collectIds(doc, path)) {
      const t = typeById.get(hit.value.toLowerCase());
      if (t && t !== 'character') out.push({ ...hit, expected: 'character' });
    }
  }
  for (const path of opts.sceneryPaths) {
    for (const hit of collectIds(doc, path)) {
      const t = typeById.get(hit.value.toLowerCase());
      if (t === 'character') out.push({ ...hit, expected: 'scenery' });
    }
  }
  return out;
}

/** Corrective message for wrong-slot ids, in the same shape as the id hint. */
export function misslotHint(
  violations: ReadonlyArray<{ path: string; value: string; expected: 'character' | 'scenery' }>,
): string {
  const lines = violations.map((v) => v.expected === 'character'
    ? `${v.path}="${v.value}" is NOT a character, so it cannot act — objects and locations go in sceneryIds`
    : `${v.path}="${v.value}" IS a character, so it cannot be scenery — characters go in acting`);
  return `Subject slot validation failed: ${lines.join('; ')}. Move each id to the correct field and re-emit the whole document.`;
}

// ── the config a bundle writes, and the one place it is interpreted ────────

export interface PerItemEnumsConfig {
  /** Input id holding the plan artifact the allowlist is read from. */
  from: string;
  /** Array field on that artifact (default "sections"). */
  itemsKey?: string;
  /** Field matched against ctx.itemId (default "id"). */
  matchField?: string;
  /** Field holding this item's licensed ids (default "entities"). */
  valuesField?: string;
  /** JSON-Schema locations to bind the enum onto, slash-separated. */
  enumSchemaPaths?: string[];
  /** Locations in the AUTHORED document to check; a string or {path, exemptWhen}. */
  idPaths?: Array<string | { path: string; exemptWhen?: { field: string; equals: unknown } }>;
  /** Document paths whose ids must be `character`-typed references. */
  characterPaths?: string[];
  /** Document paths whose ids must NOT be `character`-typed references. */
  sceneryPaths?: string[];
}

export interface NormalizedIdPath {
  path: string;
  exemptWhen?: { field: string; equals: unknown };
}

export function normalizeIdPaths(raw: PerItemEnumsConfig['idPaths']): NormalizedIdPath[] {
  if (!Array.isArray(raw)) return [];
  const out: NormalizedIdPath[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string' && entry.trim()) { out.push({ path: entry.trim() }); continue; }
    if (entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string') {
      const e = entry as { path: string; exemptWhen?: { field: string; equals: unknown } };
      out.push(e.exemptWhen ? { path: e.path.trim(), exemptWhen: e.exemptWhen } : { path: e.path.trim() });
    }
  }
  return out;
}

/**
 * Run both checks over one authored document and return a single corrective
 * message, or undefined when it is clean.
 *
 * Two DIFFERENT failures, deliberately reported together: an id that does not
 * belong to this item at all, and an id that belongs but sits in the wrong
 * SLOT. The enum can only prevent the first — it binds every id field to the
 * same list, so nothing in it stops a character landing in a scenery field.
 * Measured on a real film: `ash_sworn_riders`, a character, sat in
 * `shots[0].sceneryIds`. Licensed, spelled right, wrong slot, fatal at render.
 */
export function checkAuthoredIds(
  doc: unknown,
  cfg: PerItemEnumsConfig,
  allowlist: readonly string[],
): string | undefined {
  const problems: string[] = [];
  for (const spec of normalizeIdPaths(cfg.idPaths)) {
    const violations = findUnlicensedIds(
      doc,
      [spec.path],
      allowlist,
      spec.exemptWhen
        ? (holder) => holder[spec.exemptWhen!.field] === spec.exemptWhen!.equals
        : undefined,
    );
    if (violations.length) problems.push(violationHint(violations, allowlist));
  }
  const misslotted = findMisslottedIds(doc, {
    characterPaths: cfg.characterPaths ?? [],
    sceneryPaths: cfg.sceneryPaths ?? [],
  });
  if (misslotted.length) problems.push(misslotHint(misslotted));
  return problems.length ? problems.join(' ') : undefined;
}
