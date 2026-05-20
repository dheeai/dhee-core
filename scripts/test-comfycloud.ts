#!/usr/bin/env tsx
/**
 * Test ComfyUI Cloud workflows: FL2V, FML2V, Z-Image
 * Uses WebSocket for job tracking since /api/history requires different auth.
 */
import { readFileSync } from 'fs';
import { basename } from 'path';
import WebSocket from 'ws';

const API_KEY = 'comfyui-8d3e2df13b32a0a09eb0f0c009401e19125ccf373132083cfcc37a5ac908457a';
const BASE = 'https://cloud.comfy.org';
const CLIENT_ID = crypto.randomUUID();

const TEST_IMAGE = 'story_begins_girl_sprinting-2.dhee/assets/images/-eXJo4UY_e5b7f8f8c030490bcbdbd35dac2b90ca77dcb37f61ea66b1ab3a1e20feeec647.png';

async function uploadImage(filePath: string): Promise<string> {
  const form = new FormData();
  const fileData = readFileSync(filePath);
  const blob = new Blob([fileData], { type: 'image/png' });
  form.append('image', blob, basename(filePath));
  form.append('type', 'input');
  form.append('overwrite', 'true');

  console.log(`  Uploading ${basename(filePath)}...`);
  const res = await fetch(`${BASE}/api/upload/image`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY },
    body: form,
  });

  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { name: string };
  console.log(`  Uploaded: ${data.name}`);
  return data.name;
}

async function runWorkflow(
  name: string,
  workflow: Record<string, any>,
  timeoutMs = 300000,
): Promise<{ status: string; outputs?: any; error?: string }> {
  return new Promise((resolve) => {
    const wsUrl = `wss://cloud.comfy.org/ws?clientId=${CLIENT_ID}&token=${API_KEY}`;
    const ws = new WebSocket(wsUrl);
    let promptId = '';
    let timer: NodeJS.Timeout;

    timer = setTimeout(() => {
      console.log(`\n  TIMEOUT after ${timeoutMs / 1000}s`);
      ws.close();
      resolve({ status: 'timeout' });
    }, timeoutMs);

    ws.on('open', async () => {
      console.log(`  WebSocket connected. Submitting ${name}...`);

      const res = await fetch(`${BASE}/api/prompt`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: CLIENT_ID }),
      });

      if (!res.ok) {
        clearTimeout(timer);
        ws.close();
        const text = await res.text();
        resolve({ status: 'error', error: `Submit failed (${res.status}): ${text}` });
        return;
      }

      const data = await res.json() as { prompt_id: string; node_errors?: Record<string, any> };
      promptId = data.prompt_id;

      if (data.node_errors && Object.keys(data.node_errors).length > 0) {
        console.log(`  Node errors: ${JSON.stringify(data.node_errors).substring(0, 300)}`);
      }

      console.log(`  Prompt ID: ${promptId}`);
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        const type = msg.type;
        const d = msg.data;

        if (type === 'progress') {
          const pct = d.max > 0 ? Math.round((d.value / d.max) * 100) : 0;
          process.stdout.write(`\r  Progress: ${d.value}/${d.max} (${pct}%)`);
        } else if (type === 'executing') {
          if (d.node) {
            process.stdout.write(`\r  Executing node: ${d.node}                    `);
          }
        } else if (type === 'execution_success') {
          console.log(`\n  SUCCESS! Prompt: ${d.prompt_id}`);
          clearTimeout(timer);
          ws.close();
          resolve({ status: 'completed', outputs: d });
        } else if (type === 'execution_error') {
          console.log(`\n  ERROR: ${JSON.stringify(d).substring(0, 500)}`);
          clearTimeout(timer);
          ws.close();
          resolve({ status: 'error', error: JSON.stringify(d).substring(0, 500) });
        } else if (type === 'status') {
          // Queue status update
        } else {
          console.log(`  WS msg: ${type}`);
        }
      } catch {
        // Non-JSON message
      }
    });

    ws.on('error', (err) => {
      console.log(`  WS error: ${err.message}`);
      clearTimeout(timer);
      resolve({ status: 'error', error: err.message });
    });

    ws.on('close', () => {
      clearTimeout(timer);
    });
  });
}

