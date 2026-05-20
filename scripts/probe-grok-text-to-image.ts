#!/usr/bin/env tsx
/**
 * Probe: does GrokImageEditNode handle pure generation (no-base)
 * when we feed refs only via BatchImagesNode?
 *
 * Hypothesis: Grok's edit node treats all BatchImagesNode inputs as
 * equal-weight image context. With 3 refs and a prompt describing a
 * scene from scratch, it should produce a character-consistent
 * generation — effectively `image_text_to_image` without needing a
 * separate generation node.
 *
 * Test shot: S1.3 first_frame
 *   mode:   image_text_to_image
 *   refs:   character:vikram, character:laila, setting:torch_lit_dhaba
 *   prompt: Medium shot over Vikram's shoulder, Laila gliding in from
 *           gloom, dhaba interior blurred behind.
 *
 * Slot wiring:
 *   images.image0 = torch_lit_dhaba (setting as "base")
 *   images.image1 = vikram ref
 *   images.image2 = laila ref
 *
 * Success signal: 1 output, character identities visibly consistent
 * with the refs, scene composition matches the prompt.
 */
import 'dotenv/config';
import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { buildGrokEditWorkflow } from '../src/services/providers/comfyui/grokWorkflowBuilder.js';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const PROJECT_DIR = join(REPO_ROOT, 'noir_detective_story_setup-3.dhee');

async function main() {
  const project = JSON.parse(readFileSync(join(PROJECT_DIR, 'project.json'), 'utf-8'));
  const nodes = project.executorState.nodes;
  const shotPrompt = JSON.parse(readFileSync(join(PROJECT_DIR, 'prompts/images/shots/scene-1-shot-3.json'), 'utf-8'));
  const ff = shotPrompt.frames.first_frame;
  const prompt = ff.imagePrompt;

  // Order refs so the setting goes into slot 0 (pseudo-base), characters in slots 1+
  // Grok treats them as equal-weight context regardless; slot 0 is just convention.
  const refsByType = (t: string) => ff.references.filter((r: any) => r.type === t);
  const orderedRefs = [...refsByType('setting'), ...refsByType('character')];
  const refPaths: string[] = [];
  for (const r of orderedRefs) {
    const refNode = nodes[r.refId];
    if (!refNode?.outputPath) continue;
    refPaths.push(join(PROJECT_DIR, refNode.outputPath));
  }

  console.log('=== Grok image_text_to_image probe ===');
  console.log('Shot:   scene 1 shot 3 (Laila glides from gloom)');
  console.log(`Refs:   ${orderedRefs.map((r: any) => r.refId).join(', ')}`);
  console.log(`Prompt: ${prompt.slice(0, 100)}...`);
  console.log('');

  const outDir = join(PROJECT_DIR, 'assets/videos/compare_grok_vs_klein');
  mkdirSync(outDir, { recursive: true });

  const client = new ComfyUIClient({ outputDir: outDir });

  console.log('Uploading slot 0 (setting):', refPaths[0]!.split('/').pop());
  const slot0 = await client.uploadImage(refPaths[0]!, 'input', true);
  const restNames: string[] = [];
  for (let i = 1; i < Math.min(3, refPaths.length); i++) {
    console.log(`Uploading slot ${i}:`, refPaths[i]!.split('/').pop());
    const u = await client.uploadImage(refPaths[i]!, 'input', true);
    restNames.push(u.name);
  }

  const seed = Math.floor(Math.random() * 1_000_000_000);
  const workflow = buildGrokEditWorkflow({
    baseImage: slot0.name,
    refs: restNames,
    prompt,
    seed,
    filenamePrefix: 'grok_s1s3_gen',
    resolution: '1K',
    aspectRatio: 'auto',
  });
  console.log(`Workflow: ${Object.keys(workflow).length} nodes, seed=${seed}`);

  console.log('Submitting...');
  const start = Date.now();
  const { result: execResult, promptId, outputs } = await client.queueAndWaitWS(workflow, (info) => {
    const t = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  [${t}s] ${info.message ?? ''}                `);
  });
  console.log(`\n  promptId=${promptId}, status=${execResult.status}, outputs=${outputs?.length ?? 0}`);

  if (execResult.status !== 'completed') {
    console.error('Job failed');
    process.exit(1);
  }

  const saveOut = outputs?.find(o => o.node_id === '3') ?? outputs?.[0];
  if (!saveOut) {
    console.error('No outputs captured');
    process.exit(1);
  }

  const localName = 's1s3_grok_gen_first_frame.png';
  await client.downloadImage(saveOut.filename, saveOut.subfolder ?? '', saveOut.type ?? 'output', localName);
  writeFileSync(join(outDir, 's1s3_gen_prompt.txt'), prompt);

  console.log('\nSaved:');
  console.log(`  Grok gen:       ${join(outDir, localName)}`);
  // Also copy the existing Klein-generated first_frame for this shot
  const kleinFirstFrameRel = nodes['shot_image:scene_1_shot_3']?.outputPaths?.first_frame;
  if (kleinFirstFrameRel) {
    const { copyFileSync } = await import('fs');
    copyFileSync(join(PROJECT_DIR, kleinFirstFrameRel), join(outDir, 's1s3_klein_first_frame.png'));
    console.log(`  Klein/zimage:   ${join(outDir, 's1s3_klein_first_frame.png')}`);
  }
  console.log(`  Prompt:         ${join(outDir, 's1s3_gen_prompt.txt')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
