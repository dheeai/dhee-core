#!/usr/bin/env tsx
/**
 * resumeProject — re-run runProjectViaBundle on an existing project
 * directory. The walker's resume short-circuit (walkState completed +
 * outputPath exists) skips finished nodes; the stale-in_progress reap
 * retries anything that was killed mid-flight.
 *
 * Usage:
 *   pnpm exec tsx scripts/resumeProject.ts <project-dir>
 */
import 'dotenv/config';
import { existsSync, readFileSync, statSync, copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProjectViaBundle } from '../src/server/runners/runProjectViaBundle.js';
import { openProjectionEngine } from '../src/dag/eventLog/ProjectionEngine.js';
import { eventLogPath } from '../src/dag/eventLog/eventLogPath.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..');

function banner(t: string): void {
  console.log(`\n${'═'.repeat(76)}\n  ${t}\n${'═'.repeat(76)}`);
}

async function main(): Promise<void> {
  const projectDir = resolve(process.argv[2] ?? '');
  if (!projectDir || !existsSync(join(projectDir, 'project.json'))) {
    console.error(`Usage: tsx scripts/resumeProject.ts <project-dir>`);
    console.error(`(project.json must already exist at that path)`);
    process.exit(2);
  }

  delete process.env['DHEE_DISABLE_CAS'];

  banner(`RESUME — ${projectDir}`);
  const proj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as Record<string, unknown>;
  console.log(`  id:             ${proj['id']}`);
  console.log(`  bundleSource:   ${proj['bundleSource']}`);
  console.log(`  style:          ${proj['style']}`);
  console.log(`  events.jsonl:   ${eventLogPath(projectDir)}`);

  const engine = openProjectionEngine(projectDir);
  const priorEvents = [...engine.log().read()];
  console.log(`  prior events:   ${priorEvents.length}`);

  // Pre-run state summary
  const proj0 = engine.projection();
  const completed = Object.values(proj0.nodes).filter((n) => n.status === 'completed').length;
  const inProg = Object.values(proj0.nodes).filter((n) => n.status === 'in_progress').length;
  console.log(`  walkState:      ${completed} completed, ${inProg} in_progress (will be reaped)`);

  banner('WALK — resuming from where the prior dispatch failed');
  const startMs = Date.now();
  let lastSeq = priorEvents[priorEvents.length - 1]?.seq ?? 0;
  const progressTimer = setInterval(() => {
    const events = [...engine.log().read({ sinceSeq: lastSeq })];
    for (const e of events) {
      if (e.seq <= lastSeq) continue;
      lastSeq = e.seq;
      const p = e.payload as unknown as Record<string, unknown>;
      const nodeId = (p['nodeId'] as string) ?? '';
      const itemId = p['itemId'] ? `:${p['itemId'] as string}` : '';
      const gen = (p['generation'] as { cached?: boolean }) || {};
      const cached = gen.cached === true ? ' (CAS hit)' : '';
      const tag = `[${e.branchId}#${String(e.seq).padStart(3, '0')}]`;
      const elapsedSec = Math.floor((e.ts - startMs) / 1000);
      console.log(`  ${tag} t+${String(elapsedSec).padStart(4)}s  ${e.kind.padEnd(22)} ${nodeId}${itemId}${cached}`);
    }
  }, 2000);

  let result: { ok: boolean; error?: string; finalVideoAbs?: string };
  try {
    result = await runProjectViaBundle({
      projectDir,
      log: () => undefined,
    });
  } finally {
    clearInterval(progressTimer);
  }

  const elapsedTotalSec = Math.floor((Date.now() - startMs) / 1000);

  banner('RESULTS');
  console.log(`  ok:        ${result.ok}`);
  if (result.error) console.log(`  error:     ${result.error}`);
  console.log(`  elapsed:   ${Math.floor(elapsedTotalSec / 60)}m ${elapsedTotalSec % 60}s`);
  if (result.finalVideoAbs && existsSync(result.finalVideoAbs)) {
    const sz = statSync(result.finalVideoAbs).size;
    console.log(`  final:     ${result.finalVideoAbs} (${(sz / (1024 * 1024)).toFixed(2)} MB)`);
    const outDir = join(REPO_ROOT, 'e2e-out');
    mkdirSync(outDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const finalPub = join(outDir, `gayathri_final_${ts}.mp4`);
    copyFileSync(result.finalVideoAbs, finalPub);
    console.log(`  COPIED:    ${finalPub}`);
    console.log(`  open ${finalPub}`);
  }

  const allEvents = [...engine.log().read()];
  const completedEvents = allEvents.filter((e) => e.kind === 'node.completed');
  const cachedEvents = completedEvents.filter((e) => ((e.payload as { generation?: { cached?: boolean } }).generation?.cached) === true);
  const failedEvents = allEvents.filter((e) => e.kind === 'node.failed');
  console.log();
  console.log(`  events:           ${allEvents.length}`);
  console.log(`  completions:      ${completedEvents.length}  (CAS hits: ${cachedEvents.length})`);
  console.log(`  failures:         ${failedEvents.length}`);
  const ledger = engine.computeCostLedger();
  console.log(`  cost:             $${ledger.totalUsd.toFixed(4)}  (savings: $${ledger.estimatedSavingsUsd.toFixed(4)})`);
}

main().catch((err) => {
  console.error('\n✗ resumeProject failed:');
  console.error(err);
  process.exit(1);
});
