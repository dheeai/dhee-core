#!/usr/bin/env tsx
/**
 * Isolated stage tester — run ONE node of any stochastic stage.
 *
 * Loads the project, creates an ExecutorAgent with stopAfterNodeType set to the
 * target stage, resets that one node to pending, and runs the executor.
 * The executor processes the DAG normally but stops after one node of the target
 * type completes. This lets you test LLM prompts and ComfyUI calls in isolation.
 *
 * Usage:
 *   pnpm tsx scripts/test-stage.ts <project> <stage> [item_id]
 *
 * Examples:
 *   pnpm tsx scripts/test-stage.ts lazarus_drive shot_motion_directive
 *   pnpm tsx scripts/test-stage.ts lazarus_drive shot_image scene_1_shot_2
 *   pnpm tsx scripts/test-stage.ts lazarus_drive character_image kai
 *   pnpm tsx scripts/test-stage.ts lazarus_drive scene_video_prompt scene_1
 *
 * LLM stages:  plot, story, character, setting, object, scene, world_style,
 *              scene_video_prompt, shot_image_prompt, shot_motion_directive
 * ComfyUI:     character_image, setting_image, object_image, shot_image, shot_video
 */

import 'dotenv/config';
import { resolve, join } from 'path';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { createExecutorAgent, getVideoTemplate } from '../src/tasks/video/index.js';
import { LLMClient } from '../src/core/llm/index.js';
import type { GenericProjectFile } from '../src/core/templates/types.js';

const OUTPUT_DIR = resolve('test-output');
mkdirSync(OUTPUT_DIR, { recursive: true });

const STAGES = new Set([
  'plot', 'story', 'character', 'setting', 'object', 'scene', 'world_style',
  'scene_video_prompt', 'shot_image_prompt', 'shot_motion_directive',
  'character_image', 'setting_image', 'object_image', 'shot_image', 'shot_video',
]);

function usage() {
  console.log(`
Usage: pnpm tsx scripts/test-stage.ts <project> <stage> [item_id]

Stages: ${[...STAGES].join(', ')}

Examples:
  pnpm tsx scripts/test-stage.ts lazarus_drive shot_motion_directive
  pnpm tsx scripts/test-stage.ts lazarus_drive shot_image scene_1_shot_2
`);
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) usage();

  const projectName = args[0]!;
  const stage = args[1]!;
  const itemId = args[2]; // optional

  if (!STAGES.has(stage)) {
    console.error(`Unknown stage: ${stage}\nValid: ${[...STAGES].join(', ')}`);
    process.exit(1);
  }

  // Find project
  const projectDir = resolve(`${projectName}.dhee`);
  if (!existsSync(projectDir)) {
    console.error(`Project not found: ${projectDir}`);
    process.exit(1);
  }

  const project: GenericProjectFile = JSON.parse(
    readFileSync(join(projectDir, 'project.json'), 'utf-8'),
  );

  console.log(`\n=== Test Stage: ${stage} ===`);
  console.log(`  Project: ${projectName} (${project.title || project.id})`);
  console.log(`  Item: ${itemId || '(first available)'}`);

  // If a specific item is requested, reset just that node in the execution state
  if (itemId) {
    const statePath = join(projectDir, 'execution_state.json');
    if (existsSync(statePath)) {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const nodeId = `${stage}:${itemId}`;
      const node = state.nodes?.find((n: any) => n.id === nodeId);
      if (node) {
        console.log(`  Resetting ${nodeId} from ${node.status} → pending`);
        node.status = 'pending';
        node.error = undefined;
        // Keep outputPath so we can compare before/after
        writeFileSync(statePath, JSON.stringify(state, null, 2));
      } else {
        console.log(`  Node ${nodeId} not found in execution state — executor will create it`);
      }
    }
  }

  // Create the executor agent — same way the server does
  const llmConfig = {
    baseUrl: process.env['LLM_BASE_URL'],
    apiKey: process.env['LLM_API_KEY'],
    model: process.env['LLM_MODEL'],
  };

  const template = getVideoTemplate(project.templateId || 'narrative');

  // Use createExecutorAgent if available, otherwise construct directly
  const { ExecutorAgent } = await import('../src/core/planner/ExecutorAgent.js');
  const llm = new LLMClient(llmConfig);

  const agent = new ExecutorAgent(llm, {
    template,
    project,
    projectDir,
    goal: {
      targetArtifacts: ['final_video'],
      preferences: { style: project.style || 'cinematic_realism' },
      description: `Test stage: ${stage}`,
    },
    name: 'test-stage',
    stopAfterNodeType: stage,
  });

  // Listen for events
  let lastToolCall = '';
  agent.on((event: any) => {
    if (event.type === 'tool_call') {
      lastToolCall = event.toolName;
      console.log(`\n  [${event.toolName}] ${JSON.stringify(event.arguments ?? {}).substring(0, 200)}`);
    } else if (event.type === 'tool_streaming' && event.chunk && !event.done) {
      // Show dots for progress, but print full LLM output
      if (lastToolCall === 'generate_content') {
        process.stdout.write(event.chunk);
      } else {
        process.stdout.write('.');
      }
    } else if (event.type === 'tool_streaming' && event.done) {
      console.log(`\n  ✓ ${event.chunk?.substring(0, 200)}`);
    } else if (event.type === 'tool_result') {
      const r = event.result;
      if (r?.file_path) {
        console.log(`  Output: ${r.file_path}`);
      } else if (r?.status) {
        console.log(`  Status: ${r.status}`);
      }
    }
  });

  console.log(`\n  Running executor (stops after first ${stage} completes)...\n`);

  try {
    const result = await agent.run(`Test stage: ${stage}`);
    console.log(`\n  Agent result: ${result.status}`);
  } catch (err) {
    console.error(`\n  Error: ${(err as Error).message}`);
  }

  console.log('\nDone!');
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
