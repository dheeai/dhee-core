#!/usr/bin/env tsx
/**
 * LTX 2.3 FL2V INT8 A/B probe — same workflow, same DeepSeek-built prompt,
 * same first/last frame, same seeds — single variable: an extra
 * `LTX2.3-OmniNFT.safetensors` LoRA at strength 0.8 stacked on top of the
 * existing I2V LoRA chain.
 *
 * Defaults to Ruby s1shot4 (frames from ~/Projects/Ruby).
 *
 * Run:
 *   COMFY_MODE=local COMFYUI_BASE_URL=https://comfyui.share.zrok.io \
 *     pnpm tsx scripts/probe-ltx-omninft-ab.ts
 *
 * Optional env:
 *   PROMPT_OVERRIDE="..."        skip DeepSeek, use this prompt verbatim
 *   OMNINFT_STRENGTH=0.8         override lora strength (default 0.8)
 *   PROBE_PROJECT_DIR=...        absolute path to .kshana-style project dir
 *                                 (default ~/Projects/Ruby)
 *   PROBE_SCENE=1 PROBE_SHOT=4   override scene/shot indices
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { LLMClient } from '../src/core/llm/LLMClient.js';

const REPO_ROOT = process.cwd();
const WORKFLOW_PATH =
  process.env['WORKFLOW_PATH'] ||
  join(REPO_ROOT, 'workflows/cloud/ltx23_fl2v_cloud_local.json');
const LTX_SYSTEM_PROMPT_PATH = join(REPO_ROOT, 'prompts/probes/ltxv_official_i2v.md');

const PROJECT_DIR = process.env['PROBE_PROJECT_DIR'] || join(homedir(), 'Projects/Ruby');
const SCENE = parseInt(process.env['PROBE_SCENE'] || '1', 10);
const SHOT = parseInt(process.env['PROBE_SHOT'] || '4', 10);
const OMNINFT_STRENGTH = parseFloat(process.env['OMNINFT_STRENGTH'] || '0.8');
const OMNINFT_LORA_NAME = 'LTX-2.3-OmniNFT-RL-Lora_bf16.safetensors';

const SHOT_BRIEF_PATH = join(
  PROJECT_DIR,
  `prompts/videos/scenes/scene_${SCENE}.shots/${SHOT}.json`,
);
const SHOT_IMAGE_PROMPT_PATH = join(
  PROJECT_DIR,
  `prompts/images/shots/scene-${SCENE}-shot-${SHOT}.json`,
);

function pickFrame(kind: 'first_frame' | 'last_frame'): string {
  // Frames live under PROJECT_DIR/assets/images and follow the naming pattern
  // s{scene}shot{shot}_{first|last}_frame_klein_XXXXXX.png. Scan and pick the
  // newest match so a regenerated frame is preferred over the original.
  const dir = join(PROJECT_DIR, 'assets/images');
  const pattern = new RegExp(`^s${SCENE}shot${SHOT}_${kind}_klein_.*\\.png$`);
  const candidates = readdirSync(dir)
    .filter((f: string) => pattern.test(f))
    .map((f: string) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    throw new Error(`No ${kind} match in ${dir} for s${SCENE}shot${SHOT}`);
  }
  return join(dir, candidates[0]!.f);
}

const FIRST_FRAME_PATH = process.env['FIRST_FRAME_PATH'] || pickFrame('first_frame');
const LAST_FRAME_PATH = process.env['LAST_FRAME_PATH'] || pickFrame('last_frame');

const OUTPUT_DIR = join(REPO_ROOT, 'test-output');

async function buildLtxPrompt(): Promise<string> {
  const override = process.env['PROMPT_OVERRIDE'];
  if (override && override.trim()) {
    console.log('Using PROMPT_OVERRIDE (skipping DeepSeek call)');
    return override.trim();
  }

  const systemPrompt = readFileSync(LTX_SYSTEM_PROMPT_PATH, 'utf-8');
  const brief = JSON.parse(readFileSync(SHOT_BRIEF_PATH, 'utf-8'));
  const imgPrompts = JSON.parse(readFileSync(SHOT_IMAGE_PROMPT_PATH, 'utf-8'));
  const firstFrameDescription: string =
    imgPrompts?.frames?.first_frame?.imagePrompt ?? '';
  const lastFrameDescription: string =
    imgPrompts?.frames?.last_frame?.imagePrompt ?? '';

  const userMessage = [
    'IMAGE DESCRIPTION — FIRST FRAME (start state):',
    firstFrameDescription,
    '',
    'IMAGE DESCRIPTION — LAST FRAME (end state the video must land on):',
    lastFrameDescription,
    '',
    'RAW INPUT PROMPT (the motion the user wants):',
    `${brief.description} Camera: ${brief.cameraWork}. Audio context: ${brief.audio}. Duration: ${brief.duration}s.`,
  ].join('\n');

  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) throw new Error('OPENAI_API_KEY (OpenRouter) not set');

  const llm = new LLMClient({
    baseUrl: 'https://openrouter.ai/api/v1',
    apiKey,
    model: 'deepseek/deepseek-v4-flash',
  });

  console.log('Calling DeepSeek via OpenRouter for LTX-style prompt...');
  let text = '';
  for (let attempt = 1; attempt <= 3 && !text; attempt++) {
    const res = await llm.generate({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: attempt === 1 ? 0.7 : 0.9,
      maxTokens: 700,
    });
    text = (res.content || '').trim();
    if (!text) console.log(`  attempt ${attempt}: empty content, retrying...`);
  }
  if (!text) throw new Error('DeepSeek returned empty content after 3 attempts');
  return text;
}

function buildWorkflow(
  template: Record<string, any>,
  firstName: string,
  lastName: string,
  promptText: string,
  filenamePrefix: string,
  addOmniNft: boolean,
): Record<string, any> {
  const wf = JSON.parse(JSON.stringify(template));
  wf['16'].inputs.text = promptText;
  wf['45'].inputs.image = firstName;
  wf['47'].inputs.image = lastName;
  wf['43'].inputs.filename_prefix = filenamePrefix;

  // I2V mode: rewrite LTXVImgToVideoInplaceKJ nodes 35 (stage 2) and 210
  // (stage 1) to anchor on the first frame only — drop image_2 / strength_2 /
  // index_2 so the model is no longer end-anchored. Last-frame upstream
  // nodes (47/48/49/50) become orphan branches and Comfy skips them.
  if (process.env['MODE'] === 'i2v') {
    for (const nid of ['35', '210']) {
      const node = wf[nid];
      if (!node?.inputs) continue;
      node.inputs['num_images'] = '1';
      delete node.inputs['num_images.image_2'];
      delete node.inputs['num_images.strength_2'];
      delete node.inputs['num_images.index_2'];
    }
  }

  // NO_VBVR=1: bypass node 217 (Licon VBVR I2V lora at strength 1.0) entirely.
  // Variant A then runs the bare base UNET; variant B stacks OmniNFT alone.
  // This isolates whether VBVR is crowding OmniNFT out of the weight space.
  const noVbvr = process.env['NO_VBVR'] === '1';
  const baseModelRef: [string, number] = noVbvr ? ['187', 0] : ['217', 0];
  if (noVbvr) {
    wf['8'].inputs.model = baseModelRef;
    wf['36'].inputs.model = baseModelRef;
  }

  if (addOmniNft) {
    wf['218'] = {
      class_type: 'LoraLoaderModelOnly',
      _meta: { title: `Load LoRA (OmniNFT @ ${OMNINFT_STRENGTH}${noVbvr ? ', VBVR off' : ''})` },
      inputs: {
        lora_name: OMNINFT_LORA_NAME,
        strength_model: OMNINFT_STRENGTH,
        model: baseModelRef,
      },
    };
    wf['8'].inputs.model = ['218', 0];
    wf['36'].inputs.model = ['218', 0];
  }
  return wf;
}

async function runVariant(
  client: ComfyUIClient,
  wf: Record<string, any>,
  label: string,
): Promise<string> {
  console.log(`\n=== Queueing variant ${label} ===`);
  const queueResult = await client.queueWorkflow(wf, undefined, true);
  console.log(`promptId=${queueResult.promptId}`);
  const result = await client.waitForCompletionWS(
    queueResult.promptId,
    queueResult.clientId,
    info => {
      if (info.percentage > 0) {
        process.stdout.write(`\r  [${label}] ${info.message}                `);
      }
    },
  );
  console.log('');
  if (result.status !== 'completed') {
    throw new Error(
      `variant ${label} failed: ${result.status}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`,
    );
  }
  const outputs = await client.getOutputImages(queueResult.promptId);
  if (outputs.length === 0) throw new Error(`variant ${label}: no output files`);
  const first = outputs[0]!;
  const stamp = Date.now();
  const outName = `probe_omninft_ab_${label}_s${SCENE}shot${SHOT}_${stamp}.mp4`;
  const savedPath = await client.downloadImage(
    first.filename,
    first.subfolder,
    first.type,
    outName,
  );
  console.log(`  variant ${label} → ${savedPath}`);
  return savedPath;
}

async function main() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(WORKFLOW_PATH)) throw new Error(`Workflow not found: ${WORKFLOW_PATH}`);
  if (!existsSync(FIRST_FRAME_PATH)) throw new Error(`First frame not found: ${FIRST_FRAME_PATH}`);
  if (!existsSync(LAST_FRAME_PATH)) throw new Error(`Last frame not found: ${LAST_FRAME_PATH}`);
  if (!existsSync(SHOT_BRIEF_PATH)) throw new Error(`Shot brief not found: ${SHOT_BRIEF_PATH}`);
  if (!existsSync(SHOT_IMAGE_PROMPT_PATH)) {
    throw new Error(`Image-prompt JSON not found: ${SHOT_IMAGE_PROMPT_PATH}`);
  }

  console.log(`Project dir : ${PROJECT_DIR}`);
  console.log(`Scene/Shot  : s${SCENE} / shot ${SHOT}`);
  console.log(`First frame : ${basename(FIRST_FRAME_PATH)}`);
  console.log(`Last frame  : ${basename(LAST_FRAME_PATH)}`);
  console.log(`OmniNFT lora: ${OMNINFT_LORA_NAME} @ ${OMNINFT_STRENGTH}`);

  const promptText = await buildLtxPrompt();
  console.log('\n=== Shared LTX prompt (used by both variants) ===');
  console.log(promptText);
  console.log('');

  const template = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf-8'));
  const client = new ComfyUIClient({ outputDir: OUTPUT_DIR });

  console.log(`\nUploading first frame ${basename(FIRST_FRAME_PATH)}...`);
  const upFirst = await client.uploadImage(FIRST_FRAME_PATH, 'input', true);
  console.log(`  uploaded as: ${upFirst.name}`);

  console.log(`Uploading last frame ${basename(LAST_FRAME_PATH)}...`);
  const upLast = await client.uploadImage(LAST_FRAME_PATH, 'input', true);
  console.log(`  uploaded as: ${upLast.name}`);

  const runStamp = Date.now();
  const wfA = buildWorkflow(
    template,
    upFirst.name,
    upLast.name,
    promptText,
    `probe_omninft_ab_A_${runStamp}`,
    false,
  );
  const wfB = buildWorkflow(
    template,
    upFirst.name,
    upLast.name,
    promptText,
    `probe_omninft_ab_B_${runStamp}`,
    true,
  );

  const pathA = await runVariant(client, wfA, 'A_baseline');
  const pathB = await runVariant(client, wfB, 'B_omninft');

  const sidecar = {
    projectDir: PROJECT_DIR,
    scene: SCENE,
    shot: SHOT,
    workflow: WORKFLOW_PATH,
    firstFrame: FIRST_FRAME_PATH,
    lastFrame: LAST_FRAME_PATH,
    sharedPrompt: promptText,
    omninft: {
      loraName: OMNINFT_LORA_NAME,
      strength: OMNINFT_STRENGTH,
      stackedOnNode: '217',
      injectedAsNode: '218',
    },
    seeds: {
      stage1: template['15']?.inputs?.noise_seed,
      stage2: template['14']?.inputs?.noise_seed,
    },
    variantA_baseline: pathA,
    variantB_omninft: pathB,
    ranAt: new Date().toISOString(),
  };
  const sidecarPath = join(
    OUTPUT_DIR,
    `probe_omninft_ab_s${SCENE}shot${SHOT}_${runStamp}.json`,
  );
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));

  console.log('\n=== Side-by-side ===');
  console.log(`A (baseline)       → ${pathA}`);
  console.log(`B (OmniNFT @ ${OMNINFT_STRENGTH}) → ${pathB}`);
  console.log(`Sidecar            → ${sidecarPath}`);
}

main().catch(err => {
  console.error('Probe failed:', err);
  process.exit(1);
});
