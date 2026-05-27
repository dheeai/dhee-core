/**
 * DAG bundle walker — v1 downstream renderer scope.
 *
 * Loads a bundle JSON, walks backward from the goal node, expands
 * collection nodes from CLI-provided item specs, resolves each node's
 * inputs against the project's existing artifacts, and dispatches to
 * the runner registered for each node's `runner.tool`.
 *
 * Out of scope for v1: redo isolation, abort recovery, mutation
 * persistence, the full reconciliation loop. The walker assumes the
 * project already has the upstream artifacts (scene plans, first
 * frames) on disk — it produces only the new ones declared by the
 * bundle. See docs/dag-bundles-sketch.md "Backward walker" section.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DagBundle, NodeDef, RunnerContext, RunnerResult } from './schema.js';
import { getRunner } from './runners/index.js';
import { getGlobalRegistry } from './runners/registry.js';
import { resolveRelayInputs, chunkScene } from './projectResolvers.js';
import { REPO_ROOT } from '../agent/pi/paths.js';
import {
  loadWalkState,
  saveWalkState,
  initWalkState,
  pruneStaleEntries,
  type WalkState,
} from './walkState.js';

export {
  loadWalkState,
  saveWalkState,
  initWalkState,
  pruneStaleEntries,
} from './walkState.js';
export type { WalkState, NodeStateEntry, NodeRunStatus } from './walkState.js';

export interface WalkerCliParams {
  /** Which scene(s) to render. */
  sceneIds?: number[];
}

export interface WalkerOptions {
  projectDir: string;
  bundle: DagBundle;
  cli?: WalkerCliParams;
  log?: (msg: string) => void;
  /**
   * Bundle source URI (e.g. 'built-in:narrative_relay'). Required for
   * walkState persistence — when set, the walker reads/writes
   * project.json walkState. When absent (legacy callers like
   * runProjectInProcess), the walker runs without state.
   */
  bundleSource?: string;
  /**
   * Stop after running this node id (and its upstream). When set, the
   * walker runs everything topologically ≤ stopAt, then stops; nodes
   * downstream stay pending in walkState. Stopping at the bundle's
   * goal node is equivalent to no stopAt (run to completion).
   */
  stopAt?: string;
  /**
   * When set, walker runs only these node ids and their transitive
   * dependents. Everything not in the cascade is skipped (state
   * preserved as-is). Used by `dhee_run_to scope=last_invalidated`
   * to redo a single node without re-cascading the whole graph. Empty
   * array means "explicitly run nothing" (legitimate signal, not a
   * no-op fallback).
   */
  runOnly?: string[];
  /**
   * Absolute path to the bundle directory. Threaded into every
   * runner's ctx.bundleDir for resolving prompt templates, workflow
   * JSONs, schemas. Optional; legacy callers may omit it (single-file
   * bundles have no co-located resources).
   */
  bundleDir?: string;
  /** Cooperative cancellation signal — threaded into every runner ctx. */
  signal?: AbortSignal;
}

interface NodeInstance {
  /** Bundle node definition. */
  def: NodeDef;
  /** For collection items: the resolved item id (e.g. 'scene_1', 'scene_1_chunk_2'). */
  itemId?: string;
  /** For chunked scene_clip: parent scene number this instance covers. */
  sceneNumber?: number;
  /** For chunked scene_clip: contiguous shot range within the scene. */
  shotRange?: [number, number];
  /** Chunk index within its parent scene (1-based). */
  chunkIndex?: number;
  /** Total chunks for the parent scene. */
  chunkCount?: number;
  /** Status. */
  status: 'pending' | 'completed' | 'failed';
  /** After completion: absolute path to the output artifact. */
  outputAbs?: string;
  /** After completion: relative path (per bundle's outputs.pattern). */
  outputRel?: string;
  /** Runner metadata. */
  metadata?: Record<string, unknown>;
}

/**
 * Backward-walk: starting from the goal node, find all node defs that
 * (transitively) feed it. Returns nodes in dependency order (leaves first).
 */
function topoFromGoal(bundle: DagBundle): NodeDef[] {
  const byId = new Map(bundle.nodes.map((n) => [n.id, n]));
  const goal = byId.get(bundle.goal);
  if (!goal) {
    throw new Error(`Bundle goal node '${bundle.goal}' not found in nodes[]`);
  }

  const visited = new Set<string>();
  const order: NodeDef[] = [];

  function visit(node: NodeDef): void {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    for (const inp of node.inputs) {
      const upstream = byId.get(inp.from);
      if (upstream) visit(upstream);
    }
    order.push(node);
  }

  visit(goal);
  return order;
}

