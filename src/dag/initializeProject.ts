/**
 * initializeProject — pure, pre-agent project bootstrap.
 *
 * This is the single function the desktop's "New Project" flow calls
 * AFTER the user has picked a bundle and filled in its required inputs
 * on the Production Slate screen, but BEFORE the chat / agent loads.
 * It does the full setup so the agent enters a ready project:
 *
 *   1. Resolve the bundle manifest by id.
 *   2. For each `kind: 'file'` input: write the caller-supplied value
 *      to `<projectDir>/<decl.path>` (parent dir auto-created).
 *   3. For each `kind: 'project'` input: set the value (or
 *      `decl.default`) at `decl.field` on the project object.
 *   4. Required inputs without a value → return a structured error
 *      (caller surfaces in UI; nothing written).
 *   5. Write `project.json` to `<projectDir>/project.json`.
 *
 * The function is intentionally NOT an agent tool. The agent is not
 * involved in initial project setup anymore — that grind is gone.
 * The agent's existing `dhee_create_project` tool stays as a legacy
 * path for headless / chat-led flows; it does NOT call this function.
 *
 * Failure mode philosophy: return `{ ok: false, error }` rather than
 * throwing, so the IPC layer can surface the cause cleanly without
 * try/catch noise.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, extname, join } from 'node:path';
import { parseBundleSource, resolveBundleDir } from './bundleSource.js';
import { openEventLog } from './eventLog/EventLog.js';
import type { BundleInputDecl, DagBundle, NodeDef } from './schema.js';

export type ProjectReferenceImagePurpose =
  | 'character_ref'
  | 'setting_ref'
  | 'reference_general';
export type ProjectReferenceImageRole = 'auto' | 'character' | 'setting';

export interface ProjectLocalReferenceImage {
  name: string;
  relativePath: string;
  purpose?: ProjectReferenceImagePurpose;
  referenceRole?: ProjectReferenceImageRole;
  sourcePath?: string;
  originalFilename?: string;
  mimeType?: string;
  size?: number;
  replacementCharacterId?: string;
  replacementCharacterName?: string;
}

export interface InitializeProjectParams {
  /** Absolute path of an existing (already-created) project directory. */
  projectDir: string;
  /** Display name for the project — written to project.json.name. */
  name: string;
  /** Bundle id to pin (e.g. "narrative_prompt_relay"). */
  bundleId: string;
  /** Optional human-readable description. */
  description?: string;
  /**
   * Caller-supplied values keyed by `bundle.inputs[].id`. File-kind go
   * to disk; project-kind go to project.json top-level. Missing
   * project-kind inputs fall back to `decl.default`. Missing required
   * inputs return an error.
   */
  inputs?: Record<string, unknown>;
  /**
   * Already-imported project-local reference images from desktop setup.
   * They are recorded under project.inputs for later planner/agent use.
   */
  referenceImages?: ProjectLocalReferenceImage[];
  /**
   * Per-project paid-spend ceiling in USD, stamped into
   * `features.budgetCapUsd`. The desktop passes its global default
   * (ships at $5) here so every new project is protected out of the
   * box; the user can change it in Settings. Only stamped when a finite
   * number > 0 — omit / pass undefined (e.g. headless CLI use) to leave
   * the project uncapped, preserving the pre-feature behavior. See
   * src/dag/projectFeatures.ts.
   */
  budgetCapUsd?: number;
}

export type InitializeProjectResult =
  | { ok: true; projectDir: string }
  | { ok: false; error: string };

