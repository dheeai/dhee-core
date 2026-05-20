#!/usr/bin/env tsx
/**
 * Retrofit shot durations on existing scene_video_prompt JSONs.
 *
 * Applies `fitShotDurations` (same pass that runs live inside
 * `validateJsonOutput`) to every scene_N.json file on disk. No LLM
 * call — purely deterministic: scans each shot's `audio` field for
 * dialogue, computes min duration, bumps if short.
 *
 * Use this to fix an existing project's durations without paying to
 * regenerate the whole scene_video_prompt stage. For new runs, the
 * validator catches this at generation time automatically.
 *
 * Usage:
 *   pnpm tsx scripts/fit-shot-durations.ts <project_dir>             # dry run
 *   pnpm tsx scripts/fit-shot-durations.ts <project_dir> --write     # save back to disk
 *
 * Exit 0 on success, 1 on usage error. Dry runs always exit 0 — it's
 * safe to run as a sanity check.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { fitShotDurations, type ShotLike } from '../src/core/planner/shotDurationFit.js';

const projectDir = process.argv[2];
const writeBack = process.argv.includes('--write');
if (!projectDir) {
  console.error('Usage: pnpm tsx scripts/fit-shot-durations.ts <project_dir> [--write]');
  process.exit(1);
}

const sceneDir = join(projectDir, 'prompts', 'videos', 'scenes');
if (!existsSync(sceneDir)) {
  console.error(`No scene_video_prompt dir at ${sceneDir}`);
  process.exit(1);
}

interface Report {
  file: string;
  adjustments: Array<{
    shotNumber: number;
    from: number;
    to: number;
    dialogueSeconds: number;
    audioPreview: string;
  }>;
}

const reports: Report[] = [];
let totalAdjustments = 0;
let totalAddedSeconds = 0;

for (const f of readdirSync(sceneDir).sort()) {
  // Skip state files — only touch the LLM-written scene breakdowns.
  if (!/^scene_\d+\.json$/.test(f)) continue;

  const filePath = join(sceneDir, f);
  let raw: string;
  let parsed: { shots?: ShotLike[] };
  try {
    raw = readFileSync(filePath, 'utf-8').trim();
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    parsed = JSON.parse(raw);
  } catch (e) {
    console.warn(`  skip ${f}: ${(e as Error).message}`);
    continue;
  }

  if (!Array.isArray(parsed.shots)) continue;

  // Keep audio snippets for reporting BEFORE mutation (fitShotDurations
  // mutates shot.duration in place; audio itself is untouched but we
  // grab it while we're here for the pretty print).
  const audioByShot = new Map<number, string>();
  for (const s of parsed.shots) {
    if (typeof s.shotNumber === 'number') {
      audioByShot.set(s.shotNumber, typeof s.audio === 'string' ? s.audio : '');
    }
  }

  const adjustments = fitShotDurations(parsed.shots);
  if (adjustments.length === 0) continue;

  const report: Report = { file: f, adjustments: [] };
  for (const adj of adjustments) {
    const audio = audioByShot.get(adj.shotNumber) ?? '';
    report.adjustments.push({
      shotNumber: adj.shotNumber,
      from: adj.from,
      to: adj.to,
      dialogueSeconds: adj.dialogueSeconds,
      audioPreview: audio.length > 80 ? audio.slice(0, 77) + '...' : audio,
    });
    totalAddedSeconds += adj.to - adj.from;
  }
  totalAdjustments += adjustments.length;
  reports.push(report);

  if (writeBack) {
    writeFileSync(filePath, JSON.stringify(parsed, null, 2));
  }
}

// ── Report ──
console.log(`\nProject: ${projectDir}`);
console.log(`Scene files scanned: ${readdirSync(sceneDir).filter(f => /^scene_\d+\.json$/.test(f)).length}`);
console.log(`Shots adjusted: ${totalAdjustments}`);
console.log(`Total seconds added: ${totalAddedSeconds}`);
console.log();

if (reports.length === 0) {
  console.log('All shot durations already fit their dialogue. Nothing to do.');
} else {
  for (const r of reports) {
    console.log(`${r.file}:`);
    for (const a of r.adjustments) {
      console.log(`  shot ${a.shotNumber}: ${a.from}s → ${a.to}s (dialogue ≈ ${a.dialogueSeconds}s)`);
      if (a.audioPreview) console.log(`    audio: ${a.audioPreview}`);
    }
  }
}

console.log();
if (writeBack) {
  console.log(`✓ Wrote ${reports.length} file(s) back to disk.`);
  console.log(`  Next: reset downstream stages so the new durations propagate through shot_video generation:`);
  console.log(`    pnpm reset ${projectDir.replace(/\.dhee$/, '')} shot_video`);
} else {
  console.log(`(dry run — pass --write to save changes to disk)`);
}
