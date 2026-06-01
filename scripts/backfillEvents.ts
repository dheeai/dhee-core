#!/usr/bin/env tsx
/**
 * backfillEvents — synthesize .dhee/events.jsonl from a legacy
 * project's executorState/walkState + a chosen bundle.
 *
 * Use case: existing projects (run before the event log existed) have
 * artifacts on disk and a `nodes` map in project.json showing
 * completion status, but no event log. The Inspector "Cards" UI
 * consumes the event log only — so without backfill, those projects
 * show "no events yet" forever.
 *
 * Strategy:
 *   1. Read project.json's executorState.nodes (or walkState.nodes).
 *   2. Load the chosen bundle.
 *   3. Build a name-mapping table to translate legacy node IDs to
 *      bundle node IDs (e.g. `scene_shot_plan` → `scenes_plan`).
 *   4. For each completed legacy entry that maps to a bundle node,
 *      derive its dependencies from the bundle's inputs[] + scope
 *      rules + content-aware refinement when prompt JSONs declare
 *      `references[]`.
 *   5. Emit events in topological order so projection folds cleanly.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfillEvents.ts <projectDir> [bundleSource]
 *
 * Bundle defaults to `built-in:narrative_shot_by_shot` (closest to
 * the legacy schema). For Klein/LTX projects, pass
 * `built-in:narrative_klein_relay_review`.
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  parseBundleSource,
  resolveBundleDir,
  loadBundle,
  openProjectionEngine,
  type DagBundle,
  type NodeDependency,
} from '../src/dag/walker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Legacy → bundle node ID mapping ───────────────────────────────────

const LEGACY_TO_BUNDLE: Record<string, string> = {
  // Legacy single-LLM-call nodes that the bundle splits across
  // multiple nodes. The legacy entry maps to the closest bundle node.
  scene_shot_plan: 'scenes_plan',
  character: 'characters_plan',     // legacy: per-character LLM, bundle: aggregate
  setting: 'settings_plan',
  scene: 'scenes_plan',
  shot_breakdown: 'shot_image_prompt', // legacy alias
  // 1:1 names already match — pass-through handled by default.
};

function mapNodeId(legacyId: string): string {
  return LEGACY_TO_BUNDLE[legacyId] ?? legacyId;
}

interface LegacyEntry {
  status?: string;
  outputPath?: string;
  itemId?: string;
  completedAt?: number;
}

function parseStateKey(key: string): { nodeId: string; itemId: string | undefined } {
  const colonIdx = key.indexOf(':');
  if (colonIdx === -1) return { nodeId: key, itemId: undefined };
  return { nodeId: key.slice(0, colonIdx), itemId: key.slice(colonIdx + 1) };
}

// ── Topo ordering ─────────────────────────────────────────────────────

function topoBundleOrder(bundle: DagBundle): string[] {
  const visited = new Set<string>();
  const order: string[] = [];
  const byId = new Map(bundle.nodes.map((n) => [n.id, n]));
  function visit(id: string): void {
    if (visited.has(id)) return;
    visited.add(id);
    const node = byId.get(id);
    if (!node) return;
    for (const inp of node.inputs ?? []) visit(inp.from);
    order.push(id);
  }
  for (const n of bundle.nodes) visit(n.id);
  return order;
}

// ── Dep derivation ────────────────────────────────────────────────────

/**
 * For a downstream instance, derive its dependencies by walking
 * bundle.nodes[downstream].inputs[] and matching upstream instances
 * already present in the entries map.
 */
