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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseBundleSource, resolveBundleDir } from './bundleSource.js';
import type { BundleInputDecl, DagBundle } from './schema.js';

export interface InitializeProjectParams {
  /** Absolute path of an existing (already-created) project directory. */
  projectDir: string;
  /** Display name for the project — written to project.json.name. */
  name: string;
  /** Bundle id to pin (e.g. "narrative_prompt_relay"). */
  bundleId: string;
  /**
   * Optional full source URI to persist (e.g.
   * "user:youtube_short_text_video"). When omitted, the legacy
   * behavior persists "built-in:<bundleId>".
   */
  bundleSource?: string;
  /** Optional human-readable description. */
  description?: string;
  /**
   * Caller-supplied values keyed by `bundle.inputs[].id`. File-kind go
   * to disk; project-kind go to project.json top-level. Missing
   * project-kind inputs fall back to `decl.default`. Missing required
   * inputs return an error.
   */
  inputs?: Record<string, unknown>;
}

export type InitializeProjectResult =
  | { ok: true; projectDir: string }
  | { ok: false; error: string };

export function initializeProject(params: InitializeProjectParams): InitializeProjectResult {
  const { projectDir, name, bundleId, bundleSource, description, inputs = {} } = params;

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

  const sourceUri = bundleSource ?? `built-in:${bundleId}`;
  let parsedSource: ReturnType<typeof parseBundleSource>;
  try {
    parsedSource = parseBundleSource(sourceUri);
  } catch (error) {
    return {
      ok: false,
      error: `Bundle source '${sourceUri}' is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (parsedSource.scheme !== 'registry' && parsedSource.id !== bundleId) {
    return {
      ok: false,
      error: `Bundle source '${sourceUri}' does not match bundleId '${bundleId}'.`,
    };
  }

  const bundle = loadBundleManifestFromSource(sourceUri);
  if (!bundle) {
    return { ok: false, error: `Bundle source '${sourceUri}' could not be loaded.` };
  }

  const project: Record<string, unknown> = {
    name,
    bundleSource: sourceUri,
    ...(description ? { description } : {}),
    createdAt: new Date().toISOString(),
  };

  if (bundle.inputs && bundle.inputs.length > 0) {
    const result = applyBundleInputs(projectDir, project, bundle.inputs, inputs);
    if (result.error) {
      return { ok: false, error: result.error };
    }
  }

  writeFileSync(join(projectDir, 'project.json'), JSON.stringify(project, null, 2), 'utf8');
  return { ok: true, projectDir };
}

function loadBundleManifestFromSource(bundleSource: string): DagBundle | null {
  try {
    const source = parseBundleSource(bundleSource);
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
  values: Record<string, unknown>
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
        provided !== undefined ? provided : decl.default !== undefined ? decl.default : undefined;
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
