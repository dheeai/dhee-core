#!/usr/bin/env tsx
/**
 * cloneAndRunGayathri — clones the Gayathri project's story input into
 * a fresh project dir, points it at the narrative_qwen_chain_review
 * bundle (reviewLoopMax: 3), and runs it end-to-end through the
 * PRODUCTION walker against the user's local ComfyUI.
 *
 * This is the real-deal validation:
 *   - real LLM calls (DeepSeek V4 Flash via OpenRouter)
 *   - real Klein image generation via local Comfy (zrok endpoint)
 *   - real Qwen Edit chain for shot continuity
 *   - real LTX-2.3 video synthesis
 *   - real VLM judge review loop (up to 3 attempts per shot)
 *   - all flowing through the new event-sourced architecture
 *
 * Project name: gayathri_relay_<timestamp>
 * Story: Lara Croft cave (the existing Gayathri input)
 * Style: anime
 * Target: 60s
 *
 * Run:
 *   pnpm exec tsx scripts/cloneAndRunGayathri.ts
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runProjectViaBundle } from '../src/server/runners/runProjectViaBundle.js';
import { openProjectionEngine } from '../src/dag/eventLog/ProjectionEngine.js';
import { eventLogPath } from '../src/dag/eventLog/eventLogPath.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const SOURCE_PROJECT = '/Users/ganaraj/dhee-studios/Gayathri';
const REPO_ROOT = join(__dirname, '..');

function banner(t: string): void {
  const w = 76;
  console.log(`\n${'═'.repeat(w)}\n  ${t}\n${'═'.repeat(w)}`);
}

function sub(t: string): void {
  console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 68 - t.length))}`);
}

async function main(): Promise<void> {
  // 1. Clone the project — copy ONLY the story input. The walker will
  //    regenerate everything else (plot, characters, scenes, images,
  //    videos) using the bundle.
  const storyPath = join(SOURCE_PROJECT, 'original_input.md');
  if (!existsSync(storyPath)) {
    throw new Error(`Source Gayathri story not found at ${storyPath}`);
  }
  const story = readFileSync(storyPath, 'utf-8');

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const newProjectDir = join(REPO_ROOT, 'e2e-out', `gayathri_relay_${ts}`);
  mkdirSync(newProjectDir, { recursive: true });
  mkdirSync(join(newProjectDir, 'inputs'), { recursive: true });
  writeFileSync(join(newProjectDir, 'inputs', 'story.md'), story);

  // Match source project metadata.
  const sourceMeta = JSON.parse(readFileSync(join(SOURCE_PROJECT, 'project.json'), 'utf-8')) as {
    style?: string;
    targetDuration?: number;
  };

  const projectJson = {
    id: `gayathri-relay-${ts}`,
    bundleSource: 'built-in:narrative_klein_relay_review',
    style: sourceMeta.style ?? 'anime',
    targetDuration: sourceMeta.targetDuration ?? 60,
    title: 'Gayathri (relay test)',
    clonedFrom: SOURCE_PROJECT,
    createdAt: new Date().toISOString(),
  };
  writeFileSync(join(newProjectDir, 'project.json'), JSON.stringify(projectJson, null, 2));

  banner('CLONE — Gayathri → narrative_qwen_chain_review (reviewLoopMax=3)');
  console.log(`  source story:    ${storyPath}`);
  console.log(`  new project dir: ${newProjectDir}`);
  console.log(`  style:           ${projectJson.style}`);
  console.log(`  targetDuration:  ${projectJson.targetDuration}s`);
  console.log(`  bundle:          ${projectJson.bundleSource}`);
  console.log(`  Comfy endpoint:  ${process.env['ENDPOINT_self_local'] ?? process.env['COMFYUI_BASE_URL'] ?? '(none)'}`);
  console.log();
  console.log('  STORY:');
  console.log('  ' + story.split('\n').join('\n  '));

  // 2. Make sure CAS is enabled (production runs use it).
  delete process.env['DHEE_DISABLE_CAS'];

  // 3. Use the shared global CAS (~/.kshana/cache) so re-runs after
  //    failures hit cached LLM artifacts and don't re-pay. Each
  //    individual project still has its own .dhee/events.jsonl
  //    inside its dir.
  delete process.env['DHEE_CACHE_ROOT'];
  console.log(`  CAS root:        ~/.kshana/cache (shared global)`);
  console.log();

  // 4. Run.
  banner('WALK — production runProjectViaBundle (real LLM + real Comfy + real LTX)');
  const startMs = Date.now();
  const engine = openProjectionEngine(newProjectDir);
  // Print event-stream progress in real time by polling the engine.
  // Walker emits node.started/completed as it runs; we just narrate.
  let lastSeq = 0;
  const progressTimer = setInterval(() => {
    const events = [...engine.log().read({ sinceSeq: lastSeq })];
    for (const e of events) {
      if (e.seq <= lastSeq) continue;
      lastSeq = e.seq;
      const p = e.payload as unknown as Record<string, unknown>;
      const nodeId = (p['nodeId'] as string) ?? '';
      const itemId = p['itemId'] ? `:${p['itemId'] as string}` : '';
      const cached = (p['generation'] as { cached?: boolean })?.cached === true ? ' (CAS hit)' : '';
      const tag = `[${e.branchId}#${String(e.seq).padStart(3, '0')}]`;
      const elapsedSec = Math.floor((e.ts - startMs) / 1000);
      console.log(`  ${tag} t+${String(elapsedSec).padStart(4)}s  ${e.kind.padEnd(22)} ${nodeId}${itemId}${cached}`);
    }
  }, 2000);

  let result: { ok: boolean; error?: string; finalVideoAbs?: string };
  try {
    result = await runProjectViaBundle({
      projectDir: newProjectDir,
      log: () => undefined, // quiet — the event stream above is the narration
    });
  } finally {
    clearInterval(progressTimer);
  }

  const elapsedTotalSec = Math.floor((Date.now() - startMs) / 1000);

  banner('RESULTS');
  console.log(`  ok:        ${result.ok}`);
  if (result.error) console.log(`  error:     ${result.error}`);
  console.log(`  elapsed:   ${Math.floor(elapsedTotalSec / 60)}m ${elapsedTotalSec % 60}s`);
  if (result.finalVideoAbs) {
    console.log(`  final:     ${result.finalVideoAbs}`);
    if (existsSync(result.finalVideoAbs)) {
      const sz = statSync(result.finalVideoAbs).size;
      console.log(`             ${(sz / (1024 * 1024)).toFixed(2)} MB`);
    }
  }

  const allEvents = [...engine.log().read()];
  const ledger = engine.computeCostLedger();
  const branches = engine.computeBranchTree();
  const completedEvents = allEvents.filter((e) => e.kind === 'node.completed');
  const cachedEvents = completedEvents.filter((e) => ((e.payload as { generation?: { cached?: boolean } }).generation?.cached) === true);
  const failedEvents = allEvents.filter((e) => e.kind === 'node.failed');
  const reviewIterations = allEvents.filter((e) => e.kind === 'node.invalidated').length;

  sub('Event log summary');
  console.log(`  total events:        ${allEvents.length}`);
  console.log(`  node.completed:      ${completedEvents.length}`);
  console.log(`    of which cached:   ${cachedEvents.length}`);
  console.log(`  node.failed:         ${failedEvents.length}`);
  console.log(`  invalidations:       ${reviewIterations} (review-loop iterations)`);
  console.log(`  branches:            ${branches.branches.length}`);

  sub('Cost ledger (main branch)');
  console.log(`  total spend:         $${ledger.totalUsd.toFixed(4)}`);
  console.log(`  compute count:       ${ledger.computeCount}`);
  console.log(`  cache hits:          ${ledger.cacheHits}`);
  console.log(`  est. savings:        $${ledger.estimatedSavingsUsd.toFixed(4)}`);

  sub('Event log location');
  console.log(`  ${eventLogPath(newProjectDir)}`);

  sub('Project files');
  console.log(`  ${newProjectDir}`);
  console.log();
  if (result.ok && result.finalVideoAbs && existsSync(result.finalVideoAbs)) {
    const outDir = join(REPO_ROOT, 'e2e-out');
    const finalPub = join(outDir, `gayathri_relay_final_${ts}.mp4`);
    copyFileSync(result.finalVideoAbs, finalPub);
    console.log(`  COPIED FINAL → ${finalPub}`);
    console.log(`  open ${finalPub}`);
  }
}

main().catch((err) => {
  console.error('\n✗ Gayathri relay run failed:');
  console.error(err);
  process.exit(1);
});
