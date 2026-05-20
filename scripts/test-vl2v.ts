#!/usr/bin/env tsx
/**
 * Test script for VL2V (Video + Last frame → Video) workflow.
 *
 * Takes a source video + target last frame from the current project
 * and submits to ComfyUI cloud to test the new VL2V workflow.
 *
 * Usage:
 *   pnpm tsx scripts/test-vl2v.ts [project-name]
 */

import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/index.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const PROJECT_NAME = process.argv[2] || 'noir_detective_story_setup-3';
const PROJECT_DIR = join(process.cwd(), `${PROJECT_NAME}.dhee`);
const OUTPUT_DIR = join(process.cwd(), 'test-output', 'vl2v-test');
const WORKFLOW_PATH = join(process.cwd(), 'workflows', 'cloud', 'ltx23_vl2v_cloud.json');
const MANIFEST_PATH = join(process.cwd(), 'workflows', 'cloud', 'ltx23_vl2v_cloud.manifest.json');

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

// Load project state to find test pairs (source_video + last_frame from next shot)
const projectPath = join(PROJECT_DIR, 'project.json');
if (!existsSync(projectPath)) {
  console.error(`Project not found: ${projectPath}`);
  process.exit(1);
}

const project = JSON.parse(readFileSync(projectPath, 'utf-8'));
const nodes = project.executorState?.nodes ?? {};

interface TestCase {
  label: string;
  sourceVideoPath: string;
  midFramePath?: string;
  lastFramePath: string;
  prompt: string;
}

// Build test cases: use shot N's video + shot N+1's last_frame
const testCases: TestCase[] = [];

const testPairs = [
  // Scene 1: shot 2 video → shot 3. Mid = shot 3 first_frame (close to source end), Last = shot 3 last_frame
  { video: 'shot_video:scene_1_shot_2', midFrame: 'shot_image:scene_1_shot_3', lastFrame: 'shot_image:scene_1_shot_3', label: 'S1 Shot2→Shot3' },
  // Scene 2: shot 2 video → shot 3
  { video: 'shot_video:scene_2_shot_2', midFrame: 'shot_image:scene_2_shot_3', lastFrame: 'shot_image:scene_2_shot_3', label: 'S2 Shot2→Shot3' },
];

for (const pair of testPairs) {
  const videoNode = nodes[pair.video];
  const lastFrameNode = nodes[pair.lastFrame];
  const midFrameNode = nodes[pair.midFrame];

  if (!videoNode?.outputPath || !lastFrameNode?.outputPaths?.['last_frame']) {
    console.log(`Skipping ${pair.label}: missing data`);
    continue;
  }

  const videoPath = join(PROJECT_DIR, videoNode.outputPath);
  const lastFramePath = join(PROJECT_DIR, lastFrameNode.outputPaths['last_frame']);
  // Use the target shot's first_frame as mid_frame — it's the state we're transitioning through
  const midFramePath = midFrameNode?.outputPaths?.['first_frame']
    ? join(PROJECT_DIR, midFrameNode.outputPaths['first_frame'])
    : undefined;

  if (!existsSync(videoPath) || !existsSync(lastFramePath)) {
    console.log(`Skipping ${pair.label}: files not found`);
    continue;
  }

  testCases.push({
    label: pair.label,
    sourceVideoPath: videoPath,
    midFramePath: midFramePath && existsSync(midFramePath) ? midFramePath : undefined,
    lastFramePath: lastFramePath,
    prompt: 'Cinematic continuation with smooth motion, character movements, dramatic lighting',
  });
}

if (testCases.length === 0) {
  console.error('No valid test cases found');
  process.exit(1);
}

console.log(`\nFound ${testCases.length} test cases:\n`);
for (const tc of testCases) {
  console.log(`  ${tc.label}`);
  console.log(`    Video: ${tc.sourceVideoPath.split('/').slice(-1)}`);
  console.log(`    Mid frame: ${tc.midFramePath ? tc.midFramePath.split('/').slice(-1) : 'none'}`);
  console.log(`    Last frame: ${tc.lastFramePath.split('/').slice(-1)}`);
}