export function initializeProject(params: InitializeProjectParams): InitializeProjectResult {
  const {
    projectDir,
    name,
    bundleId,
    description,
    inputs = {},
    referenceImages = [],
    budgetCapUsd,
  } = params;

  if (!existsSync(projectDir)) {
    return { ok: false, error: `Project directory '${projectDir}' does not exist.` };
  }
  if (!statSync(projectDir).isDirectory()) {
    return { ok: false, error: `'${projectDir}' is not a directory.` };
  }
  if (existsSync(join(projectDir, 'project.json'))) {
    return {
      ok: false,
      error: `project.json already exists at ${projectDir}. Refusing to overwrite.`,
    };
  }

  const bundle = loadBundleManifest(bundleId);
  if (!bundle) {
    return { ok: false, error: `Bundle '${bundleId}' could not be loaded.` };
  }

  const project: Record<string, unknown> = {
    projectId: randomUUID(),
    name,
    bundleSource: `built-in:${bundleId}`,
    ...(description ? { description } : {}),
    createdAt: new Date().toISOString(),
    // Per-project feature flags (docs/feature-flags.md). Seeded with
    // their defaults so new projects show what's available.
    // gateAfterCollections defaults ON (opt-out) — the reader
    // (src/dag/projectFeatures.ts) treats missing as ON too, so the
    // seed just makes the default visible/editable.
    features: {
      gateAfterCollections: true,
      // Strict opt-in (default OFF) — see src/dag/projectFeatures.ts
      // isNarrationEnabled and docs/feature-flags.md.
      narration: false,
      // Budget backstop: stamped only when the caller (desktop) supplies
      // a valid cap. The reader (getBudgetCapUsd) treats a missing /
      // ≤0 / non-finite value as "no cap", so omitting it keeps headless
      // projects uncapped.
      ...(typeof budgetCapUsd === 'number' && Number.isFinite(budgetCapUsd) && budgetCapUsd > 0
        ? { budgetCapUsd }
        : {}),
    },
  };

  // Seed the bundle's shipped assets (its inputs/ dir) into the project BEFORE
  // applying user inputs, so a bundle can ship "talent" — a default creator
  // photo, a reference voice, a default brief — that just works without the
  // user supplying it. User-provided inputs (next step) overwrite the matching
  // seeded files, so seeded assets act as defaults. No-op for bundles without
  // an inputs/ dir (e.g. the narrative bundles, which generate everything).
  const bundleDir = resolveBundleRootDir(bundleId);
  if (bundleDir) seedBundleAssets(bundleDir, projectDir);

  if (bundle.inputs && bundle.inputs.length > 0) {
    const result = applyBundleInputs(projectDir, project, bundle.inputs, inputs);
    if (result.error) {
      return { ok: false, error: result.error };
    }
  }

  appendReferenceImageInputs(project, referenceImages);

  // A file-input can pre-populate a NODE'S OUTPUT (e.g. an "Art direction"
  // style guide → plans/world_style.md, which is the world_style node's
  // output). Mark that node completed so the first walk uses the provided
  // content verbatim. Without this, the walker treats the node as pending
  // (walkState only had the FILE, not a completion), preserves the file as
  // a version, runs the runner, and OVERWRITES the user's content — the
  // runner's skip-if-output-exists can't help once the walker has moved
  // the file aside. See writeNodeContent (the override path) for the same
  // completion-recording, applied here at creation time.
  prePopulateProvidedOutputs(projectDir, project, bundle, inputs);

  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2), 'utf8');
  return { ok: true, projectDir };
}

function isReferencePurpose(value: unknown): value is ProjectReferenceImagePurpose {
  return (
    value === 'character_ref' ||
    value === 'setting_ref' ||
    value === 'reference_general'
  );
}

function isReferenceRole(value: unknown): value is ProjectReferenceImageRole {
  return value === 'auto' || value === 'character' || value === 'setting';
}

function roleForReferencePurpose(
  purpose: ProjectReferenceImagePurpose | undefined,
): ProjectReferenceImageRole {
  if (purpose === 'character_ref') return 'character';
  if (purpose === 'setting_ref') return 'setting';
  return 'auto';
}

function purposeForReferenceRole(
  role: ProjectReferenceImageRole,
): ProjectReferenceImagePurpose {
  if (role === 'character') return 'character_ref';
  if (role === 'setting') return 'setting_ref';
  return 'reference_general';
}

function normalizeReferenceRole(image: ProjectLocalReferenceImage): ProjectReferenceImageRole {
  if (isReferenceRole(image.referenceRole)) return image.referenceRole;
  if (isReferencePurpose(image.purpose)) return roleForReferencePurpose(image.purpose);
  return 'auto';
}

