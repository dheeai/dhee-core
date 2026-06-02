/**
 * DemoWalker — event-sourced bundle walker (the proof-of-architecture).
 *
 * A lightweight, self-contained walker that emits events through the
 * ProjectionEngine instead of mutating a snapshot. It demonstrates all
 * four capabilities the design promises in one runtime:
 *
 *   ① content-addressed cache  — runners consult GenerationCache before
 *     compute; hits emit node.completed with `cached:true`.
 *   ② non-destructive versions — every node.completed produces a new
 *     version under a versioned path; the canonical path mirrors the
 *     selected version. Regen is additive (no unlinkSync).
 *   ③ branches / forks         — events carry a branchId; the walker
 *     reads only events on its branch when computing topo state.
 *   ④ conditional runner swap  — `resolveRunnerForInstance` checks the
 *     event log for the most recent `runner.swapped` event for an
 *     instance and dispatches to the swapped runner.
 *
 * Sits alongside `src/dag/walker.ts` rather than replacing it. The
 * production walker will be migrated to the same primitives in a
 * follow-up phase per the design's incremental cutover plan.
 *
 * Scope: stage nodes only (no collection materialization), one output
 * per node. Enough to prove the architecture; not enough to drive the
 * narrative bundles. Those keep using the production walker until the
 * migration phase.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { nanoid } from 'nanoid';

import type { ProjectionEngine } from './ProjectionEngine.js';
import { openGenerationCache, defaultCacheRoot } from '../cas/GenerationCache.js';
import type { DheeEvent } from './events.js';
import { computeInputsHash, type InputsHashKey } from '../cas/inputsHash.js';

// ── Public bundle shape used by the DemoWalker ─────────────────────────

export interface DemoNodeInput {
  /** Upstream node id. */
  from: string;
}

export interface DemoNode {
  id: string;
  runner: { tool: string; config: Record<string, unknown> };
  output: { format: string; pattern: string };
  inputs: DemoNodeInput[];
  /**
   * Optional runner alternatives. Bundle authors declare swappable
   * alternatives statically; the actual swap is event-driven (a
   * `runner.swapped` event activates one). The alternatives list isn't
   * a HARD constraint — the walker will use whichever tool is named
   * in the event, as long as a runner with that name is registered.
   */
  runnerAlternatives?: Array<{
    tool: string;
    configOverride?: Record<string, unknown>;
    matchesHint?: string;
  }>;
}

export interface DemoBundle {
  id: string;
  version: string;
  description?: string;
  goal: string;
  nodes: DemoNode[];
}

// ── Runner contract ─────────────────────────────────────────────────────

export interface DemoRunnerContext {
  projectDir: string;
  nodeId: string;
  itemId?: string;
  inputs: Record<string, unknown>;
  config: Record<string, unknown>;
}

export interface DemoRunnerResult {
  /** Textual representation of the output (for inputs of downstream nodes). */
  content: string;
  /** Raw bytes to write to disk + cache. Defaults to UTF-8 encoding of content. */
  contentBytes?: Buffer;
  costUsd?: number;
  /** Tool-specific metadata stamped onto the node.completed event. */
  metadata?: Record<string, unknown>;
}

export interface DemoRunner {
  tool: string;
  toolVersion: string;
  run(ctx: DemoRunnerContext): Promise<DemoRunnerResult>;
}

// ── Walker API ──────────────────────────────────────────────────────────

export interface RunDemoWalkOpts {
  bundle: DemoBundle;
  projectDir: string;
  engine: ProjectionEngine;
  runners: Record<string, DemoRunner>;
  branchId?: string;
  /** Only run these nodes and their descendants; everything else skipped. */
  runOnly?: string[];
  /** Override the default CAS root (~/.kshana/cache). Useful for tests. */
  cacheRoot?: string;
  log?: (msg: string) => void;
}

export interface RunDemoWalkResult {
  ok: boolean;
  error?: string;
  /** Path of the goal-node artifact, if the walk completed it. */
  goalPath?: string;
}

// ── Runner resolution (the runner-swap hook) ────────────────────────────

/**
 * Resolve the effective runner tool + config for a node instance,
 * considering any prior `runner.swapped` events on the same instance.
 *
 * Per-instance scope: a swap on `shot_image:shot_3` does NOT affect
 * `shot_image:shot_4`. A swap with no itemId applies to the bare node
 * (used when the node is a stage, not a collection).
 *
 * Returns the latest swap wins; bundle default is the fallback.
 */
