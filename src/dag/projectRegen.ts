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
import { join, relative, resolve } from 'node:path';
import { cascadeInvalidationKeys, type CascadeTarget } from './cascadeInvalidationKeys.js';
import { openEventLog } from './eventLog/EventLog.js';
import { preserveAsVersion } from './preserveAsVersion.js';
import { isWalkLocked } from './projectWalkLock.js';
import { loadBundle } from './walker.js';
import { parseBundleSource, resolveBundleDir } from './bundleSource.js';
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
  /** Who produced the current content; 'user' marks a hand-authored pin. */
  generation?: { tool?: string; toolVersion?: string };
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

/**
 * Best-effort set of agentEditable node ids for the project's bundle.
 * Used by the user-authored plan barrier. Returns an empty set when the
 * bundle can't be resolved/loaded — i.e. no barrier (prior behavior).
 */
function loadAgentEditableIds(project: ProjectJson): Set<string> {
  try {
    const src = project['bundleSource'];
    if (typeof src !== 'string') return new Set();
    const bundleDir = resolveBundleDir(parseBundleSource(src));
    let manifestPath = bundleDir;
    try {
      if (existsSync(join(bundleDir, 'bundle.json'))) manifestPath = join(bundleDir, 'bundle.json');
    } catch {
      /* fall through */
    }
    const bundle = loadBundle(manifestPath);
    return new Set((bundle.nodes).filter((n) => n.agentEditable).map((n) => n.id));
  } catch {
    return new Set();
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

  // agentEditable node ids — used for the user-authored plan barrier
  // below. Best-effort: a bundle we can't load just means no barrier.
  const agentEditableIds = loadAgentEditableIds(project);

  // Cascade: for each requested target, walk the event-derived
  // dependency graph forward and collect every downstream consumer.
  // Then the loop below clears every key in the expanded set.
  // Pre-fix: the loop only cleared the requested keys, leaving
  // downstream artifacts intact with stale-upstream baked in. The
  // walker compensated with the upstreamReRun cache-bypass hack
  // (BUG-023). With cascade-invalidation, the walker becomes dumb
  // (state-as-truth) — that hack is removed in this commit's
  // walker simplification.
  let cascadeKeys: string[];
  try {
    const log = openEventLog(opts.projectDir);
    const allEvents = [...log.read()];
    const expanded = new Set<string>();
    for (const requested of opts.nodeIds) {
      const target: CascadeTarget = requested.includes(':')
        ? { nodeId: requested.split(':')[0]!, itemId: requested.split(':').slice(1).join(':') }
        : { nodeId: requested };
      for (const k of cascadeInvalidationKeys(allEvents, target)) {
        expanded.add(k.itemId !== undefined ? `${k.nodeId}:${k.itemId}` : k.nodeId);
      }
    }
    cascadeKeys = [...expanded];
  } catch {
    // Event log unreadable — fall back to requested keys only.
    cascadeKeys = [...opts.nodeIds];
  }

  // Open the event log ONCE for the whole invalidation. Every cascaded
  // key gets a `node.invalidated` event so the event-sourced
  // projections (projectInstanceGraph → the desktop Cards view,
  // projectWalkState) reflect the cascade. Without this, walkState was
  // cleared but the events-based UI still showed the nodes as
  // 'completed' — the cascade was invisible (the bug behind "marking a
  // node stale doesn't blank its downstream"). Best-effort: a log
  // failure must not abort the invalidate.
  let invLog: ReturnType<typeof openEventLog> | null = null;
  try {
    invLog = openEventLog(opts.projectDir);
  } catch {
    invLog = null;
  }
  const splitKey = (k: string): { nodeId: string; itemId?: string } => {
    const [bare, ...rest] = k.split(':');
    return rest.length > 0 ? { nodeId: bare ?? k, itemId: rest.join(':') } : { nodeId: bare ?? k };
  };

  for (const key of cascadeKeys) {
    if (!walkState.nodes![key]) {
      // Cascade keys may include items never recorded in walkState
      // (e.g. a downstream item that hasn't been rendered yet). Skip
      // silently rather than reporting notFound — they don't need
      // clearing. Only report notFound for keys the CALLER requested.
      if (opts.nodeIds.includes(key)) notFound.push(key);
      continue;
    }
    // User-authored plan barrier (#147 Gap 2): a hand-authored,
    // agentEditable PLAN node (built via dhee_add_item) is NEVER wiped by
    // an UPSTREAM cascade — that would re-fire its llm.generate and erase
    // the user's items. Only an explicit request for THIS exact node
    // (dhee_regenerate_node, which puts it in opts.nodeIds) clears it.
    // Scoped to agentEditable so the prior contract holds: a user-pinned
    // SHOT still re-renders when its character changes upstream.
    const bareNodeId = key.includes(':') ? (key.split(':')[0] ?? key) : key;
    if (
      !opts.nodeIds.includes(key) &&
      agentEditableIds.has(bareNodeId) &&
      walkState.nodes![key]?.generation?.tool === 'user'
    ) {
      continue;
    }
    // Delete the on-disk artifact too — some runners (comfy.klein,
    // comfy.tti, comfy.fl2v, comfy.qwen_edit_chain, comfy.ltx_director) have their own
    // "skip if output file exists" cache that runs independently of
    // walkState. If we only clear walkState, those runners see the
    // stale file and return `{skipped: true}` — turning the
    // invalidation into a no-op. Removing the file forces a real
    // re-render. Best-effort; missing/unwritable files are not
    // fatal — the runner-level cache check still works the right
    // way (file gone → re-render).
    const entry = walkState.nodes![key];
    const outputPath = entry?.outputPath;
    let preservedRel: string | null = null;
    if (typeof outputPath === 'string' && outputPath.length > 0) {
      const abs = resolve(opts.projectDir, outputPath);
      try {
        // Preserve the old artifact as a versioned sibling so user can
        // roll back / compare. The canonical path is then free for the
        // next render. Falls back to no-op when the file is gone
        // already.
        const preservedAbs = preserveAsVersion(abs);
        if (preservedAbs) {
          preservedRel = relative(resolve(opts.projectDir), preservedAbs);
        }
      } catch {
        // best-effort; swallow so invalidation still proceeds.
      }
    }
    // Emit version.added so the event log records the preserved file —
    // closes the gap "which version went to which path." Best-effort:
    // event log failure must not abort the invalidate.
    const { nodeId: bareNode, itemId } = splitKey(key);
    if (preservedRel && invLog) {
      try {
        invLog.append({
          kind: 'version.added',
          actor: 'agent',
          branchId: 'main',
          payload: {
            nodeId: bareNode,
            ...(itemId ? { itemId } : {}),
            versionId: `preserved-${Date.now()}-${key}`,
            outputPath: preservedRel,
            source: 'runner',
            reason: 'preserved on invalidateNodes — prior auto-render moved aside before re-run',
          },
        });
      } catch {
        // best-effort
      }
    }
    // Record the invalidation itself so the event-sourced projections
    // (Cards view) mark this instance — and the whole cascade — stale.
    if (invLog) {
      try {
        invLog.append({
          kind: 'node.invalidated',
          actor: 'agent',
          branchId: 'main',
          payload: {
            nodeId: bareNode,
            ...(itemId ? { itemId } : {}),
            reason: opts.source
              ? `invalidateNodes (${opts.source})`
              : 'invalidateNodes cascade',
          },
        });
      } catch {
        // best-effort
      }
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

  // Bail BEFORE mutating state if a walk is already running for this
  // project. Without this, we'd invalidate nodes (a real state mutation)
  // and then have the walk rejected by the lock — leaving the project
  // half-changed under a live walk. The walk lock in walkBundle is the
  // hard guard; this is the clean early exit. (TOCTOU between here and
  // walkBundle's acquire is harmless — walkBundle still rejects.)
  if (isWalkLocked(opts.projectDir)) {
    return {
      ok: false,
      nodeId: opts.nodeId,
      error:
        `cannot regenerate '${key}': a walk is already in progress for this project. ` +
        `Stop it first (dhee_stop_run) or wait for it to finish, then retry.`,
    };
  }

  const inv = await invalidateNodes({
    projectDir: opts.projectDir,
    nodeIds: [key],
  });
  if (inv.error) return { ok: false, error: inv.error };

  // Post-cascade: invalidateNodes already cleared the target item + every
  // transitive consumer from walkState. The walker just needs to do a
  // normal topo walk; state-as-truth (pending → run, completed → skip)
  // produces the right execution set without any runOnly force-rerun
  // hint. The old `runOnly: [opts.nodeId]` was a band-aid for missing
  // cascade behavior — no longer needed.
  const runner = opts.runProjectViaBundle ?? defaultRunner;
  const runOpts: RunProjectViaBundleOpts = {
    projectDir: opts.projectDir,
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
