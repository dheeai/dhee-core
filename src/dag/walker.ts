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
import { dirname, relative, resolve } from 'node:path';
import { openEventLog } from './eventLog/EventLog.js';
import { preserveAsVersion } from './preserveAsVersion.js';
import { acquireWalkLock, isWalkLockResult } from './projectWalkLock.js';
import { resolveRunnerForInstance } from './resolveRunnerForInstance.js';

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
import type { DagBundle, LLMAccess, NodeDef, RunnerContext, RunnerResult } from './schema.js';
import type { BundleInputDecl } from './schema.js';
import { createRunnerLLMAccess } from './llmAccess.js';
import { getRunner } from './runners/index.js';
import { getGlobalRegistry } from './runners/registry.js';
import { resolveRelayInputs, chunkScene } from './projectResolvers.js';
import { depBelongsToChunk } from './chunkDeps.js';
import { applyAspect, applyAspectToConfig } from './aspect.js';
import { effectiveFrameCap, scaleBudgetForGpu } from './chunkBudget.js';
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
export { writeNodeContent } from './writeNodeContent.js';
export type { WriteNodeContentInput, WriteNodeContentResult } from './writeNodeContent.js';
export type {
  InvalidateNodesOpts,
  InvalidateNodesResult,
  RegenerateNodeOpts,
  RegenerateNodeResult,
  RunProjectViaBundleFn,
} from './projectRegen.js';
// Event-sourced projections — exposed for desktop / external consumers.
export { openEventLog } from './eventLog/EventLog.js';
export type { EventLog } from './eventLog/EventLog.js';
export { eventLogPath, dheeDir } from './eventLog/eventLogPath.js';
export type {
  DheeEvent,
  EventKind,
  EventActor,
  NodeDependency,
  NodeCompletedPayload,
} from './eventLog/events.js';
export { openProjectionEngine } from './eventLog/ProjectionEngine.js';
export type { ProjectionEngine } from './eventLog/ProjectionEngine.js';
export { projectInstanceGraph, computeDependents } from './eventLog/projectInstanceGraph.js';
export type {
  InstanceGraph,
  InstanceNode,
  InstanceEdge,
  InstanceRef,
  ProjectInstanceGraphOpts,
} from './eventLog/projectInstanceGraph.js';
export { listVersions } from './eventLog/projectVersions.js';
export type { VersionTrayEntry, ListVersionsOpts } from './eventLog/projectVersions.js';
export { computeBranchTree } from './eventLog/projectBranches.js';
export type { BranchTree, BranchEntry } from './eventLog/projectBranches.js';
export { computeCostLedger } from './eventLog/projectCost.js';
export type { CostLedger, CostLedgerOpts } from './eventLog/projectCost.js';

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
   * LLM access capability injected into every runner's ctx.llm. When
   * omitted, the walker builds a router-backed default from project
   * config (createRunnerLLMAccess). Tests can inject a stub.
   */
  llm?: LLMAccess;
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
   * Stop-after-each-collection gate. When true, the walker halts as
   * soon as a `collection` node (other than the bundle goal) finishes
   * a pass in which at least one of its instances actually ran (i.e.
   * the runner was invoked, not a cache-skip). Downstream nodes stay
   * pending in walkState, so the next walk (the desktop "Resume"
   * button, `dhee_run_bundle` again, etc.) cache-skips the now-complete
   * collection — which therefore does NO new work and does NOT re-gate
   * — and proceeds to the next collection. Net effect: one collection
   * step per run, letting the user inspect each fan-out batch before
   * continuing. A collection whose instances were all cache-skipped
   * never gates (no real work → no progress stall on resume). Sourced
   * from `project.features.gateAfterCollections`; see
   * src/dag/projectFeatures.ts and docs/feature-flags.md.
   */
  gateAfterCollections?: boolean;
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
  /**
   * Optional projection engine for the event-sourced log. When set,
   * the walker emits node.started/completed/failed events alongside
   * its existing walkState writes (dual-write). When absent, the
   * walker behaves exactly as before — no events, no log file.
   *
   * The engine's `appendAndProject` writes the back-compat walkState
   * snapshot to project.json as a side effect of each append, so the
   * walker's own saveWalkState calls become redundant but harmless
   * (last writer wins; both produce the same content).
   */
  engine?: import('./eventLog/ProjectionEngine.js').ProjectionEngine;
  /** Branch this walk runs on; events tagged with it. Default 'main'. */
  branchId?: string;
  /**
   * Test seam — probe the render GPU's total VRAM (bytes). Used to make
   * scene chunking GPU-aware: a chunk-frame budget tuned on a 12 GiB card
   * scales up on bigger cards (longer chunks) and down on smaller ones.
   * Probed once per walk, only when a bundle node declares
   * `chunkBy.maxFramePixels`. Returns null when the GPU is unknown
   * (probe failed / cloud / headless) → budget stays unscaled. Defaults
   * to the env-configured Comfy `/system_stats` probe.
   */
  probeGpuVramBytes?: () => Promise<number | null>;
}

