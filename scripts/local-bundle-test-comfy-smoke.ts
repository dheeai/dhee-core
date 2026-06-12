#!/usr/bin/env tsx
/**
 * Direct ComfyUI smoke test for the user-installed local_bundle_test bundle.
 *
 * No LLM calls and no bundle walker. This script loads the three workflow
 * JSON files, patches concrete prompt/image/timeline inputs in memory, calls
 * ComfyUI through its HTTP/WS APIs, downloads the generated artifacts, and
 * writes a small manifest.
 *
 * Usage:
 *   pnpm exec tsx scripts/local-bundle-test-comfy-smoke.ts \
 *     --url http://100.93.149.119:8188 \
 *     --bundle-dir ~/.kshana/bundles/local_bundle_test \
 *     --output /tmp/local-bundle-test-comfy-direct
 */

import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { ComfyUIClient, type ImageInfo, type WSProgressInfo } from '../src/services/comfyui/index.js';

type WorkflowNode = {
  class_type: string;
  inputs: Record<string, unknown>;
  _meta?: Record<string, unknown>;
};
type ApiWorkflow = Record<string, WorkflowNode>;

interface Args {
  url: string;
  bundleDir: string;
  output: string;
  skipVideo: boolean;
}

interface RunResult {
  promptId: string;
  savedPath: string;
  remoteFilename: string;
}

const DEFAULT_URL = 'http://100.93.149.119:8188';
const DEFAULT_BUNDLE_DIR = '~/.kshana/bundles/local_bundle_test';
const DEFAULT_OUTPUT = '/tmp/local-bundle-test-comfy-direct';

