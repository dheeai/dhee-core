#!/usr/bin/env tsx
/**
 * Minimal diagnostic: does ComfyUI Cloud accept the GrokImageEditNode
 * with our existing COMFY_CLOUD_API_KEY?
 *
 * Uploads a test image, submits workflows/user/grok_image_edit.json,
 * watches WS for execution_success or execution_error.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { basename } from 'path';
import WebSocket from 'ws';

const API_KEY = process.env['COMFY_CLOUD_API_KEY'];
const CLOUD_URL = (process.env['COMFYUI_BASE_URL'] || 'https://cloud.comfy.org/api').replace(/\/$/, '');
const BASE = CLOUD_URL.replace(/\/api$/, '');

if (!API_KEY) {
  console.error('COMFY_CLOUD_API_KEY not set');
  process.exit(1);
}

const TEST_IMAGE = process.argv[2]
  || 'air_already_thick_promise.dhee/assets/images/iGnmUX9h_Scene3_00026_.png';
const WORKFLOW_PATH = 'workflows/user/grok_image_edit.json';
const CLIENT_ID = crypto.randomUUID();

async function uploadImage(filePath: string): Promise<string> {
  const form = new FormData();
  const fileData = readFileSync(filePath);
  const blob = new Blob([fileData], { type: 'image/png' });
  form.append('image', blob, basename(filePath));
  form.append('type', 'input');
  form.append('overwrite', 'true');

  console.log(`Uploading ${basename(filePath)}...`);
  const res = await fetch(`${BASE}/api/upload/image`, {
    method: 'POST',
    headers: { 'X-API-Key': API_KEY! },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed (${res.status}): ${await res.text()}`);
  const data = await res.json() as { name: string };
  console.log(`Uploaded: ${data.name}`);
  return data.name;
}

async function submit(workflow: Record<string, any>): Promise<{ status: string; detail?: string }> {
  return new Promise((resolve) => {
    const wsUrl = `${BASE.replace(/^http/, 'ws')}/ws?clientId=${CLIENT_ID}&token=${API_KEY}`;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { ws.close(); resolve({ status: 'timeout' }); }, 300_000);

    ws.on('open', async () => {
      console.log('WS connected; submitting workflow...');
      const res = await fetch(`${BASE}/api/prompt`, {
        method: 'POST',
        headers: { 'X-API-Key': API_KEY!, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: workflow,
          client_id: CLIENT_ID,
          extra_data: { api_key_comfy_org: API_KEY },
        }),
      });
      const text = await res.text();
      if (!res.ok) {
        clearTimeout(timer); ws.close();
        resolve({ status: 'submit_error', detail: `HTTP ${res.status}: ${text}` });
        return;
      }
      let parsed: any;
      try { parsed = JSON.parse(text); } catch { parsed = {}; }
      if (parsed.node_errors && Object.keys(parsed.node_errors).length > 0) {
        console.log(`Node errors at submit: ${JSON.stringify(parsed.node_errors)}`);
      }
      console.log(`Prompt ID: ${parsed.prompt_id}`);
    });

    ws.on('message', (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        const { type, data: d } = msg;
        if (type === 'progress') {
          const pct = d.max > 0 ? Math.round((d.value / d.max) * 100) : 0;
          process.stdout.write(`\rProgress: ${d.value}/${d.max} (${pct}%)   `);
        } else if (type === 'executing' && d.node) {
          process.stdout.write(`\rExecuting node: ${d.node}                    `);
        } else if (type === 'execution_success') {
          console.log(`\nSUCCESS: ${d.prompt_id}`);
          clearTimeout(timer); ws.close();
          resolve({ status: 'completed', detail: JSON.stringify(d) });
        } else if (type === 'execution_error') {
          console.log(`\nEXECUTION ERROR: ${JSON.stringify(d)}`);
          clearTimeout(timer); ws.close();
          resolve({ status: 'exec_error', detail: JSON.stringify(d) });
        } else if (type === 'executed') {
          console.log(`\nNode executed: ${d.node} outputs=${JSON.stringify(d.output).slice(0, 200)}`);
        } else if (type !== 'status' && type !== 'progress_state') {
          console.log(`\nWS ${type}: ${JSON.stringify(d).slice(0, 200)}`);
        }
      } catch { /* non-JSON (binary preview frame) */ }
    });

    ws.on('error', (err) => {
      console.log(`WS error: ${err.message}`);
      clearTimeout(timer);
      resolve({ status: 'ws_error', detail: err.message });
    });
  });
}

async function main() {
  console.log(`Cloud base: ${BASE}`);
  console.log(`API key: ${API_KEY!.slice(0, 20)}...`);

  const uploadedName = await uploadImage(TEST_IMAGE);
  const workflow = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf-8'));
  workflow['6'].inputs.image = uploadedName;
  workflow['8'].inputs.prompt = 'Turn this into a cyberpunk night scene with neon lights, from image 1';
  workflow['8'].inputs.seed = Math.floor(Math.random() * 1_000_000_000);

  console.log(`\nWorkflow class_type at node 8: ${workflow['8'].class_type}`);
  console.log(`Model: ${workflow['8'].inputs.model}`);

  const result = await submit(workflow);
  console.log(`\nFinal: ${result.status}`);
  if (result.detail) console.log(`Detail: ${result.detail}`);
  process.exit(result.status === 'completed' ? 0 : 1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
