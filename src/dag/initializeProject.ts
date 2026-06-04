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
import { openEventLog } from './eventLog/EventLog.js';
import type { BundleInputDecl, DagBundle, NodeDef } from './schema.js';

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
}

export type InitializeProjectResult =
  | { ok: true; projectDir: string }
  | { ok: false; error: string };

export function initializeProject(params: InitializeProjectParams): InitializeProjectResult {
  const { projectDir, name, bundleId, description, inputs = {} } = params;

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
    name,
    bundleSource: `built-in:${bundleId}`,
    ...(description ? { description } : {}),
    createdAt: new Date().toISOString(),
  };

  if (bundle.inputs && bundle.inputs.length > 0) {
    const result = applyBundleInputs(projectDir, project, bundle.inputs, inputs);
    if (result.error) {
      return { ok: false, error: result.error };
    }
  }

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
    const node = (bundle.nodes as NodeDef[]).find((n) => n.outputs?.pattern === decl.path);
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
