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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function formatSrtTime(totalSeconds: number): string {
  const ms = Math.floor((totalSeconds % 1) * 1000);
  const s = Math.floor(totalSeconds) % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return (
    `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')},` +
    `${ms.toString().padStart(3, '0')}`
  );
}
import type { DagBundle, NodeDef, RunnerContext, RunnerResult } from './schema.js';
import type { BundleInputDecl } from './schema.js';
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
export {
  findByCapability,
  findInstanceByCapability,
  listCompletedItemIds,
} from './capabilities.js';
export type {
  CapabilityNode,
  CapabilityInstance,
  ProjectStateLike,
} from './capabilities.js';
export {
  parseBundleSource,
  resolveBundleDir,
  BundleSourceError,
} from './bundleSource.js';
export type { BundleSource } from './bundleSource.js';
export type { DagBundle, NodeDef, NodeInput, NodeOutput } from './schema.js';
export { invalidateNodes, regenerateNode } from './projectRegen.js';
export type {
  InvalidateNodesOpts,
  InvalidateNodesResult,
  RegenerateNodeOpts,
  RegenerateNodeResult,
  RunProjectViaBundleFn,
} from './projectRegen.js';

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
    // If the upstream is itself a collection (has any instance with
    // an itemId), mirror its instances one-to-one rather than trying
    // to read an array out of any single output file. This is the
    // "fan-through" case (e.g. character_image follows
    // character_image_prompt with the same itemIds).
    const upstreamHasItemIds = upstream.some((u) => u.itemId !== undefined);
    if (upstreamHasItemIds) {
      return upstream.map((u) => ({
        def: node,
        ...(u.itemId !== undefined ? { itemId: u.itemId } : {}),
        ...(u.sceneNumber !== undefined ? { sceneNumber: u.sceneNumber } : {}),
        status: 'pending' as const,
      }));
    }

    // Stage upstream (single instance, no itemId) — read its output file.
    if (upstream.length === 1 && upstream[0]!.outputRel) {
      const upstreamPath = resolve(projectDir, upstream[0]!.outputRel);
      if (!existsSync(upstreamPath)) {
        throw new Error(
          `materializeCollection: upstream '${node.itemSource}' output not on disk at ${upstreamPath}`,
        );
      }
      const raw = JSON.parse(readFileSync(upstreamPath, 'utf-8')) as unknown;
      // Accept: top-level array, or { itemKey: [...] } (when
      // node.itemKey is declared), or { items: [...] }, or first
      // array-valued property as a last resort. Honoring itemKey
      // first is critical when the upstream emits multiple arrays
      // (e.g. scenes_plan: {scenes, shots}).
      let items: Array<{ id?: string; name?: string } | string> = [];
      if (Array.isArray(raw)) {
        items = raw as Array<{ id?: string; name?: string } | string>;
      } else if (raw && typeof raw === 'object') {
        const obj = raw as Record<string, unknown>;
        if (node.itemKey && Array.isArray(obj[node.itemKey])) {
          items = obj[node.itemKey] as Array<{ id?: string; name?: string } | string>;
        } else if (Array.isArray(obj['items'])) {
          items = obj['items'] as Array<{ id?: string; name?: string } | string>;
        } else {
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
      // ── chunkBy on upstream-driven materializer ──
      // When the node declares chunkBy AND items are scenes (itemKey='scenes')
      // AND the upstream JSON also has a sibling 'shots' array, slice each
      // scene's shots into chunks under the frame cap and emit one instance
      // per chunk. itemId becomes 'scene_N_chunk_M', shotRange is set.
      if (
        node.chunkBy &&
        node.chunkBy.constraint === 'max_frames' &&
        node.itemKey === 'scenes' &&
        raw &&
        typeof raw === 'object' &&
        Array.isArray((raw as Record<string, unknown>)['shots'])
      ) {
        const cap = node.chunkBy.limit;
        const fps = node.chunkBy.fps ?? 24;
        const firstPlusOne = node.chunkBy.firstSegmentPlusOne ?? false;
        const allShots = (raw as { shots: Array<{ id?: string; scene?: number; shotNumber?: number; duration?: number }> }).shots;
        // Derive scene/shotNumber from shot.id when missing (LLM drift safety).
        for (const s of allShots) {
          if (s.scene === undefined || s.shotNumber === undefined) {
            const m = (s.id ?? '').match(/^scene_(\d+)_shot_(\d+)$/);
            if (m) {
              if (s.scene === undefined) s.scene = parseInt(m[1]!, 10);
              if (s.shotNumber === undefined) s.shotNumber = parseInt(m[2]!, 10);
            }
          }
        }
        const alignFrames = (durSec: number): number =>
          Math.max(8, Math.round((durSec * fps) / 8) * 8);
        const out: NodeInstance[] = [];
        for (const item of items) {
          const itemId =
            typeof item === 'string'
              ? item.replace(/\s+/g, '_').toLowerCase()
              : String(item.id ?? item.name ?? '').replace(/\s+/g, '_').toLowerCase();
          const sceneMatch = itemId.match(/^scene_(\d+)/);
          const sceneNumber = sceneMatch ? parseInt(sceneMatch[1]!, 10) : undefined;
          if (sceneNumber === undefined) {
            out.push({ def: node, itemId, status: 'pending' });
            continue;
          }
          const sceneShots = allShots
            .filter((s) => s.scene === sceneNumber)
            .sort((a, b) => (a.shotNumber ?? 0) - (b.shotNumber ?? 0));
          if (sceneShots.length === 0) {
            out.push({ def: node, itemId, sceneNumber, status: 'pending' });
            continue;
          }
          // Greedy-pack shots into chunks under cap.
          type Chunk = { startShot: number; endShot: number; frames: number };
          const chunks: Chunk[] = [];
          let cur: Chunk | null = null;
          let firstInChunk = true;
          for (const s of sceneShots) {
            let f = alignFrames(s.duration ?? 3);
            if (firstInChunk && firstPlusOne) f += 1;
            if (cur && cur.frames + f > cap) {
              chunks.push(cur);
              cur = null;
              firstInChunk = true;
              f = alignFrames(s.duration ?? 3) + (firstPlusOne ? 1 : 0);
            }
            if (!cur) cur = { startShot: s.shotNumber ?? 0, endShot: s.shotNumber ?? 0, frames: 0 };
            cur.endShot = s.shotNumber ?? 0;
            cur.frames += f;
            firstInChunk = false;
          }
          if (cur) chunks.push(cur);
          chunks.forEach((c, idx) => {
            out.push({
              def: node,
              itemId: `scene_${sceneNumber}_chunk_${idx + 1}`,
              sceneNumber,
              shotRange: [c.startShot, c.endShot],
              chunkIndex: idx + 1,
              chunkCount: chunks.length,
              status: 'pending',
            });
          });
        }
        return out;
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
        // Derive sceneNumber from scene-shaped ids ("scene_3" or
        // "scene_3_shot_2") — needed by the relay runner's
        // buildRunnerConfig path.
        const sceneMatch = itemId.match(/^scene_(\d+)/);
        const sceneNumber = sceneMatch ? parseInt(sceneMatch[1]!, 10) : undefined;
        return {
          def: node,
          itemId,
          ...(sceneNumber !== undefined ? { sceneNumber } : {}),
          status: 'pending' as const,
        };
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

function getByDotPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else return undefined;
  }
  return cur;
}

/**
 * Resolve bundle-level inputs (BundleInputDecl[]) into a flat
 * Record<id, value> ready to merge into every node's ctx.inputs.
 * Throws on missing required inputs.
 */
function resolveBundleInputs(
  decls: BundleInputDecl[] | undefined,
  projectDir: string,
): Record<string, unknown> {
  if (!decls || decls.length === 0) return {};
  const out: Record<string, unknown> = {};
  const projectJsonPath = resolve(projectDir, 'project.json');
  let projectJson: Record<string, unknown> | undefined;
  if (existsSync(projectJsonPath)) {
    try {
      projectJson = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as Record<string, unknown>;
    } catch {
      projectJson = undefined;
    }
  }
  for (const d of decls) {
    if (d.kind === 'file') {
      const p = resolve(projectDir, d.path);
      if (!existsSync(p)) {
        if (d.required !== false) {
          throw new Error(`bundle input '${d.id}' missing: file not found at ${p}`);
        }
        continue;
      }
      const raw = readFileSync(p, 'utf-8');
      out[d.id] = d.path.endsWith('.json')
        ? (() => {
            try { return JSON.parse(raw); } catch { return raw; }
          })()
        : raw;
    } else if (d.kind === 'project') {
      if (!projectJson) {
        if (d.required !== false && d.default === undefined) {
          throw new Error(`bundle input '${d.id}' requires project.json field '${d.field}' but project.json is missing/unreadable`);
        }
        if (d.default !== undefined) out[d.id] = d.default;
        continue;
      }
      const v = getByDotPath(projectJson, d.field);
      if (v === undefined) {
        if (d.default !== undefined) out[d.id] = d.default;
        else if (d.required !== false) {
          throw new Error(`bundle input '${d.id}' requires project.json field '${d.field}' but it is not set`);
        }
      } else {
        out[d.id] = v;
      }
    }
  }
  return out;
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
  bundleDir?: string,
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
    // Instance carries chunk-specific scene info after materialization.
    if (inst.sceneNumber === undefined) {
      throw new Error('comfy.ltx_director: instance missing sceneNumber');
    }
    // Prefer NEW path: read shots from scenes_plan upstream, first-frame
    // paths from shot_image's outputs, globalPrompt from
    // scene_video_prompt's output. Falls back to legacy resolveRelayInputs
    // (scene_*.json on disk) when scenes_plan upstream isn't present.
    const scenesPlanInsts = instancesById.get('scenes_plan') ?? [];
    const scenesPlanInst = scenesPlanInsts[0];
    if (scenesPlanInst?.outputRel) {
      const scenesPlanPath = resolve(projectDir, scenesPlanInst.outputRel);
      if (existsSync(scenesPlanPath)) {
        const plan = JSON.parse(readFileSync(scenesPlanPath, 'utf-8')) as {
          scenes?: Array<{ id?: string }>;
          shots?: Array<{ id?: string; scene?: number; shotNumber?: number; duration?: number; description?: string; cameraWork?: string; dialogue?: string | null; speaker?: string | null }>;
        };
        // Derive scene + shotNumber from shot.id when the LLM omits
        // them — id format is `scene_N_shot_M`. This makes the runner
        // robust to LLM output drift (DeepSeek sometimes skips fields
        // the prompt asks for; the schema's relaxed shotNumber/scene
        // requirement plus this derivation are paired).
        for (const s of (plan.shots ?? []) as Array<{ id?: string; scene?: number; shotNumber?: number }>) {
          if (s.scene === undefined || s.shotNumber === undefined) {
            const m = (s.id ?? '').match(/^scene_(\d+)_shot_(\d+)$/);
            if (m) {
              if (s.scene === undefined) s.scene = parseInt(m[1]!, 10);
              if (s.shotNumber === undefined) s.shotNumber = parseInt(m[2]!, 10);
            }
          }
        }
        const sceneShots = (plan.shots ?? []).filter((s) => s.scene === inst.sceneNumber);
        if (sceneShots.length === 0) {
          throw new Error(`comfy.ltx_director: scenes_plan has no shots for scene ${inst.sceneNumber}`);
        }
        // Honor shotRange when materializer set it (chunked); otherwise
        // use all shots in the scene.
        const filteredShots = inst.shotRange
          ? sceneShots.filter((s) => (s.shotNumber ?? 0) >= inst.shotRange![0] && (s.shotNumber ?? 0) <= inst.shotRange![1])
          : sceneShots;
        // Match first frame paths against shot_image outputs by itemId.
        const shotImageInsts = instancesById.get('shot_image') ?? [];
        const shotImagePathById: Record<string, string> = {};
        for (const u of shotImageInsts) {
          if (u.itemId && u.outputRel) {
            shotImagePathById[u.itemId] = resolve(projectDir, u.outputRel);
          }
        }
        const firstFrames: string[] = [];
        for (const s of filteredShots) {
          const sid = s.id ?? `scene_${inst.sceneNumber}_shot_${s.shotNumber}`;
          const path = shotImagePathById[sid];
          if (!path || !existsSync(path)) {
            throw new Error(`comfy.ltx_director: shot_image output missing for ${sid} (looked up: ${path ?? '<no upstream instance>'})`);
          }
          firstFrames.push(path);
        }
        // globalPrompt from scene_video_prompt's output, if present.
        let globalPrompt = '';
        const svpInsts = instancesById.get('scene_video_prompt') ?? [];
        const svp = svpInsts[0];
        if (svp?.outputRel) {
          const svpPath = resolve(projectDir, svp.outputRel);
          if (existsSync(svpPath)) globalPrompt = readFileSync(svpPath, 'utf-8');
        }
        base['shots'] = filteredShots.map((s) => ({
          shotNumber: s.shotNumber ?? 0,
          duration: s.duration ?? 3,
          ...(s.description ? { description: s.description } : {}),
          ...(s.cameraWork ? { cameraWork: s.cameraWork } : {}),
          ...(s.dialogue ? { dialogue: s.dialogue } : {}),
          ...(s.speaker ? { speaker: s.speaker } : {}),
        }));
        base['firstFrames'] = firstFrames;
        base['globalPrompt'] = globalPrompt || `Scene ${inst.sceneNumber}`;
      } else {
        // scenes_plan output file missing; fall back to legacy
        const resolved = resolveRelayInputs(projectDir, inst.sceneNumber, inst.shotRange ?? [1, 999]);
        base['shots'] = resolved.shots;
        base['firstFrames'] = resolved.firstFrames;
        base['globalPrompt'] = resolved.globalPrompt;
      }
    } else {
      // No scenes_plan upstream — fall back to legacy disk-file path.
      if (!inst.shotRange) {
        throw new Error('comfy.ltx_director: instance missing shotRange (no scenes_plan upstream and no chunkBy materialization)');
      }
      const resolved = resolveRelayInputs(projectDir, inst.sceneNumber, inst.shotRange);
      base['shots'] = resolved.shots;
      base['firstFrames'] = resolved.firstFrames;
      base['globalPrompt'] = resolved.globalPrompt;
    }
    // workflowPath may already be in config; resolve relative paths
    // against the kshana-core package root (NOT process.cwd()), so the
    // bundle resolves correctly when kshana-core is loaded as a library
    // by a host process (desktop Electron, packaged CLI) whose cwd is
    // unrelated to where the workflow JSONs ship.
    const wfRaw = (base['workflowPath'] as string | undefined) ?? '';
    if (wfRaw && !wfRaw.startsWith('/')) {
      // Prefer bundleDir when set (directory-layout bundles ship
      // workflows in their own dir). Fall back to REPO_ROOT for
      // legacy single-file bundles that referenced shared workflows.
      const bundleRel = bundleDir ? resolve(bundleDir, wfRaw) : null;
      base['workflowPath'] =
        bundleRel && existsSync(bundleRel) ? bundleRel : resolve(REPO_ROOT, wfRaw);
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

    // Subtitles: build an SRT from scenes_plan dialogue if present.
    // Cumulative timing across all shots in order. Walker writes the SRT
    // and hands the path to ffmpeg.concat; runner overlays it via the
    // subtitles filter during the watermark/encode pass.
    const scenesPlanInsts = instancesById.get('scenes_plan') ?? [];
    const scenesPlanInst = scenesPlanInsts[0];
    if (scenesPlanInst?.outputRel) {
      const scenesPlanPath = resolve(projectDir, scenesPlanInst.outputRel);
      if (existsSync(scenesPlanPath)) {
        const plan = JSON.parse(readFileSync(scenesPlanPath, 'utf-8')) as {
          shots?: Array<{ id?: string; duration?: number; dialogue?: string | null; speaker?: string | null }>;
        };
        const srtLines: string[] = [];
        let cursor = 0;
        let entryNum = 1;
        for (const s of plan.shots ?? []) {
          const dur = s.duration ?? 3;
          const start = cursor;
          const end = cursor + dur;
          cursor = end;
          if (s.dialogue && s.dialogue.trim().length > 0) {
            const speaker = (s.speaker ?? '').trim();
            const line = s.dialogue.trim().replace(/^["']|["']$/g, '');
            const text = speaker ? `${speaker}: ${line}` : line;
            srtLines.push(
              `${entryNum}`,
              `${formatSrtTime(start)} --> ${formatSrtTime(end)}`,
              text,
              '',
            );
            entryNum += 1;
          }
        }
        if (srtLines.length > 0) {
          const srtPath = resolve(projectDir, 'assets/subtitles/final.srt');
          mkdirSync(dirname(srtPath), { recursive: true });
          writeFileSync(srtPath, srtLines.join('\n'));
          base['subtitlesPath'] = srtPath;
        }
      }
    }
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

  const fullOrder = topoFromGoal(opts.bundle);
  // When stopAt is set, narrow the topo to ANCESTORS of stopAt (plus
  // stopAt itself) — nodes that aren't on the path back from stopAt
  // shouldn't run. Without this filter, the walker processes every
  // node before stopAt in the linear topo, including independent
  // branches that the user isn't asking for.
  let ordered: NodeDef[];
  if (opts.stopAt) {
    const byId = new Map(opts.bundle.nodes.map((n) => [n.id, n]));
    const ancestors = new Set<string>();
    const visit = (id: string): void => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      const n = byId.get(id);
      if (!n) return;
      for (const i of n.inputs) visit(i.from);
    };
    visit(opts.stopAt);
    ordered = fullOrder.filter((n) => ancestors.has(n.id));
  } else {
    ordered = fullOrder;
  }
  log(`walker: bundle '${opts.bundle.id}' v${opts.bundle.version}, ${ordered.length} reachable nodes${opts.stopAt ? ` (ancestors of '${opts.stopAt}')` : ''}`);

  // Resolve bundle-level inputs (project files + project.json fields)
  // once at startup. Merged into every node's ctx.inputs below.
  let bundleInputs: Record<string, unknown>;
  try {
    bundleInputs = resolveBundleInputs(opts.bundle.inputs, opts.projectDir);
  } catch (e) {
    return { ok: false, error: (e as Error).message, instances: [] };
  }
  if (Object.keys(bundleInputs).length > 0) {
    log(`walker: resolved ${Object.keys(bundleInputs).length} bundle inputs: ${Object.keys(bundleInputs).join(', ')}`);
  }

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

    // Reap stale 'in_progress' entries. At walk entry there CAN'T be a
    // live runner for any in_progress node — that would only happen
    // if a runner from a prior dispatch is currently executing, but a
    // single bundle dispatch holds the only walker call. So any
    // in_progress entry now is from a prior dispatch that was killed
    // mid-flight (Comfy went down, desktop crashed, Cmd-C, etc.).
    //
    // Without this, the walker's per-instance loop sees in_progress in
    // walkState + nothing on disk + falls through to running the
    // node fresh. That works for items but the BARE node entry stays
    // `in_progress` forever, polluting status reports and blocking
    // some bundle-level gating checks.
    let reaped = 0;
    for (const [key, entry] of Object.entries(state.nodes)) {
      if (entry.status === 'in_progress') {
        state.nodes[key] = {
          status: 'failed',
          error: 'stale in_progress entry: prior dispatch was killed mid-flight (Comfy restart, process exit, or manual abort). Walker reaped at entry; will re-run.',
        };
        reaped += 1;
      }
    }
    if (reaped > 0) {
      log(`walker: reaped ${reaped} stale in_progress walkState entries (prior dispatch killed mid-flight).`);
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

    // runOnly filter — skip the dispatch for nodes outside the
    // cascade. BUT we still hydrate their completed instances from
    // walkState so downstream runners can read these nodes' outputs
    // as inputs. Without this, a critique/regen targeting (say)
    // shot_image_prompt with runOnly: ['shot_image_prompt'] would
    // see empty `characters_plan` / `settings_plan` / `story` inputs
    // — even though those upstream artifacts are on disk and the
    // walkState says completed. (BUG-021)
    if (cascadeSet !== null && !cascadeSet.has(node.id)) {
      if (state) {
        for (const inst of insts) {
          const stateKey = inst.itemId ? `${node.id}:${inst.itemId}` : node.id;
          const prior = state.nodes[stateKey];
          if (prior && prior.status === 'completed' && prior.outputPath) {
            const priorAbs = resolve(opts.projectDir, prior.outputPath);
            if (existsSync(priorAbs)) {
              inst.status = 'completed';
              inst.outputRel = prior.outputPath;
              inst.outputAbs = priorAbs;
              if (prior.metadata) inst.metadata = prior.metadata;
            }
          }
        }
      }
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

      const cfg = buildRunnerConfig(inst, opts.projectDir, instancesById, opts.bundleDir);
      // outputPath: render the bundle's outputs.pattern against
      // item-context vars so per-instance writes don't collide. Every
      // runner that writes a single output file expects an outputPath
      // in config; we resolve it here once for everyone.
      {
        const ctxVars = {
          item_id: inst.itemId ?? '',
          scene_id: inst.sceneNumber ? `scene_${inst.sceneNumber}` : '',
          // chunk_id is only meaningful when the instance is a chunked
          // sub-piece of a scene (chunkBy materializer). For unchunked
          // instances it's empty — bundle authors who don't use chunkBy
          // simply don't reference {{chunk_id}} in their output pattern.
          chunk_id: inst.chunkIndex !== undefined ? `chunk_${inst.chunkIndex}` : '',
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
      // placeholders in its prompt template. Bundle-level inputs are
      // merged in first so node-level inputs can override.
      const resolvedInputs: Record<string, unknown> = { ...bundleInputs };
      for (const inp of node.inputs) {
        const upInsts = instancesById.get(inp.from) ?? [];
        if (upInsts.length === 0) {
          // For previousN: still expose an empty array so the
          // downstream template can reference {{inp.from}} without
          // failing — shot 1 of each scene legitimately has no priors.
          if (inp.scope === 'previousN') resolvedInputs[inp.from] = [];
          continue;
        }

        // scope='previousN' on a collection upstream → expose as an
        // ordered array of the last N completed instances whose
        // shotNumber is strictly less than the current instance's
        // shotNumber, sorted by shotNumber DESC then truncated to N.
        // Used by chain bundles where the LLM picks the best prior
        // shot to use as the edit base (handles the "previous shot
        // was a tight CU, no scene context" failure mode).
        if (inp.scope === 'previousN' && inst.itemId) {
          // Parse shotNumber from itemId (canonical format: scene_N_shot_M
          // OR just shot_M when scenes_plan doesn't carry scene info).
          const parseShotNum = (id: string | undefined): number | undefined => {
            if (!id) return undefined;
            const m = id.match(/(?:^|_)shot_(\d+)$/);
            return m ? parseInt(m[1]!, 10) : undefined;
          };
          const currentShotNum = parseShotNum(inst.itemId);
          if (currentShotNum !== undefined) {
            const n = inp.n ?? 5;
            const priors: Array<{ shotNumber: number; itemId: string; outputAbs: string; content?: unknown }> = [];
            // For JSON-output upstream collections, read the file content
            // and embed it inline so the consuming LLM can READ what each
            // prior produced (not just see a path). Without this the
            // LLM gets opaque paths and can't make a sensible chain-base
            // choice — it'll think every shot has no useful prior.
            const upstreamNode = opts.bundle.nodes.find((nd) => nd.id === inp.from);
            const inlineJson = upstreamNode?.outputs.format === 'json';
            for (const u of upInsts) {
              if (!u.outputRel || u.status !== 'completed') continue;
              const uShot = parseShotNum(u.itemId);
              if (uShot === undefined || uShot >= currentShotNum) continue;
              const abs = resolve(opts.projectDir, u.outputRel);
              if (!existsSync(abs)) continue;
              const entry: { shotNumber: number; itemId: string; outputAbs: string; content?: unknown } = {
                shotNumber: uShot, itemId: u.itemId ?? '', outputAbs: abs,
              };
              if (inlineJson) {
                try {
                  entry.content = JSON.parse(readFileSync(abs, 'utf-8'));
                } catch { /* ignore */ }
              }
              priors.push(entry);
            }
            priors.sort((a, b) => b.shotNumber - a.shotNumber);
            resolvedInputs[inp.from] = priors.slice(0, n);
            continue;
          }
        }

        // scope='all' on a collection upstream → expose as
        // { [itemId]: outputAbs } map so runners can resolve cross-
        // collection references (e.g. shot_image references
        // character_image:naia by id). The walker doesn't try to
        // pick a "matching" instance here — the consumer decides.
        if (inp.scope === 'all' && upInsts.some((u) => u.itemId !== undefined)) {
          const pathsById: Record<string, string> = {};
          for (const u of upInsts) {
            if (!u.itemId || !u.outputRel) continue;
            const abs = resolve(opts.projectDir, u.outputRel);
            if (existsSync(abs)) pathsById[u.itemId] = abs;
          }
          resolvedInputs[inp.from] = pathsById;
          continue;
        }

        // Otherwise: 'matching' picks the upstream instance with the
        // same itemId; if no match (or upstream is a stage), pick first.
        const matching =
          inst.itemId
            ? upInsts.find((u) => u.itemId === inst.itemId) ?? upInsts[0]
            : upInsts[0];
        if (!matching?.outputRel) continue;
        const upAbs = resolve(opts.projectDir, matching.outputRel);
        if (!existsSync(upAbs)) continue;
        // Binary files (images, videos, audio) → expose the absolute
        // path on ctx.inputs[<upstream>]. Reading them as utf-8 would
        // be useless. Text files (.md, .json) → expose the content
        // (parsed for json).
        const isBinary = /\.(png|jpg|jpeg|webp|gif|mp4|webm|mov|wav|mp3)$/i.test(matching.outputRel);
        if (isBinary) {
          resolvedInputs[inp.from] = upAbs;
          continue;
        }
        try {
          const raw = readFileSync(upAbs, 'utf-8');
          let value: unknown = raw;
          if (matching.outputRel.endsWith('.json')) {
            try { value = JSON.parse(raw); } catch { /* keep raw */ }
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
