#!/usr/bin/env tsx
/**
 * Regenerate a single shot's last_frame via the new Grok multi-ref
 * workflow and save it next to the existing Klein output so they can be
 * compared side-by-side in Finder/Preview.
 *
 * Reads the shot's image-prompt JSON, uploads the first_frame (as base)
 * plus every reference image to ComfyUI Cloud, builds the Grok workflow
 * via the dynamic builder, submits, and downloads.
 *
 * Usage:
 *   pnpm tsx scripts/probe-grok-one-shot.ts <project> <scene> <shot>
 *
 * Example:
 *   pnpm tsx scripts/probe-grok-one-shot.ts noir_detective_story_setup-3 2 5
 *
 * Output:
 *   <project>/assets/videos/compare_grok_vs_klein/
 *     s{scene}s{shot}_klein_last_frame.png   # copied from current
 *     s{scene}s{shot}_grok_last_frame.png    # newly generated
 *     s{scene}s{shot}_first_frame.png        # the base for both
 *     s{scene}s{shot}_prompt.txt             # the prompt used
 */

import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, copyFileSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { buildGrokEditWorkflow } from '../src/services/providers/comfyui/grokWorkflowBuilder.js';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

async function main() {
  const [, , projectArg, sceneArg, shotArg] = process.argv;
  if (!projectArg || !sceneArg || !shotArg) {
    console.error('Usage: pnpm tsx scripts/probe-grok-one-shot.ts <project> <scene> <shot>');
    process.exit(1);
  }
  const projectName = projectArg.endsWith('.dhee') ? projectArg.replace(/\.dhee$/, '') : projectArg;
  const scene = parseInt(sceneArg, 10);
  const shot = parseInt(shotArg, 10);
  const projectDir = resolve(REPO_ROOT, `${projectName}.dhee`);

  if (!existsSync(projectDir)) {
    console.error(`Project not found: ${projectDir}`);
    process.exit(1);
  }

  const project = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8'));
  const nodes = project.executorState?.nodes ?? {};
  const shotNodeId = `shot_image:scene_${scene}_shot_${shot}`;
  const shotNode = nodes[shotNodeId];
  if (!shotNode) {
    console.error(`Node ${shotNodeId} not found in project.json`);
    process.exit(1);
  }

  const firstFrameRel = shotNode.outputPaths?.first_frame;
  const kleinLastFrameRel = shotNode.outputPaths?.last_frame;
  if (!firstFrameRel) {
    console.error(`No first_frame on ${shotNodeId}. Run shot_image stage first.`);
    process.exit(1);
  }
  const firstFrameAbs = join(projectDir, firstFrameRel);
  if (!existsSync(firstFrameAbs)) {
    console.error(`first_frame file missing on disk: ${firstFrameAbs}`);
    process.exit(1);
  }

  const promptPath = join(projectDir, 'prompts', 'images', 'shots', `scene-${scene}-shot-${shot}.json`);
  if (!existsSync(promptPath)) {
    console.error(`Shot prompt JSON not found: ${promptPath}`);
    process.exit(1);
  }
  const shotPrompt = JSON.parse(readFileSync(promptPath, 'utf-8'));
  const lastFrame = shotPrompt.frames?.last_frame;
  if (!lastFrame?.imagePrompt) {
    console.error(`No frames.last_frame.imagePrompt in ${promptPath}`);
    process.exit(1);
  }

  // Resolve every reference refId → absolute file path
  const refPaths: string[] = [];
  for (const r of lastFrame.references ?? []) {
    const refNode = nodes[r.refId];
    const refRel = refNode?.outputPath;
    if (!refRel) {
      console.warn(`Skipping ref ${r.refId} — no outputPath in project.json`);
      continue;
    }
    const refAbs = join(projectDir, refRel);
    if (!existsSync(refAbs)) {
      console.warn(`Skipping ref ${r.refId} — file missing: ${refAbs}`);
      continue;
    }
    refPaths.push(refAbs);
  }

  const outDir = join(projectDir, 'assets', 'videos', 'compare_grok_vs_klein');
  mkdirSync(outDir, { recursive: true });

  const tag = `s${scene}s${shot}`;
  copyFileSync(firstFrameAbs, join(outDir, `${tag}_first_frame.png`));
  if (kleinLastFrameRel) {
    const kleinAbs = join(projectDir, kleinLastFrameRel);
    if (existsSync(kleinAbs)) {
      copyFileSync(kleinAbs, join(outDir, `${tag}_klein_last_frame.png`));
    }
  }
  writeFileSync(join(outDir, `${tag}_prompt.txt`), lastFrame.imagePrompt);

  console.log('=== Grok single-shot probe ===');
  console.log(`Project:      ${projectName}`);
  console.log(`Shot:         scene ${scene}, shot ${shot}`);
  console.log(`Base frame:   ${firstFrameRel}`);
  console.log(`Refs:         ${refPaths.length}/${(lastFrame.references ?? []).length} resolved`);
  console.log(`Out dir:      ${outDir}`);
  console.log(`Klein copy:   ${kleinLastFrameRel ? 'yes' : 'no (none on disk)'}`);
  console.log('');

  const client = new ComfyUIClient({ outputDir: outDir });

  console.log('Uploading base image...');
  const baseUpload = await client.uploadImage(firstFrameAbs, 'input', true);
  console.log(`  uploaded as: ${baseUpload.name}`);

  // GrokImageEditNode caps at 3 images total → 2 refs max
  const refNames: string[] = [];
  for (const refPath of refPaths.slice(0, 2)) {
    console.log(`Uploading ref: ${refPath.split('/').pop()}`);
    const u = await client.uploadImage(refPath, 'input', true);
    refNames.push(u.name);
  }

  const seed = Math.floor(Math.random() * 1_000_000_000);
  const workflow = buildGrokEditWorkflow({
    baseImage: baseUpload.name,
    refs: refNames,
    prompt: lastFrame.imagePrompt,
    seed,
    filenamePrefix: `grok_${tag}`,
    resolution: '1K',
    aspectRatio: 'auto',
  });
  console.log(`Workflow built: ${Object.keys(workflow).length} nodes, seed=${seed}`);

  console.log('Submitting to ComfyUI Cloud...');
  const start = Date.now();
  const { result: execResult, promptId, outputs } = await client.queueAndWaitWS(workflow, (info) => {
    const pct = Math.round(info.percentage ?? 0);
    const t = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  [${t}s] ${pct}% ${info.message ?? ''}                `);
  });
  console.log(`\n  promptId=${promptId}, status=${execResult.status}, outputs=${outputs?.length ?? 0}`);

  if (execResult.status !== 'completed') {
    console.error(`Job did not complete: status=${execResult.status}`);
    process.exit(1);
  }

  // Dump every captured output so we see exactly what the cloud sent back
  console.log('All captured outputs:');
  for (const o of outputs ?? []) {
    console.log(`  node ${o.node_id ?? '?'}: ${o.filename} (type=${o.type ?? '?'}, subfolder=${o.subfolder || '-'})`);
  }

  // The SaveImage node (id "3" in our builder) is the canonical sink.
  // Prefer its output; fall back to first output only if SaveImage didn't emit.
  const saveImageOutput = outputs?.find(o => o.node_id === '3');
  const first = saveImageOutput ?? outputs?.[0];
  if (!first) {
    console.error('No outputs captured from the job');
    process.exit(1);
  }
  console.log(`Picked ${saveImageOutput ? 'SaveImage' : 'first'} output: ${first.filename}`);

  const targetPath = join(outDir, `${tag}_grok_multiref_last_frame.png`);
  const downloadedPath = await client.downloadImage(first.filename, first.subfolder ?? '', first.type ?? 'output', `${tag}_grok_multiref_last_frame.png`);
  if (downloadedPath !== targetPath) {
    copyFileSync(downloadedPath, targetPath);
  }
  console.log(`\nSaved Grok multi-ref output: ${targetPath}`);

  console.log('\nCompare:');
  console.log(`  first_frame: ${outDir}/${tag}_first_frame.png`);
  if (kleinLastFrameRel) console.log(`  klein:       ${outDir}/${tag}_klein_last_frame.png`);
  console.log(`  grok:        ${outDir}/${tag}_grok_last_frame.png`);
  console.log(`  prompt:      ${outDir}/${tag}_prompt.txt`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