/**
 * Materialize a collection node into per-item instances.
 *
 * For `itemSource: 'scene'`:
 *   - Without `chunkBy`: one instance per scene (whole scene as one render).
 *   - With `chunkBy`: greedy-chunk each scene's shots under the runner's
 *     constraint (e.g. LTX 1000-frame cap) and create one instance per
 *     chunk. itemId becomes 'scene_N_chunk_M'.
 *
 * The chunking is the bundle architecture's strategy decision — when a
 * scene exceeds the runner's hard cap, the bundle decides how to slice
 * it. Swapping to a runner with a different cap is a config change here,
 * not a code change.
 */
function materializeCollection(
  node: NodeDef,
  projectDir: string,
  cli: WalkerCliParams,
  upstreamInstances: Map<string, NodeInstance[]>,
): NodeInstance[] {
  // ── Legacy 'scene' path (ltx_prompt_relay's scene_clip chunking) ──
  if (node.itemSource === 'scene' && cli.sceneIds && cli.sceneIds.length > 0) {
    const out: NodeInstance[] = [];
    for (const sceneNum of cli.sceneIds) {
      if (node.chunkBy && node.chunkBy.constraint === 'max_frames') {
        const fps = node.chunkBy.fps ?? 24;
        const firstPlusOne = node.chunkBy.firstSegmentPlusOne ?? false;
        const chunks = chunkScene(projectDir, sceneNum, node.chunkBy.limit, fps, firstPlusOne);
        if (chunks.length === 0) {
          throw new Error(`materializeCollection: no chunks computed for scene ${sceneNum}`);
        }
        chunks.forEach((c, idx) => {
          out.push({
            def: node,
            itemId: `scene_${sceneNum}_chunk_${idx + 1}`,
            sceneNumber: sceneNum,
            shotRange: [c.startShot, c.endShot],
            chunkIndex: idx + 1,
            chunkCount: chunks.length,
            status: 'pending',
          });
        });
      } else {
        out.push({ def: node, itemId: `scene_${sceneNum}`, sceneNumber: sceneNum, status: 'pending' });
      }
    }
    return out;
  }

  // ── Upstream-driven materialization ──
  // Collection node's items come from a JSON array in an upstream
  // node's output. Format: `itemSource: <upstreamNodeId>`, the
  // upstream output is a JSON file containing an array of `{id, ...}`
  // objects OR a top-level array of strings/objects. Each becomes one
  // instance with `itemId = <object.id>` (or stringified value).
  //
  // The walker reads the upstream node's outputPath (resolved against
  // projectDir) when materializing this collection. The upstream must
  // therefore have completed before this node's materialization runs
  // — guaranteed by topo order, but the walker enforces it explicitly
  // here for clarity.
  if (node.itemSource) {
    const upstream = upstreamInstances.get(node.itemSource);
    if (!upstream || upstream.length === 0) {
      throw new Error(
        `materializeCollection: itemSource '${node.itemSource}' has no instances (upstream not materialized yet)`,
      );
    }
    // For single-stage upstreams, read its output file.
    if (upstream.length === 1 && upstream[0]!.outputRel) {
      const upstreamPath = resolve(projectDir, upstream[0]!.outputRel);
      if (!existsSync(upstreamPath)) {
        throw new Error(
          `materializeCollection: upstream '${node.itemSource}' output not on disk at ${upstreamPath}`,
        );
      }
      const raw = JSON.parse(readFileSync(upstreamPath, 'utf-8')) as unknown;
      // Accept either: top-level array, or { items: [...] }, or a
      // map of the right shape under a node-specific key (e.g.
      // story.characters[], scene.shots[]).
      let items: Array<{ id?: string; name?: string } | string> = [];
      if (Array.isArray(raw)) {
        items = raw as Array<{ id?: string; name?: string } | string>;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        // Try `items`, then any top-level array property.
        if (Array.isArray(obj['items'])) items = obj['items'] as Array<{ id?: string; name?: string } | string>;
        else {
          for (const v of Object.values(obj)) {
            if (Array.isArray(v)) {
              items = v as Array<{ id?: string; name?: string } | string>;
              break;
            }
          }
        }
      }
      if (items.length === 0) {
        throw new Error(
          `materializeCollection: upstream '${node.itemSource}' output ${upstreamPath} has no items to materialize`,
        );
      }
      return items.map((item) => {
        const itemId =
          typeof item === 'string'
            ? item.replace(/\s+/g, '_').toLowerCase()
            : String(item.id ?? item.name ?? '').replace(/\s+/g, '_').toLowerCase();
        if (!itemId) {
          throw new Error(
            `materializeCollection: item in '${node.itemSource}' has no id or name`,
          );
        }
        return { def: node, itemId, status: 'pending' as const };
      });
    }
    // For collection upstreams (e.g. shot_breakdown is one-per-shot,
    // and shot_image is also one-per-shot), each upstream instance
    // becomes one downstream instance with the same itemId.
    return upstream.map((u) => ({
      def: node,
      ...(u.itemId !== undefined ? { itemId: u.itemId } : {}),
      ...(u.sceneNumber !== undefined ? { sceneNumber: u.sceneNumber } : {}),
      status: 'pending' as const,
    }));
  }

  // No itemSource: treat as a stage node with one instance.
  return [{ def: node, status: 'pending' }];
}

