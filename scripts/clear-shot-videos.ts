#!/usr/bin/env tsx
/**
 * Surgical reset: clear specific shot_video outputs (delete file + reset
 * graph node) so only those are regenerated on the next pipeline run.
 *
 * Usage:
 *   pnpm tsx scripts/clear-shot-videos.ts <project> <shotId> [<shotId> ...]
 *
 * Example:
 *   pnpm tsx scripts/clear-shot-videos.ts noir_detective_story_setup-3 \
 *     scene_1_shot_1 scene_2_shot_5 scene_2_shot_8
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function main() {
  const [, , projectArg, ...shotIds] = process.argv;
  if (!projectArg || shotIds.length === 0) {
    console.error('Usage: pnpm tsx scripts/clear-shot-videos.ts <project> <shotId> ...');
    process.exit(1);
  }
  const name = projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`;
  const projectDir = join(REPO_ROOT, name);
  const jsonPath = join(projectDir, 'project.json');
  const project = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const nodes = project.executorState?.nodes ?? {};
  let resets = 0, deletions = 0;
  for (const shotId of shotIds) {
    const nid = `shot_video:${shotId}`;
    const node = nodes[nid];
    if (!node) {
      console.warn(`  ${nid}: node not found in project.json`);
      continue;
    }
    const p = node.outputPath;
    if (p) {
      const full = join(projectDir, p);
      if (existsSync(full)) {
        unlinkSync(full);
        console.log(`  deleted ${p}`);
        deletions++;
      }
    }
    node.outputPath = undefined;
    node.status = 'pending';
    node.error = undefined;
    resets++;
    console.log(`  reset ${nid} → pending`);
  }
  // Also reset final_video since its inputs changed
  const fv = nodes['final_video'];
  if (fv && fv.status === 'completed') {
    fv.status = 'pending';
    fv.error = undefined;
    console.log('  reset final_video → pending (will re-assemble)');
  }
  writeFileSync(jsonPath, JSON.stringify(project, null, 2));
  console.log(`\nReset ${resets} shot_video node(s), deleted ${deletions} file(s).`);
}

main();
