/**
 * projectRegen — shared walker-driven invalidate + regenerate helpers.
 *
 * Single source of truth for "make node X redo itself" semantics. Used
 * by the desktop's IPC bridge (replacing the dead
 * ConversationManager.redoNode / invalidateNodes facade from BUG-016)
 * and by the pi-agent's `dhee_regenerate_node` custom tool.
 *
 * Two functions:
 *   - invalidateNodes — mutates walkState only. Use when the user
 *     wants to mark stale without restarting (e.g. they're about to
 *     edit upstream and don't want stale downstream artifacts to
 *     mislead them). Does NOT dispatch the bundle.
 *   - regenerateNode — invalidates THEN dispatches
 *     `runProjectViaBundle({runOnly: [nodeId]})`. The walker cascades
 *     to all descendants of nodeId.
 *
 * Walker-state semantics (per src/dag/walkState.ts):
 *   - keys are either `nodeId` (singleton) or `nodeId:itemId` (one
 *     entry per collection item).
 *   - `lastInvalidatedIds` is a list of bare nodeIds (no itemId
 *     suffix); the walker treats it as "these nodes need to re-emit
 *     work on the next dispatch."
 *
 * `runProjectViaBundle` is injected so the helpers stay decoupled
 * from the runner module's load order (and so tests can use a stub).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  RunProjectViaBundleOpts,
  RunProjectViaBundleResult,
} from '../server/runners/runProjectViaBundle.js';

export type RunProjectViaBundleFn = (opts: RunProjectViaBundleOpts) => Promise<RunProjectViaBundleResult>;

export interface RegenerateNodeOpts {
  projectDir: string;
  nodeId: string;
  /** Optional item id for collection nodes (composes key as `nodeId:itemId`). */
  itemId?: string;
  /** Cooperative cancellation forwarded to the runner. */
  signal?: AbortSignal;
  /** Defaults to lazy-loaded `runProjectViaBundle`. Override for tests. */
  runProjectViaBundle?: RunProjectViaBundleFn;
}

export interface RegenerateNodeResult {
  ok: boolean;
  nodeId?: string;
  error?: string;
  /** Set when the bundle dispatch succeeded and produced the project's goal artifact. */
  finalVideoAbs?: string;
}

export interface InvalidateNodesOpts {
  projectDir: string;
  nodeIds: string[];
  /** Optional audit tag (e.g. 'inspector-menu', 'chat'). Not persisted today; reserved for telemetry. */
  source?: string;
}

export interface InvalidateNodesResult {
  invalidated: string[];
  notFound: string[];
  /** Populated only on a hard-error path (missing project.json, malformed JSON). */
  error?: string;
}

interface NodeEntry {
  status?: string;
  outputPath?: string;
  itemId?: string;
  error?: string;
  [k: string]: unknown;
}

interface ProjectJson {
  walkState?: {
    nodes?: Record<string, NodeEntry>;
    lastInvalidatedIds?: string[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

function readProject(projectDir: string): { ok: true; project: ProjectJson; path: string } | { ok: false; error: string } {
  const path = join(projectDir, 'project.json');
  if (!existsSync(path)) return { ok: false, error: `project.json not found at ${path}` };
  try {
    const project = JSON.parse(readFileSync(path, 'utf8')) as ProjectJson;
    return { ok: true, project, path };
  } catch (err) {
    return { ok: false, error: `project.json failed to parse: ${(err as Error).message}` };
  }
}

function ensureWalkState(project: ProjectJson): NonNullable<ProjectJson['walkState']> {
  project.walkState ??= { nodes: {}, lastInvalidatedIds: [] };
  project.walkState.nodes ??= {};
  project.walkState.lastInvalidatedIds ??= [];
  return project.walkState;
}

async function defaultRunner(opts: RunProjectViaBundleOpts): Promise<RunProjectViaBundleResult> {
  const mod = await import('../server/runners/runProjectViaBundle.js');
  return mod.runProjectViaBundle(opts);
}

/**
 * Invalidate one or more nodes. Pure walkState mutation; the walker
 * picks them up on the next dispatch. Idempotent — invalidating
 * an already-cleared node returns it in `notFound` and is a no-op.
 */
export async function invalidateNodes(opts: InvalidateNodesOpts): Promise<InvalidateNodesResult> {
  const read = readProject(opts.projectDir);
  if (!read.ok) return { invalidated: [], notFound: [], error: read.error };

  const { project, path } = read;
  const walkState = ensureWalkState(project);
  const invalidated: string[] = [];
  const notFound: string[] = [];

  for (const key of opts.nodeIds) {
    if (!walkState.nodes![key]) {
      notFound.push(key);
      continue;
    }
    delete walkState.nodes![key];
    invalidated.push(key);
    // Track the bare node id (without itemId suffix) on
    // lastInvalidatedIds — the walker keys re-dispatches by bare id.
    const bareId = key.includes(':') ? (key.split(':')[0] ?? key) : key;
    if (!walkState.lastInvalidatedIds!.includes(bareId)) {
      walkState.lastInvalidatedIds!.push(bareId);
    }
  }

  if (invalidated.length > 0) {
    writeFileSync(path, JSON.stringify(project, null, 2), 'utf8');
  }

  return { invalidated, notFound };
}

/**
 * Invalidate one node (optionally one collection item of that node)
 * and immediately dispatch the bundle with `runOnly: [nodeId]` so the
 * walker re-runs that node + everything downstream.
 *
 * The invalidation is persisted BEFORE the dispatch so that if the
 * runner fails mid-flight, a retry picks up where this call left off.
 */
export async function regenerateNode(opts: RegenerateNodeOpts): Promise<RegenerateNodeResult> {
  const key = opts.itemId ? `${opts.nodeId}:${opts.itemId}` : opts.nodeId;

  const inv = await invalidateNodes({
    projectDir: opts.projectDir,
    nodeIds: [key],
  });
  if (inv.error) return { ok: false, error: inv.error };

  const runner = opts.runProjectViaBundle ?? defaultRunner;
  const runOpts: RunProjectViaBundleOpts = {
    projectDir: opts.projectDir,
    runOnly: [opts.nodeId],
    ...(opts.signal ? { signal: opts.signal } : {}),
  };

  let result: RunProjectViaBundleResult;
  try {
    result = await runner(runOpts);
  } catch (err) {
    return { ok: false, nodeId: opts.nodeId, error: `runProjectViaBundle threw: ${(err as Error).message}` };
  }

  if (!result.ok) {
    return { ok: false, nodeId: opts.nodeId, error: result.error ?? '(no error message)' };
  }
  return {
    ok: true,
    nodeId: opts.nodeId,
    ...(result.finalVideoAbs ? { finalVideoAbs: result.finalVideoAbs } : {}),
  };
}