async function testWorkflow(
  name: string,
  workflowPath: string,
  imageOverrides: Record<string, string>,
  textOverrides: Record<string, string> = {},
) {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Testing: ${name}`);
  console.log(`${'='.repeat(50)}`);

  const workflow = JSON.parse(readFileSync(workflowPath, 'utf-8'));

  for (const [nodeId, imageName] of Object.entries(imageOverrides)) {
    if (workflow[nodeId]) {
      // VHS_LoadVideo uses 'video' field, LoadImage uses 'image' field
      const field = workflow[nodeId].class_type === 'VHS_LoadVideo' ? 'video' : 'image';
      workflow[nodeId].inputs[field] = imageName;
      console.log(`  Set node ${nodeId} ${field} → ${imageName.substring(0, 30)}...`);
    }
  }

  for (const [nodeId, text] of Object.entries(textOverrides)) {
    if (workflow[nodeId]) {
      workflow[nodeId].inputs.text = text;
      console.log(`  Set node ${nodeId} text → ${text.substring(0, 60)}...`);
    }
  }

  const result = await runWorkflow(name, workflow);
  console.log(`  Final: ${result.status}`);
  if (result.error) console.log(`  Error: ${result.error}`);
  return result;
}

async function main() {
  console.log('ComfyUI Cloud Workflow Test');
  console.log('==========================\n');

  // Test V2V Extend only — upload video, not image
  const testVideo = 'story_begins_girl_sprinting-2.dhee/assets/videos/shots/_HteAs4E_93d844652f3b14beca5c9ccb86e3ef1b385546be28a5fa04f9b3e78d581fdb22.mp4';
  console.log('Step 1: Upload test video');
  const uploadedVideo = await uploadImage(testVideo);

  await testWorkflow(
    'LTX 2.3 V2V Extend',
    '/Users/ganaraj/Projects/dhee-core/workflows/cloud/ltx23_v2v_extend_cloud.json',
    { '319': uploadedVideo },
    {},
  );

  console.log('\nDone!');
  process.exit(0);

  // Also set the prompt text for FLUX Klein (node 109)
  const kleinPrompt = 'A girl with determined expression standing in a rain-soaked apocalyptic city street, from image 1, dramatic overhead lighting, shallow depth of field';

  // Test FLUX Klein with 1 ref (others filled with same image as fallback)
  console.log('\n--- Test: FLUX Klein with 1 reference ---');
  await testWorkflow(
    'FLUX Klein (1 ref)',
    '/Users/ganaraj/Projects/dhee-core/workflows/flux2_klein_edit.json',
    { '76': uploadedName, '81': uploadedName, '82': uploadedName, '83': uploadedName },
    { '109': kleinPrompt },
  );

  // Test FLUX Klein with 2 refs (ref 3,4 = fallback to ref 1)
  console.log('\n--- Test: FLUX Klein with 2 references ---');
  const settingImage = 'story_begins_girl_sprinting-2.dhee/assets/images/a8EYrprZ_SettingRef_apocalypticcity_00002_.png';
  const uploadedSetting = await uploadImage(settingImage);
  await testWorkflow(
    'FLUX Klein (2 refs)',
    '/Users/ganaraj/Projects/dhee-core/workflows/flux2_klein_edit.json',
    { '76': uploadedName, '81': uploadedSetting, '82': uploadedName, '83': uploadedName },
    { '109': 'The girl from image 1 standing in the apocalyptic city from image 2, dramatic lighting, cinematic composition' },
  );

  console.log('\n\nAll tests complete!');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