function appendReferenceImageInputs(
  project: Record<string, unknown>,
  images: ProjectLocalReferenceImage[],
): void {
  if (images.length === 0) return;
  const projectInputs = Array.isArray(project['inputs'])
    ? (project['inputs'] as Array<Record<string, unknown>>)
    : [];
  const existingPaths = new Set(
    projectInputs
      .map((input) => {
        const source = input['source'];
        const processing = input['processing'];
        const sourceValue =
          source && typeof source === 'object'
            ? (source as Record<string, unknown>)['value']
            : undefined;
        const localPath =
          processing && typeof processing === 'object'
            ? (processing as Record<string, unknown>)['localPath']
            : undefined;
        return typeof sourceValue === 'string'
          ? sourceValue
          : typeof localPath === 'string'
            ? localPath
            : undefined;
      })
      .filter((value): value is string => typeof value === 'string' && value.length > 0),
  );
  const now = Date.now();

  for (const [index, image] of images.entries()) {
    if (!image.relativePath || existingPaths.has(image.relativePath)) continue;
    const role = normalizeReferenceRole(image);
    const purpose = isReferencePurpose(image.purpose)
      ? image.purpose
      : purposeForReferenceRole(role);
    projectInputs.push({
      id: `${purpose === 'character_ref' ? 'character-ref' : purpose === 'setting_ref' ? 'setting-ref' : 'reference-image'}-${now}-${index + 1}`,
      source: {
        type: 'local_path',
        value: image.relativePath,
        ...(image.sourcePath ? { originalValue: image.sourcePath } : {}),
      },
      mediaType: 'image',
      purpose,
      metadata: {
        originalFilename: image.originalFilename ?? image.name,
        ...(image.mimeType ? { mimeType: image.mimeType } : {}),
        ...(image.size !== undefined ? { fileSize: image.size } : {}),
        addedAt: now,
        processedAt: now,
        referenceRole: role,
        ...(image.replacementCharacterId ? { replacementCharacterId: image.replacementCharacterId } : {}),
        ...(image.replacementCharacterName ? { replacementCharacterName: image.replacementCharacterName } : {}),
      },
      processing: {
        status: 'completed',
        localPath: image.relativePath,
      },
      notes: 'Uploaded from the desktop project setup.',
    });
    existingPaths.add(image.relativePath);
  }

  project['inputs'] = projectInputs;
}

interface PrePopMatch {
  nodeId: string;
  outputPath: string;
  format: NodeDef['outputs']['format'];
}

function prePopulateProvidedOutputs(
  projectDir: string,
  project: Record<string, unknown>,
  bundle: DagBundle,
  inputs: Record<string, unknown>,
): void {
  // Find provided (non-empty) kind:file inputs whose path exactly matches
  // a node's (non-templated) output pattern.
  const matches: PrePopMatch[] = [];
  for (const decl of bundle.inputs ?? []) {
    if (decl.kind !== 'file') continue;
    const v = inputs[decl.id];
    if (v === undefined || v === null || v === '') continue;
    const node = bundle.nodes.find((n) => n.outputs?.pattern === decl.path);
    if (node) matches.push({ nodeId: node.id, outputPath: decl.path, format: node.outputs.format });
  }
  if (matches.length === 0) return;

  // 1. project.json walkState — for legacy callers that read it directly.
  const walkState = (project['walkState'] ?? {}) as { nodes?: Record<string, unknown> };
  walkState.nodes = walkState.nodes ?? {};
  const nowIso = new Date().toISOString();
  for (const m of matches) {
    walkState.nodes[m.nodeId] = {
      status: 'completed',
      outputPath: m.outputPath,
      completedAt: nowIso,
      generation: { tool: 'user', toolVersion: '0.1.0' },
    };
  }
  project['walkState'] = walkState;

  // 2. Event log — the ProjectionEngine rebuilds walkState from events, so
  //    the completion MUST be an event or the projection shows it pending.
  //    Emit bundle.bound first (matching source+version) so the walker's
  //    reinit check sees a matching prior bind and won't wipe these.
  const log = openEventLog(projectDir);
  log.append({
    branchId: 'main',
    actor: 'user',
    kind: 'bundle.bound',
    payload: {
      bundleSource: project['bundleSource'] as string,
      bundleVersion: bundle.version,
      engineVersion: '0.1.0',
    },
  });
  for (const m of matches) {
    log.append({
      branchId: 'main',
      actor: 'user',
      kind: 'node.completed',
      payload: {
        nodeId: m.nodeId,
        versionId: `user-init-${m.nodeId}`,
        outputPath: m.outputPath,
        artifact: { format: m.format },
        generation: { tool: 'user', toolVersion: '0.1.0', cached: false },
        metadata: { reason: 'provided at project creation' },
      },
    });
  }
}

