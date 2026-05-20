#!/usr/bin/env tsx
/**
 * Flux Klein fp8-vs-GGUF-Q5 A/B probe.
 *
 * Renders the same Klein edit twice on the same prompt, seed, and reference
 * images — variant A uses the existing safetensors UNETLoader (fp8), variant
 * B swaps it for UnetLoaderGGUF with flux-2-klein-9b-Q5_0.gguf. Times each
 * end-to-end so we can compare wall time and visually compare the outputs.
 *
 * Defaults to the FIRST frame of Ruby s1shot2 (one ref: CharRef_ruby).
 *
 * Run:
 *   COMFY_MODE=local COMFYUI_BASE_URL=https://comfyui.share.zrok.io \
 *     pnpm tsx scripts/probe-klein-gguf-ab.ts
 *
 * Optional env:
 *   PROBE_PROJECT_DIR=...  default ~/Projects/Ruby
 *   PROBE_SCENE=1 PROBE_SHOT=2
 *   FRAME_KEY=first_frame  (or last_frame)
 *   SEED=12345             override seed
 *   PROMPT_OVERRIDE="..."  use this prompt instead of the JSON's imagePrompt
 *   REF_IMAGE_OVERRIDE=path  use this single ref image instead of the JSON refs
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename } from 'path';
import { homedir } from 'os';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

const REPO_ROOT = process.cwd();
const WORKFLOW_PATH =
  process.env['WORKFLOW_PATH'] ||
  join(REPO_ROOT, 'workflows/built-in/flux2_klein_edit_local.json');

const PROJECT_DIR = process.env['PROBE_PROJECT_DIR'] || join(homedir(), 'Projects/Ruby');
const SCENE = parseInt(process.env['PROBE_SCENE'] || '1', 10);
const SHOT = parseInt(process.env['PROBE_SHOT'] || '2', 10);
const FRAME_KEY = (process.env['FRAME_KEY'] || 'first_frame') as 'first_frame' | 'last_frame';
const SEED = parseInt(process.env['SEED'] || '432262096973500', 10);

const GGUF_UNET_NAME = 'flux-2-klein-9b-Q5_0.gguf';
const GGUF_CLIP_NAME = 'Qwen3-8B-Q4_K_M.gguf';

type Variant =
  | 'A_fp8'
  | 'B_q5gguf'
  | 'C_q5gguf_clipgguf'
  | 'D_bf16_evict'
  | 'E_fp8_native'
  | 'F_nunchaku_int4';
const VARIANTS = (process.env['VARIANTS'] || 'A_fp8,B_q5gguf,C_q5gguf_clipgguf')
  .split(',')
  .map(s => s.trim()) as Variant[];

const SHOT_IMAGE_PROMPT_PATH = join(
  PROJECT_DIR,
  `prompts/images/shots/scene-${SCENE}-shot-${SHOT}.json`,
);

const OUTPUT_DIR = join(REPO_ROOT, 'test-output');

const REF_NODES = ['76', '81', '82', '83']; // up to 4 reference image LoadImage nodes

function resolveRefImage(refId: string): string {
  // Map refId like "character_image:ruby" → outputPath in project.json's executorState
  const project = JSON.parse(readFileSync(join(PROJECT_DIR, 'project.json'), 'utf-8'));
  const node = project?.executorState?.nodes?.[refId];
  if (!node?.outputPath) {
    throw new Error(`Cannot resolve refId ${refId}: not found or missing outputPath`);
  }
  return join(PROJECT_DIR, node.outputPath);
}

function getPromptAndRefs(): { promptText: string; refPaths: string[] } {
  const override = process.env['PROMPT_OVERRIDE'];
  const refOverride = process.env['REF_IMAGE_OVERRIDE'];
  if (override && refOverride) {
    return { promptText: override.trim(), refPaths: [refOverride] };
  }
  const data = JSON.parse(readFileSync(SHOT_IMAGE_PROMPT_PATH, 'utf-8'));
  const frame = data?.frames?.[FRAME_KEY];
  if (!frame) throw new Error(`No frame ${FRAME_KEY} in ${SHOT_IMAGE_PROMPT_PATH}`);
  const promptText = override?.trim() || frame.imagePrompt;
  const refs: Array<{ refId: string }> = frame.references || [];
  const refPaths = refOverride
    ? [refOverride]
    : refs.map(r => resolveRefImage(r.refId));
  if (refPaths.length === 0) {
    throw new Error('No references found and no REF_IMAGE_OVERRIDE provided');
  }
  return { promptText, refPaths };
}

function buildWorkflow(
  template: Record<string, any>,
  uploadedRefNames: string[],
  promptText: string,
  seed: number,
  filenamePrefix: string,
  variant: Variant,
): Record<string, any> {
  const wf = JSON.parse(JSON.stringify(template));

  wf['109'].inputs.text = promptText;
  wf['92:73'].inputs.noise_seed = seed;
  wf['94'].inputs.filename_prefix = filenamePrefix;

  // Fill ref-image slots; pad with the first ref so unused slots still point
  // to a valid uploaded image (Klein conditions on 4 latents — for fewer
  // distinct refs we repeat the first, which is the existing local-workflow
  // convention).
  REF_NODES.forEach((nid, i) => {
    wf[nid].inputs.image = uploadedRefNames[i] ?? uploadedRefNames[0]!;
  });

  if (variant === 'B_q5gguf' || variant === 'C_q5gguf_clipgguf') {
    // Swap node 92:70 from UNETLoader to UnetLoaderGGUF in place — same
    // node id, so the downstream CFGGuider reference [92:70, 0] still wires.
    wf['92:70'] = {
      class_type: 'UnetLoaderGGUF',
      _meta: { title: `Load Diffusion Model (GGUF Q5_0)` },
      inputs: { unet_name: GGUF_UNET_NAME },
    };
  }

  if (variant === 'C_q5gguf_clipgguf') {
    // Swap node 92:71 from CLIPLoader to CLIPLoaderGGUF. CLIPLoaderGGUF has
    // no `device` field — only clip_name + type. Downstream node 92:74
    // (CLIPTextEncode) references [92:71, 0] so wiring stays intact.
    wf['92:71'] = {
      class_type: 'CLIPLoaderGGUF',
      _meta: { title: `Load CLIP (GGUF Q4_K_M)` },
      inputs: {
        clip_name: GGUF_CLIP_NAME,
        type: 'flux2',
      },
    };
  }

  if (variant === 'F_nunchaku_int4') {
    // Swap node 92:70 to NunchakuFluxDiTLoader with the SVDQuant INT4 Klein
    // checkpoint. The loader outputs a MODEL just like UNETLoader, so the
    // downstream CFGGuider reference [92:70, 0] stays valid.
    // cpu_offload="auto" enables offload because our 12 GB VRAM < 14 GB
    // threshold. attention="nunchaku-fp16" gives Nunchaku's claimed 1.2x
    // speedup over flash-attention2 on Ampere.
    wf['92:70'] = {
      class_type: 'NunchakuFluxDiTLoader',
      _meta: { title: 'Nunchaku FLUX DiT Loader (INT4)' },
      inputs: {
        model_path: 'svdq-int4_r32-FLUX.2-klein-9b-kv-Nunchaku.safetensors',
        cache_threshold: 0,
        attention: 'nunchaku-fp16',
        cpu_offload: 'auto',
        device_id: 0,
        data_type: 'bfloat16',
      },
    };
  }

  if (variant === 'E_fp8_native') {
    // Swap UNETLoader to the smaller fp8 checkpoint. ~9 GB on disk, should
    // fit fully resident in 12 GB VRAM after text encoder evicts, so the
    // sampler runs without PCIe streaming. weight_dtype stays "default" —
    // the file is already native fp8, no cast needed.
    wf['92:70'] = {
      class_type: 'UNETLoader',
      _meta: { title: 'Load Diffusion Model (fp8 native)' },
      inputs: {
        unet_name: 'flux-2-klein-9b-fp8.safetensors',
        weight_dtype: 'default',
      },
    };
  }

  if (variant === 'D_bf16_evict') {
    // Insert `easy cleanGpuUsed` as a pass-through on the conditioning chain
    // right before CFGGuider, so all upstream encoders (text encoder + VAE)
    // are fully done before the UNET is requested. The cleanup forces the
    // text encoder out of VRAM so the bf16 UNET can occupy more of the 12 GB
    // (less partial-loading, less PCIe streaming during sampling).
    //
    // Wire: 92:89:77 (last positive ReferenceLatent) -> 219 -> 92:63
    //       92:89:76 (last negative ReferenceLatent) -> 220 -> 92:63
    wf['219'] = {
      class_type: 'easy cleanGpuUsed',
      _meta: { title: 'Evict GPU (positive)' },
      inputs: { anything: ['92:89:77', 0] },
    };
    wf['220'] = {
      class_type: 'easy cleanGpuUsed',
      _meta: { title: 'Evict GPU (negative)' },
      inputs: { anything: ['92:89:76', 0] },
    };
    wf['92:63'].inputs.positive = ['219', 0];
    wf['92:63'].inputs.negative = ['220', 0];
  }

  return wf;
}

async function runVariant(
  client: ComfyUIClient,
  wf: Record<string, any>,
  label: string,
): Promise<{ savedPath: string; wallMs: number }> {
  console.log(`\n=== Queueing variant ${label} ===`);
  const t0 = Date.now();
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
  const outName = `probe_klein_gguf_${label}_s${SCENE}shot${SHOT}_${stamp}.png`;
  const savedPath = await client.downloadImage(
    first.filename,
    first.subfolder,
    first.type,
    outName,
  );
  const wallMs = Date.now() - t0;
  console.log(`  variant ${label} → ${savedPath}  (wall: ${(wallMs / 1000).toFixed(1)}s)`);
  return { savedPath, wallMs };
}

async function main() {
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!existsSync(WORKFLOW_PATH)) throw new Error(`Workflow not found: ${WORKFLOW_PATH}`);
  if (!existsSync(SHOT_IMAGE_PROMPT_PATH) && !process.env['PROMPT_OVERRIDE']) {
    throw new Error(`Image-prompt JSON not found: ${SHOT_IMAGE_PROMPT_PATH}`);
  }

  const { promptText, refPaths } = getPromptAndRefs();
  for (const p of refPaths) {
    if (!existsSync(p)) throw new Error(`Reference image missing: ${p}`);
  }

  console.log(`Workflow    : ${WORKFLOW_PATH}`);
  console.log(`Project     : ${PROJECT_DIR}`);
  console.log(`Scene/Shot  : s${SCENE} / shot ${SHOT} (${FRAME_KEY})`);
  console.log(`Seed        : ${SEED}`);
  console.log(`References  : ${refPaths.map(p => basename(p)).join(', ')}`);
  console.log(`Prompt      : ${promptText.slice(0, 160)}...`);

  const template = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf-8'));
  const client = new ComfyUIClient({ outputDir: OUTPUT_DIR });

  const uploadedRefNames: string[] = [];
  for (let i = 0; i < refPaths.length; i++) {
    const p = refPaths[i]!;
    console.log(`\nUploading ref ${i + 1} ${basename(p)}...`);
    const up = await client.uploadImage(p, 'input', true);
    console.log(`  uploaded as: ${up.name}`);
    uploadedRefNames.push(up.name);
  }

  const runStamp = Date.now();
  const results: Record<string, { savedPath: string; wallMs: number }> = {};
  for (const variant of VARIANTS) {
    const wf = buildWorkflow(
      template,
      uploadedRefNames,
      promptText,
      SEED,
      `probe_klein_gguf_${variant}_${runStamp}`,
      variant,
    );
    results[variant] = await runVariant(client, wf, variant);
  }

  const sidecar = {
    projectDir: PROJECT_DIR,
    scene: SCENE,
    shot: SHOT,
    frameKey: FRAME_KEY,
    workflow: WORKFLOW_PATH,
    refPaths,
    promptText,
    seed: SEED,
    variants: VARIANTS,
    results,
    ranAt: new Date().toISOString(),
  };
  const sidecarPath = join(
    OUTPUT_DIR,
    `probe_klein_gguf_s${SCENE}shot${SHOT}_${runStamp}.json`,
  );
  writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2));

  console.log('\n=== Summary ===');
  const baseMs = results[VARIANTS[0]!]?.wallMs ?? 0;
  for (const v of VARIANTS) {
    const r = results[v];
    if (!r) continue;
    const ratio = baseMs > 0 ? r.wallMs / baseMs : 1;
    console.log(
      `${v.padEnd(22)} → ${r.savedPath}  ${(r.wallMs / 1000).toFixed(1)}s  ` +
      `(${ratio === 1 ? 'baseline' : `${ratio.toFixed(2)}x vs ${VARIANTS[0]}`})`,
    );
  }
  console.log(`Sidecar → ${sidecarPath}`);
}

main().catch(err => {
  console.error('Probe failed:', err);
  process.exit(1);
});