/**
 * Default GPU-VRAM probe: query the env-configured Comfy `/system_stats`.
 * Dynamic-imported so headless callers without Comfy don't pay the cost
 * and tests can inject a stub via WalkerOptions. Any failure → null.
 */
async function defaultProbeGpuVramBytes(): Promise<number | null> {
  try {
    const mod = (await import('../services/comfyui/ComfyUIClient.js')) as {
      probeGpuVramBytes: () => Promise<number | null>;
    };
    return await mod.probeGpuVramBytes();
  } catch {
    return null;
  }
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
 * Pick the `scene_video_prompt` instance that supplies a `scene_clip`'s
 * global prompt. Per-scene global prompts: `scene_clip:scene_N` must read
 * `scene_video_prompt:scene_N`, not the first instance — otherwise every
 * clip is conditioned on scene 1's brief (the bug behind the repeating
 * spoken title). Falls back to the first instance when `scene_video_prompt`
 * is a single `stage` node (legacy one-prompt-for-the-whole-video bundles)
 * or when no instance matches the clip's scene.
 */
export function pickSceneVideoPrompt<T extends { sceneNumber?: number }>(
  svpInsts: T[],
  sceneNumber: number | undefined,
): T | undefined {
  if (sceneNumber !== undefined) {
    const match = svpInsts.find((s) => s.sceneNumber === sceneNumber);
    if (match) return match;
  }
  return svpInsts[0];
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
  projectAspect?: string,
  projectResolution?: number,
  gpuVramBytes?: number | null,
): NodeInstance[] {
  // Resolution- AND GPU-aware chunk cap. `chunkBy.limit` is the model's
  // audio-latent frame cap (resolution-independent); `maxFramePixels`
  // is the VRAM ceiling on the chunk's latent VOLUME (frames × pixels).
  // At higher resolutions the same frame count blows past VRAM, so we
  // scale the per-chunk frame cap down by the actual render area, AND we
  // scale the VRAM budget itself by the actual GPU's VRAM (bigger card →
  // longer chunks). The render area is the node's baseline width/height
  // after the same aspect+resolution transform the runner will see at
  // run time. See src/dag/chunkBudget.ts.
  const declaredCap = node.chunkBy?.limit ?? 0;
  let effectiveCap = declaredCap;
  if (node.chunkBy?.maxFramePixels) {
    const cfg = (node.runner?.config ?? {}) as Record<string, unknown>;
    const cw = cfg['width'];
    const ch = cfg['height'];
    if (typeof cw === 'number' && typeof ch === 'number') {
      const { width: rw, height: rh } = applyAspect(projectAspect, cw, ch, projectResolution);
      const budget = scaleBudgetForGpu(
        node.chunkBy.maxFramePixels,
        gpuVramBytes,
        node.chunkBy.referenceVramBytes,
      );
      effectiveCap = effectiveFrameCap(declaredCap, rw, rh, budget);
    }
  }

  // ── Legacy 'scene' path (ltx_prompt_relay's scene_clip chunking) ──
  if (node.itemSource === 'scene' && cli.sceneIds && cli.sceneIds.length > 0) {
    const out: NodeInstance[] = [];
    for (const sceneNum of cli.sceneIds) {
      if (node.chunkBy && node.chunkBy.constraint === 'max_frames') {
        const fps = node.chunkBy.fps ?? 24;
        const firstPlusOne = node.chunkBy.firstSegmentPlusOne ?? false;
        const chunks = chunkScene(projectDir, sceneNum, effectiveCap, fps, firstPlusOne);
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
        const cap = effectiveCap;
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
        // Per-scene: this clip reads its OWN scene's brief
        // (scene_clip:scene_N → scene_video_prompt:scene_N). Falls back
        // to the first instance for single-stage (one-global) bundles.
        let globalPrompt = '';
        const svpInsts = instancesById.get('scene_video_prompt') ?? [];
        const svp = pickSceneVideoPrompt(svpInsts, inst.sceneNumber);
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
          // Write the SRT sidecar for external players. We deliberately do
          // NOT wire it into final_video as `subtitlesPath`: burned-in
          // captions were dropped (no feature consumes them, and the
          // drawtext pass used to fail and take the watermark down with it).
          const srtPath = resolve(projectDir, 'assets/subtitles/final.srt');
          mkdirSync(dirname(srtPath), { recursive: true });
          writeFileSync(srtPath, srtLines.join('\n'));
        }
      }
    }
  }

  return base;
}

