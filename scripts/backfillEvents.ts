#!/usr/bin/env tsx
/**
 * backfillEvents — synthesize .dhee/events.jsonl from a legacy
 * project's executorState/walkState + a chosen bundle.
 *
 * Pure helpers in `src/dag/eventLog/backfillHelpers.ts` carry the
 * logic that has tests; this file is the I/O glue: read project.json,
 * map legacy IDs, parse prompt JSONs, emit events.
 *
 * Usage:
 *   pnpm exec tsx scripts/backfillEvents.ts <projectDir> [bundleSource]
 */
import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

import {
  parseBundleSource,
  resolveBundleDir,
  loadBundle,
  openProjectionEngine,
  type DagBundle,
} from '../src/dag/walker.js';
import {
  deriveDeps,
  extractRefs,
  synthesizeMissingPromptEntries,
  type EntriesByBundleNode,
  type InstanceEntry,
  type ContentRef,
  type ReferenceMap,
} from '../src/dag/eventLog/backfillHelpers.js';

// ── Legacy → bundle node ID mapping ───────────────────────────────────

const LEGACY_TO_BUNDLE: Record<string, string> = {
  // Legacy single-LLM-call nodes that the bundle splits across
  // multiple nodes. The legacy entry maps to the closest bundle node.
  scene_shot_plan: 'scenes_plan',
  character: 'characters_plan',
  setting: 'settings_plan',
  scene: 'scenes_plan',
  shot_breakdown: 'shot_image_prompt',
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

// ── Prompt-ref discovery (legacy + bundle paths) ─────────────────────

function discoverShotReferences(
  projectDir: string,
  shotItemIds: Set<string>,
): ReferenceMap {
  const out: ReferenceMap = new Map();
  for (const itemId of shotItemIds) {
    const dashed = itemId.replace(/_/g, '-');
    const candidates = [
      join(projectDir, 'prompts', 'shot_image', `${itemId}.json`),
      join(projectDir, 'prompts', 'images', `${itemId}.json`),
      join(projectDir, 'prompts', 'images', 'shots', `${dashed}.json`),
      join(projectDir, 'prompts', 'images', 'shots', `${itemId}.json`),
    ];
    let refs: ContentRef[] = [];
    for (const p of candidates) {
      if (!existsSync(p)) continue;
      try {
        const j = JSON.parse(readFileSync(p, 'utf-8')) as unknown;
        refs = extractRefs(j);
        if (refs.length > 0) break;
      } catch { /* skip */ }
    }
    if (refs.length === 0) continue;
    for (const downstream of [
      'shot_image_prompt',
      'shot_image',
      'shot_image_last_frame',
      'shot_image_last_frame_prompt',
      'shot_video',
      'shot_motion_directive',
    ]) {
      out.set(`${downstream}:${itemId}`, refs);
    }
  }
  return out;
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

  // Index legacy entries by (bundle) node id.
  const entriesByBundleNode: EntriesByBundleNode = new Map();
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
    const e: InstanceEntry = { itemId, ...(entry.outputPath ? { outputPath: entry.outputPath } : {}) };
    list.push(e);
    entriesByBundleNode.set(bundleNodeId, list);
  }

  const syntheticAdded = synthesizeMissingPromptEntries(bundle, entriesByBundleNode);
  console.log(
    `Mapped ${[...entriesByBundleNode.values()].reduce((a, b) => a + b.length, 0)} instances ` +
      `(of which ${syntheticAdded} are synthesized prompt-tier nodes); ` +
      `skipped ${skipped.length} legacy entries with no bundle mapping.`,
  );

  // Discover content-aware refs from shot prompt JSONs.
  const shotItemIds = new Set<string>();
  for (const inst of entriesByBundleNode.get('shot_image_prompt') ?? []) {
    if (inst.itemId) shotItemIds.add(inst.itemId);
  }
  for (const inst of entriesByBundleNode.get('shot_image') ?? []) {
    if (inst.itemId) shotItemIds.add(inst.itemId);
  }
  const promptRefs = discoverShotReferences(projectDir, shotItemIds);
  const distinctRefShots = new Set([...promptRefs.keys()].map((k) => k.split(':').slice(1).join(':'))).size;
  console.log(`Parsed content-aware references for ${distinctRefShots} shots.`);

  // Emit events: bundle.bound + node.completed × N in topo order.
  const dheePath = join(projectDir, '.dhee');
  mkdirSync(dheePath, { recursive: true });
  const eventsPath = join(dheePath, 'events.jsonl');
  if (existsSync(eventsPath)) {
    const backupPath = `${eventsPath}.pre-backfill-${Date.now()}`;
    writeFileSync(backupPath, readFileSync(eventsPath, 'utf-8'));
    console.log(`Backed up existing events.jsonl → ${backupPath}`);
  }
  writeFileSync(eventsPath, '');

  const engine = openProjectionEngine(projectDir);
  engine.appendAndProject({
    branchId: 'main',
    actor: 'walker',
    kind: 'bundle.bound',
    payload: { bundleSource, bundleVersion: bundle.version, engineVersion: '0.1.0' },
  });

  const topo = topoBundleOrder(bundle);
  let emitted = 0;
  for (const bundleNodeId of topo) {
    const instances = entriesByBundleNode.get(bundleNodeId) ?? [];
    if (instances.length === 0) continue;
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
          generation: { tool: bundleNode.runner.tool, toolVersion: '0.1.0', cached: false },
          ...(deps.length > 0 ? { dependencies: deps } : {}),
          ...(inst.synthetic ? { metadata: { synthetic: true, source: 'backfill' } } : {}),
        },
      });
      emitted += 1;
    }
  }

  console.log(`\nEmitted ${emitted + 1} events (1 bundle.bound + ${emitted} node.completed).`);
  if (skipped.length > 0) {
    console.log(`\nSkipped legacy nodes (no bundle mapping): ${skipped.slice(0, 10).join(', ')}${skipped.length > 10 ? '...' : ''}`);
  }
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
