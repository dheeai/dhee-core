#!/usr/bin/env tsx
/**
 * FL2V int8 probe — drives the converted LTX 2.3 INT8 first-last-frame-to-video
 * workflow at `workflows/cloud/ltx23_fl2v_cloud_int8.json` with a single
 * LTX-V-official-style prompt synthesized by DeepSeek via OpenRouter.
 *
 * No A/B render here — the user already has a kshana-style render of this
 * shot on disk and wants to compare a fresh LTX-V-enhancer render against
 * it directly.
 *
 * Run:
 *   COMFY_MODE=local COMFYUI_BASE_URL=https://comfyui.share.zrok.io \
 *     pnpm tsx scripts/probe-ltx-fl2v-int8.ts
 *
 * Optional env:
 *   PROMPT_B_OVERRIDE="..."   skip DeepSeek, use this prompt verbatim
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { LLMClient } from '../src/core/llm/LLMClient.js';

const REPO_ROOT = process.cwd();
const WORKFLOW_PATH =
  process.env['WORKFLOW_PATH'] ||
  join(REPO_ROOT, 'workflows/cloud/ltx23_fl2v_cloud_int8.json');
const LTX_SYSTEM_PROMPT_PATH = join(REPO_ROOT, 'prompts/probes/ltxv_official_i2v.md');

const PROJECT = process.env['PROBE_PROJECT'] || 'Ruby.kshana';
const SCENE = parseInt(process.env['PROBE_SCENE'] || '1', 10);
const SHOT = parseInt(process.env['PROBE_SHOT'] || '2', 10);
// Default newest first/last frames for Ruby s1shot2 — override via
// FIRST_FRAME_PATH / LAST_FRAME_PATH to swap in a different image
// (e.g. the prior shot's last frame for continuity-by-construction tests).
const DEFAULT_FIRST = 'assets/images/s1shot2_first_frame_klein_eKC6iY.png';
const DEFAULT_LAST = 'assets/images/s1shot2_last_frame_klein_Y5Xb3N.png';
const DEFAULT_EXISTING = 'assets/videos/shots/s1shot2_ltx23__wp1Ay.mp4';

const FIRST_FRAME_PATH =
  process.env['FIRST_FRAME_PATH'] || join(REPO_ROOT, PROJECT, DEFAULT_FIRST);
const LAST_FRAME_PATH =
  process.env['LAST_FRAME_PATH'] || join(REPO_ROOT, PROJECT, DEFAULT_LAST);
const EXISTING_RENDER =
  process.env['EXISTING_RENDER'] || join(REPO_ROOT, PROJECT, DEFAULT_EXISTING);

const SHOT_BRIEF_PATH = join(
  REPO_ROOT,
  PROJECT,
  `prompts/videos/scenes/scene_${SCENE}.shots/${SHOT}.json`,
);
const SHOT_IMAGE_PROMPT_PATH = join(
  REPO_ROOT,
  PROJECT,
  `prompts/images/shots/scene-${SCENE}-shot-${SHOT}.json`,
);

const OUTPUT_DIR = join(REPO_ROOT, 'test-output');

async function buildLtxPrompt(): Promise<string> {
  const override = process.env['PROMPT_B_OVERRIDE'];
  if (override && override.trim()) {
    console.log('Using PROMPT_B_OVERRIDE (skipping DeepSeek call)');
    return override.trim();
  }

  const systemPrompt = readFileSync(LTX_SYSTEM_PROMPT_PATH, 'utf-8');

  // Apples-to-apples mode: when USER_MESSAGE_FILE is set, replay the
  // EXACT user message kshana's production motion-directive LLM
  // received. This bypasses our hand-built brief and lets DeepSeek
  // see the full <scene_state>, <shot_audio>, <bharata_cues>, World
  // Style Bible, etc., so the only variable in the A/B is the system
  // prompt (kshana motion guide vs LTX-V official i2v).
  const userMessageFile = process.env['USER_MESSAGE_FILE'];
  if (userMessageFile) {
    const userMessage = readFileSync(userMessageFile, 'utf-8');
    console.log(`Replaying user message from ${userMessageFile} (${userMessage.length} chars)`);
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY (OpenRouter) not set');
    const llm = new LLMClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey,
      model: 'deepseek/deepseek-v4-flash',
    });
    // 4000 tokens: DeepSeek v4-flash has implicit <think> reasoning that
    // counts against the budget. Empirically a 7k-char input ate ~800
    // think tokens before emitting visible text, so 4000 leaves room for
    // think + a ~100-word LTX-V paragraph.
    let text = '';
    for (let attempt = 1; attempt <= 3 && !text; attempt++) {
      const res = await llm.generate({
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: attempt === 1 ? 0.7 : 0.9,
        maxTokens: 4000,
      });
      text = (res.content || '').trim();
      if (!text) console.log(`  attempt ${attempt}: empty content, retrying...`);
    }
    if (!text) throw new Error('DeepSeek returned empty content after 3 attempts');
    return text;
  }
  const brief = JSON.parse(readFileSync(SHOT_BRIEF_PATH, 'utf-8'));
  const imgPrompts = JSON.parse(readFileSync(SHOT_IMAGE_PROMPT_PATH, 'utf-8'));
  let firstFrameDescription: string =
    imgPrompts?.frames?.first_frame?.imagePrompt ?? '';
  const lastFrameDescription: string =
    imgPrompts?.frames?.last_frame?.imagePrompt ?? '';

  // When START_STATE_FROM=S:N:KEY is set (e.g. "1:2:last_frame"), pull the
  // start-state description from a DIFFERENT shot's image-prompt JSON.
  // This is for continuity-by-construction probes where the FL2V model is
  // anchored on the prior shot's last frame instead of a freshly generated
  // first frame — the enhancer's "analyze the image" step then sees the
  // correct start state.
  const startFrom = process.env['START_STATE_FROM'];
  if (startFrom) {
    const [s, n, key] = startFrom.split(':');
    const overridePath = join(
      REPO_ROOT,
      PROJECT,
      `prompts/images/shots/scene-${s}-shot-${n}.json`,
    );
    const overrideJson = JSON.parse(readFileSync(overridePath, 'utf-8'));
    const desc = overrideJson?.frames?.[key as string]?.imagePrompt;
    if (!desc) throw new Error(`START_STATE_FROM=${startFrom}: no imagePrompt at frames.${key}`);
    firstFrameDescription = desc;
    console.log(`Start state overridden from scene-${s}-shot-${n}.${key}.imagePrompt`);
  }

  // FL2V conditions on BOTH frames. Surface both as textual descriptions
  // for the (text-only) enhancer, so it has the START and END states to
  // bridge — same way the video model itself anchors at both ends.
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

async function main() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(WORKFLOW_PATH)) throw new Error(`Workflow not found: ${WORKFLOW_PATH}`);
  if (!existsSync(FIRST_FRAME_PATH)) throw new Error(`First frame not found: ${FIRST_FRAME_PATH}`);
  if (!existsSync(LAST_FRAME_PATH)) throw new Error(`Last frame not found: ${LAST_FRAME_PATH}`);

  const promptB = await buildLtxPrompt();
  console.log('\n=== Prompt B (LTX-V official style via DeepSeek) ===');
  console.log(promptB);
  console.log('');

  const client = new ComfyUIClient({ outputDir: OUTPUT_DIR });

  console.log(`Uploading first frame ${basename(FIRST_FRAME_PATH)}...`);
  const upFirst = await client.uploadImage(FIRST_FRAME_PATH, 'input', true);
  console.log(`  uploaded as: ${upFirst.name}`);

  console.log(`Uploading last frame ${basename(LAST_FRAME_PATH)}...`);
  const upLast = await client.uploadImage(LAST_FRAME_PATH, 'input', true);
  console.log(`  uploaded as: ${upLast.name}`);

  // Parameterize: prompt at 16, first frame at 45, last frame at 47, output prefix at 43.
  const wf = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf-8'));
  wf['16'].inputs.text = promptB;
  wf['45'].inputs.image = upFirst.name;
  wf['47'].inputs.image = upLast.name;
  wf['43'].inputs.filename_prefix = `probe_fl2v_int8_${SCENE}_${SHOT}_${Date.now()}`;

  console.log('\nQueueing FL2V int8 workflow...');
  const queueResult = await client.queueWorkflow(wf, undefined, true);
  console.log(`promptId=${queueResult.promptId}`);

  const result = await client.waitForCompletionWS(
    queueResult.promptId,
    queueResult.clientId!,
    info => {
      if (info.percentage > 0) {
        process.stdout.write(`\r  ${info.message}`);
      }
    },
  );
  console.log('');
  if (result.status !== 'completed') {
    throw new Error(`workflow failed: ${result.status}${result.errorMessage ? ` — ${result.errorMessage}` : ''}`);
  }

  const outputs = await client.getOutputImages(queueResult.promptId);
  if (outputs.length === 0) throw new Error('no output files');
  const first = outputs[0]!;
  const outName = `probe_fl2v_int8_${SCENE}_${SHOT}_${Date.now()}.mp4`;
  const savedPath = await client.downloadImage(
    first.filename,
    first.subfolder,
    first.type,
    outName,
  );

  const sidecar = {
    project: PROJECT,
    scene: SCENE,
    shot: SHOT,
    workflow: WORKFLOW_PATH,
    firstFrame: FIRST_FRAME_PATH,
    lastFrame: LAST_FRAME_PATH,
    existingRender: EXISTING_RENDER,
    promptB,
    output: savedPath,
    ranAt: new Date().toISOString(),
  };
  const sidecarPath = join(
    OUTPUT_DIR,
    `probe_fl2v_int8_${SCENE}_${SHOT}_${Date.now()}.json`,
  );
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));

  console.log(`\nLTX-V enhancer output → ${savedPath}`);
  console.log(`Existing kshana render → ${EXISTING_RENDER}`);
  console.log(`Sidecar → ${sidecarPath}`);
}

main().catch(err => {
  console.error('Probe failed:', err);
  process.exit(1);
});