/** Walk the bundle and run every reachable node to completion. */
interface WalkResult {
  ok: boolean;
  goal?: { outputRel: string; outputAbs: string };
  error?: string;
  instances: NodeInstance[];
  /**
   * Set to the collection node id the walk halted after when the
   * `gateAfterCollections` gate fired. Distinguishes an intentional
   * mid-graph pause (ok:true, no goal, resume to continue) from a
   * stopAt / run-to-completion result. Absent on all other outcomes.
   */
  gatedAfter?: string;
}

/**
 * Public entry — wraps `walkBundleOnce` with the review-loop. When the
 * bundle declares `reviewLoopMax > 0`, the walker snapshots
 * `pendingCritiques` keys at entry, runs the graph once, then checks
 * if any NEW critique keys appeared (typical source: a `vlm.judge`
 * runner that wrote `pendingCritiques[refineNode:itemId]` on a fail
 * verdict). If yes and the iteration cap isn't hit, the walker
 * re-walks — the freshly-invalidated upstream re-runs, BUG-023's
 * cascade picks up the dependent re-renders, the review fires again,
 * and the loop continues until pass-through (no new critiques) or cap.
 *
 * Default `reviewLoopMax = 0` preserves single-shot behavior.
 */
export async function walkBundle(opts: WalkerOptions): Promise<WalkResult> {
  // Per-project single-flight guard. Two concurrent walks of the same
  // project corrupt shared state (duplicate event seqs from independent
  // EventLog handles, lost invalidations from last-writer-wins walkState
  // snapshots). Acquire-or-reject, keyed per project, held across the
  // whole review loop. See projectWalkLock.ts (2026-06-03 incident).
  const lock = acquireWalkLock(opts.projectDir);
  if (isWalkLockResult(lock)) {
    const msg =
      `a walk is already in progress for this project (${lock.holder}). ` +
      `Stop it first (dhee_stop_run) or wait for it to finish before starting another.`;
    (opts.log ?? ((m: string) => console.log(m)))(`walker: ${msg}`);
    return { ok: false, error: msg, instances: [] };
  }
  try {
    return await walkBundleWithReviewLoop(opts, 0);
  } finally {
    lock.release();
  }
}

async function walkBundleWithReviewLoop(
  opts: WalkerOptions,
  iteration: number,
): Promise<WalkResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const projectJsonPath = resolve(opts.projectDir, 'project.json');

  const result = await walkBundleOnce(opts);

  // A gateAfterCollections pause is an intentional early stop — never
  // re-walk it through the review loop (the graph hasn't reached the
  // judge nodes that would seed critiques, and re-walking would defeat
  // the gate). Resume drives the next pass.
  if (result.gatedAfter) return result;

  // Semantic: `reviewLoopMax` = TOTAL max walks per dispatch
  // (including the initial). max=1 → no re-walks. max=3 → up to 3
  // total walks. iteration is 0-indexed: after walk N, iteration is
  // N-1 in the recursive call, so the guard is iteration + 1 >= max.
  const max = opts.bundle.reviewLoopMax ?? 0;
  if (max <= 1 || iteration + 1 >= max) return result;

  // Rule: re-walk while there are unconsumed pendingCritiques at the
  // end of the walk. A clean walk (no critiques OR all critiques
  // consumed by their LLM runners) → exit. A walk that leaves
  // critique(s) sitting in project.json → another iteration to give
  // the LLMs a chance to fix them. Bounded by `reviewLoopMax`.
  //
  // The legacy single-shot critique flow (dhee_critique_node) is
  // unchanged: bundles that don't opt in via reviewLoopMax stay at 0
  // and the wrapper exits after one walk regardless of pending state.
  let pendingKeys: string[] = [];
  if (existsSync(projectJsonPath)) {
    try {
      const raw = JSON.parse(readFileSync(projectJsonPath, 'utf-8')) as {
        pendingCritiques?: Record<string, unknown>;
      };
      pendingKeys = Object.keys(raw.pendingCritiques ?? {});
    } catch {}
  }
  if (pendingKeys.length === 0) return result;

  // Invalidate the walkState entries targeted by the stamped critiques
  // so the recursive walk doesn't cache-skip them. Runners that wrote
  // these critiques (judges, etc.) only need to stamp the critique +
  // return — the walker handles invalidation here. Decouples the
  // judge runner from any walkState mutation and avoids races with
  // the walker's own `persistState` writes during a walk.
  const { invalidateNodes: invalidate } = await import('./projectRegen.js');
  const inv = await invalidate({ projectDir: opts.projectDir, nodeIds: pendingKeys });
  if (inv.error) {
    log(`walker: review-loop invalidation failed: ${inv.error}; aborting loop`);
    return result;
  }
  log(
    `walker: review-loop iter ${iteration + 1}/${max} — ${pendingKeys.length} unconsumed critique(s) [${pendingKeys.join(', ')}]; invalidated + re-walking`,
  );
  return walkBundleWithReviewLoop(opts, iteration + 1);
}

