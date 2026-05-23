#!/usr/bin/env tsx
/**
 * Run the pipeline up to a stage, then pause — CLI counterpart of the
 * `/run-to <stage>` slash command.
 *
 * Thin wrapper around `runExecutor` (src/server/runners/runExecutor.ts) —
 * the same in-process runner the desktop uses. Keeping this CLI on the
 * canonical runner means "works in pnpm run-to" ⇔ "works in the desktop"
 * by construction, not coincidence.
 *
 * Usage:
 *   pnpm run-to <project> [stage] [--skip-media]
 *
 * Examples:
 *   pnpm run-to lazarus_drive character_image                 # gate at stage
 *   pnpm run-to lazarus_drive scene_video_prompt --skip-media # prompts only
 *   pnpm run-to lazarus_drive                                 # to completion
 *
 * Exit codes:
 *   0 — complete or paused_at_stage (state persisted, safe to resume)
 *   1 — failed, cancelled, or argument error
 */

import 'dotenv/config';
import { resolve, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import { VALID_STAGES } from '../src/core/planner/stages.js';
import { runExecutor } from '../src/server/runners/runExecutor.js';
import type { GenericProjectFile } from '../src/core/templates/types.js';

function usage(exitCode = 1): never {
  console.log(`
Usage: pnpm run-to <project> [stage] [--skip-media]

  <project>     project name (folder: <project>.dhee)
  [stage]       optional — pause after this stage completes. Omit to run to final_video.
  --skip-media  skip ComfyUI calls (LLM prompts only). Useful for iterating on prompts.

Valid stages: ${VALID_STAGES.join(', ')}

Examples:
  pnpm run-to lazarus_drive character_image
  pnpm run-to lazarus_drive scene_video_prompt --skip-media
  pnpm run-to lazarus_drive                         # run to completion (no gate)
`);
  process.exit(exitCode);
}

/**
 * Parse argv into { projectName, target, skipMedia }.
 * `target` is either a stage typeId (`shot_image`), a full node id
 * (`shot_image:scene_1_shot_1`), or null (no gate).
 *
 * Exported so the unit test can exercise the parsing independently of
 * actually spawning the executor.
 */
export function parseArgs(argv: string[]): {
  projectName: string;
  target: string | null;
  skipMedia: boolean;
} {
  // Accept `--skip-media` or `-s` as a flag anywhere after positional args.
  const skipMedia = argv.includes('--skip-media') || argv.includes('-s');
  const positional = argv.filter(a => !a.startsWith('-'));

  if (positional.length < 1 || positional.length > 2) {
    throw new Error(`Expected 1 or 2 positional args (project [stage|node]); got ${positional.length}`);
  }

  const projectName = positional[0]!;
  const target = positional[1] ?? null;

  // Validation deferred to main(): a stage typeId is checked here, but
  // a node-id/alias needs the project's executorState to resolve.
  if (target !== null && !VALID_STAGES.includes(target) && !target.includes(':') && !target.includes('.')) {
    throw new Error(
      `Unknown target: '${target}'. Expected a stage (${VALID_STAGES.join(', ')}) or a node id like 'shot_image:scene_1_shot_1' or alias like 'scene_1_shot_1.image'.`,
    );
  }

  return { projectName, target, skipMedia };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    usage(0);
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(args);
  } catch (err) {
    console.error(`Error: ${(err as Error).message}\n`);
    usage(1);
  }

  const { projectName, target, skipMedia } = parsed;
  const projectDir = resolve(`${projectName}.dhee`);
  if (!existsSync(projectDir)) {
    console.error(`Project not found: ${projectDir}`);
    process.exit(1);
  }

  // SessionContext is pinned to this project by `runExecutor` (see
  // src/server/runners/runExecutor.ts) — it calls `setActiveProjectDir`
  // internally so we don't need to do it here. (An older version of
  // this script imported the helper directly; the import got removed
  // in a refactor but the call survived, leaving a ReferenceError.)

  const project: GenericProjectFile = JSON.parse(
    readFileSync(join(projectDir, 'project.json'), 'utf-8'),
  );

  // Classify the target: stage typeId vs single node id / alias. Stage
  // typeIds are valid up-front; node ids/aliases need the project's
  // executorState to resolve (e.g. `scene_1_shot_2.image` →
  // `shot_image:scene_1_shot_2`).
  let stopAtStage: string | undefined;
  let stopAfterNode: string | undefined;
  if (target !== null) {
    if (VALID_STAGES.includes(target)) {
      stopAtStage = target;
    } else {
      const { resolveNodeId } = await import('./cli-helpers.js');
      const state = (project as unknown as { executorState?: { nodes: Record<string, unknown> } }).executorState;
      if (!state) {
        console.error(`Cannot resolve node target '${target}' — project has no executorState yet. Run 'pnpm run-to <project>' first to bootstrap, then target a specific node.`);
        process.exit(1);
      }
      const resolved = resolveNodeId(state as never, target);
      if (!resolved) {
        console.error(`Unknown target: '${target}'. Not a stage typeId, and no matching node id/alias in this project's graph.`);
        process.exit(1);
      }
      stopAfterNode = resolved;
    }
  }

  const gateLabel = stopAtStage
    ? `stage=${stopAtStage}`
    : stopAfterNode
      ? `node=${stopAfterNode}`
      : '(none — run to final_video)';
  console.log([
    `=== run-to ===`,
    `  Project:     ${projectName} (${project.title || project.id})`,
    `  Pause after: ${gateLabel}`,
    `  Skip media:  ${skipMedia}`,
    ``,
  ].join('\n'));

  // Delegate to the canonical in-process runner. Same path the desktop UI
  // takes through executorRunner → runExecutor. No more parallel agent
  // construction between CLI and server.
  try {
    const result = await runExecutor({
      project,
      projectDir,
      target: {
        ...(stopAtStage ? { stage: stopAtStage } : {}),
        ...(stopAfterNode ? { nodeId: stopAfterNode } : {}),
        skipMedia,
      },
      name: 'run-to-cli',
      onTool: ({ toolName, nodeId }) => {
        const hint = nodeId ? ` ${nodeId}` : '';
        process.stdout.write(`  [${toolName}]${hint}\n`);
      },
      onResult: ({ filePath, status }) => {
        if (filePath) process.stdout.write(`    → ${filePath}\n`);
        else if (status) process.stdout.write(`    → ${status}\n`);
      },
      onNotification: ({ level, message }) => {
        if (level === 'error' || level === 'warning') {
          process.stderr.write(`  [${level}] ${message}\n`);
        } else {
          process.stdout.write(`  [info] ${message}\n`);
        }
      },
    });

    console.log(`\n=== Run finished ===`);
    console.log(`  result.status: ${result.status}`);
    console.log(`  stopReason:    ${result.stopReason ?? '(unknown)'}`);
    if (result.error) console.log(`  error:         ${result.error}`);

    // Success = complete OR paused_at_stage. Anything else is exit 1.
    const ok = result.status === 'completed' || result.stopReason === 'paused_at_stage';
    process.exit(ok ? 0 : 1);
  } catch (err) {
    console.error(`\nFatal: ${(err as Error).message}`);
    process.exit(1);
  }
}

// Only run main() when invoked directly (not when imported by tests).
const invokedDirectly = (() => {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return invoked.endsWith('run-to.ts') || invoked.endsWith('run-to.js');
})();

if (invokedDirectly) {
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}