/**
 * Substitute {{key}} placeholders in a string using ctx values.
 * Supports {{scene_id}} (e.g. 'scene_1') and {{shot_id}}.
 */
function applyPattern(pattern: string, ctx: Record<string, string>): string {
  return pattern.replace(/\{\{(\w+)\}\}/g, (_, k) => ctx[k] ?? `{{${k}}}`);
}

/**
 * Build the runner config by merging the bundle's static config with
 * runtime-resolved inputs (artifacts read from disk, paths from
 * upstream nodes). Bundle-specific knowledge of "what each runner
 * wants" lives here for v1.
 */
function buildRunnerConfig(
  inst: NodeInstance,
  projectDir: string,
  instancesById: Map<string, NodeInstance[]>,
): Record<string, unknown> {
  const node = inst.def;
  const base = { ...node.runner.config };

  // Output path: render pattern with item context.
  const outputCtx: Record<string, string> = {};
  if (inst.itemId) outputCtx['scene_id'] = inst.itemId;
  const outputPath = applyPattern(node.outputs.pattern, outputCtx);
  base['outputPath'] = outputPath;

  // Per-runner input resolution.
  if (node.runner.tool === 'comfy.ltx_director') {
    // Instance carries chunk-specific scene + shotRange after materialization.
    if (inst.sceneNumber === undefined || !inst.shotRange) {
      throw new Error('comfy.ltx_director: instance missing sceneNumber/shotRange');
    }
    const resolved = resolveRelayInputs(projectDir, inst.sceneNumber, inst.shotRange);
    base['shots'] = resolved.shots;
    base['firstFrames'] = resolved.firstFrames;
    base['globalPrompt'] = resolved.globalPrompt;
    // workflowPath may already be in config; resolve relative paths
    // against the kshana-core package root (NOT process.cwd()), so the
    // bundle resolves correctly when kshana-core is loaded as a library
    // by a host process (desktop Electron, packaged CLI) whose cwd is
    // unrelated to where the workflow JSONs ship.
    const wfRaw = (base['workflowPath'] as string | undefined) ?? '';
    if (wfRaw && !wfRaw.startsWith('/')) {
      base['workflowPath'] = resolve(REPO_ROOT, wfRaw);
    }
  } else if (node.runner.tool === 'ffmpeg.concat') {
    // Inputs come from upstream node outputs. Walk node.inputs and
    // collect absolute paths from completed instances.
    const inputs: string[] = [];
    for (const inp of node.inputs) {
      const upstreams = instancesById.get(inp.from) ?? [];
      for (const u of upstreams) {
        if (u.status === 'completed' && u.outputAbs) {
          inputs.push(u.outputAbs);
        }
      }
    }
    base['inputs'] = inputs;
  }

  return base;
}

/**
 * Compute the cascade set for runOnly: the requested nodes plus every
 * node that transitively depends on any of them. Returns a Set of node
 * ids (bundle-level, not per-instance).
 *
 * Throws when a requested node isn't in the bundle — callers turn this
 * into ok:false at the walkBundle boundary.
 */