export function resolveRunnerForInstance(
  node: DemoNode,
  itemId: string | undefined,
  events: Iterable<DheeEvent>,
): { tool: string; config: Record<string, unknown> } {
  let swapped: { tool: string; config: Record<string, unknown> } | null = null;
  for (const e of events) {
    if (e.kind !== 'runner.swapped') continue;
    const p = e.payload as { nodeId: string; itemId?: string; toTool: string; configOverride?: Record<string, unknown> };
    if (p.nodeId !== node.id) continue;
    if ((p.itemId ?? undefined) !== (itemId ?? undefined)) continue;
    swapped = {
      tool: p.toTool,
      config: { ...node.runner.config, ...(p.configOverride ?? {}) },
    };
  }
  return swapped ?? { tool: node.runner.tool, config: node.runner.config };
}

// ── Topo helpers ────────────────────────────────────────────────────────

function topoFromGoal(bundle: DemoBundle): DemoNode[] {
  const byId = new Map(bundle.nodes.map((n) => [n.id, n]));
  const goal = byId.get(bundle.goal);
  if (!goal) throw new Error(`Bundle goal '${bundle.goal}' not in nodes[]`);
  const visited = new Set<string>();
  const order: DemoNode[] = [];
  function visit(n: DemoNode): void {
    if (visited.has(n.id)) return;
    visited.add(n.id);
    for (const inp of n.inputs) {
      const upstream = byId.get(inp.from);
      if (upstream) visit(upstream);
    }
    order.push(n);
  }
  visit(goal);
  return order;
}

function computeCascade(bundle: DemoBundle, runOnly: string[]): Set<string> {
  const downstream = new Map<string, string[]>();
  for (const n of bundle.nodes) {
    for (const inp of n.inputs) {
      const list = downstream.get(inp.from) ?? [];
      if (!list.includes(n.id)) list.push(n.id);
      downstream.set(inp.from, list);
    }
  }
  const cascade = new Set<string>(runOnly);
  const queue = [...runOnly];
  while (queue.length) {
    const cur = queue.shift()!;
    for (const dn of downstream.get(cur) ?? []) {
      if (cascade.has(dn)) continue;
      cascade.add(dn);
      queue.push(dn);
    }
  }
  return cascade;
}

// ── Versioned path helper ───────────────────────────────────────────────

/**
 * Produce a versioned variant of an output pattern.
 *   "image.png"   + "abc123" -> "image.abc123.png"
 *   "foo/x.md"    + "v9"     -> "foo/x.v9.md"
 *   "no-ext"      + "x"      -> "no-ext.x"
 */
function versionedPath(pattern: string, versionId: string): string {
  const ext = extname(pattern);
  const base = ext ? pattern.slice(0, -ext.length) : pattern;
  return `${base}.${versionId}${ext}`;
}

// ── The walk ────────────────────────────────────────────────────────────

