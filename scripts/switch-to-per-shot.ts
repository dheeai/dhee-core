#!/usr/bin/env tsx
/**
 * One-off migration: switch a project from prompt-relay to per-shot
 * video generation, in a way that preserves existing first_frames and
 * only regenerates the missing last_frames.
 *
 * What it does:
 *   1. For every completed `shot_image:*` node:
 *      - If `outputPath` is set but `outputPaths` is null/missing,
 *        populate `outputPaths.first_frame = outputPath`. This is the
 *        prompt-relay legacy shape — the executor's per-frame
 *        incremental-retry logic only checks `outputPaths`.
 *      - Mark status='pending' (so the executor re-fires the node).
 *      - Clear startedAt/completedAt/error/artifactId.
 *      - Leave `outputPaths.first_frame` intact so the executor
 *        skips first_frame regen on re-run.
 *   2. For every completed `shot_video:*` node: mark pending and
 *      clear outputPath/outputPaths/etc. The new per-shot videos
 *      need to be regenerated from the new last_frames.
 *
 * After running this, the user needs to:
 *   - Set `dhee_VIDEO_STRATEGY=per_shot` in .env (uncomment it)
 *   - `pnpm run-to <project> final_video`
 *
 * The executor will:
 *   - For each shot_image: see first_frame in outputPaths, skip it,
 *     generate ONLY last_frame (and any other missing frames).
 *   - For each shot_video: render via per-shot FLFV from first+last.
 *   - Re-assemble final_video.
 *
 * Usage:
 *   pnpm tsx scripts/switch-to-per-shot.ts <project>
 *   pnpm tsx scripts/switch-to-per-shot.ts sun_hadnt_yet_cleared-2
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';

const projectArg = process.argv[2];
if (!projectArg) {
  console.error('Usage: pnpm tsx scripts/switch-to-per-shot.ts <project>');
  process.exit(1);
}

const projectDir = resolve(
  process.cwd(),
  projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`,
);
const projectPath = join(projectDir, 'project.json');
if (!existsSync(projectPath)) {
  console.error(`Project not found: ${projectPath}`);
  process.exit(1);
}

interface NodeShape {
  status?: string;
  outputPath?: string;
  outputPaths?: Record<string, string> | null;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  artifactId?: string;
  typeId?: string;
}

const project = JSON.parse(readFileSync(projectPath, 'utf-8'));
const nodes: Record<string, NodeShape> = project.executorState?.nodes ?? {};
if (Object.keys(nodes).length === 0) {
  console.error('No executor state found in project');
  process.exit(1);
}

let imageMigrated = 0;
let imageReset = 0;
let videoReset = 0;
let finalReset = 0;
const samples: string[] = [];

for (const [nid, node] of Object.entries(nodes)) {
  if (node.typeId === 'final_video' && node.status === 'completed') {
    // Without this, run-to sees final_video already complete and
    // exits early without firing the pending shot_image / shot_video
    // upstream nodes. Reset it so the executor walks the dep graph
    // properly.
    node.status = 'pending';
    node.outputPath = undefined;
    node.outputPaths = undefined;
    node.startedAt = undefined;
    node.completedAt = undefined;
    node.error = undefined;
    node.artifactId = undefined;
    finalReset++;
    continue;
  }
  if (node.typeId === 'shot_image' && node.status === 'completed') {
    // Populate outputPaths.first_frame from outputPath if missing.
    if (node.outputPath && (!node.outputPaths || !node.outputPaths['first_frame'])) {
      const op: Record<string, string> = node.outputPaths ?? {};
      op['first_frame'] = node.outputPath;
      node.outputPaths = op;
      imageMigrated++;
      if (samples.length < 3) samples.push(`${nid} → outputPaths.first_frame=${node.outputPath}`);
    }
    // Mark pending; preserve outputPaths so per-frame incremental
    // retry skips first_frame and only generates last_frame.
    node.status = 'pending';
    node.startedAt = undefined;
    node.completedAt = undefined;
    node.error = undefined;
    node.artifactId = undefined;
    imageReset++;
  } else if (node.typeId === 'shot_video' && node.status === 'completed') {
    // Per-shot videos must regenerate from the new first+last frames.
    node.status = 'pending';
    node.outputPath = undefined;
    node.outputPaths = undefined;
    node.startedAt = undefined;
    node.completedAt = undefined;
    node.error = undefined;
    node.artifactId = undefined;
    videoReset++;
  }
}

// Bump executor state's updatedAt so the executor knows things changed.
if (project.executorState) {
  project.executorState.completedAt = undefined;
  project.executorState.updatedAt = Date.now();
}

writeFileSync(projectPath, JSON.stringify(project, null, 2));

console.log(`shot_image: ${imageReset} reset to pending (${imageMigrated} migrated outputPath → outputPaths.first_frame)`);
for (const s of samples) console.log(`  ${s}`);
console.log(`shot_video: ${videoReset} reset to pending`);
console.log(`final_video: ${finalReset} reset to pending`);
console.log('');
console.log('Next:');
console.log('  1. Edit .env: uncomment dhee_VIDEO_STRATEGY=per_shot');
console.log(`  2. pnpm run-to ${projectArg.replace(/\.dhee$/, '')} final_video`);
console.log('');
console.log('The executor will skip first_frame regen on each shot_image and only generate the missing last_frame, then per-shot FLFV will render new videos.');
