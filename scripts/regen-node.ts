#!/usr/bin/env tsx
/**
 * Regenerate one specific node (and, by default, its downstream consumers).
 *
 * Usage:
 *   pnpm regen <project> <node-id-or-alias> [--cascade] [--no-run] \
 *              [--frame=<first_frame|last_frame|mid_frame>] [--scope=<prompt|image_only>]
 *
 * Examples:
 *   pnpm regen myproj shot_image_prompt:scene_2_shot_3   # exact id, full reset
 *   pnpm regen myproj scene_2_shot_3.prompt              # alias
 *   pnpm regen myproj scene_2.svp                        # regen scene 2's video prompt
 *   pnpm regen myproj scene_2.svp --cascade              # also reset every node downstream
 *
 *   # Surgical-frame regen (mirrors ExecutorAgent.redoNode dispatch).
 *   # Drops just the named frame from outputPaths, keeps the others,
 *   # and cascades only to ALREADY-COMPLETED downstream so in-flight /
 *   # pending work isn't disturbed.
 *   pnpm regen myproj shot_image:scene_2_shot_3 --frame=last_frame --scope=image_only
 *
 *   # Prompt re-roll: invalidate shot_image_prompt + shot_image together,
 *   # cascade-only-completed to dirty downstream video.
 *   pnpm regen myproj scene_2_shot_3.prompt --scope=prompt
 *
 * Default (no --frame / --scope): full node reset + cascade=true (mirrors
 * the original kshana_regen contract).
 *
 * --cascade: explicit form of the default downstream walk.
 * --no-run:  reset only, exit without spawning run-to.
 */
import { readFileSync } from 'fs';
import { atomicWriteFileSync } from '../src/utils/atomicWrite.js';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { loadProjectStrict, resolveNodeId, type ExecutionNode } from './cli-helpers.js';
import { applyInvalidation } from '../src/core/planner/applyInvalidation.js';
import type { ExecutorState } from '../src/core/project/projectTypes.js';

type FrameKey = 'first_frame' | 'last_frame' | 'mid_frame';
type Scope = 'prompt' | 'image_only';

