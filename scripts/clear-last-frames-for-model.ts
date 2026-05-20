#!/usr/bin/env tsx
/**
 * Surgical reset: clear only the last_frame outputs that were generated
 * by a specific model, so the next pipeline run regenerates them with
 * whatever model is currently active — without touching first_frames or
 * shots edited by other models.
 *
 * Useful after reverting a model preference. Example:
 *   - Grok was producing edit_first_frame outputs
 *   - We flip Grok off and want Klein to re-do those edits
 *   - We DO NOT want to re-run the Klein first-frame generations that
 *     are already correct and cost money
 *
 * Behavior:
 *   - For each shot_image:scene_N_shot_M node whose outputPaths.last_frame
 *     (or .mid_frame) filename contains the model tag (`_<model>_`):
 *       - Delete the file from disk
 *       - Remove outputPaths.last_frame (and mid_frame)
 *       - Set status = 'pending' so the executor will re-execute
 *   - first_frame, node dependencies, and everything else stay intact.
 *
 * Usage:
 *   pnpm tsx scripts/clear-last-frames-for-model.ts <project> <modelTag>
 *
 * Example:
 *   pnpm tsx scripts/clear-last-frames-for-model.ts noir_detective_story_setup-3 grok
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, resolve, dirname } from 'path';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function main() {
  const [, , projectArg, modelTagArg] = process.argv;
  if (!projectArg || !modelTagArg) {
    console.error('Usage: pnpm tsx scripts/clear-last-frames-for-model.ts <project> <modelTag>');
    process.exit(1);
  }
  const projectName = projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`;
  const projectDir = join(REPO_ROOT, projectName);
  const jsonPath = join(projectDir, 'project.json');
  if (!existsSync(jsonPath)) {
    console.error(`project.json not found: ${jsonPath}`);
    process.exit(1);
  }

  const tag = `_${modelTagArg}_`; // e.g. "_grok_"
  const project = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  const nodes = project.executorState?.nodes ?? {};

  let clearedFrames = 0, deletedFiles = 0, nodesReset = 0;
  const framesToCheck = ['last_frame', 'mid_frame']; // first_frame intentionally excluded

  for (const [nodeId, node] of Object.entries(nodes) as Array<[string, any]>) {
    if (!nodeId.startsWith('shot_image:scene_')) continue;
    if (!node.outputPaths) continue;
    let touched = false;
    for (const frameId of framesToCheck) {
      const path = node.outputPaths[frameId];
      if (!path || !path.includes(tag)) continue;
      const fullPath = join(projectDir, path);
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
        deletedFiles++;
      }
      delete node.outputPaths[frameId];
      clearedFrames++;
      touched = true;
      console.log(`  ${nodeId}: cleared ${frameId} (${path.split('/').pop()})`);
    }
    if (touched) {
      node.status = 'pending';
      node.error = undefined;
      nodesReset++;
    }
  }

  writeFileSync(jsonPath, JSON.stringify(project, null, 2));
  console.log('');
  console.log(`Cleared ${clearedFrames} frame(s), deleted ${deletedFiles} file(s), reset ${nodesReset} node(s) to pending.`);
  console.log('Next pipeline run will regenerate only these last_frames using the currently-active image_editing workflow.');
}

main();