// Load workflow and manifest
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf-8'));
const template = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf-8'));

async function runTest(tc: TestCase): Promise<void> {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Running: ${tc.label}`);
  console.log(`${'='.repeat(60)}`);

  const client = new ComfyUIClient({ outputDir: OUTPUT_DIR });

  // Upload source video
  console.log('  Uploading source video...');
  const videoUpload = await client.uploadImage(tc.sourceVideoPath, 'input', true);
  console.log(`  → ${videoUpload.name}`);

  // Upload mid frame (if available)
  let midFrameUpload: { name: string } | null = null;
  if (tc.midFramePath) {
    console.log('  Uploading mid frame...');
    midFrameUpload = await client.uploadImage(tc.midFramePath, 'input', true);
    console.log(`  → ${midFrameUpload.name}`);
  }

  // Upload last frame
  console.log('  Uploading last frame...');
  const lastFrameUpload = await client.uploadImage(tc.lastFramePath, 'input', true);
  console.log(`  → ${lastFrameUpload.name}`);

  // Parameterize workflow
  const params: Record<string, unknown> = {
    source_video: videoUpload.name,
    last_frame: lastFrameUpload.name,
    prompt: tc.prompt,
    negative_prompt: 'blurry, distorted, low quality, text, watermark',
    filenamePrefix: `VL2V_${tc.label.replace(/\s+/g, '_')}`,
    seed: Math.floor(Math.random() * 2 ** 31),
  };
  // If mid_frame provided, set it; otherwise the workflow's default stays (which may error)
  // Use last_frame as fallback for mid_frame if not provided
  params['mid_frame'] = midFrameUpload?.name ?? lastFrameUpload.name;

  const workflow = parameterizeGeneric(template, manifest, params) as Record<string, unknown>;

  // Fix any stale LoadImage placeholders
  const knownUploads = new Set([videoUpload.name, lastFrameUpload.name]);
  if (midFrameUpload) knownUploads.add(midFrameUpload.name);
  for (const [nid, wfNode] of Object.entries(workflow)) {
    const n = wfNode as { class_type?: string; inputs?: Record<string, unknown> };
    if (n.class_type === 'LoadImage' && n.inputs) {
      const currentVal = n.inputs['image'];
      if (typeof currentVal === 'string' && !knownUploads.has(currentVal)) {
        console.log(`  [Safety] Node ${nid}: replacing stale "${currentVal}" → "${lastFrameUpload.name}"`);
        n.inputs['image'] = lastFrameUpload.name;
      }
    }
  }

  // Submit and wait
  console.log('  Submitting to ComfyUI...');
  const { promptId, outputs } = await client.queueAndWaitWS(workflow);
  console.log(`  Prompt ID: ${promptId}`);

  // Download outputs
  const allOutputs = outputs && outputs.length > 0
    ? outputs
    : await client.getOutputImages(promptId);

  console.log(`  Found ${allOutputs.length} output(s)`);
  for (const output of allOutputs) {
    try {
      const outName = `${tc.label.replace(/\s+/g, '_')}_${output.filename}`;
      const savedPath = await client.downloadImage(
        output.filename,
        output.subfolder,
        output.type || 'output',
        outName,
      );
      console.log(`  ✓ Downloaded: ${savedPath}`);
    } catch (err) {
      console.log(`  ✗ Download failed for ${output.filename}: ${(err as Error).message}`);
    }
  }
}

async function main() {
  for (const tc of testCases) {
    try {
      await runTest(tc);
    } catch (err) {
      console.error(`  ✗ FAILED: ${(err as Error).message}`);
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Done. Results in: ${OUTPUT_DIR}`);
  console.log(`${'='.repeat(60)}`);
}

main().catch(console.error);