function parseFlag(arg: string, key: string): string | null {
  const prefix = `--${key}=`;
  if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  if (arg === `--${key}`) return ''; // bare flag with no value
  return null;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2 || argv[0] === '--help' || argv[0] === '-h') {
    console.error(
      'Usage: pnpm regen <project> <node-id-or-alias> [--cascade] [--no-run] [--frame=<frame>] [--scope=<prompt|image_only>]',
    );
    process.exit(argv[0] === '--help' || argv[0] === '-h' ? 0 : 1);
  }
  const positional: string[] = [];
  let cascade = false;
  let noRun = false;
  let frame: FrameKey | undefined;
  let scope: Scope | undefined;
  for (const a of argv) {
    if (a === '--cascade') {
      cascade = true;
      continue;
    }
    if (a === '--no-run') {
      noRun = true;
      continue;
    }
    const frameVal = parseFlag(a, 'frame');
    if (frameVal !== null) {
      if (frameVal !== 'first_frame' && frameVal !== 'last_frame' && frameVal !== 'mid_frame') {
        console.error(
          `--frame must be one of: first_frame, last_frame, mid_frame (got "${frameVal}")`,
        );
        process.exit(1);
      }
      frame = frameVal;
      continue;
    }
    const scopeVal = parseFlag(a, 'scope');
    if (scopeVal !== null) {
      if (scopeVal !== 'prompt' && scopeVal !== 'image_only') {
        console.error(
          `--scope must be one of: prompt, image_only (got "${scopeVal}")`,
        );
        process.exit(1);
      }
      scope = scopeVal;
      continue;
    }
    if (!a.startsWith('--')) positional.push(a);
  }
  const [projectName, alias] = positional as [string, string];

  const { project, projectDir } = loadProjectStrict(projectName);
  const state = project.executorState;
  if (!state || !state.nodes) {
    console.error(`No executor state. Run \`pnpm run-to ${projectName}\` first.`);
    process.exit(1);
  }

  const nodeId = resolveNodeId(state, alias);
  if (!nodeId) {
    console.error(`No matching node for alias: "${alias}"`);
    process.exit(1);
  }

  // ── Dispatch to applyInvalidation. The mode argument matrix mirrors
  // ExecutorAgent.redoNode (src/core/planner/ExecutorAgent.ts:1041).
  // Without flags we get the historical contract (full reset + cascade);
  // with --frame / --scope we route to the surgical paths.
  const projectLike = project as Parameters<typeof applyInvalidation>[0];
  let surgicalLog = '';

  if (scope === 'prompt') {
    // Re-roll prompt: invalidate shot_image_prompt + shot_image together,
    // cascade-only-completed so downstream video that consumed the old
    // image flips to pending.
    const shotImageNodeId = nodeId.startsWith('shot_image_prompt:')
      ? nodeId.replace('shot_image_prompt:', 'shot_image:')
      : nodeId.startsWith('shot_image:')
        ? nodeId
        : null;
    if (!shotImageNodeId) {
      console.error(
        `--scope=prompt requires a shot_image_prompt:* or shot_image:* node (got "${nodeId}")`,
      );
      process.exit(1);
    }
    const promptNodeId = shotImageNodeId.replace('shot_image:', 'shot_image_prompt:');
    applyInvalidation(projectLike, [promptNodeId], { cascade: false });
    applyInvalidation(projectLike, [shotImageNodeId], {
      cascade: true,
      cascadeOnlyCompleted: true,
    });
    surgicalLog = `Redo prompt: invalidated ${promptNodeId} + ${shotImageNodeId} (cascade to completed downstream)`;
  } else if (scope === 'image_only' || frame) {
    // Surgical-image redo. For first_frame: clear all frames (mid/last
    // derive from first). For last_frame / mid_frame: preserve the
    // other frames so the executor's incremental-retry path reuses them.
    const preserveOthers = frame === 'last_frame' || frame === 'mid_frame';
    applyInvalidation(projectLike, [nodeId], {
      cascade: true,
      cascadeOnlyCompleted: true,
      ...(preserveOthers
        ? { preserveFramesOther: true, singleFrame: frame }
        : {}),
    });
    surgicalLog = `Redo image_only${frame ? ` [frame=${frame}]` : ''}: invalidated ${nodeId} (cascade to completed downstream${preserveOthers ? `, preserving frames other than ${frame}` : ''})`;
  } else {
    // Legacy contract: full reset of the node and (if --cascade) its
    // transitive downstream cone. Implemented in-place here rather than
    // via applyInvalidation because the older form clears every
    // dependent (not just completed ones) and reports per-node detail.
    const targets: string[] = [nodeId];
    if (cascade) {
      const seen = new Set<string>([nodeId]);
      const queue = [nodeId];
      while (queue.length > 0) {
        const cur = queue.shift()!;
        const node = state.nodes[cur]!;
        for (const child of node.dependents ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          queue.push(child);
          targets.push(child);
        }
      }
    }
    console.log(`Regenerating ${targets.length} node(s):`);
    for (const id of targets) {
      const node = state.nodes[id] as ExecutionNode | undefined;
      if (!node) continue;
      console.log(`  · ${id} (was: ${node.status})`);
      node.status = 'pending';
      delete node.outputPath;
      delete node.error;
      delete node.startedAt;
      delete node.completedAt;
    }
  }

  // Persist updated state to project.json. When surgical paths are used,
  // applyInvalidation mutates state.nodes in-place (the same Map-like
  // object loaded by loadProjectStrict), so writing the project record
  // back is enough.
  const projectJsonPath = join(projectDir, 'project.json');
  const raw = readFileSync(projectJsonPath, 'utf-8');
  const obj = JSON.parse(raw) as Record<string, unknown>;
  const persistedState = (project.executorState ?? state) as ExecutorState;
  (obj['executorState'] as { nodes: Record<string, ExecutionNode> }).nodes =
    persistedState.nodes;
  // applyInvalidation also writes `lastInvalidatedIds`; preserve it.
  const lastInvalidatedIds = (persistedState as unknown as {
    lastInvalidatedIds?: string[];
  }).lastInvalidatedIds;
  if (lastInvalidatedIds) {
    (obj['executorState'] as unknown as {
      lastInvalidatedIds?: string[];
    }).lastInvalidatedIds = lastInvalidatedIds;
  }
  atomicWriteFileSync(projectJsonPath, JSON.stringify(obj, null, 2));
  if (surgicalLog) console.log(surgicalLog);
  console.log(`Wrote updated state to ${projectJsonPath}`);

  if (noRun) {
    console.log('');
    console.log('--no-run was set; exiting without running.');
    return;
  }

  // Hand off to run-to.
  console.log('');
  console.log(`Running pipeline to final_video...`);
  const res = spawnSync('pnpm', ['run-to', projectName], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  process.exit(res.status ?? 0);
}

main();
