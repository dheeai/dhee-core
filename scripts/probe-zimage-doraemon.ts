#!/usr/bin/env tsx
/**
 * Diagnose the "officer renders as Doraemon byte-identical across runs"
 * bug by submitting Z-Image three times directly through the local
 * Comfy that the desktop is talking to. Bypasses kshana's executor /
 * artifact / asset-scanner layers — only the WorkflowLoader + ComfyUI
 * client are exercised, so any caching observed must live in the local
 * ComfyUI server (or the zrok tunnel in front of it), not in kshana's
 * pipeline.
 *
 * Three submissions, two independent variables:
 *   A) full officer prompt (current `officer.json`)        seed = nanoid
 *   B) full officer prompt (current `officer.json`)        seed = different nanoid
 *   C) totally different prompt — "red apple on white table"  seed = different nanoid
 *
 * Then md5-diff the three outputs:
 *   - A == B  →  seed isn't reaching the sampler (or being ignored)
 *   - A == C  →  prompt isn't reaching the model (caching by workflow-id / filename_prefix)
 *   - A == B == C  →  Comfy is returning a cached PNG regardless of submission
 *   - All distinct  →  the bug is upstream in kshana, NOT in Comfy
 */

import 'dotenv/config';
import { readFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeZImageWorkflow } from '../src/services/comfyui/WorkflowLoader.js';

const REPO_ROOT = process.cwd();
const WORKFLOW_PATH = join(REPO_ROOT, 'workflows/zimage_standard.json');
const OFFICER_JSON = '/Users/ganaraj/Projects/The Village/prompts/images/characters/officer.json';
const OUTPUT_DIR = join(REPO_ROOT, 'test-output');

const officer = JSON.parse(readFileSync(OFFICER_JSON, 'utf-8')) as {
  imagePrompt: string;
  negativePrompt?: string;
};

const RUNS: Array<{ label: string; prompt: string; negPrompt: string }> = [
  {
    label: 'A_officer_prompt_seed1',
    prompt: officer.imagePrompt,
    negPrompt: officer.negativePrompt ?? 'blurry ugly bad',
  },
  {
    label: 'B_officer_prompt_seed2',
    prompt: officer.imagePrompt,
    negPrompt: officer.negativePrompt ?? 'blurry ugly bad',
  },
  {
    label: 'C_red_apple_seed3',
    prompt: 'Photorealistic studio photograph, 85mm lens, sharp focus — a bright red apple on a clean white table, soft even studio lighting, plain neutral background.',
    negPrompt: 'cartoon, anime, illustration, mascot, blurry, low quality',
  },
];

async function runOne(client: ComfyUIClient, template: any, run: typeof RUNS[number]) {
  const seed = Math.floor(Math.random() * 0x7FFFFFFF);
  const workflow = parameterizeZImageWorkflow(template, {
    prompt: run.prompt,
    negativePrompt: run.negPrompt,
    width: 1024,
    height: 1024,
    seed,
    steps: 9,
    cfg: 1.0,
    filenamePrefix: `probe_${run.label}`,
  } as any);

  console.log(`\n[${run.label}] queue (seed=${seed}, prompt[0..80]="${run.prompt.slice(0, 80)}…")`);
  const queueResult = await client.queueWorkflow(workflow as Record<string, unknown>, undefined, true);

  const result = await client.waitForCompletionWS(
    queueResult.promptId,
    queueResult.clientId!,
    (info) => {
      if (info.percentage > 0) process.stdout.write(`\r  ${info.message}`);
    },
  );
  console.log('');
  if (result.status !== 'completed') {
    throw new Error(`[${run.label}] failed: ${result.status}`);
  }

  const outputs = await client.getOutputImages(queueResult.promptId);
  if (!outputs.length) throw new Error(`[${run.label}] no outputs`);
  const first = outputs[0]!;
  const outName = `probe_zi_${run.label}_${Date.now()}.png`;
  const savedPath = await client.downloadImage(first.filename, first.subfolder, first.type, outName);
  const bytes = readFileSync(savedPath);
  const md5 = createHash('md5').update(bytes).digest('hex');
  console.log(`  [${run.label}] seed=${seed}  comfy=${first.filename}  saved=${outName}  bytes=${bytes.length}  md5=${md5}`);
  return { label: run.label, seed, comfyFilename: first.filename, savedPath, bytes: bytes.length, md5 };
}

async function main() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const template = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf-8'));
  const client = new ComfyUIClient({ outputDir: OUTPUT_DIR });

  type RunResult = Awaited<ReturnType<typeof runOne>>;
  const results: RunResult[] = [];
  for (const run of RUNS) {
    let attempt = 0;
    while (true) {
      try {
        results.push(await runOne(client, template, run));
        break;
      } catch (err) {
        attempt += 1;
        if (attempt >= 3) throw err;
        console.log(`  [${run.label}] error: ${(err as Error).message} — retry ${attempt}/3 in 5s`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  console.log('\n=== summary ===');
  for (const r of results) {
    console.log(`${r.label}  seed=${r.seed}  md5=${r.md5}  comfy=${r.comfyFilename}`);
  }

  const [a, b, c] = results;
  console.log('\n=== diagnosis ===');
  const ab = a!.md5 === b!.md5;
  const ac = a!.md5 === c!.md5;
  if (a && b && c) {
    if (ab && ac) {
      console.log('All three byte-identical → ComfyUI/zrok is returning a cached PNG regardless of submission. Bug is server-side.');
    } else if (ab && !ac) {
      console.log('A == B (same prompt, diff seed → same image) → seed not reaching sampler OR Comfy caches by prompt.');
    } else if (!ab && ac) {
      console.log('A == C (diff prompt → same image) → prompt not reaching model. Workflow hash collision somewhere.');
    } else {
      console.log('All three distinct → Comfy is fine. Bug is upstream in kshana pipeline.');
    }
  }
}

main().catch((err) => {
  console.error('Probe failed:', err);
  process.exit(1);
});
