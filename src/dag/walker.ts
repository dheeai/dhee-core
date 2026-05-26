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
import { resolveRelayInputs, chunkScene } from './projectResolvers.js';

export interface WalkerCliParams {
  /** Which scene(s) to render. */
  sceneIds?: number[];
}

export interface WalkerOptions {
  projectDir: string;
  bundle: DagBundle;
  cli?: WalkerCliParams;
  log?: (msg: string) => void;
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
function materializeCollection(node: NodeDef, projectDir: string, cli: WalkerCliParams): NodeInstance[] {
  if (node.itemSource !== 'scene') {
    throw new Error(
      `materializeCollection: itemSource '${node.itemSource}' not supported in v1 (only 'scene')`,
    );
  }

  const sceneIds = cli.sceneIds ?? [];
  if (sceneIds.length === 0) {
    throw new Error(`Collection node '${node.id}' requires --scenes CLI arg`);
  }

  const out: NodeInstance[] = [];
  for (const sceneNum of sceneIds) {
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
    // workflowPath may already be in config; resolve relative paths.
    const wfRaw = (base['workflowPath'] as string | undefined) ?? '';
    if (wfRaw && !wfRaw.startsWith('/')) {
      base['workflowPath'] = resolve(process.cwd(), wfRaw);
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

/** Walk the bundle and run every reachable node to completion. */
export async function walkBundle(opts: WalkerOptions): Promise<{
  ok: boolean;
  goal?: { outputRel: string; outputAbs: string };
  error?: string;
  instances: NodeInstance[];
}> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const cli = opts.cli ?? {};
  const ordered = topoFromGoal(opts.bundle);
  log(`walker: bundle '${opts.bundle.id}' v${opts.bundle.version}, ${ordered.length} reachable nodes`);

  // Materialize instances per node.
  const instancesById = new Map<string, NodeInstance[]>();
  for (const node of ordered) {
    if (node.kind === 'collection') {
      instancesById.set(node.id, materializeCollection(node, opts.projectDir, cli));
    } else {
      instancesById.set(node.id, [{ def: node, status: 'pending' }]);
    }
  }

  // Summary log: planned execution shape.
  for (const node of ordered) {
    const insts = instancesById.get(node.id) ?? [];
    if (insts.length === 1 && !insts[0]!.itemId) {
      log(`  plan: ${node.id} (stage)`);
    } else {
      const summary = insts
        .map((i) => `${i.itemId}${i.shotRange ? ` shots ${i.shotRange[0]}-${i.shotRange[1]}` : ''}`)
        .join(', ');
      log(`  plan: ${node.id} × ${insts.length} (${summary})`);
    }
  }

  const allInstances: NodeInstance[] = [];
  for (const node of ordered) {
    allInstances.push(...(instancesById.get(node.id) ?? []));
  }

  // Run in topo order. Within a node, run all its instances (single
  // for stage; one per item for collection).
  for (const node of ordered) {
    const insts = instancesById.get(node.id) ?? [];
    for (const inst of insts) {
      const runner = getRunner(node.runner.tool);
      if (!runner) {
        const err = `runner '${node.runner.tool}' not registered`;
        log(`✗ ${node.id}${inst.itemId ? `[${inst.itemId}]` : ''}: ${err}`);
        inst.status = 'failed';
        return { ok: false, error: err, instances: allInstances };
      }

      const cfg = buildRunnerConfig(inst, opts.projectDir, instancesById);
      const runtimeNode: NodeDef = {
        ...node,
        runner: { ...node.runner, config: cfg },
      };

      const ctx: RunnerContext = {
        projectDir: opts.projectDir,
        node: runtimeNode,
        ...(inst.itemId !== undefined && { itemId: inst.itemId }),
        inputs: {},
        log: (m) => log(`  ${m}`),
      };

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
        return { ok: false, error: result.error, instances: allInstances };
      }

      inst.status = 'completed';
      inst.outputRel = result.outputPath;
      inst.outputAbs = resolve(opts.projectDir, result.outputPath);
      if (result.metadata !== undefined) inst.metadata = result.metadata;
      log(`✓ ${node.id}${inst.itemId ? `[${inst.itemId}]` : ''} → ${result.outputPath}`);
    }
  }

  // Goal output.
  const goalInsts = instancesById.get(opts.bundle.goal) ?? [];
  const goalInst = goalInsts[0];
  if (!goalInst || goalInst.status !== 'completed' || !goalInst.outputAbs) {
    return { ok: false, error: 'goal node did not complete', instances: allInstances };
  }
  return {
    ok: true,
    goal: { outputRel: goalInst.outputRel!, outputAbs: goalInst.outputAbs },
    instances: allInstances,
  };
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
