#!/usr/bin/env tsx
/**
 * Test LTX video generation through the same code path as generate_video_from_image tool.
 * Uses a scene image from the project assets to test the ltx_i2v workflow end-to-end.
 */

import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { loadWorkflowTemplate, parameterizeWorkflowByName } from '../src/services/comfyui/WorkflowLoader.js';
import { getRegistry } from '../src/services/comfyui/WorkflowRegistry.js';

async function main() {
  // Use a scene image from project assets
  const testImage = path.resolve('.dhee/assets/images/96DPDyzl_Scene1_00132_.png');
  if (!fs.existsSync(testImage)) {
    console.error(`Test image not found: ${testImage}`);
    console.error('Available images in .dhee/assets/images/:');
    const imagesDir = path.resolve('.dhee/assets/images');
    if (fs.existsSync(imagesDir)) {
      fs.readdirSync(imagesDir).filter(f => f.endsWith('.png')).forEach(f => console.error(`  ${f}`));
    }
    process.exit(1);
  }

  const motionPrompt = 'subtle camera pan across the scene, gentle wind movement';
  const sceneNumber = 1;
  const model = 'ltx';

  console.log('='.repeat(60));
  console.log('Test: generate_video_from_image with LTX model');
  console.log('='.repeat(60));
  console.log(`Image:    ${testImage}`);
  console.log(`Prompt:   ${motionPrompt}`);
  console.log(`Model:    ${model}`);
  console.log('='.repeat(60));

  // Step 1: Registry lookup (same as tool handler)
  const registry = getRegistry();
  const workflowName = model === 'ltx' ? 'ltx_i2v' : 'wan_single_image';
  const workflowMetadata = registry.get(workflowName);

  if (!workflowMetadata) {
    console.error(`Workflow '${workflowName}' not found in registry`);
    process.exit(1);
  }

  console.log(`\n[1/4] Registry lookup: ${workflowName} -> ${workflowMetadata.filename}`);
  console.log(`       Display: ${workflowMetadata.displayName}`);

  // Step 2: Create client and upload image
  const assetsDir = path.resolve('.dhee/assets/videos');
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }

  const client = new ComfyUIClient({
    outputDir: assetsDir,
    timeout: 600,
  });

  console.log(`\n[2/4] Uploading image to ComfyUI...`);
  const uploadResult = await client.uploadImage(testImage, 'input', true);
  console.log(`       Uploaded as: ${uploadResult.name}`);

  // Step 3: Load and parameterize workflow (same as tool handler)
  console.log(`\n[3/4] Loading and parameterizing workflow: ${workflowMetadata.filename}`);
  const template = loadWorkflowTemplate(workflowMetadata.filename);
  const workflow = parameterizeWorkflowByName(workflowName, template, {
    sceneNumber,
    prompt: motionPrompt,
    negativePrompt: undefined,
    seed: undefined,
    inputImageFilename: uploadResult.name,
    filenamePrefix: `Scene${sceneNumber}_video`,
  });

  console.log(`       Workflow parameterized successfully`);
  console.log(`       Node count: ${Object.keys(workflow).length}`);

  // Step 4: Queue workflow
  console.log(`\n[4/4] Queueing workflow to ComfyUI...`);
  const promptId = await client.queueWorkflow(workflow as Record<string, unknown>);

  console.log('\n' + '='.repeat(60));
  console.log('SUCCESS - Workflow queued!');
  console.log('='.repeat(60));
  console.log(`prompt_id: ${promptId}`);

  // Wait for completion
  console.log(`\nWaiting for completion...`);
  const result = await client.waitForCompletion(promptId, (pct, msg) => {
    process.stdout.write(`\r  Progress: ${pct}% - ${msg}                    `);
  });

  console.log('\n');

  if (result.status === 'error') {
    console.error('Workflow FAILED');
    process.exit(1);
  }

  console.log(`Status: ${result.status}`);

  // Download outputs
  const outputs = await client.getOutputImages(promptId);
  if (outputs.length === 0) {
    console.log('No output files found');
  } else {
    for (const output of outputs) {
      const downloadedPath = await client.downloadImage(
        output.filename,
        output.subfolder,
        output.type
      );
      console.log(`Downloaded: ${downloadedPath}`);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log('Test complete!');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