function deriveDeps(
  bundle: DagBundle,
  downstreamNodeId: string,
  downstreamItemId: string | undefined,
  entriesByBundleNode: Map<string, Array<{ itemId: string | undefined }>>,
  promptRefs: Map<string, Array<{ id: string; type: string }>>,
): NodeDependency[] {
  const node = bundle.nodes.find((n) => n.id === downstreamNodeId);
  if (!node) return [];
  const deps: NodeDependency[] = [];
  for (const inp of node.inputs ?? []) {
    const upstream = bundle.nodes.find((n) => n.id === inp.from);
    if (!upstream) continue;
    const upInstances = entriesByBundleNode.get(inp.from) ?? [];
    if (upInstances.length === 0) continue;
    const scope = inp.scope ?? 'any';
    const role = inp.usage as NodeDependency['role'];

    // Stage upstream: single dep
    if (upstream.kind === 'stage') {
      deps.push({ nodeId: inp.from, ...(role ? { role } : {}) });
      continue;
    }

    if (scope === 'matching') {
      const match = upInstances.find((u) => u.itemId === downstreamItemId);
      if (match) deps.push({ nodeId: inp.from, ...(match.itemId !== undefined ? { itemId: match.itemId } : {}), ...(role ? { role } : {}) });
      continue;
    }

    if (scope === 'previousN') {
      const n = (inp as { n?: number }).n ?? 5;
      const parseShot = (id: string | undefined): number | undefined => {
        if (!id) return undefined;
        const m = id.match(/(?:^|_)shot_(\d+)$/);
        return m ? parseInt(m[1]!, 10) : undefined;
      };
      const dnShot = parseShot(downstreamItemId);
      if (dnShot === undefined) continue;
      const priors = upInstances
        .map((u) => ({ itemId: u.itemId, shot: parseShot(u.itemId) }))
        .filter((u) => u.shot !== undefined && u.shot < dnShot)
        .sort((a, b) => b.shot! - a.shot!)
        .slice(0, n);
      for (const p of priors) deps.push({ nodeId: inp.from, ...(p.itemId !== undefined ? { itemId: p.itemId } : {}), ...(role ? { role } : {}) });
      continue;
    }

    // scope='all' or default — content-aware refinement when available
    const downstreamKey = downstreamItemId ? `${downstreamNodeId}:${downstreamItemId}` : downstreamNodeId;
    const refs = promptRefs.get(downstreamKey);
    let chosen = upInstances;
    if (refs && refs.length > 0) {
      const expectedType = inp.from.includes('character')
        ? 'character'
        : inp.from.includes('setting')
          ? 'setting'
          : null;
      if (expectedType) {
        const allowed = new Set(refs.filter((r) => r.type === expectedType).map((r) => r.id));
        if (allowed.size > 0) chosen = upInstances.filter((u) => u.itemId && allowed.has(u.itemId));
      }
    }
    for (const u of chosen) {
      deps.push({ nodeId: inp.from, ...(u.itemId !== undefined ? { itemId: u.itemId } : {}), ...(role ? { role } : {}) });
    }
  }
  return deps;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const projectDir = resolve(process.argv[2] ?? '');
  const bundleSource = process.argv[3] ?? 'built-in:narrative_shot_by_shot';
  if (!projectDir || !existsSync(join(projectDir, 'project.json'))) {
    console.error('Usage: tsx scripts/backfillEvents.ts <projectDir> [bundleSource]');
    process.exit(2);
  }

  console.log(`Backfilling events for: ${projectDir}`);
  console.log(`Bundle:                 ${bundleSource}`);

  const projectJson = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as Record<string, unknown>;
  const walkState = (projectJson['walkState'] ?? projectJson['executorState']) as { nodes?: Record<string, LegacyEntry | string> } | undefined;
  if (!walkState?.nodes) {
    console.error('Project has neither walkState nor executorState — nothing to backfill.');
    process.exit(1);
  }

  // Load bundle
  const source = parseBundleSource(bundleSource);
  const bundleDirPath = resolveBundleDir(source);
  const bundlePath = bundleDirPath.endsWith('.json') ? bundleDirPath : join(bundleDirPath, 'bundle.json');
  const bundle = loadBundle(bundlePath);
  const bundleNodeIds = new Set(bundle.nodes.map((n) => n.id));

  // Index entries by (bundle) node id
  const entriesByBundleNode = new Map<string, Array<{ itemId: string | undefined; outputPath?: string }>>();
  const skipped: string[] = [];
  for (const [stateKey, entryRaw] of Object.entries(walkState.nodes)) {
    const entry: LegacyEntry =
      typeof entryRaw === 'string' ? { status: entryRaw } : (entryRaw as LegacyEntry);
    if (entry.status !== 'completed') continue;
    const { nodeId: legacyNodeId, itemId } = parseStateKey(stateKey);
    const bundleNodeId = mapNodeId(legacyNodeId);
    if (!bundleNodeIds.has(bundleNodeId)) {
      skipped.push(stateKey);
      continue;
    }
    const list = entriesByBundleNode.get(bundleNodeId) ?? [];
    list.push({ itemId, ...(entry.outputPath ? { outputPath: entry.outputPath } : {}) });
    entriesByBundleNode.set(bundleNodeId, list);
  }

  console.log(`Mapped ${[...entriesByBundleNode.values()].reduce((a, b) => a + b.length, 0)} instances; skipped ${skipped.length} (no matching bundle node).`);

  // Optional: parse prompt JSONs for content-aware references.
  // Looks at `prompts/shot_image/<itemId>.json` (bundle layout) or
  // `prompts/images/<...>.json` (legacy) — first one that has a
  // `references[]` array wins.
  const promptRefs = new Map<string, Array<{ id: string; type: string }>>();
  for (const inst of entriesByBundleNode.get('shot_image_prompt') ?? []) {
    if (!inst.itemId) continue;
    const candidates = [
      join(projectDir, 'prompts', 'shot_image', `${inst.itemId}.json`),
      join(projectDir, 'prompts', 'images', `${inst.itemId}.json`),
    ];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, 'utf-8')) as { references?: Array<{ id: string; type: string }> };
        if (Array.isArray(j.references) && j.references.length > 0) {
          promptRefs.set(`shot_image_prompt:${inst.itemId}`, j.references);
          // shot_image inherits its prompt's references for dep wiring.
          promptRefs.set(`shot_image:${inst.itemId}`, j.references);
          promptRefs.set(`shot_video:${inst.itemId}`, j.references);
        }
      } catch { /* ignore */ }
    }
  }
  console.log(`Parsed content-aware references for ${promptRefs.size / 3} shots.`);

  // Emit events in topo order. Wipe any existing events.jsonl first
  // since this is a from-scratch backfill.
  const dheePath = join(projectDir, '.dhee');
  mkdirSync(dheePath, { recursive: true });
  const eventsPath = join(dheePath, 'events.jsonl');
  if (existsSync(eventsPath)) {
    const backupPath = `${eventsPath}.pre-backfill-${Date.now()}`;
    writeFileSync(backupPath, readFileSync(eventsPath, 'utf-8'));
    console.log(`Backed up existing events.jsonl → ${backupPath}`);
  }
  writeFileSync(eventsPath, ''); // truncate

  const engine = openProjectionEngine(projectDir);

  // 1. bundle.bound
  engine.appendAndProject({
    branchId: 'main', actor: 'walker', kind: 'bundle.bound',
    payload: {
      bundleSource,
      bundleVersion: bundle.version,
      engineVersion: '0.1.0',
    },
  });

  // 2. node.completed in topo order
  const topo = topoBundleOrder(bundle);
  let emitted = 0;
  for (const bundleNodeId of topo) {
    const instances = entriesByBundleNode.get(bundleNodeId) ?? [];
    if (instances.length === 0) continue;
    // Sort instances by itemId for stable ordering.
    instances.sort((a, b) => (a.itemId ?? '').localeCompare(b.itemId ?? ''));
    for (const inst of instances) {
      const deps = deriveDeps(bundle, bundleNodeId, inst.itemId, entriesByBundleNode, promptRefs);
      const bundleNode = bundle.nodes.find((n) => n.id === bundleNodeId)!;
      engine.appendAndProject({
        branchId: 'main',
        actor: 'walker',
        kind: 'node.completed',
        payload: {
          nodeId: bundleNodeId,
          ...(inst.itemId !== undefined ? { itemId: inst.itemId } : {}),
          versionId: `backfill-${emitted.toString(36)}`,
          outputPath: inst.outputPath ?? `(backfilled — no path on legacy entry)`,
          artifact: { format: bundleNode.outputs.format },
          generation: {
            tool: bundleNode.runner.tool,
            toolVersion: '0.1.0',
            cached: false,
          },
          ...(deps.length > 0 ? { dependencies: deps } : {}),
        },
      });
      emitted += 1;
    }
  }

  console.log(`\nEmitted ${emitted + 1} events (1 bundle.bound + ${emitted} node.completed).`);
  console.log(`Events file: ${eventsPath}`);
  if (skipped.length > 0) {
    console.log(`\nSkipped legacy nodes (no bundle mapping): ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? '...' : ''}`);
  }

  // Summary by node
  console.log(`\nInstances by bundle node:`);
  for (const id of topo) {
    const c = entriesByBundleNode.get(id)?.length ?? 0;
    if (c > 0) console.log(`  ${id.padEnd(30)} ${c}`);
  }
}

main().catch((err) => {
  console.error('backfillEvents failed:');
  console.error(err);
  process.exit(1);
});