/** Resolve a built-in bundle's root DIRECTORY (null for single-file `.json`
 * bundles or unresolvable ids). Used to locate shipped assets to seed. */
function resolveBundleRootDir(bundleId: string): string | null {
  try {
    const dirOrJson = resolveBundleDir(parseBundleSource(`built-in:${bundleId}`));
    return statSync(dirOrJson).isDirectory() ? dirOrJson : null;
  } catch {
    return null;
  }
}

/**
 * Text/markdown extensions that hold a generative BRIEF (topic, story,
 * script, product description, ...) rather than a talent ASSET. Never
 * seeded — see `seedBundleAssets` below for why.
 */
const BRIEF_TEXT_EXTENSIONS = new Set(['.md', '.txt']);

/**
 * Copy a bundle's shipped `inputs/` assets into the project's `inputs/` dir.
 * Shallow (bundle inputs/ are flat files), binary-safe (copyFileSync). Returns
 * the seeded filenames. No-op when the bundle has no `inputs/` dir. Called
 * BEFORE applyBundleInputs so user-provided inputs overwrite the seeded
 * defaults. Exported for unit testing.
 *
 * Deliberately skips `.md`/`.txt` files: across every bundle's `inputs/`
 * dir, the text files are exactly the generative BRIEFS (topic.md,
 * story.md, script.md, product.md, ...), never genuine talent assets
 * (those are always binary — voice_ref.wav, portrait.png, logo.png, ...).
 * Seeding a brief silently substituted the bundle's SAMPLE brief for a
 * missing user topic (e.g. remotion_explainer's sample "Helm AI support
 * agent" brief leaking into unrelated projects created without a topic —
 * see initializeProject.ts's header). A missing brief should surface as a
 * required-input error, not silently default to the bundle's demo copy.
 */
export function seedBundleAssets(bundleDir: string, projectDir: string): string[] {
  const srcInputs = join(bundleDir, 'inputs');
  if (!existsSync(srcInputs) || !statSync(srcInputs).isDirectory()) return [];
  const destInputs = join(projectDir, 'inputs');
  mkdirSync(destInputs, { recursive: true });
  const seeded: string[] = [];
  for (const entry of readdirSync(srcInputs, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (BRIEF_TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
    copyFileSync(join(srcInputs, entry.name), join(destInputs, entry.name));
    seeded.push(entry.name);
  }
  return seeded;
}

function loadBundleManifest(bundleId: string): DagBundle | null {
  try {
    const source = parseBundleSource(`built-in:${bundleId}`);
    const dirOrJson = resolveBundleDir(source);
    const manifestPath = statSync(dirOrJson).isDirectory()
      ? join(dirOrJson, 'bundle.json')
      : dirOrJson;
    if (!existsSync(manifestPath)) return null;
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as DagBundle;
  } catch {
    return null;
  }
}

function setDeep(target: Record<string, unknown>, dottedField: string, value: unknown): void {
  const parts = dottedField.split('.').filter(Boolean);
  if (parts.length === 0) return;
  let node: Record<string, unknown> = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = node[key];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      const fresh: Record<string, unknown> = {};
      node[key] = fresh;
      node = fresh;
    } else {
      node = next as Record<string, unknown>;
    }
  }
  node[parts[parts.length - 1]!] = value;
}

function applyBundleInputs(
  projectDir: string,
  project: Record<string, unknown>,
  decls: BundleInputDecl[],
  values: Record<string, unknown>,
): { error?: string } {
  for (const decl of decls) {
    const provided = Object.prototype.hasOwnProperty.call(values, decl.id)
      ? values[decl.id]
      : undefined;
    if (decl.kind === 'file') {
      if (provided === undefined || provided === null || provided === '') {
        if (decl.required) {
          return { error: `Required input '${decl.id}' (file: ${decl.path}) was not provided.` };
        }
        continue;
      }
      const content = typeof provided === 'string' ? provided : JSON.stringify(provided, null, 2);
      const absPath = join(projectDir, decl.path);
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, content, 'utf8');
    } else {
      const resolved =
        provided !== undefined
          ? provided
          : decl.default !== undefined
            ? decl.default
            : undefined;
      if (resolved === undefined) {
        if (decl.required) {
          return { error: `Required input '${decl.id}' (project.${decl.field}) was not provided.` };
        }
        continue;
      }
      setDeep(project, decl.field, resolved);
    }
  }
  return {};
}
