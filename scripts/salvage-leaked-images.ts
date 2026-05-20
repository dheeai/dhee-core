#!/usr/bin/env tsx
/**
 * One-off salvage after the run-to session-scoping bug
 * (fixed in 2026-04-21 — run-to.ts now calls setActiveProjectDir).
 *
 * Before the fix, the CLI bootstrap never set the session projectDir, so
 * `submitImageGeneration` downloaded Klein outputs into `default.dhee/`
 * while the executor graph registered paths under the correct project.
 * Each aborted shot_image node produced exactly one valid first_frame
 * before the next step tried to `edit_first_frame` and couldn't find it.
 *
 * This script parses the aborted run's log output, moves the leaked
 * first-frame pngs from `default.dhee/assets/images/` into the target
 * project's `assets/images/`, and writes
 * `outputPaths.first_frame = "assets/images/<name>.png"` on each
 * `shot_image:scene_N_shot_M` node in `project.json`. The executor's
 * incremental-retry guard (ExecutorAgent.ts:4098) will then skip the
 * first_frame on resume and only regen the missing last_frame.
 *
 * Usage:
 *   pnpm tsx scripts/salvage-leaked-images.ts <log-file> <project-name>
 *
 * Example:
 *   pnpm tsx scripts/salvage-leaked-images.ts \
 *     /private/tmp/.../bdmoyghyo.output \
 *     noir_detective_story_setup-3
 */

import { readFileSync, existsSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

const REPO_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const LEAK_DIR = join(REPO_ROOT, 'default.dhee', 'assets', 'images');

function main() {
  const logPath = process.argv[2];
  const projectName = process.argv[3];
  if (!logPath || !projectName) {
    console.error('Usage: salvage-leaked-images.ts <log-file> <project-name>');
    process.exit(1);
  }

  const projectDir = join(REPO_ROOT, `${projectName}.dhee`);
  const projectJsonPath = join(projectDir, 'project.json');
  const assetsDir = join(projectDir, 'assets', 'images');

  if (!existsSync(projectJsonPath)) {
    console.error(`project.json not found: ${projectJsonPath}`);
    process.exit(1);
  }
  mkdirSync(assetsDir, { recursive: true });

  // Parse log: pairs of lines like
  //   "  [info] [N/M] Working on: Shot Images: S1 Shot 3: ..."
  //   "    → assets/images/abc123.png"
  const log = readFileSync(logPath, 'utf-8');
  const lines = log.split('\n');
  const mappings: Array<{ shotId: string; filename: string }> = [];
  let pendingShot: string | null = null;

  for (const line of lines) {
    const shotMatch = line.match(/Working on: Shot Images: S(\d+) Shot (\d+):/);
    if (shotMatch) {
      pendingShot = `scene_${shotMatch[1]}_shot_${shotMatch[2]}`;
      continue;
    }
    const fileMatch = line.match(/→ assets\/images\/(\S+\.png)/);
    if (fileMatch && pendingShot) {
      mappings.push({ shotId: pendingShot, filename: fileMatch[1]! });
      pendingShot = null;
    }
    // Reset on error so we don't bind the next file to the wrong shot
    if (line.includes('[error]')) {
      pendingShot = null;
    }
  }

  console.log(`Parsed ${mappings.length} shot→file mapping(s) from log`);

  const project = JSON.parse(readFileSync(projectJsonPath, 'utf-8'));
  const nodes = project.executorState?.nodes ?? {};

  let moved = 0;
  let skipped = 0;
  let patched = 0;

  for (const { shotId, filename } of mappings) {
    const leakedPath = join(LEAK_DIR, filename);
    const targetPath = join(assetsDir, filename);
    const nodeId = `shot_image:${shotId}`;
    const node = nodes[nodeId];

    if (!node) {
      console.warn(`  [skip] no node ${nodeId} in project.json`);
      skipped++;
      continue;
    }

    if (!existsSync(leakedPath)) {
      if (existsSync(targetPath)) {
        console.log(`  [already-moved] ${filename} already in target dir`);
      } else {
        console.warn(`  [skip] leaked file missing: ${leakedPath}`);
        skipped++;
        continue;
      }
    } else {
      renameSync(leakedPath, targetPath);
      console.log(`  [move] ${filename} → ${projectName}.dhee/assets/images/`);
      moved++;
    }

    const relPath = `assets/images/${filename}`;
    node.outputPaths = node.outputPaths ?? {};
    if (node.outputPaths.first_frame === relPath) {
      console.log(`    [patch] outputPaths.first_frame already set on ${nodeId}`);
    } else {
      node.outputPaths.first_frame = relPath;
      patched++;
      console.log(`    [patch] ${nodeId}.outputPaths.first_frame = ${relPath}`);
    }
  }

  writeFileSync(projectJsonPath, JSON.stringify(project, null, 2));
  console.log('');
  console.log(`Done. Moved ${moved}, patched ${patched} node(s), skipped ${skipped}.`);
  console.log(`Re-run:  pnpm run-to ${projectName} shot_image`);
  console.log('Incremental-retry guard will skip first_frames and only regen last_frames.');
}

main();