export async function runDemoWalk(opts: RunDemoWalkOpts): Promise<RunDemoWalkResult> {
  const log = opts.log ?? (() => undefined);
  const branchId = opts.branchId ?? 'main';
  const cacheRoot = opts.cacheRoot ?? defaultCacheRoot();
  const cache = openGenerationCache({ cacheRoot });
  const engine = opts.engine;

  const order = topoFromGoal(opts.bundle);
  const cascadeSet = opts.runOnly ? computeCascade(opts.bundle, opts.runOnly) : null;

  // Per-walk in-memory map of "what each node produced this walk" so
  // downstream input resolution doesn't have to re-scan the projection
  // for the freshly-selected version.
  const lastOutput: Map<string, { content: string; absPath: string }> = new Map();

  // Seed lastOutput from the projection so a runOnly walk can still
  // resolve upstream inputs that completed in a prior dispatch.
  const proj = engine.projection({ branchId });
  for (const n of opts.bundle.nodes) {
    const entry = proj.nodes[n.id];
    if (entry?.outputPath && entry.status === 'completed') {
      const abs = resolve(opts.projectDir, entry.outputPath);
      if (existsSync(abs)) {
        const content = readFileSync(abs, 'utf-8');
        lastOutput.set(n.id, { content, absPath: abs });
      }
    }
  }

  for (const node of order) {
    if (cascadeSet && !cascadeSet.has(node.id)) {
      // Out of the cascade; skip dispatch but keep upstream lookup
      // alive from `lastOutput` (which we already hydrated above).
      log(`◌ ${node.id} (out of cascade)`);
      continue;
    }

    // Resolve runner (honoring any runner.swapped events).
    const allEvents = [...engine.log().read({ branchId })];
    const resolvedRunner = resolveRunnerForInstance(node, undefined, allEvents);
    const runner = opts.runners[resolvedRunner.tool];
    if (!runner) {
      const err = `${node.id}: runner '${resolvedRunner.tool}' not registered`;
      engine.appendAndProject({ branchId, actor: 'walker', kind: 'node.failed', payload: { nodeId: node.id, error: err } });
      return { ok: false, error: err };
    }

    // Resolve inputs from the latest known output of each upstream.
    const resolvedInputs: Record<string, unknown> = {};
    for (const inp of node.inputs) {
      const up = lastOutput.get(inp.from);
      if (!up) {
        const err = `${node.id}: upstream input '${inp.from}' has not been produced yet`;
        engine.appendAndProject({ branchId, actor: 'walker', kind: 'node.failed', payload: { nodeId: node.id, error: err } });
        return { ok: false, error: err };
      }
      resolvedInputs[inp.from] = up.content;
    }

    engine.appendAndProject({ branchId, actor: 'walker', kind: 'node.started', payload: { nodeId: node.id } });

    // Build the CAS key. inputsHash hashes content (not paths) so we
    // get the same key across re-runs / branches / projects.
    const key: InputsHashKey = {
      tool: resolvedRunner.tool,
      toolVersion: runner.toolVersion,
      inputs: resolvedInputs,
      config: resolvedRunner.config,
    };

    const versionId = nanoid(8);
    const versionedRel = versionedPath(node.output.pattern, versionId);
    const versionedAbs = resolve(opts.projectDir, versionedRel);
    mkdirSync(dirname(versionedAbs), { recursive: true });

    // ── Cache check ──
    const cacheHit = cache.get(key);
    let outputContent: string;
    let metadata: Record<string, unknown> = {};
    let costUsd: number | undefined;
    let cached: boolean;

    if (cacheHit) {
      copyFileSync(cacheHit.storePath, versionedAbs);
      outputContent = readFileSync(versionedAbs, 'utf-8');
      metadata = cacheHit.metadata ?? {};
      costUsd = typeof metadata['costUsd'] === 'number' ? (metadata['costUsd'] as number) : 0;
      cached = true;
      log(`✓ ${node.id} (cache hit: ${cacheHit.hash.slice(0, 8)})`);
    } else {
      const result = await runner.run({
        projectDir: opts.projectDir,
        nodeId: node.id,
        inputs: resolvedInputs,
        config: resolvedRunner.config,
      });
      const bytes = result.contentBytes ?? Buffer.from(result.content, 'utf-8');
      writeFileSync(versionedAbs, bytes);
      cache.put({ key, sourcePath: versionedAbs, ext: extname(node.output.pattern).slice(1) || 'bin', metadata: { ...(result.metadata ?? {}), costUsd: result.costUsd } });
      outputContent = result.content;
      metadata = result.metadata ?? {};
      costUsd = result.costUsd;
      cached = false;
      log(`✓ ${node.id} (computed)`);
    }

    // Mirror the versioned file to the canonical pattern path — the
    // "selected" version. Existing readers (desktop, dheeReadArtifact)
    // see this path unchanged.
    const canonicalAbs = resolve(opts.projectDir, node.output.pattern);
    if (canonicalAbs !== versionedAbs) {
      mkdirSync(dirname(canonicalAbs), { recursive: true });
      copyFileSync(versionedAbs, canonicalAbs);
    }
    lastOutput.set(node.id, { content: outputContent, absPath: canonicalAbs });

    const inputsHash = computeInputsHash(key);
    engine.appendAndProject({
      branchId,
      actor: 'walker',
      kind: 'node.completed',
      payload: {
        nodeId: node.id,
        versionId,
        outputPath: versionedRel,
        artifact: { format: (node.output.format as 'md' | 'json' | 'image' | 'video' | 'audio' | 'text') ?? 'text' },
        generation: {
          tool: resolvedRunner.tool,
          toolVersion: runner.toolVersion,
          inputsHash,
          cached,
          ...(costUsd !== undefined ? { costUsd } : {}),
        },
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      },
    });
  }

  const goalOutput = lastOutput.get(opts.bundle.goal);
  return {
    ok: true,
    ...(goalOutput ? { goalPath: goalOutput.absPath } : {}),
  };
}
