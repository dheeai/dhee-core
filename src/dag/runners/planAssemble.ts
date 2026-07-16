/**
 * `plan.assemble` — deterministic (NO LLM calls) runner that assembles
 * the canonical `scenes_plan.json` out of per-scene fragments produced
 * by an upstream collection, plus the outline stage's `title`.
 *
 * Why this exists: splitting scene planning into one small LLM call per
 * scene (a `scope:'all'` fan-out collection, each instance producing
 * `{ section, shots }` for ONE scene) is far more reliable than a
 * single mega-call that has to emit the whole multi-scene plan in one
 * shot — but the DAG needs a single canonical, ORDERED, cross-
 * validated `scenes_plan.json` to hand to every downstream stage. This
 * runner does that assembly with plain data-shuffling — no model call,
 * no retry loop, no schema-repair heuristics — so it's fully
 * deterministic and instant.
 *
 * ── Input contract ──────────────────────────────────────────────────
 * The node's declared `inputs[]` must contain EXACTLY:
 *   - one input with `scope:'all'` — the per-scene fragment collection.
 *     The walker resolves a non-`llm.generate` `scope:'all'` input to
 *     `{ [itemId]: absoluteFilePath }` (see walker.ts), so
 *     `ctx.inputs[thatInput.from]` is a map of scene itemId → the
 *     absolute path of that scene's fragment JSON file. Each fragment
 *     file is `{ section: {...}, shots: [...] }` for ONE scene.
 *   - one input WITHOUT `scope:'all'` — the outline stage. The walker
 *     resolves a single (non-collection) JSON upstream by inlining its
 *     PARSED content, so `ctx.inputs[thatInput.from]` is already the
 *     outline object (must carry a string `title`).
 * Any other count of either kind is a config error (fails loudly rather
 * than guessing which input is which).
 *
 * ── Fragment shape ──────────────────────────────────────────────────
 * `{ section: { id: 'scene_<N>', mode?: string, ... }, shots: [ { id:
 * 'scene_<N>_shot_<M>', scene: <N>, characterPresence?: 'character' |
 * 'none' | ..., ... } ] }`. `section.id` supplies the scene's ordinal
 * (regex `^scene_(\d+)$`); shot ids must match `^scene_\d+_shot_\d+$`
 * AND each shot's `scene` number must match the fragment's OWN section
 * — a shot from one fragment claiming a different scene is a structural
 * bug (e.g. a copy-paste in the per-scene prompt) and fails the run
 * rather than silently mis-filing the shot.
 *
 * ── Output shape ─────────────────────────────────────────────────────
 * `{ title, sections, shots, narration_section_ids, character_shot_ids,
 * none_shot_ids }` — scenes ordered by section.id's scene number; shots
 * flattened scene-then-shotNumber order. `narration_section_ids` is
 * every section with `mode==='narration'` (in scene order) UNLESS
 * narration is disabled — see "Narration flag resolution" below — in
 * which case it's forced to `[]` regardless of what the fragments say.
 * `character_shot_ids` / `none_shot_ids` are every shot whose
 * `characterPresence` is `'character'` / `'none'` respectively, in the
 * same flattened order.
 *
 * ── Narration flag resolution ────────────────────────────────────────
 * If the node declares an input with `from:'narration'` AND
 * `ctx.inputs['narration']` is present, that value's truthiness wins
 * (`true`/`'true'` → on, `false`/`'false'` → off). Otherwise, falls back
 * to the project's `features.narration` flag (see projectFeatures.ts).
 * A wired `narration` input does not count toward the "exactly one
 * non-scope:'all' input" outline contract above.
 *
 * Config:
 *   - outputPath (string): set by the walker from node.outputs.pattern.
 *   - outputSchema (string, optional): path (relative to bundleDir) to
 *     a JSON Schema the assembled result must satisfy; a mismatch fails
 *     the run with the ajv error detail.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as ajvNs from 'ajv';
import * as ajvFormatsNs from 'ajv-formats';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import { isNarrationEnabled } from '../projectFeatures.js';

type AjvInstance = { compile: (schema: unknown) => (data: unknown) => boolean; errors?: Array<{ instancePath?: string; message?: string }> | null };
type AjvCtor = new (opts?: Record<string, unknown>) => AjvInstance;
type AddFormatsFn = (ajv: AjvInstance) => void;
const Ajv: AjvCtor = ((ajvNs as unknown as { default?: AjvCtor }).default ?? (ajvNs as unknown as AjvCtor));
const addFormats: AddFormatsFn = ((ajvFormatsNs as unknown as { default?: AddFormatsFn }).default ?? (ajvFormatsNs as unknown as AddFormatsFn));

interface PlanAssembleConfig {
  outputPath: string;
  outputSchema?: string;
}

interface RawShot {
  id?: unknown;
  scene?: unknown;
  shotNumber?: unknown;
  characterPresence?: unknown;
  [k: string]: unknown;
}

interface RawFragment {
  section?: unknown;
  shots?: unknown;
}

const SCENE_ID_RE = /^scene_(\d+)$/;
const SHOT_ID_RE = /^scene_(\d+)_shot_(\d+)$/;

function fail(error: string): RunnerResult {
  return { ok: false, error: `plan.assemble: ${error}` };
}

const describe = (): RunnerDescription => ({
  id: 'plan.assemble',
  displayName: 'Plan Assemble',
  description:
    'Deterministic (no LLM calls) assembly of the canonical scenes_plan.json from per-scene fragments (a scope:all collection) plus the outline stage title.',
  capabilities: ['json-generation'],
  modalities: { input: ['text'], output: ['text'] },
  configSchema: {
    type: 'object',
    required: ['outputPath'],
    properties: {
      outputPath: { type: 'string' },
      outputSchema: { type: 'string' },
    },
  },
});

async function run(ctx: RunnerContext): Promise<RunnerResult> {
  const raw = ctx.node.runner.config;
  if (!raw || typeof raw !== 'object') return fail('config must be an object');
  const cfg = raw as Partial<PlanAssembleConfig>;
  if (!cfg.outputPath || typeof cfg.outputPath !== 'string') {
    return fail("missing required config field 'outputPath'");
  }

  // 1. Identify the fragments input (scope:'all') and the outline input
  //    (anything else) from the node's declared inputs. Exactly one of
  //    each — an ambiguous or missing declaration is a bundle-wiring bug.
  const allScopeInputs = ctx.node.inputs.filter((i) => i.scope === 'all');
  const narrationDeclared = ctx.node.inputs.some((i) => i.from === 'narration');
  const otherInputs = ctx.node.inputs.filter((i) => i.scope !== 'all' && i.from !== 'narration');
  if (allScopeInputs.length !== 1) {
    return fail(
      `expected exactly ONE declared input with scope:'all' (the per-scene fragment collection); found ${allScopeInputs.length}.`,
    );
  }
  if (otherInputs.length !== 1) {
    return fail(
      `expected exactly ONE declared input WITHOUT scope:'all' (the outline stage); found ${otherInputs.length}.`,
    );
  }
  const fragmentsKey = allScopeInputs[0]!.from;
  const outlineKey = otherInputs[0]!.from;

  // 2. Outline — the walker inlines a single JSON upstream's PARSED
  //    content, so this should already be an object with a `title`.
  const outlineRaw = ctx.inputs[outlineKey];
  if (!outlineRaw || typeof outlineRaw !== 'object' || Array.isArray(outlineRaw)) {
    return fail(`outline input '${outlineKey}' is not a JSON object (got ${typeof outlineRaw}).`);
  }
  const title = (outlineRaw as { title?: unknown }).title;
  if (typeof title !== 'string' || title.trim() === '') {
    return fail(`outline input '${outlineKey}' is missing a non-empty string 'title'.`);
  }

  // 3. Fragments — { itemId: absoluteFilePath }.
  const fragmentsRaw = ctx.inputs[fragmentsKey];
  if (!fragmentsRaw || typeof fragmentsRaw !== 'object' || Array.isArray(fragmentsRaw)) {
    return fail(`fragments input '${fragmentsKey}' is not an { itemId: path } object (got ${typeof fragmentsRaw}).`);
  }
  const fragmentPaths = Object.values(fragmentsRaw as Record<string, unknown>);
  if (fragmentPaths.length === 0) {
    return fail(`fragments input '${fragmentsKey}' has no scene fragments to assemble.`);
  }

  interface ParsedFragment {
    sceneNum: number;
    section: Record<string, unknown>;
    shots: RawShot[];
  }
  const parsedFragments: ParsedFragment[] = [];
  for (const p of fragmentPaths) {
    if (typeof p !== 'string') {
      return fail(`fragments input '${fragmentsKey}' entry is not a file path (got ${typeof p}).`);
    }
    if (!existsSync(p)) {
      return fail(`scene fragment file not found at ${p}.`);
    }
    let parsed: RawFragment;
    try {
      parsed = JSON.parse(readFileSync(p, 'utf-8')) as RawFragment;
    } catch (err) {
      return fail(`failed to parse scene fragment at ${p}: ${(err as Error).message}`);
    }
    const section = parsed.section;
    if (!section || typeof section !== 'object' || Array.isArray(section)) {
      return fail(`scene fragment at ${p} is missing an object 'section'.`);
    }
    const sectionId = (section as { id?: unknown }).id;
    const m = typeof sectionId === 'string' ? sectionId.match(SCENE_ID_RE) : null;
    if (!m) {
      return fail(
        `scene fragment at ${p} has section.id '${String(sectionId)}' — expected the pattern 'scene_<N>'.`,
      );
    }
    const sceneNum = parseInt(m[1]!, 10);
    const shotsRaw = parsed.shots;
    if (!Array.isArray(shotsRaw)) {
      return fail(`scene fragment at ${p} (section '${sectionId}') is missing a 'shots' array.`);
    }
    parsedFragments.push({ sceneNum, section: section as Record<string, unknown>, shots: shotsRaw as RawShot[] });
  }

  // 4. Order scenes by the number parsed from section.id.
  parsedFragments.sort((a, b) => a.sceneNum - b.sceneNum);

  // 5. Flatten shots (scene order, then shotNumber order within each
  //    scene), validating id shape + scene/section agreement.
  const flatShots: RawShot[] = [];
  for (const f of parsedFragments) {
    const sceneShots = [...f.shots].sort((a, b) => {
      const an = typeof a.shotNumber === 'number' ? a.shotNumber : 0;
      const bn = typeof b.shotNumber === 'number' ? b.shotNumber : 0;
      return an - bn;
    });
    for (const shot of sceneShots) {
      const shotId = shot.id;
      const shotMatch = typeof shotId === 'string' ? shotId.match(SHOT_ID_RE) : null;
      if (!shotMatch) {
        return fail(
          `shot id '${String(shotId)}' in scene_${f.sceneNum}'s fragment does not match the canonical pattern 'scene_<N>_shot_<M>'.`,
        );
      }
      const idSceneNum = parseInt(shotMatch[1]!, 10);
      if (idSceneNum !== f.sceneNum || (typeof shot.scene === 'number' && shot.scene !== f.sceneNum)) {
        return fail(
          `shot '${shotId}' claims scene ${typeof shot.scene === 'number' ? shot.scene : idSceneNum}, but it was found in scene_${f.sceneNum}'s own fragment (scene/section mismatch).`,
        );
      }
      flatShots.push(shot);
    }
  }

  // 6. Derived id arrays.
  const narrationEnabled =
    narrationDeclared && Object.prototype.hasOwnProperty.call(ctx.inputs, 'narration')
      ? isTruthyNarrationValue(ctx.inputs['narration'])
      : isNarrationEnabled(readProjectJson(ctx.projectDir));
  const narrationSectionIds = narrationEnabled
    ? parsedFragments
        .filter((f) => (f.section as { mode?: unknown }).mode === 'narration')
        .map((f) => (f.section as { id: string }).id)
    : [];
  const characterShotIds = flatShots
    .filter((s) => s.characterPresence === 'character')
    .map((s) => s.id as string);
  const noneShotIds = flatShots
    .filter((s) => s.characterPresence === 'none')
    .map((s) => s.id as string);

  const assembled = {
    title,
    sections: parsedFragments.map((f) => f.section),
    shots: flatShots,
    narration_section_ids: narrationSectionIds,
    character_shot_ids: characterShotIds,
    none_shot_ids: noneShotIds,
  };

  // 7. Optional schema validation.
  if (cfg.outputSchema) {
    if (!ctx.bundleDir) {
      return fail('outputSchema declared but ctx.bundleDir is unset — cannot resolve the schema path.');
    }
    const schemaAbs = resolve(ctx.bundleDir, cfg.outputSchema);
    if (!existsSync(schemaAbs)) {
      return fail(`outputSchema not found at ${schemaAbs}`);
    }
    let schema: unknown;
    try {
      schema = JSON.parse(readFileSync(schemaAbs, 'utf-8'));
    } catch (err) {
      return fail(`failed to load outputSchema at ${schemaAbs}: ${(err as Error).message}`);
    }
    const ajv = new Ajv({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(schema as Record<string, unknown>) as ((data: unknown) => boolean) & {
      errors?: Array<{ instancePath?: string; message?: string }> | null;
    };
    if (!validate(assembled)) {
      const errs = (validate.errors ?? ajv.errors ?? [])
        .map((e) => `${e.instancePath || '<root>'} ${e.message ?? 'invalid'}`)
        .join('; ');
      return fail(`assembled result failed schema validation: ${errs}`);
    }
  }

  // 8. Write.
  const outAbs = resolve(ctx.projectDir, cfg.outputPath);
  mkdirSync(dirname(outAbs), { recursive: true });
  const toWrite = JSON.stringify(assembled, null, 2);
  writeFileSync(outAbs, toWrite, 'utf-8');
  ctx.log(`plan.assemble: wrote ${cfg.outputPath} (${parsedFragments.length} scenes, ${flatShots.length} shots)`);

  return {
    ok: true,
    outputPath: cfg.outputPath,
    metadata: { bytes: toWrite.length, sceneCount: parsedFragments.length, shotCount: flatShots.length },
  };
}

function isTruthyNarrationValue(value: unknown): boolean {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return Boolean(value);
}

function readProjectJson(projectDir: string): unknown {
  try {
    const p = resolve(projectDir, 'project.json');
    if (!existsSync(p)) return undefined;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return undefined;
  }
}

export const planAssembleRunner: Runner = { describe, run };
