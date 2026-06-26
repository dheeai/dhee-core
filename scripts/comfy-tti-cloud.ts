#!/usr/bin/env tsx
/**
 * Terminal smoke test — run `comfy.tti.cloud` LIVE against Comfy Cloud.
 *
 * This is NOT the `dhee` bundle CLI. It invokes the runner directly so a
 * single text-to-image job can be verified against cloud.comfy.org from
 * the shell, without spinning up a project / bundle / walker.
 *
 * Usage:
 *   pnpm tsx scripts/comfy-tti-cloud.ts                    # default prompt
 *   pnpm tsx scripts/comfy-tti-cloud.ts "a red panda ..."
 *
 * Loads dhee-core/.env (for COMFY_CLOUD_API_KEY + COMFYUI_BASE_URL), runs
 * the REAL (non-stub) ComfyUI client, and writes the generated PNG to
 * outputs/cloud-tti-<timestamp>.png.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadDevEnv } from '../src/server/loadDevEnv.js';
import { comfyTtiCloudRunner } from '../src/dag/runners/comfyTtiCloud.js';
import type { NodeDef, RunnerContext } from '../src/dag/schema.js';

const BUNDLE_DIR = resolve('src/dag/bundles/narrative_prompt_relay');
const PROJECT_DIR = resolve('outputs');
const WORKFLOW = 'workflows/zimage_tti.json';
const MANIFEST = 'workflows/zimage_tti.manifest.json';

async function main(): Promise<void> {
  const env = loadDevEnv();
  console.log(env.loaded ? `loaded env: ${env.path}` : 'no .env found — relying on shell env');

  const prompt =
    process.argv[2] ??
    'a cinematic portrait of a lone astronaut standing on a red desert planet, golden hour, dramatic clouds, highly detailed';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outRel = `cloud-tti-${ts}.png`;

  for (const p of [join(BUNDLE_DIR, WORKFLOW), join(BUNDLE_DIR, MANIFEST)]) {
    if (!existsSync(p)) {
      console.error(`missing workflow asset: ${p}`);
      process.exit(1);
    }
  }
  mkdirSync(PROJECT_DIR, { recursive: true });

  const node: NodeDef = {
    id: 'tti_cloud_test',
    kind: 'stage',
    inputs: [],
    outputs: { format: 'image', pattern: outRel },
    runner: {
      tool: 'comfy.tti.cloud',
      config: {
        workflowPath: WORKFLOW,
        manifestPath: MANIFEST,
        endpoint: 'public.cloud',
        workflowId: 'zimage_cloud',
        width: 1024,
        height: 1024,
        prompt,
        outputPath: outRel,
      },
    },
  };
  const ctx: RunnerContext = {
    projectDir: PROJECT_DIR,
    bundleDir: BUNDLE_DIR,
    node,
    inputs: {},
    log: (m) => console.log('  ' + m),
  };

  console.log(`prompt:   ${prompt}`);
  console.log(`endpoint: ${process.env['ENDPOINT_public_cloud'] ?? '(unset)'}`);
  console.log(`mode:     ${process.env['COMFY_MODE'] ?? '(unset)'}`);
  console.log('submitting to Comfy Cloud…');

  const result = await comfyTtiCloudRunner.run(ctx);
  if (result.ok) {
    console.log(`\nOK — wrote ${resolve(PROJECT_DIR, outRel)}`);
  } else {
    console.error(`\nFAILED — ${result.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('fatal:', (err as Error)?.stack ?? err);
  process.exit(1);
});