/**
 * Single-pass walker. Performs one topological traversal of the
 * bundle's DAG, dispatching each node's runner (or cache-skipping when
 * walkState says it's already done + output exists). See `walkBundle`
 * for the review-loop wrapper.
 */
async function walkBundleOnce(opts: WalkerOptions): Promise<WalkResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const cli = opts.cli ?? {};
  // LLM capability handed to every runner via ctx.llm — built once per
  // walk. Runners (esp. SDK-only third-party ones) use this instead of
  // importing a provider directly.
  const runnerLlm = opts.llm ?? createRunnerLLMAccess(opts.projectDir);

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
  // `runOnly` is a deprecated back-compat parameter — the old walker
  // used it as a force-rerun signal because cascade-invalidation
  // didn't exist. Now invalidateNodes (projectRegen.ts) cascades the
  // event-derived dep graph BEFORE dispatch, so the walker is
  // state-as-truth: pending → run, completed (with file) → skip. We
  // still validate the ids so a caller passing garbage learns fast,
  // but the parameter no longer drives any cache bypass.
  if (opts.runOnly !== undefined && opts.runOnly.length > 0) {
    for (const id of opts.runOnly) {
      if (!bundleNodeIds.has(id)) {
        return {
          ok: false,
          error: `runOnly node id '${id}' is not in bundle (valid nodes: ${[...bundleNodeIds].join(', ')})`,
          instances: [],
        };
      }
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

  // Emit bundle.bound on the event log so the projection knows which
  // bundle this run is tied to. Idempotent — if the engine's log
  // already has a bundle.bound matching this source+version on the
  // current branch, skip; otherwise append.
  if (opts.engine && opts.bundleSource) {
    const branch = opts.branchId ?? 'main';
    const prior = [...opts.engine.log().read({ branchId: branch })].find((e) => e.kind === 'bundle.bound');
    const priorPayload = prior?.payload as { bundleSource?: string; bundleVersion?: string } | undefined;
    if (!prior || priorPayload?.bundleSource !== opts.bundleSource || priorPayload?.bundleVersion !== opts.bundle.version) {
      opts.engine.appendAndProject({
        branchId: branch,
        actor: 'walker',
        kind: 'bundle.bound',
        payload: {
          bundleSource: opts.bundleSource,
          bundleVersion: opts.bundle.version,
          engineVersion: '0.1.0',
        },
      });
    }
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
    // When the projection engine is in use, the walkState snapshot is
    // a projection of the event log on the active branch. A "different
    // bundleSource" reading is expected after a branch switch (each
    // branch may project to different bundle metadata), so trust the
    // engine and skip the destructive reinit. Without the engine
    // (legacy callers), keep the old behavior — drop incompatible
    // state to avoid replaying stale entries from a different bundle.
    if (state.bundleSource !== opts.bundleSource && !opts.engine) {
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

  // GPU-aware chunking: probe the render GPU's VRAM ONCE (only when a
  // node actually declares a maxFramePixels budget), then scale that
  // budget by actual/reference VRAM at materialization. Bigger card →
  // longer chunks; smaller card → shorter. Probe failure (cloud /
  // headless / unreachable) → null → budget stays unscaled. See
  // src/dag/chunkBudget.ts (BUG-026).
  const needsGpuProbe = ordered.some(
    (n) => n.kind === 'collection' && typeof n.chunkBy?.maxFramePixels === 'number',
  );
  let gpuVramBytes: number | null = null;
  if (needsGpuProbe) {
    gpuVramBytes = await (opts.probeGpuVramBytes ?? defaultProbeGpuVramBytes)();
    if (gpuVramBytes) {
      log(`walker: GPU VRAM probe → ${(gpuVramBytes / 1024 ** 3).toFixed(1)} GiB (chunk budget scales to this card)`);
    } else {
      log(`walker: GPU VRAM unknown (probe returned null) — chunk budget unscaled (12 GiB reference)`);
    }
  }

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
        instancesById.set(
          node.id,
          materializeCollection(
            node,
            opts.projectDir,
            cli,
            instancesById,
            typeof bundleInputs['aspect'] === 'string' ? bundleInputs['aspect'] : undefined,
            typeof bundleInputs['resolution'] === 'number' ? bundleInputs['resolution'] : undefined,
            gpuVramBytes,
          ),
        );
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
  // Set to a collection node id when the gateAfterCollections gate
  // fires after that node — the loop stops (like stopAt) and the
  // return reports it so callers can message "paused, resume to
  // continue" instead of a misleading completion.
  let gatedAfter: string | undefined;
  // BUG-023: track which nodes had their runner actually invoked in
  // The pre-cascade walker tracked `reRunInThisWalk` to force
  // downstream cache-bypass for any node whose upstream had been
  // re-invoked this walk (BUG-023 band-aid). Cascade-invalidation
  // now handles this at the boundary — invalidateNodes clears every
  // transitive consumer's walkState entry, so the in-loop short-
  // circuit naturally re-runs them. Removed here.
  for (const node of ordered) {
    if (stopAtReached) break;

    // Cooperative cancellation. stop_run → BackgroundTaskRunner.cancel()
    // aborts the walker's signal. Check it BETWEEN nodes so no NEW node
    // starts once an abort lands — the in-flight node's runner honors
    // the signal via ctx.signal (comfy poll exits); this stops the loop
    // from advancing to the next one. Without this the walker finished
    // the current clip and dispatched the next (the 2026-06-03 "chunk_2
    // started after stop" gap).
    if (opts.signal?.aborted) {
      log('walker: abort signal received — halting before next node');
      break;
    }

    // Lazy materialization for upstream-driven collections. By topo
    // order, every input.from upstream has already run; their output
    // files exist on disk and their instance metadata is in
    // instancesById. materializeCollection reads from these.
    if (node.kind === 'collection' && (instancesById.get(node.id) ?? []).length === 0) {
      try {
        const materialized = materializeCollection(
          node,
          opts.projectDir,
          cli,
          instancesById,
          typeof bundleInputs['aspect'] === 'string' ? bundleInputs['aspect'] : undefined,
          typeof bundleInputs['resolution'] === 'number' ? bundleInputs['resolution'] : undefined,
          gpuVramBytes,
        );
        instancesById.set(node.id, materialized);
      } catch (e) {
        const err = `${node.id}: materializeCollection failed: ${(e as Error).message}`;
        log(`✗ ${err}`);
        return { ok: false, error: err, instances: allInstances };
      }
    }

    const insts = instancesById.get(node.id) ?? [];

    // gateAfterCollections: did any instance of THIS node actually run
    // its runner this pass (vs. a cache-skip)? Only a node that did
    // real work should gate — otherwise a resumed walk (which cache-
    // skips the now-complete collection) would re-gate on it forever
    // and never advance to the next node.
    let nodeDidRealWork = false;

    // Pre-cascade walker had a cascadeSet bypass here that skipped
    // dispatch for nodes outside runOnly's reach while still hydrating
    // their completed instances from walkState. With cascade-
    // invalidation (cascadeInvalidationKeys + invalidateNodes), the
    // walker becomes pure state-as-truth — completed nodes are hydrated
    // by the in-loop short-circuit below, pending nodes run. No outer
    // filter needed.

    for (const inst of insts) {
      const stateKey = inst.itemId ? `${node.id}:${inst.itemId}` : node.id;

      // State-as-truth resume: if walkState says completed AND the
      // output file is present, skip. Otherwise re-run (item is
      // pending or its file was removed). This single rule replaces
      // three pre-cascade bypass branches (explicitlyRunning /
      // upstreamReRun / isUserPinned) that worked around missing
      // cascade-invalidation semantics. With invalidateNodes now
      // cascading per-item event deps, completed = trustworthy.
      // User-pin no longer survives upstream cascade — if the user
      // changes a character ref, even a pinned downstream shot is
      // invalidated, matching user intent ("downstream fixes should
      // not be stuck with the old character").
      if (state) {
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

      // Honor any agent-recorded runner.swapped events for this
      // (nodeId, itemId). Falls back to the bundle's declared tool
      // when no swap exists. configOverride from the swap (if any)
      // gets merged into the runner config below.
      const resolved = resolveRunnerForInstance({
        projectDir: opts.projectDir,
        nodeId: node.id,
        ...(inst.itemId !== undefined ? { itemId: inst.itemId } : {}),
        fallbackTool: node.runner.tool,
        branchId: opts.branchId ?? 'main',
      });
      const effectiveTool = resolved.tool;
      const runner = getRunner(effectiveTool);
      if (!runner) {
        const err = `runner '${effectiveTool}' not registered`;
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
      // Merge any swap-provided config overrides on top of node.runner.config.
      if (resolved.configOverride) {
        Object.assign(cfg, resolved.configOverride);
      }
      // Apply project-level aspect-ratio + resolution to the runner
      // config's width + height (if both are numbers). Bundle authors
      // declare baseline dimensions tuned for 16:9 at the runner's max
      // supported resolution; the slate's aspect choice (9:16, 21:9)
      // and resolution choice (720p, 1080p, 4K) flow through here so
      // every comfy/ltx node renders correctly without per-runner
      // code. Resolution is capped per-node by the bundle's baseline.
      // See src/dag/aspect.ts.
      const projectAspect = bundleInputs['aspect'];
      const projectResolution = bundleInputs['resolution'];
      if (typeof projectAspect === 'string') {
        applyAspectToConfig(
          cfg,
          projectAspect,
          typeof projectResolution === 'number' ? projectResolution : undefined,
        );
      }
      const runtimeNode: NodeDef = {
        ...node,
        runner: { tool: effectiveTool, config: cfg },
      };

      // Resolve ctx.inputs from upstream completed nodes. For each
      // declared input, read the upstream's output file (markdown →
      // string, json → parsed value) and key by the upstream node id.
      // The llm.generate runner uses these to substitute {{node_id}}
      // placeholders in its prompt template. Bundle-level inputs are
      // merged in first so node-level inputs can override.
      const resolvedInputs: Record<string, unknown> = { ...bundleInputs };
      // Track the upstream instances actually consumed for this run.
      // Stamped onto the node.completed event so the per-instance
      // dependency graph projection can render edges card-to-card on
      // the Inspector UI without re-deriving from bundle structure
      // or file contents. Captured here because the walker already
      // knows the exact instance set as part of input resolution.
      const dependenciesUsed: Array<{ nodeId: string; itemId?: string; role?: 'input' | 'context' | 'reference' | 'aggregate' }> = [];
      const recordDep = (fromNodeId: string, fromItemId: string | undefined, role: 'input' | 'context' | 'reference' | 'aggregate' | undefined): void => {
        dependenciesUsed.push({
          nodeId: fromNodeId,
          ...(fromItemId !== undefined ? { itemId: fromItemId } : {}),
          ...(role ? { role } : {}),
        });
      };
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
            const chosen = priors.slice(0, n);
            resolvedInputs[inp.from] = chosen;
            for (const c of chosen) recordDep(inp.from, c.itemId, (inp.usage as 'input' | 'context' | 'reference' | 'aggregate' | undefined));
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
            if (existsSync(abs)) {
              pathsById[u.itemId] = abs;
              // Chunk-aware dep narrowing: a chunked consumer (scene_clip
              // with a shotRange) only depends on the shots inside its
              // chunk, even though scope='all' exposes every shot's path.
              // Recording ALL shots as deps makes cascade-invalidation
              // re-roll sibling chunks on any shot edit (editing shot 3
              // re-rendered the chunk holding shots 5-6). Narrow to the
              // chunk's range so invalidation stays surgical; non-chunk
              // consumers and non-shot deps are unaffected. The path map
              // (pathsById) stays full — only the recorded dependency set
              // narrows; the scene_clip runner builds its own per-chunk
              // first-frame list regardless.
              if (depBelongsToChunk(inst.shotRange, u.itemId)) {
                recordDep(inp.from, u.itemId, (inp.usage as 'input' | 'context' | 'reference' | 'aggregate' | undefined));
              }
            }
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
        recordDep(inp.from, matching.itemId, (inp.usage as 'input' | 'context' | 'reference' | 'aggregate' | undefined));
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
        llm: runnerLlm,
      };

      if (state) {
        state.nodes[stateKey] = { status: 'in_progress', startedAt: Date.now() };
        persistState();
      }
      if (opts.engine) {
        opts.engine.appendAndProject({
          branchId: opts.branchId ?? 'main',
          actor: 'walker',
          kind: 'node.started',
          payload: { nodeId: node.id, ...(inst.itemId !== undefined ? { itemId: inst.itemId } : {}) },
        });
      }

      log(`→ ${node.id}${inst.itemId ? `[${inst.itemId}]` : ''} via ${effectiveTool}${effectiveTool !== node.runner.tool ? ` (swapped from ${node.runner.tool})` : ''}`);

      // Non-destructive overwrite: if a canonical artifact already
      // sits at the runner's outputPath, rename it to a versioned
      // sibling (.v<N>.<ext>) so the prior render survives. Skip when
      // there's nothing to preserve (first-time render). Emit a
      // version.added event so the projection records the rename.
      // We write the event via openEventLog (not opts.engine) so
      // preservation events land even when the caller didn't attach
      // a ProjectionEngine — keeps preservation consistent with the
      // other sites (invalidateNodes, dhee_write_node_content).
      const cfgOutputPath = (cfg as Record<string, unknown>)['outputPath'];
      if (typeof cfgOutputPath === 'string' && cfgOutputPath.length > 0) {
        const canonicalAbs = resolve(opts.projectDir, cfgOutputPath);
        if (existsSync(canonicalAbs)) {
          try {
            const preservedAbs = preserveAsVersion(canonicalAbs);
            if (preservedAbs) {
              const preservedRel = relative(resolve(opts.projectDir), preservedAbs);
              try {
                const log = openEventLog(opts.projectDir);
                log.append({
                  branchId: opts.branchId ?? 'main',
                  actor: 'walker',
                  kind: 'version.added',
                  payload: {
                    nodeId: node.id,
                    ...(inst.itemId !== undefined ? { itemId: inst.itemId } : {}),
                    versionId: `preserved-${Date.now()}-${node.id}${inst.itemId ? '-' + inst.itemId : ''}`,
                    outputPath: preservedRel,
                    source: 'runner',
                    reason: 'preserved before walker re-render',
                  },
                });
              } catch {
                // event log open/append best-effort
              }
            }
          } catch {
            // best-effort — never block the re-render on a preservation issue
          }
        }
      }

      // The runner is about to be invoked for real (this instance was
      // not cache-skipped above) — mark the node as having done work
      // this pass so the gateAfterCollections check below can fire.
      nodeDidRealWork = true;

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
        if (opts.engine) {
          opts.engine.appendAndProject({
            branchId: opts.branchId ?? 'main',
            actor: 'walker',
            kind: 'node.failed',
            payload: {
              nodeId: node.id,
              ...(inst.itemId !== undefined ? { itemId: inst.itemId } : {}),
              error: result.error,
            },
          });
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
      {
        // The runner stamps cache state + inputsHash via metadata.
        // We propagate them onto the event so projections (cost,
        // lineage) can reason about cache hits and replayability.
        const md = result.metadata ?? {};
        const cached = Boolean(md['cached']);
        const inputsHash = typeof md['inputsHash'] === 'string' ? (md['inputsHash'] as string) : undefined;
        const costUsd = typeof md['costUsd'] === 'number' ? (md['costUsd'] as number) : undefined;
        const versionId = `v${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        // Dependency source-of-truth: if the runner stamped a precise
        // dep list on metadata.dependencies, prefer it. Otherwise fall
        // back to the walker's own collection (which is over-broad for
        // scope='all' inputs — every item gets recorded, including
        // ones the runner ignored). The runner-stamped list is what
        // the cascade-invalidator and the Inspector hover-blast use
        // to stay surgical.
        const runnerDeps = result.metadata && typeof result.metadata === 'object'
          ? (result.metadata as { dependencies?: Array<{ nodeId: string; itemId?: string; role?: 'input' | 'context' | 'reference' | 'aggregate' }> }).dependencies
          : undefined;
        const sourceDeps = Array.isArray(runnerDeps) ? runnerDeps : dependenciesUsed;
        const depSeen = new Set<string>();
        const depsForEvent: typeof dependenciesUsed = [];
        for (const d of sourceDeps) {
          const k = `${d.nodeId}:${d.itemId ?? ''}:${d.role ?? ''}`;
          if (depSeen.has(k)) continue;
          depSeen.add(k);
          depsForEvent.push(d);
        }
        // Always append node.completed — when an engine is attached,
        // also let it project. Without unconditional append, callers
        // that don't bring a ProjectionEngine (review-loop wrapper,
        // most agent paths) leave an empty events.jsonl and cascade-
        // invalidation has no dep graph to walk on the next regen.
        const completedEvent = {
          branchId: opts.branchId ?? 'main',
          actor: 'walker' as const,
          kind: 'node.completed' as const,
          payload: {
            nodeId: node.id,
            ...(inst.itemId !== undefined ? { itemId: inst.itemId } : {}),
            versionId,
            outputPath: result.outputPath,
            artifact: { format: node.outputs.format },
            generation: {
              tool: node.runner.tool,
              toolVersion: '0.1.0',
              cached,
              ...(inputsHash ? { inputsHash } : {}),
              ...(costUsd !== undefined ? { costUsd } : {}),
            },
            ...(depsForEvent.length > 0 ? { dependencies: depsForEvent } : {}),
            ...(result.metadata ? { metadata: result.metadata } : {}),
          },
        };
        if (opts.engine) {
          opts.engine.appendAndProject(completedEvent);
        } else {
          try {
            const log2 = openEventLog(opts.projectDir);
            log2.append(completedEvent);
          } catch {
            // Best-effort — event log write must not block the walk.
          }
        }
      }
      log(`✓ ${node.id}${inst.itemId ? `[${inst.itemId}]` : ''} → ${result.outputPath}`);
    }

    // Stop-after-each-collection gate. Fires once this collection node
    // has fully completed a pass that did real work (some instance ran).
    // Never gate after the goal node — completing the goal IS the run
    // finishing, not a mid-graph pause. stopAtReached breaks the loop at
    // the top of the next iteration, exactly like stopAt.
    if (
      opts.gateAfterCollections &&
      node.kind === 'collection' &&
      node.id !== opts.bundle.goal &&
      nodeDidRealWork
    ) {
      gatedAfter = node.id;
      stopAtReached = true;
      log(`walker: gate-after-collections — collection '${node.id}' complete, halting (resume to continue).`);
    }

    if (opts.stopAt && node.id === opts.stopAt) {
      stopAtReached = true;
      log(`walker: reached stopAt='${opts.stopAt}', halting.`);
    }
  }

  // Aborted mid-walk → report cancellation rather than a misleading
  // "goal node did not complete". BackgroundTaskRunner keys 'cancelled'
  // off signal.aborted regardless of this return value, but a clear
  // error helps direct callers (scripts, runProjectViaBundle).
  if (opts.signal?.aborted) {
    return { ok: false, error: 'walk cancelled (abort signal received)', instances: allInstances };
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
  // Gated mid-graph by gateAfterCollections — ok, but no goal yet.
  // Report which collection we halted after so callers can say
  // "paused, resume to continue" rather than treating it as done.
  if (gatedAfter) {
    return { ok: true, gatedAfter, instances: allInstances };
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

// Re-export the pre-agent project bootstrap so the desktop can import
// it via `dhee-core/dag`. See src/dag/initializeProject.ts.
export { initializeProject } from './initializeProject.js';
export type { InitializeProjectParams, InitializeProjectResult } from './initializeProject.js';

// Re-export bundle listing so the desktop's Production Slate can
// render the bundle picker without going through the agent.
export { listBundles } from './listBundles.js';
export type { BundleSummary } from './listBundles.js';

// Workflow fit-checking: does a ComfyUI endpoint have the models +
// custom nodes a bundle's workflows need? Engine behind the desktop
// Bundle Configurator (first-run / community install / BYO workflow).
export {
  checkWorkflow,
  extractModelRefs,
  extractNodeClasses,
  findMissingNodeClasses,
} from './workflowVerify.js';
export type {
  ComfyWorkflow,
  ObjectInfo,
  CheckOpts,
  CheckResult,
  WorkflowModelRef,
  MissingNodeClass,
} from './workflowVerify.js';
export { checkBundle, listBundleWorkflows } from './checkBundle.js';
export type {
  CheckBundleOpts,
  BundleFit,
  BundleFitStatus,
  BundleWorkflowFit,
} from './checkBundle.js';
export {
  readAliases,
  writeAliases,
  applyAliases,
  endpointSlug,
} from './workflowAliases.js';
export type { WorkflowAliases } from './workflowAliases.js';
export {
  readBundleResolution,
  writeBundleResolution,
  isBundleResolved,
} from './bundleResolution.js';
export type { BundleResolution } from './bundleResolution.js';
export {
  loadBundleRequirements,
  deriveBundleRequirements,
  enrichBundleFit,
  CORE_COMFY_CLASSES,
} from './bundleRequirements.js';
export type {
  DerivedRequirements,
  EnrichedBundleFit,
  EnrichedWorkflowFit,
  EnrichedModelGap,
  EnrichedNodeGap,
} from './bundleRequirements.js';
export type {
  BundleRequirements,
  RequiredCustomNode,
  RequiredModel,
} from './schema.js';
export {
  installBundle,
  validateBundleStructure,
  findBundleRoot,
  userBundlesDir,
} from './installBundle.js';
export type {
  BundleInstallSource,
  InstallResult,
  InstallOpts,
  BundleValidation,
} from './installBundle.js';
export {
  validateApiWorkflow,
  suggestParameterMappings,
} from './importWorkflow.js';
export type { ApiWorkflowValidation, ParameterMapping } from './importWorkflow.js';