function computeCascade(bundle: DagBundle, runOnly: string[]): Set<string> {
  const bundleNodeIds = new Set(bundle.nodes.map((n) => n.id));
  for (const id of runOnly) {
    if (!bundleNodeIds.has(id)) {
      throw new Error(`runOnly node id '${id}' is not in bundle (valid nodes: ${[...bundleNodeIds].join(', ')})`);
    }
  }
  // Build reverse adjacency: who points AT each node?
  const dependents = new Map<string, Set<string>>();
  for (const n of bundle.nodes) {
    for (const inp of n.inputs) {
      let s = dependents.get(inp.from);
      if (!s) {
        s = new Set();
        dependents.set(inp.from, s);
      }
      s.add(n.id);
    }
  }
  // BFS from each runOnly id over dependents.
  const cascade = new Set<string>();
  const queue = [...runOnly];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (cascade.has(id)) continue;
    cascade.add(id);
    for (const d of dependents.get(id) ?? []) {
      queue.push(d);
    }
  }
  return cascade;
}

/** Walk the bundle and run every reachable node to completion. */
export async function walkBundle(opts: WalkerOptions): Promise<{
  ok: boolean;
  goal?: { outputRel: string; outputAbs: string };
  error?: string;
  instances: NodeInstance[];
}> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const cli = opts.cli ?? {};

  // Bundle dependency validation — fail BEFORE walking when a declared
  // runner isn't registered, version doesn't satisfy, or required
  // credential env var is missing. Cheap pre-flight that saves the
  // user a half-rendered project.
  if (opts.bundle.dependencies) {
    const v = getGlobalRegistry().validateBundle(opts.bundle);
    if (!v.ok) {
      const msg = `bundle validation failed:\n  - ${v.errors.join('\n  - ')}`;
      log(msg);
      return { ok: false, error: msg, instances: [] };
    }
  }

  // Topo validation up front — surfaces invalid stopAt / runOnly with
  // the bundle's actual node list before doing any work.
  const bundleNodeIds = new Set(opts.bundle.nodes.map((n) => n.id));
  if (opts.stopAt && !bundleNodeIds.has(opts.stopAt)) {
    return {
      ok: false,
      error: `stopAt '${opts.stopAt}' is not in bundle (valid nodes: ${[...bundleNodeIds].join(', ')}).`,
      instances: [],
    };
  }
  let cascadeSet: Set<string> | null = null;
  if (opts.runOnly !== undefined) {
    try {
      cascadeSet = computeCascade(opts.bundle, opts.runOnly);
    } catch (e) {
      return { ok: false, error: (e as Error).message, instances: [] };
    }
  }

  const ordered = topoFromGoal(opts.bundle);
  log(`walker: bundle '${opts.bundle.id}' v${opts.bundle.version}, ${ordered.length} reachable nodes`);

  // walkState: load + prune stale entries from previous bundles.
  let state: WalkState | null = null;
  if (opts.bundleSource) {
    state =
      loadWalkState(opts.projectDir) ??
      initWalkState({
        bundleSource: opts.bundleSource,
        bundleVersion: opts.bundle.version,
        engineVersion: '0.1.0',
      });
    if (state.bundleSource !== opts.bundleSource) {
      log(`walker: walkState bundleSource changed (${state.bundleSource} → ${opts.bundleSource}); reinitializing.`);
      state = initWalkState({
        bundleSource: opts.bundleSource,
        bundleVersion: opts.bundle.version,
        engineVersion: '0.1.0',
      });
    }
    const pruned = pruneStaleEntries(state, bundleNodeIds);
    if (pruned > 0) {
      log(`walker: pruned ${pruned} stale walkState entries (nodes no longer in bundle).`);
    }
    // Initialize entries for any bundle nodes that aren't yet in
    // walkState. Status defaults to 'pending' so callers can read the
    // full DAG state in one go (the agent shows "5 of 8 done"; the
    // missing 3 need to be visible as pending).
    for (const n of opts.bundle.nodes) {
      if (!state.nodes[n.id]) {
        state.nodes[n.id] = { status: 'pending' };
      }
    }
  }

  const persistState = (): void => {
    if (opts.bundleSource && state) {
      saveWalkState(opts.projectDir, state);
    }
  };

  // Materialize instances per node. For 'scene'-sourced collections
  // with CLI-provided scene ids, we can materialize up front. For
  // upstream-driven collections (where items come from a not-yet-run
  // node's output), we defer materialization to run-time — the
  // upstream will be completed by the time we reach this node thanks
  // to topo order.
  const instancesById = new Map<string, NodeInstance[]>();
  for (const node of ordered) {
    if (node.kind === 'collection') {
      if (node.itemSource === 'scene' && cli.sceneIds && cli.sceneIds.length > 0) {
        instancesById.set(node.id, materializeCollection(node, opts.projectDir, cli, instancesById));
      } else {
        // Lazy: empty for now; materialized when we reach the node.
        instancesById.set(node.id, []);
      }
    } else {
      instancesById.set(node.id, [{ def: node, status: 'pending' }]);
    }
  }

  const allInstances: NodeInstance[] = [];
  for (const node of ordered) {
    allInstances.push(...(instancesById.get(node.id) ?? []));
  }

  // Run in topo order.
  let stopAtReached = false;
  for (const node of ordered) {
    if (stopAtReached) break;

    // Lazy materialization for upstream-driven collections. By topo
    // order, every input.from upstream has already run; their output
    // files exist on disk and their instance metadata is in
    // instancesById. materializeCollection reads from these.
    if (node.kind === 'collection' && (instancesById.get(node.id) ?? []).length === 0) {
      try {
        const materialized = materializeCollection(node, opts.projectDir, cli, instancesById);
        instancesById.set(node.id, materialized);
      } catch (e) {
        const err = `${node.id}: materializeCollection failed: ${(e as Error).message}`;
        log(`✗ ${err}`);
        return { ok: false, error: err, instances: allInstances };
      }
    }

    const insts = instancesById.get(node.id) ?? [];

    // runOnly filter — skip nodes not in the cascade.
    if (cascadeSet !== null && !cascadeSet.has(node.id)) {
      // Mark instances as skipped (preserve any prior state from walkState).
      continue;
    }

    for (const inst of insts) {
      const stateKey = inst.itemId ? `${node.id}:${inst.itemId}` : node.id;

      // Resume short-circuit: if walkState says completed AND output
      // file is present, skip. (If output is gone, treat as missing
      // and re-run.)
      //
      // EXCEPTION: when runOnly is set AND this node is in the cascade,
      // the caller explicitly asked to redo this node — bypass the
      // short-circuit. Skipping here would silently turn a redo
      // request into a no-op.
      const explicitlyRunning = cascadeSet !== null && cascadeSet.has(node.id);
      if (state && !explicitlyRunning) {
        const prior = state.nodes[stateKey];
        if (prior && prior.status === 'completed' && prior.outputPath) {
          const priorAbs = resolve(opts.projectDir, prior.outputPath);
          if (existsSync(priorAbs)) {
            inst.status = 'completed';
            inst.outputRel = prior.outputPath;
            inst.outputAbs = priorAbs;
            if (prior.metadata) inst.metadata = prior.metadata;
            log(`◌ ${node.id}${inst.itemId ? `[${inst.itemId}]` : ''} (already completed)`);
            continue;
          }
        }
      }

      const runner = getRunner(node.runner.tool);
      if (!runner) {
        const err = `runner '${node.runner.tool}' not registered`;
        log(`✗ ${node.id}${inst.itemId ? `[${inst.itemId}]` : ''}: ${err}`);
        inst.status = 'failed';
        if (state) {
          state.nodes[stateKey] = { status: 'failed', error: err };
          persistState();
        }
        return { ok: false, error: err, instances: allInstances };
      }

      const cfg = buildRunnerConfig(inst, opts.projectDir, instancesById);
      // For LLM runners: outputPath must be a node-specific path (one
      // per instance) so collections don't all write to the same file.
      // We derive it from outputs.pattern with item-context substitution
      // and pass it into the config under the `outputPath` key the LLM
      // runner expects.
      if (node.runner.tool === 'llm.generate') {
        const ctxVars = {
          item_id: inst.itemId ?? '',
          scene_id: inst.sceneNumber ? `scene_${inst.sceneNumber}` : '',
          shot_id: inst.itemId ?? '',
        };
        (cfg as Record<string, unknown>)['outputPath'] = applyPattern(
          node.outputs.pattern,
          ctxVars,
        );
      }
      const runtimeNode: NodeDef = {
        ...node,
        runner: { ...node.runner, config: cfg },
      };

      // Resolve ctx.inputs from upstream completed nodes. For each
      // declared input, read the upstream's output file (markdown →
      // string, json → parsed value) and key by the upstream node id.
      // The llm.generate runner uses these to substitute {{node_id}}
      // placeholders in its prompt template.
      const resolvedInputs: Record<string, unknown> = {};
      for (const inp of node.inputs) {
        const upInsts = instancesById.get(inp.from) ?? [];
        if (upInsts.length === 0) continue;
        // For 'matching' scope on collections, pick the upstream
        // instance with the same itemId. Otherwise concatenate /
        // pick first.
        const matching =
          inst.itemId
            ? upInsts.find((u) => u.itemId === inst.itemId) ?? upInsts[0]
            : upInsts[0];
        if (!matching?.outputRel) continue;
        const upAbs = resolve(opts.projectDir, matching.outputRel);
        if (!existsSync(upAbs)) continue;
        try {
          const raw = readFileSync(upAbs, 'utf-8');
          // If JSON, parse; else keep as string.
          let value: unknown = raw;
          if (matching.outputRel.endsWith('.json')) {
            try {
              value = JSON.parse(raw);
            } catch {
              // keep raw
            }
          }
          resolvedInputs[inp.from] = value;
        } catch {
          // skip; runner will fail at substitution if it needs this
        }
      }

      const ctx: RunnerContext = {
        projectDir: opts.projectDir,
        ...(opts.bundleDir ? { bundleDir: opts.bundleDir } : {}),
        node: runtimeNode,
        ...(inst.itemId !== undefined && { itemId: inst.itemId }),
        inputs: resolvedInputs,
        ...(opts.signal ? { signal: opts.signal } : {}),
        log: (m) => log(`  ${m}`),
      };

      if (state) {
        state.nodes[stateKey] = { status: 'in_progress', startedAt: Date.now() };
        persistState();
      }

      log(`→ ${node.id}${inst.itemId ? `[${inst.itemId}]` : ''} via ${node.runner.tool}`);
      let result: RunnerResult;
      try {
        result = await runner.run(ctx);
      } catch (e) {
        result = { ok: false, error: (e as Error).message };
      }

      if (!result.ok) {
        log(`✗ ${node.id}${inst.itemId ? `[${inst.itemId}]` : ''}: ${result.error}`);
        inst.status = 'failed';
        if (state) {
          state.nodes[stateKey] = { status: 'failed', error: result.error };
          persistState();
        }
        return { ok: false, error: result.error, instances: allInstances };
      }

      inst.status = 'completed';
      inst.outputRel = result.outputPath;
      inst.outputAbs = resolve(opts.projectDir, result.outputPath);
      if (result.metadata !== undefined) inst.metadata = result.metadata;
      if (state) {
        state.nodes[stateKey] = {
          status: 'completed',
          outputPath: result.outputPath,
          completedAt: Date.now(),
          ...(inst.itemId !== undefined ? { itemId: inst.itemId } : {}),
          ...(result.metadata ? { metadata: result.metadata } : {}),
        };
        persistState();
      }
      log(`✓ ${node.id}${inst.itemId ? `[${inst.itemId}]` : ''} → ${result.outputPath}`);
    }

    if (opts.stopAt && node.id === opts.stopAt) {
      stopAtReached = true;
      log(`walker: reached stopAt='${opts.stopAt}', halting.`);
    }
  }

  // Goal output (only meaningful when the goal node ran).
  const goalInsts = instancesById.get(opts.bundle.goal) ?? [];
  const goalInst = goalInsts[0];
  if (goalInst && goalInst.status === 'completed' && goalInst.outputAbs) {
    return {
      ok: true,
      goal: { outputRel: goalInst.outputRel!, outputAbs: goalInst.outputAbs },
      instances: allInstances,
    };
  }
  // If stopAt was used or runOnly was set, the goal isn't expected to
  // have completed — return ok without a goal payload.
  if (opts.stopAt || opts.runOnly !== undefined) {
    return { ok: true, instances: allInstances };
  }
  return { ok: false, error: 'goal node did not complete', instances: allInstances };
}

/** Load a bundle JSON from disk. */
export function loadBundle(path: string): DagBundle {
  if (!existsSync(path)) {
    throw new Error(`Bundle not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as DagBundle;
  if (!raw.id || !raw.goal || !Array.isArray(raw.nodes)) {
    throw new Error(`Invalid bundle at ${path}: missing id/goal/nodes`);
  }
  return raw;
}
