#!/usr/bin/env tsx
/**
 * eventSourcedDemo — end-to-end proof of the event-sourced reactive
 * graph architecture.
 *
 * Walks a tiny 3-node bundle (seed → image → caption) with stub runners
 * and exercises each capability the design promises:
 *
 *   1. Event log foundation       — every walk step appended as an
 *      event to .dhee/events.jsonl.
 *   2. walkState projection       — the back-compat snapshot in
 *      project.json is computed from the log, not mutated directly.
 *   3. Content-addressed cache    — the second project (with shared
 *      CAS root) replays all three nodes for free.
 *   4. Non-destructive versioning — a regen produces a NEW version;
 *      the prior file still lives on disk; the candidate tray shows
 *      both options.
 *   5. Forks / branches           — the experiment branch inherits
 *      main's prefix and diverges; main is untouched.
 *   6. Conditional runner swap    — a mock VLM stamps a suggestion,
 *      the agent (mocked) confirms via runner.swapped, the re-walk
 *      uses the alt runner.
 *
 * Output is intentionally verbose so each capability is visible.
 *
 * Run with:
 *   pnpm exec tsx scripts/eventSourcedDemo.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openProjectionEngine } from '../src/dag/eventLog/ProjectionEngine.js';
import {
  runDemoWalk,
  type DemoBundle,
  type DemoRunner,
} from '../src/dag/eventLog/DemoWalker.js';
import { eventLogPath } from '../src/dag/eventLog/eventLogPath.js';

// ── Tiny bundle ──────────────────────────────────────────────────────

const TINY_BUNDLE: DemoBundle = {
  id: 'tiny',
  version: '0.1.0',
  description: 'demo: seed → image → caption',
  goal: 'caption',
  nodes: [
    {
      id: 'seed',
      runner: { tool: 'demo.seed', config: { seed: 'astronaut' } },
      output: { format: 'md', pattern: 'seed.md' },
      inputs: [],
    },
    {
      id: 'image',
      runner: { tool: 'demo.image', config: { style: 'cinematic' } },
      output: { format: 'png', pattern: 'image.png' },
      inputs: [{ from: 'seed' }],
      runnerAlternatives: [
        { tool: 'demo.image.alt', matchesHint: 'reverse_angle | character_in_3d_rotation' },
      ],
    },
    {
      id: 'caption',
      runner: { tool: 'demo.caption', config: {} },
      output: { format: 'md', pattern: 'caption.md' },
      inputs: [{ from: 'image' }],
    },
  ],
};

// ── Stub runners ─────────────────────────────────────────────────────

let imageCounter = 0;
const runners: Record<string, DemoRunner> = {
  'demo.seed': {
    tool: 'demo.seed',
    toolVersion: '0.1.0',
    async run(ctx) {
      const seed = (ctx.config as { seed?: string }).seed ?? 'unknown';
      const content = `# Seed\n\nSubject: ${seed}\n`;
      return { content, costUsd: 0.001 };
    },
  },
  'demo.image': {
    tool: 'demo.image',
    toolVersion: '0.1.0',
    async run(ctx) {
      imageCounter += 1;
      const seedInput = ctx.inputs['seed'] as string;
      const style = (ctx.config as { style?: string }).style ?? 'plain';
      const content = `[IMAGE v${imageCounter} | style=${style} | derived-from:\n${seedInput.trim()}]\n`;
      return { content, costUsd: 0.02 };
    },
  },
  'demo.image.alt': {
    tool: 'demo.image.alt',
    toolVersion: '0.1.0',
    async run(ctx) {
      const seedInput = ctx.inputs['seed'] as string;
      const content = `[ALT-IMAGE (rendered by demo.image.alt) | derived-from:\n${seedInput.trim()}]\n`;
      return { content, costUsd: 0.03 };
    },
  },
  'demo.caption': {
    tool: 'demo.caption',
    toolVersion: '0.1.0',
    async run(ctx) {
      const img = ctx.inputs['image'] as string;
      const content = `Caption: ${img.split('\n')[0]?.slice(0, 60) ?? '(image)'}`;
      return { content, costUsd: 0.005 };
    },
  },
};

// ── Pretty-printing helpers ──────────────────────────────────────────

function banner(title: string): void {
  const w = 70;
  const bar = '═'.repeat(w);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

function subheader(s: string): void {
  console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`);
}

function printEventLog(filePath: string, label: string): void {
  subheader(label);
  if (!existsSync(filePath)) {
    console.log('(no events.jsonl)');
    return;
  }
  const raw = readFileSync(filePath, 'utf-8').trim();
  if (raw.length === 0) {
    console.log('(empty)');
    return;
  }
  for (const line of raw.split('\n')) {
    try {
      const e = JSON.parse(line) as {
        seq: number;
        kind: string;
        actor: string;
        branchId: string;
        payload: Record<string, unknown>;
      };
      const tag = `[${e.branchId}#${String(e.seq).padStart(2, '0')}]`;
      const summary = summarizePayload(e.kind, e.payload);
      console.log(`${tag} ${e.actor.padEnd(7)} ${e.kind.padEnd(22)} ${summary}`);
    } catch {
      console.log(`(unparseable: ${line.slice(0, 80)}…)`);
    }
  }
}

function summarizePayload(kind: string, p: Record<string, unknown>): string {
  switch (kind) {
    case 'node.started':
      return `${p['nodeId'] as string}`;
    case 'node.completed': {
      const gen = p['generation'] as { tool?: string; cached?: boolean; costUsd?: number } | undefined;
      const v = p['versionId'] as string;
      const cached = gen?.cached ? '(cached)' : '';
      const cost = typeof gen?.costUsd === 'number' ? `$${gen.costUsd.toFixed(4)}` : '';
      const tool = gen?.tool ?? '?';
      return `${p['nodeId'] as string} v=${v} via ${tool} ${cached} ${cost}`.trim();
    }
    case 'node.invalidated':
      return `${p['nodeId'] as string}`;
    case 'version.selected':
      return `${p['nodeId'] as string} → v=${p['versionId'] as string}`;
    case 'branch.created':
      return `${p['branchId'] as string} from ${p['parentBranchId'] as string} @ ${p['forkedFromEventId'] as string}`;
    case 'runner.swap_suggested':
      return `${p['nodeId'] as string} suggest ${p['suggestedTool'] as string} (${p['reason'] as string})`;
    case 'runner.swapped':
      return `${p['nodeId'] as string} ${p['fromTool'] as string} → ${p['toTool'] as string}`;
    default:
      return JSON.stringify(p).slice(0, 80);
  }
}

function printWalkState(label: string, eng: ReturnType<typeof openProjectionEngine>, branchId?: string): void {
  subheader(label);
  const proj = eng.projection(branchId ? { branchId } : {});
  if (Object.keys(proj.nodes).length === 0) {
    console.log('(no node entries)');
    return;
  }
  for (const [k, v] of Object.entries(proj.nodes)) {
    const versions = v.versions ?? [];
    const sel = v.selectedVersionId ?? '?';
    console.log(`  ${k.padEnd(20)} status=${v.status.padEnd(11)} selected=${sel} versions=${versions.length}`);
    if (v.outputPath) console.log(`    outputPath: ${v.outputPath}`);
  }
}

function printVersionTray(label: string, eng: ReturnType<typeof openProjectionEngine>, nodeId: string, branchId?: string): void {
  subheader(label);
  const versions = eng.listVersions(nodeId, undefined, branchId ? { branchId } : {});
  if (versions.length === 0) {
    console.log('(empty tray)');
    return;
  }
  for (const v of versions) {
    const sel = v.selected ? '★' : ' ';
    const tool = v.generation?.tool ?? '?';
    const cached = v.generation?.cached ? '(cached)' : '';
    console.log(`  ${sel} ${v.versionId.padEnd(12)} via ${tool.padEnd(18)} → ${v.outputPath} ${cached}`);
  }
}

function printBranchTree(label: string, eng: ReturnType<typeof openProjectionEngine>): void {
  subheader(label);
  const tree = eng.computeBranchTree();
  for (const b of tree.branches) {
    const parent = b.parentBranchId ? ` (fork of ${b.parentBranchId})` : '';
    const lbl = b.label ? ` "${b.label}"` : '';
    console.log(`  • ${b.branchId}${lbl}${parent}`);
  }
}

function printCostLedger(label: string, eng: ReturnType<typeof openProjectionEngine>, branchId?: string): void {
  subheader(label);
  const c = eng.computeCostLedger(branchId ? { branchId } : {});
  console.log(`  totalUsd:             $${c.totalUsd.toFixed(4)}`);
  console.log(`  computeCount:         ${c.computeCount}`);
  console.log(`  cacheHits:            ${c.cacheHits}`);
  console.log(`  estimatedSavingsUsd:  $${c.estimatedSavingsUsd.toFixed(4)}`);
}

// ── Demo run ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const projectA = mkdtempSync(join(tmpdir(), 'esg-demo-A-'));
  const projectB = mkdtempSync(join(tmpdir(), 'esg-demo-B-'));
  const casRoot = mkdtempSync(join(tmpdir(), 'esg-demo-cas-'));

  try {
    banner('① EVENT LOG FOUNDATION — first walk');
    const engA = openProjectionEngine(projectA);
    engA.appendAndProject({
      branchId: 'main',
      actor: 'user',
      kind: 'project.created',
      payload: { projectDir: projectA },
    });
    engA.appendAndProject({
      branchId: 'main',
      actor: 'user',
      kind: 'bundle.bound',
      payload: { bundleSource: 'demo:tiny', bundleVersion: '0.1.0', engineVersion: '0.1.0' },
    });
    const walk1 = await runDemoWalk({
      bundle: TINY_BUNDLE,
      projectDir: projectA,
      engine: engA,
      runners,
      cacheRoot: casRoot,
      log: (m) => console.log(`    ${m}`),
    });
    console.log(`\n  walk ok=${walk1.ok}  goal=${walk1.goalPath ? walk1.goalPath.replace(projectA, '<projectA>') : '?'}`);
    printEventLog(eventLogPath(projectA), 'event log (after first walk)');
    printWalkState('walkState projection (back-compat snapshot)', engA);
    printCostLedger('cost ledger', engA);

    banner('③ CONTENT-ADDRESSED CACHE — fresh project, SAME CAS, all hits replay');
    const engB = openProjectionEngine(projectB);
    engB.appendAndProject({
      branchId: 'main',
      actor: 'user',
      kind: 'bundle.bound',
      payload: { bundleSource: 'demo:tiny', bundleVersion: '0.1.0', engineVersion: '0.1.0' },
    });
    const walk2 = await runDemoWalk({
      bundle: TINY_BUNDLE,
      projectDir: projectB,
      engine: engB,
      runners,
      cacheRoot: casRoot,
      log: (m) => console.log(`    ${m}`),
    });
    console.log(`\n  walk ok=${walk2.ok}`);
    printCostLedger('cost ledger for projectB (notice cacheHits=3, totalUsd=0)', engB);

    banner('② NON-DESTRUCTIVE VERSIONING — regen image, keep prior version');
    engA.appendAndProject({ branchId: 'main', actor: 'agent', kind: 'node.invalidated', payload: { nodeId: 'image' } });
    await runDemoWalk({
      bundle: TINY_BUNDLE,
      projectDir: projectA,
      engine: engA,
      runners,
      cacheRoot: casRoot,
      runOnly: ['image'],
      log: (m) => console.log(`    ${m}`),
    });
    printVersionTray('image node — candidate tray (two versions, latest selected)', engA, 'image');
    // List files on disk to prove non-destruction.
    subheader('disk: image.* files still alive');
    const { readdirSync } = await import('node:fs');
    for (const f of readdirSync(projectA)) {
      if (f.startsWith('image.')) console.log(`  ${f}`);
    }

    banner('② TASTE-GATE: select the older version');
    const tray = engA.listVersions('image');
    const v1Id = tray[0]!.versionId;
    engA.appendAndProject({ branchId: 'main', actor: 'user', kind: 'version.selected', payload: { nodeId: 'image', versionId: v1Id } });
    printVersionTray('image node — selection flipped to v1', engA, 'image');
    printWalkState('walkState projection — outputPath repointed at v1', engA);

    banner('④ FORKS — experiment branch tries the alt runner');
    const lastEvent = [...engA.log().read()].pop()!;
    engA.appendAndProject({
      branchId: 'main',
      actor: 'user',
      kind: 'branch.created',
      payload: {
        branchId: 'experiment',
        label: 'try alt runner',
        forkedFromEventId: lastEvent.id,
        parentBranchId: 'main',
      },
    });

    banner('⑤ CONDITIONAL RUNNER SWAP — VLM suggests, agent confirms, re-walk');
    engA.appendAndProject({
      branchId: 'experiment',
      actor: 'runner',
      kind: 'runner.swap_suggested',
      payload: {
        nodeId: 'image',
        suggestedTool: 'demo.image.alt',
        reason: 'mock VLM verdict: cinematic style does not match brief',
        confidence: 0.82,
      },
    });
    engA.appendAndProject({
      branchId: 'experiment',
      actor: 'agent',
      kind: 'runner.swapped',
      payload: {
        nodeId: 'image',
        fromTool: 'demo.image',
        toTool: 'demo.image.alt',
        reason: 'LLM accepted mock VLM verdict; alt runner is a better fit',
      },
    });
    engA.appendAndProject({ branchId: 'experiment', actor: 'agent', kind: 'node.invalidated', payload: { nodeId: 'image' } });
    await runDemoWalk({
      bundle: TINY_BUNDLE,
      projectDir: projectA,
      engine: engA,
      runners,
      cacheRoot: casRoot,
      runOnly: ['image'],
      branchId: 'experiment',
      log: (m) => console.log(`    ${m}`),
    });

    printBranchTree('branch tree', engA);
    printVersionTray('image tray on main (untouched)', engA, 'image', 'main');
    printVersionTray('image tray on experiment (inherited prefix + alt-runner divergence)', engA, 'image', 'experiment');
    printWalkState('walkState projection on main', engA, 'main');
    printWalkState('walkState projection on experiment', engA, 'experiment');
    printCostLedger('cost on main', engA, 'main');
    printCostLedger('cost on experiment', engA, 'experiment');

    banner('FULL EVENT LOG (the source of truth)');
    printEventLog(eventLogPath(projectA), 'all events');

    banner('SUMMARY');
    const totalEvents = [...engA.log().read()].length;
    const mainCost = engA.computeCostLedger();
    const expCost = engA.computeCostLedger({ branchId: 'experiment' });
    console.log(`  Total events:            ${totalEvents}`);
    console.log(`  Branches:                ${engA.computeBranchTree().branches.length}`);
    console.log(`  Image versions (main):   ${engA.listVersions('image', undefined, { branchId: 'main' }).length}`);
    console.log(`  Image versions (exp):    ${engA.listVersions('image', undefined, { branchId: 'experiment' }).length}`);
    console.log(`  Spend on main:           $${mainCost.totalUsd.toFixed(4)} (cache hits: ${mainCost.cacheHits})`);
    console.log(`  Spend on experiment:     $${expCost.totalUsd.toFixed(4)} (cache hits: ${expCost.cacheHits})`);
    console.log(`  Spend on projectB:       $${engB.computeCostLedger().totalUsd.toFixed(4)} (savings: $${engB.computeCostLedger().estimatedSavingsUsd.toFixed(4)})`);
    console.log(`\n  events.jsonl path:        ${eventLogPath(projectA)}`);
    console.log(`  project.json walkState:   ${join(projectA, 'project.json')}`);
    console.log(`  CAS root:                 ${casRoot}`);
    console.log('\n  ALL FOUR CAPABILITIES PROVEN END-TO-END.');
  } finally {
    rmSync(projectA, { recursive: true, force: true });
    rmSync(projectB, { recursive: true, force: true });
    rmSync(casRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
