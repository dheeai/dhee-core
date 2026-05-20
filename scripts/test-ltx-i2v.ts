#!/usr/bin/env tsx
/**
 * Quick test: send a single image + prompt to LTX23 via ComfyUI and check the output.
 *
 * Usage:
 *   pnpm tsx scripts/test-ltx-i2v.ts <image-path> [prompt] [duration]
 *
 * Example:
 *   pnpm tsx scripts/test-ltx-i2v.ts earth_dead_five_ships-2.dhee/assets/images/a9TO4tXL_Scene1_00041_.png "Camera slowly pans across a desolate landscape" 5
 */

import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { loadWorkflowTemplate, parameterizeWorkflowByName } from '../src/services/comfyui/WorkflowLoader.js';
import { getRegistry } from '../src/services/comfyui/WorkflowRegistry.js';

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1) {
    console.error('Usage: pnpm tsx scripts/test-ltx-i2v.ts <image-path> [prompt] [duration]');
    process.exit(1);
  }

  const imagePath = join(process.cwd(), args[0]!);
  const prompt = args[1] || 'Slow cinematic camera pan with subtle movement';
  const duration = parseInt(args[2] || '5', 10);
  const width = parseInt(args[3] || '848', 10);
  const height = parseInt(args[4] || '480', 10);

  if (!existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    process.exit(1);
  }

  const outputDir = join(process.cwd(), 'test-output');
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  console.log(`Image: ${imagePath}`);
  console.log(`Prompt: ${prompt}`);
  console.log(`Duration: ${duration}s`);
  console.log(`Output: ${outputDir}`);
  console.log('');

  const client = new ComfyUIClient({ outputDir });
  const registry = getRegistry();
  const workflowMetadata = registry.get('ltx23');
  if (!workflowMetadata) {
    console.error('LTX23 workflow not found in registry');
    process.exit(1);
  }

  // Upload image
  console.log('Uploading image...');
  const uploadResult = await client.uploadImage(imagePath, 'input', true);
  console.log(`Uploaded as: ${uploadResult.name}`);

  // Load and parameterize workflow
  console.log('Loading workflow...');
  const template = loadWorkflowTemplate(workflowMetadata.filename);
  const workflow = parameterizeWorkflowByName('ltx23', template, {
    sceneNumber: 0,
    prompt,
    filenamePrefix: 'test_i2v',
    inputImageFilename: uploadResult.name,
    durationSeconds: duration,
    width,
    height,
  } as Parameters<typeof parameterizeWorkflowByName>[2]);

  // Queue
  console.log('Queueing workflow...');
  const queueResult = await client.queueWorkflow(workflow as Record<string, unknown>, undefined, true);
  console.log(`Prompt ID: ${queueResult.promptId}`);

  // Wait with progress
  console.log('Waiting for completion...');
  const result = await client.waitForCompletionWS(queueResult.promptId, queueResult.clientId!, (info) => {
    if (info.percentage > 0) {
      process.stdout.write(`\r  ${info.message}`);
    }
  });
  console.log('\n');

  if (result.status !== 'completed') {
    console.error(`Failed: ${result.status}`);
    process.exit(1);
  }

  // Download output
  const images = await client.getOutputImages(queueResult.promptId);
  if (images.length === 0) {
    console.error('No output files');
    process.exit(1);
  }

  const first = images[0]!;
  const outputFilename = `test_i2v_${Date.now()}.mp4`;
  const savedPath = await client.downloadImage(first.filename, first.subfolder, first.type, outputFilename);
  console.log(`Output saved: ${savedPath}`);
  console.log('Done!');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
