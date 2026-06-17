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

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { cascadeInvalidationKeys, type CascadeTarget } from './cascadeInvalidationKeys.js';
import { parseBundleSource, resolveBundleDir } from './bundleSource.js';
import { openEventLog } from './eventLog/EventLog.js';
import { preserveAsVersion } from './preserveAsVersion.js';
import { isWalkLocked } from './projectWalkLock.js';
import type {
  RunProjectViaBundleOpts,
  RunProjectViaBundleResult,
} from '../server/runners/runProjectViaBundle.js';
import type { DagBundle } from './schema.js';

/**
 * Transitive downstream node ids via the bundle's STATIC inputs[].from
 * graph. Authoritative and never stale — unlike the event-recorded
 * dependency graph, which a runner can poison by recording a wrong/stale
 * upstream id (issue #158: comfy.klein recorded a phantom
 * 'shot_image_prompt' dep, so the event-derived cascade missed the real
 * image node and the critique never re-rendered it). Returns bare node
 * ids (excludes the requested targets themselves).
 */
function bundleStructuralDownstream(bundle: DagBundle, requested: string[]): string[] {
  const downstream = new Map<string, string[]>();
  for (const node of bundle.nodes) {
    for (const input of node.inputs) {
      const list = downstream.get(input.from) ?? [];
      if (!list.includes(node.id)) list.push(node.id);
      downstream.set(input.from, list);
    }
  }
  const out = new Set<string>();
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of requested) {
    const bare = r.includes(':') ? r.split(':')[0]! : r;
    if (!seen.has(bare)) { seen.add(bare); queue.push(bare); }
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of downstream.get(cur) ?? []) {
      if (!out.has(next)) out.add(next);
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return [...out];
}

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
  /**
   * Loads the project's bundle so the invalidation cascade follows the
   * authoritative static `inputs[].from` graph (issue #158) instead of
   * the event-recorded deps, which a runner can leave incomplete (e.g.
   * comfy.ltx_director clips not recording their audio upstream — that
   * left `regen <audio>` failing to re-render the dependent clip).
   * Defaults to reading project.json's bundleSource. Override for tests.
   */
  loadBundleForProject?: (projectDir: string) => DagBundle | Promise<DagBundle>;
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
  /** When provided, the cascade ALSO follows the bundle's static
   *  inputs[].from graph (authoritative, never stale), unioned with the
   *  event-derived cascade. Without this, a runner that recorded a
   *  wrong/stale upstream id silently breaks the cascade — the apply
   *  then disagrees with the bundle-graph preview (issue #158). */
  bundle?: DagBundle;
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

  // Union in the bundle's STATIC structural downstream (issue #158). The
  // event-derived cascade above is item-precise but goes blind when a
  // runner recorded a wrong/stale upstream id (e.g. comfy.klein's phantom
  // 'shot_image_prompt' dep), silently leaving the dependent image
  // `completed`. The bundle inputs[] graph never goes stale, so a prompt
  // critique reliably reaches its image + everything downstream — matching
  // what computeCascadeImpact already shows in the preview.
  if (opts.bundle) {
    const set = new Set(cascadeKeys);
    for (const n of bundleStructuralDownstream(opts.bundle, opts.nodeIds)) set.add(n);
    cascadeKeys = [...set];
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
/**
 * Default bundle loader for regenerateNode — reads project.json's
 * bundleSource and resolves the manifest. `loadBundle` is dynamically
 * imported to avoid the walker ↔ projectRegen import cycle (walker.ts
 * re-exports invalidateNodes/regenerateNode from this module).
 */
async function defaultLoadBundleForProject(projectDir: string): Promise<DagBundle> {
  const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf8')) as { bundleSource?: string };
  if (typeof pj.bundleSource !== 'string') {
    throw new Error('project.json has no bundleSource field.');
  }
  const bundleDir = resolveBundleDir(parseBundleSource(pj.bundleSource));
  let manifestPath = bundleDir;
  try {
    if (statSync(bundleDir).isDirectory()) manifestPath = join(bundleDir, 'bundle.json');
  } catch {
    /* fall through — treat bundleDir as the manifest path */
  }
  const { loadBundle } = await import('./walker.js');
  return loadBundle(manifestPath);
}

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

  // Load the bundle so the cascade follows the authoritative static
  // inputs[].from graph (#158). If it can't be loaded, fall back to the
  // event-derived cascade rather than failing the regen outright.
  let bundle: DagBundle | undefined;
  try {
    bundle = await (opts.loadBundleForProject ?? defaultLoadBundleForProject)(opts.projectDir);
  } catch {
    bundle = undefined;
  }

  const inv = await invalidateNodes({
    projectDir: opts.projectDir,
    nodeIds: [key],
    ...(bundle ? { bundle } : {}),
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