function expandPath(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function parseArgs(): Args {
  const out: Args = {
    url: process.env['COMFYUI_BASE_URL'] || DEFAULT_URL,
    bundleDir: expandPath(DEFAULT_BUNDLE_DIR),
    output: DEFAULT_OUTPUT,
    skipVideo: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const next = argv[i + 1];
    if (a === '--url' && next) {
      out.url = next;
      i += 1;
    } else if (a === '--bundle-dir' && next) {
      out.bundleDir = expandPath(next);
      i += 1;
    } else if (a === '--output' && next) {
      out.output = next;
      i += 1;
    } else if (a === '--skip-video') {
      out.skipVideo = true;
    } else if (a === '--help' || a === '-h') {
      console.log(`Usage: pnpm exec tsx scripts/local-bundle-test-comfy-smoke.ts [--url ${DEFAULT_URL}] [--bundle-dir ${DEFAULT_BUNDLE_DIR}] [--output ${DEFAULT_OUTPUT}] [--skip-video]`);
      process.exit(0);
    }
  }
  out.bundleDir = resolve(out.bundleDir);
  out.output = resolve(out.output);
  return out;
}

function loadWorkflow(bundleDir: string, file: string): ApiWorkflow {
  const p = join(bundleDir, 'workflows', file);
  if (!existsSync(p)) throw new Error(`workflow not found: ${p}`);
  return JSON.parse(readFileSync(p, 'utf8')) as ApiWorkflow;
}

function cloneWorkflow(workflow: ApiWorkflow): ApiWorkflow {
  return JSON.parse(JSON.stringify(workflow)) as ApiWorkflow;
}

function requireNode(workflow: ApiWorkflow, id: string, classType?: string): WorkflowNode {
  const node = workflow[id];
  if (!node) throw new Error(`workflow missing node ${id}`);
  if (classType && node.class_type !== classType) {
    throw new Error(`workflow node ${id} expected ${classType}, got ${node.class_type}`);
  }
  return node;
}

function seed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

function logProgress(prefix: string): (info: WSProgressInfo) => void {
  return (info) => {
    if (info.percentage !== undefined && info.message) {
      console.log(`  ${prefix} [${info.percentage.toFixed(0)}%] ${info.message}`);
    }
  };
}

async function runAndDownload(
  client: ComfyUIClient,
  workflow: ApiWorkflow,
  opts: {
    label: string;
    outputName: string;
    extensions: RegExp;
  },
): Promise<RunResult> {
  console.log(`\nSubmitting ${opts.label}...`);
  const t0 = Date.now();
  const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(
    workflow as unknown as Record<string, unknown>,
    logProgress(opts.label),
  );
  const seconds = Math.floor((Date.now() - t0) / 1000);
  console.log(`  ${opts.label} completed in ${seconds}s (prompt_id=${promptId})`);

  const historyOutputs = await client.getOutputImages(promptId);
  const seen = new Set<string>();
  const all = [...wsOutputs, ...historyOutputs]
    .filter((o: ImageInfo) => opts.extensions.test(o.filename))
    .filter((o: ImageInfo) => !seen.has(`${o.type}/${o.subfolder}/${o.filename}`) && seen.add(`${o.type}/${o.subfolder}/${o.filename}`));

  if (all.length === 0) {
    throw new Error(`${opts.label}: no matching output for ${opts.extensions}`);
  }

  const item = all[0]!;
  const savedPath = await client.downloadImage(
    item.filename,
    item.subfolder ?? '',
    item.type ?? 'output',
    opts.outputName,
  );
  console.log(`  ${opts.label} saved: ${savedPath}`);
  return { promptId, savedPath, remoteFilename: item.filename };
}

async function makeZitImage(
  client: ComfyUIClient,
  base: ApiWorkflow,
  opts: {
    label: string;
    prompt: string;
    outputName: string;
    width: number;
    height: number;
  },
): Promise<RunResult> {
  const wf = cloneWorkflow(base);
  requireNode(wf, '16', 'UNETLoader').inputs['unet_name'] = 'zit_turbo_stableyogi_bf16.safetensors';
  requireNode(wf, '6', 'CLIPTextEncode').inputs['text'] = opts.prompt;
  requireNode(wf, '7', 'CLIPTextEncode').inputs['text'] = 'low quality, blurry, distorted, watermark, text, logo';
  requireNode(wf, '13', 'EmptySD3LatentImage').inputs['width'] = opts.width;
  requireNode(wf, '13', 'EmptySD3LatentImage').inputs['height'] = opts.height;
  requireNode(wf, '3', 'KSampler').inputs['seed'] = seed();
  requireNode(wf, '9', 'SaveImage').inputs['filename_prefix'] = `local_bundle_test/${opts.label}`;
  return runAndDownload(client, wf, {
    label: opts.label,
    outputName: opts.outputName,
    extensions: /\.(png|jpg|jpeg|webp)$/i,
  });
}

async function makeQwenEditImage(
  client: ComfyUIClient,
  base: ApiWorkflow,
  outputDir: string,
  settingPath: string,
  characterPath: string,
): Promise<RunResult> {
  const wf = cloneWorkflow(base);
  const baseUp = await client.uploadImage(settingPath, 'input', true);
  const charUp = await client.uploadImage(characterPath, 'input', true);
  console.log(`\nUploaded Qwen refs: base=${basename(settingPath)} -> ${baseUp.name}, ref=${basename(characterPath)} -> ${charUp.name}`);

  requireNode(wf, 'UNET', 'UNETLoader').inputs['unet_name'] = 'Qwen-Image-Edit-2511-FP8_e4m3fn.safetensors';
  requireNode(wf, 'LORA_MA', 'LoraLoaderModelOnly').inputs['lora_name'] = 'qwen-image-edit-2511-multiple-angles-lora.safetensors';
  requireNode(wf, 'LORA_MA', 'LoraLoaderModelOnly').inputs['strength_model'] = 0.9;
  requireNode(wf, 'LORA_QW_UNCH', 'LoraLoaderModelOnly').inputs['lora_name'] = 'QWEN_EDIT_Unch.safetensors';
  requireNode(wf, 'LORA_QW_UNCH', 'LoraLoaderModelOnly').inputs['strength_model'] = 1.0;
  requireNode(wf, 'LORA_LIGHT', 'LoraLoaderModelOnly').inputs['lora_name'] = 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors';
  requireNode(wf, 'LORA_LIGHT', 'LoraLoaderModelOnly').inputs['strength_model'] = 1.0;

  requireNode(wf, 'LI', 'LoadImage').inputs['image'] = baseUp.name;
  requireNode(wf, 'REF_1', 'LoadImage').inputs['image'] = charUp.name;
  requireNode(wf, 'REF_2', 'LoadImage').inputs['image'] = charUp.name;
  requireNode(wf, 'POS', 'TextEncodeQwenImageEditPlus').inputs['prompt'] = [
    '<sks> eye-level medium close-up, Mira stands at the clockmaker workbench holding a glowing brass seed above her palm.',
    'Preserve the rain-lit workshop setting, brass tools, warm lamplight, and Mira identity from the reference image.',
    'Cinematic realism, shallow depth of field, no text, no watermark.',
  ].join(' ');
  requireNode(wf, 'NEG', 'TextEncodeQwenImageEditPlus').inputs['prompt'] = 'low quality, blurry, distorted hands, extra fingers, watermark, text, logo';
  requireNode(wf, 'KS', 'KSampler').inputs['seed'] = seed();
  requireNode(wf, 'SAVE', 'SaveImage').inputs['filename_prefix'] = `local_bundle_test/qwen_edit_${Date.now()}`;

  const result = await runAndDownload(client, wf, {
    label: 'qwen_edit_chain',
    outputName: 'qwen_edit_frame.png',
    extensions: /\.(png|jpg|jpeg|webp)$/i,
  });

  writeFileSync(
    join(outputDir, 'qwen_edit_prompt.txt'),
    String(requireNode(wf, 'POS').inputs['prompt']),
    'utf8',
  );
  return result;
}

async function makeLtxVideo(
  client: ComfyUIClient,
  base: ApiWorkflow,
  firstFramePath: string,
): Promise<RunResult> {
  const wf = cloneWorkflow(base);
  const firstFrame = await client.uploadImage(firstFramePath, 'input', true);
  console.log(`\nUploaded LTX guide frame: ${basename(firstFramePath)} -> ${firstFrame.name}`);

  requireNode(wf, '77', 'UNETLoader').inputs['unet_name'] = '10Eros_v1_fp8_model.safetensors';
  requireNode(wf, '80', 'LoraLoaderModelOnly').inputs['lora_name'] = 'ltx-2.3-22b-distilled-lora-fro90_ceil72.safetensors';
  requireNode(wf, '80', 'LoraLoaderModelOnly').inputs['strength_model'] = 1.0;

  const fps = 24;
  const segmentFrames = 49;
  const director = requireNode(wf, '46', 'LTXDirector');
  director.inputs['global_prompt'] = [
    'A rain-lit clockmaker workshop scene in cinematic realism.',
    'Mira studies a glowing brass seed while blue map light rises from her palm.',
    'Natural motion, steady camera, warm lamplight, realistic hands and face.',
  ].join(' ');
  director.inputs['duration_frames'] = segmentFrames;
  director.inputs['duration_seconds'] = segmentFrames / fps;
  director.inputs['timeline_data'] = JSON.stringify({
    segments: [{ type: 'image', imageFile: firstFrame.name, start: 0 }],
    audioSegments: [],
  });
  director.inputs['local_prompts'] = 'Mira gently raises the glowing brass seed, blue light opens above her palm, rain flickers on the workshop window, slow push-in.';
  director.inputs['segment_lengths'] = String(segmentFrames);
  director.inputs['frame_rate'] = fps;
  director.inputs['epsilon'] = 0.001;
  director.inputs['guide_strength'] = '1.0';
  director.inputs['use_custom_audio'] = false;
  director.inputs['custom_width'] = 854;
  director.inputs['custom_height'] = 480;
  director.inputs['divisible_by'] = 32;
  director.inputs['img_compression'] = 18;

  const negativeNode = wf['90'];
  if (negativeNode?.class_type === 'CLIPTextEncode') {
    negativeNode.inputs['text'] = [
      'blurry, oversaturated, pixelated, low resolution, grainy, distorted, noise, compression artifacts, watermark, text, logo, subtitles',
      'distorted sound, saturated sound, narration, voice over, singing, background music',
      'improvised speech, extra dialogue, hallucinated speech, mumbling',
    ].join(', ');
  }

  const noiseNode = wf['28'];
  if (noiseNode?.class_type === 'RandomNoise') {
    noiseNode.inputs['noise_seed'] = seed();
  }
  const saveNode = wf['30'];
  if (saveNode?.class_type === 'SaveVideo') {
    saveNode.inputs['filename_prefix'] = `local_bundle_test/ltx_direct_${Date.now()}`;
  }

  return runAndDownload(client, wf, {
    label: 'ltx_director',
    outputName: 'ltx_director_clip.mp4',
    extensions: /\.(mp4|webm|mov)$/i,
  });
}

async function main(): Promise<void> {
  const args = parseArgs();
  process.env['COMFYUI_BASE_URL'] = args.url;
  process.env['COMFYUI_WS_TIMEOUT'] = process.env['COMFYUI_WS_TIMEOUT'] || '900';

  mkdirSync(args.output, { recursive: true });
  if (!existsSync(args.bundleDir)) throw new Error(`bundle dir not found: ${args.bundleDir}`);

  const client = new ComfyUIClient({ baseUrl: args.url, outputDir: args.output, timeout: 900 });
  console.log('Direct Comfy smoke test for local_bundle_test');
  console.log(`Comfy URL:  ${args.url}`);
  console.log(`Bundle dir: ${args.bundleDir}`);
  console.log(`Output dir: ${args.output}`);

  const zimage = loadWorkflow(args.bundleDir, 'zimage_tti.json');
  const qwen = loadWorkflow(args.bundleDir, 'qwen_edit_multi.json');
  const ltx = loadWorkflow(args.bundleDir, 'ltx_director_local.json');

  const character = await makeZitImage(client, zimage, {
    label: 'zit_character',
    outputName: 'zit_character.png',
    width: 1024,
    height: 1024,
    prompt: [
      'Cinematic realism portrait of Mira, a young clockmaker in a rain-lit workshop.',
      'South Asian woman in her late twenties, focused eyes, dark wavy hair tied back, rolled linen sleeves, brass loupe necklace, oil-smudged fingertips.',
      'Warm lamplight, shallow depth of field, detailed skin texture, no text, no watermark.',
    ].join(' '),
  });

  const setting = await makeZitImage(client, zimage, {
    label: 'zit_setting',
    outputName: 'zit_setting.png',
    width: 1024,
    height: 1024,
    prompt: [
      'Cinematic realism image of a rain-lit clockmaker workshop at night.',
      'Wooden workbench covered with brass gears, tiny springs, antique clocks, glass jars, warm desk lamp, blue reflections from rain on the window.',
      'Highly detailed production still, no people, no text, no watermark.',
    ].join(' '),
  });

  const qwenFrame = await makeQwenEditImage(client, qwen, args.output, setting.savedPath, character.savedPath);
  const ltxVideo = args.skipVideo ? null : await makeLtxVideo(client, ltx, qwenFrame.savedPath);

  const manifest = {
    ranAt: new Date().toISOString(),
    comfyUrl: args.url,
    bundleDir: args.bundleDir,
    outputs: {
      zitCharacter: character,
      zitSetting: setting,
      qwenEditFrame: qwenFrame,
      ltxDirectorClip: ltxVideo,
    },
  };
  const manifestPath = join(args.output, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log('\nDone.');
  console.log(`Manifest: ${manifestPath}`);
  console.log(`ZIT character: ${character.savedPath}`);
  console.log(`ZIT setting:   ${setting.savedPath}`);
  console.log(`Qwen frame:    ${qwenFrame.savedPath}`);
  if (ltxVideo) console.log(`LTX video:     ${ltxVideo.savedPath}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : err);
  process.exit(1);
});
