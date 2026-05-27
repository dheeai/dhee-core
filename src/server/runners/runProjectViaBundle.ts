/**
 * runProjectViaBundle — the bundle-architecture entry point for
 * project execution. Replaces runProjectInProcess for projects that
 * declare a `bundleSource` in their project.json.
 *
 * Reads project.json → bundleSource, resolves the bundle source URI
 * to a directory, loads the bundle JSON, validates dependencies, and
 * walks. Returns a shape compatible with the legacy RunProjectResult
 * so executeRunTo / chat-bridge code doesn't care which path ran.
 *
 * No mix-and-match: a project either uses bundles (bundleSource set)
 * or the legacy executor (bundleSource absent). The two paths don't
 * collaborate per-run.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  parseBundleSource,
  resolveBundleDir,
  BundleSourceError,
} from '../../dag/bundleSource.js';
import { walkBundle, loadBundle } from '../../dag/walker.js';
import type { DagBundle, NodeDef } from '../../dag/schema.js';
import type { GenericProjectFile } from '../../core/templates/types.js';
import type { AssetEvent } from '../../agent/pi/tools/parseAssetLines.js';

export interface RunProjectViaBundleOpts {
  projectDir: string;
  /**
   * Optional caller-supplied stage-gate / stop-at. Forwarded to the
   * walker's stopAt. Must be a node id present in the bundle.
   */
  stopAt?: string;
  /**
   * Optional runOnly cascade. Forwarded to the walker. Empty array =
   * "explicitly run nothing." Used by `dhee_run_to scope=last_invalidated`.
   */
  runOnly?: string[];
  /** Cooperative abort signal — passed to every runner via ctx.signal. */
  signal?: AbortSignal;
  /** Log sink. Defaults to console. */
  log?: (msg: string) => void;
  /**
   * Optional event hooks — mirror the legacy runExecutor onTool / onResult /
   * onNotification / onAsset signatures so executeRunTo can bridge them to
   * the chat session's IPC stream without translation.
   */
  onTool?: (info: { toolName: string; nodeId?: string }) => void;
  onResult?: (info: { filePath?: string; status?: string; nodeId?: string }) => void;
  onNotification?: (info: { level: 'info' | 'warn' | 'error'; message: string }) => void;
  onAsset?: (event: AssetEvent & { toolName?: string; nodeId?: string }) => void;
}

export interface RunProjectViaBundleResult {
  ok: boolean;
  /** Absolute path to the final video produced by the bundle's goal node. */
  finalVideoAbs?: string;
  error?: string;
}

export async function runProjectViaBundle(
  opts: RunProjectViaBundleOpts,
): Promise<RunProjectViaBundleResult> {
  const log = opts.log ?? ((m: string) => console.log(m));

  // 1. Read project.json → bundleSource.
  const projectJsonPath = join(opts.projectDir, 'project.json');
  if (!existsSync(projectJsonPath)) {
    return { ok: false, error: `runProjectViaBundle: project.json not found at ${projectJsonPath}` };
  }
  let project: GenericProjectFile & { bundleSource?: string };
  try {
    project = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as GenericProjectFile & {
      bundleSource?: string;
    };
  } catch (err) {
    return {
      ok: false,
      error: `runProjectViaBundle: project.json is malformed JSON: ${(err as Error).message}`,
    };
  }
  if (!project.bundleSource || typeof project.bundleSource !== 'string') {
    return {
      ok: false,
      error:
        `runProjectViaBundle: project.json does not declare a bundleSource. ` +
        `Add a 'bundleSource' field with a value like 'built-in:ltx_prompt_relay' or 'user:my_doc'.`,
    };
  }

  // 2. Parse the bundleSource URI.
  let source;
  try {
    source = parseBundleSource(project.bundleSource);
  } catch (err) {
    if (err instanceof BundleSourceError) return { ok: false, error: err.message };
    return { ok: false, error: `runProjectViaBundle: ${(err as Error).message}` };
  }

  // 3. Resolve to a path (directory or single-file bundle).
  let bundlePathOrDir: string;
  try {
    bundlePathOrDir = resolveBundleDir(source);
  } catch (err) {
    if (err instanceof BundleSourceError) return { ok: false, error: err.message };
    return { ok: false, error: `runProjectViaBundle: ${(err as Error).message}` };
  }

  // 4. Load the bundle JSON. Directory layout: <dir>/bundle.json.
  // Legacy single-file layout: the path IS the JSON.
  const isDir = statSync(bundlePathOrDir).isDirectory();
  const bundleJsonPath = isDir ? join(bundlePathOrDir, 'bundle.json') : bundlePathOrDir;
  const bundleDir = isDir ? bundlePathOrDir : undefined;
  let bundle: DagBundle;
  try {
    bundle = loadBundle(bundleJsonPath);
  } catch (err) {
    return { ok: false, error: `runProjectViaBundle: ${(err as Error).message}` };
  }
  log(`runProjectViaBundle: ${project.bundleSource} → bundle '${bundle.id}' v${bundle.version}`);

  // 5. Auto-discover scenes from project.json (for collection nodes).
  // Falls back to scene ids found in project.scenes[]; if none, the
  // walker may still run if the bundle has no scene-keyed collections.
  const sceneIds = discoverSceneIdsFromProject(project, bundle);

  // 6. Walk the bundle.
  const walkResult = await walkBundle({
    projectDir: opts.projectDir,
    bundle,
    bundleSource: project.bundleSource,
    ...(bundleDir ? { bundleDir } : {}),
    ...(opts.stopAt ? { stopAt: opts.stopAt } : {}),
    ...(opts.runOnly !== undefined ? { runOnly: opts.runOnly } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    cli: { sceneIds },
    log,
  });

  if (!walkResult.ok) {
    return { ok: false, error: walkResult.error ?? 'bundle walk failed' };
  }
  return {
    ok: true,
    ...(walkResult.goal ? { finalVideoAbs: walkResult.goal.outputAbs } : {}),
  };
}

/**
 * Walk the project.json to find scene numbers the bundle's collection
 * nodes will need to materialize. Today: read project.scenes[] (the
 * narrative shape) or fall back to []. Tomorrow: bundle-declared
 * itemSource resolvers may take over (Phase 4 extension).
 */
function discoverSceneIdsFromProject(
  project: GenericProjectFile,
  bundle: DagBundle,
): number[] {
  // If no scene-typed collection nodes, return empty.
  const needsScenes = bundle.nodes.some(
    (n: NodeDef) => n.kind === 'collection' && n.itemSource === 'scene',
  );
  if (!needsScenes) return [];

  // Look for project.scenes (the legacy executor's narrative shape).
  const scenes = (project as unknown as { scenes?: Array<{ id?: string; sceneNumber?: number }> }).scenes;
  if (Array.isArray(scenes)) {
    return scenes
      .map((s) => {
        if (typeof s.sceneNumber === 'number') return s.sceneNumber;
        // Try to parse from id like 'scene_3' or '3'
        const id = String(s.id ?? '');
        const m = id.match(/scene_?(\d+)/i);
        if (m) return parseInt(m[1]!, 10);
        const num = parseInt(id, 10);
        return Number.isFinite(num) ? num : null;
      })
      .filter((n): n is number => n !== null && Number.isFinite(n));
  }
  // Fallback path (filesystem-based scene discovery) is intentionally
  // not done here — Phase 4's `discoverSceneIds` in runProjectInProcess
  // owns that, and callers that need it call `runProjectInProcess`. For
  // bundles, we expect the project.json to be the source of truth.
  return [];
}
