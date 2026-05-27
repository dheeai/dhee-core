#!/usr/bin/env tsx
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

const WF = '/Users/ganaraj/Downloads/flux2dev_fixed_multiangle.json';
const IMG = '/Users/ganaraj/dhee-studios/Coffee Shop Meet/assets/images/settings/sunlit_coffee_shop.png';
const UNET_GUESS = process.argv[2] ?? 'flux2-dev.safetensors';

const cloudUrl = process.env['ENDPOINT_public_cloud'] ?? process.env['COMFY_CLOUD_URL']!;
const apiKey = process.env['COMFY_CLOUD_API_KEY']!;

async function main() {
  const wf = JSON.parse(readFileSync(WF, 'utf-8')) as Record<string, { inputs: Record<string, unknown>; class_type: string }>;
  wf['92:70']!.inputs['unet_name'] = UNET_GUESS;
  console.log(`Trying UNET filename: ${UNET_GUESS}`);

  const client = new ComfyUIClient({ outputDir: '/tmp', baseUrl: cloudUrl });
  const up = await client.uploadImage(IMG, 'input', true);
  for (const nid of ['76', '81', '82', '83']) wf[nid]!.inputs['image'] = up.name;
  wf['109']!.inputs['text'] = '<sks> back eye-level shot wide, interior of a warm sunlit coffee shop, no people';
  wf['92:73']!.inputs['noise_seed'] = 12345;

  // Submit raw (bypass the WS waiter so we can read the validation/exec error directly).
  const resp = await fetch(`${cloudUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ prompt: wf }),
  });
  const submitRes = await resp.json() as { prompt_id?: string; node_errors?: Record<string, unknown> };
  console.log('submit:', JSON.stringify(submitRes).slice(0, 400));
  if (!submitRes.prompt_id) return;

  // Poll job status until terminal.
  for (let i = 0; i < 90; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const j = await (await fetch(`${cloudUrl}/jobs/${submitRes.prompt_id}`, { headers: { Authorization: `Bearer ${apiKey}` } })).json() as {
      status?: string; execution_error?: { exception_type?: string; exception_message?: string };
    };
    if (j.status === 'failed') {
      const ee = j.execution_error ?? {};
      console.log(`failed: ${ee.exception_type}: ${ee.exception_message?.slice(0, 1000)}`);
      return;
    }
    if (j.status === 'completed' || j.status === 'success') {
      console.log('SUCCESS');
      return;
    }
  }
  console.log('timed out polling');
}
main().catch((e) => { console.error(e); process.exit(1); });
