#!/usr/bin/env tsx
/**
 * Full Ruby V3 image-chain pass using Qwen Edit + Multi-Angle + Lightning on
 * cloud Comfy. For each scene:
 *   - Use Klein's existing shot 1 first-frame as the chain base.
 *   - For shots 2..N, generate a delta-edit prompt via DeepSeek, then run
 *     Qwen Edit chain (image1=prev shot, image2/3=character refs).
 *
 * All outputs land at assets/images/qwen_chain/s{N}_shot{M}_first.png and
 * delta prompts are saved at prompts/qwen_chain/scene_{N}_shot_{M}.json.
 *
 * Args:
 *   --scene N         only run scene N (default: all)
 *   --dry-run         print plan + LLM-generated prompts only, no Comfy calls
 */
import 'dotenv/config';
import { readFileSync, readdirSync, existsSync, mkdirSync, copyFileSync, writeFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { LLMRouter, loadRoutingFromEnv, isRoutingEnabledFromEnv } from '../src/core/llm/router.js';
import { getLLMConfig } from '../src/core/llm/config.js';

const PROJ = '/Users/ganaraj/dhee-studios/Ruby V3';

const CLOUD_UNET           = 'qwen_image_edit_2511_bf16.safetensors';
const CLOUD_LIGHTNING_LORA = 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors';
const CLOUD_MULTI_ANGLE    = 'qwen-image-edit-2511-multiple-angles-lora.safetensors';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}
function flag(name: string): boolean { return process.argv.includes(`--${name}`); }

interface ShotPlan { shotNumber: number; description?: string; cameraWork?: string; dialogue?: string }

function loadShotPlan(sceneN: number, shotN: number): ShotPlan {
  const p = join(PROJ, `prompts/videos/scenes/scene_${sceneN}.shots/${shotN}.json`);
  const raw = JSON.parse(readFileSync(p, 'utf-8')) as Record<string, unknown>;
  return {
    shotNumber: shotN,
    description: raw['description'] as string | undefined,
    cameraWork: raw['cameraWork'] as string | undefined,
    dialogue: raw['dialogue'] as string | undefined,
  };
}

function listScenes(): number[] {
  const dir = join(PROJ, 'prompts/videos/scenes');
  return readdirSync(dir)
    .filter((f) => /^scene_\d+\.shots$/.test(f))
    .map((f) => parseInt(f.match(/scene_(\d+)/)![1]!, 10))
    .sort((a, b) => a - b);
}
function listShots(sceneN: number): number[] {
  const dir = join(PROJ, `prompts/videos/scenes/scene_${sceneN}.shots`);
  return readdirSync(dir).filter((f) => /^\d+\.json$/.test(f)).map((f) => parseInt(f.split('.')[0]!, 10)).sort((a, b) => a - b);
}
function findKleinShot1(sceneN: number): string | null {
  const dir = join(PROJ, 'assets/images');
  const files = readdirSync(dir)
    .filter((f) => new RegExp(`^s${sceneN}shot1_first_frame_klein_.*\\.png$`).test(f))
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? join(dir, files[0]!.name) : null;
}
function findCharRef(charId: string): string | null {
  const dir = join(PROJ, 'assets/images');
  const f = readdirSync(dir).find((x) => new RegExp(`^CharRef_${charId}_`).test(x));
  return f ? join(dir, f) : null;
}

const DELTA_PROMPT_INSTRUCTIONS = `You write delta-edit instructions for the Qwen Image Edit 2511 model with the lovis Multi-Angles LoRA stacked on top.

Inputs you'll be given:
- PREV_SHOT_DESC: what the previous shot showed
- PREV_SHOT_CAMERA: previous shot's camera work
- THIS_SHOT_DESC: what THIS shot should show
- THIS_SHOT_CAMERA: this shot's camera work
- CHARACTERS_PRESENT: list of characters expected in this shot

The model takes the PREVIOUS shot's first frame as its base image and edits it into the new shot. You're writing the edit instruction.

CRITICAL — write the prompt in this exact format:

<sks> {azimuth} {elevation} {distance}, <natural-language description of WHAT CHANGES from the previous shot to this one — new actions, who entered/left, camera motion, expression changes, but DO NOT restate things that haven't changed>. Same setting, same lighting, same characters except as noted. Photorealistic.

Azimuth choices (the camera's position relative to the SUBJECT — pick based on this shot's perspective):
  - front view (subject faces camera)
  - front-right quarter view
  - right side view (profile right)
  - back-right quarter view  (OTS over right shoulder)
  - back view (camera behind subject)
  - back-left quarter view (OTS over left shoulder)
  - left side view (profile left)
  - front-left quarter view

Elevation choices:
  - low-angle shot (camera below subject, looking up — power/looming)
  - eye-level shot (default)
  - elevated shot (slightly above)
  - high-angle shot (camera looking down — vulnerability)

Distance choices:
  - close-up (face / object detail)
  - medium shot (waist-up two-shot, single mid-frame)
  - wide shot (full body / environment establishing)

Pick the SINGLE best azimuth+elevation+distance combo from the camera-work description. For OTS shots, use back-right or back-left quarter view + the appropriate distance.

Output ONLY the prompt text. No preamble, no explanation, no quotes around it.`;

function buildLLMUserMessage(prev: ShotPlan, curr: ShotPlan, charsPresent: string[]): string {
  return `PREV_SHOT_DESC: ${prev.description ?? '(none)'}
PREV_SHOT_CAMERA: ${prev.cameraWork ?? '(none)'}
THIS_SHOT_DESC: ${curr.description ?? '(none)'}
THIS_SHOT_CAMERA: ${curr.cameraWork ?? '(none)'}
THIS_SHOT_DIALOGUE: ${curr.dialogue ?? '(none)'}
CHARACTERS_PRESENT: ${charsPresent.join(', ')}`;
}

interface APINode { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }
type APIWorkflow = Record<string, APINode>;

function buildQwenWorkflow(opts: { baseImageName: string; prompt: string; refNames: string[] }): APIWorkflow {
  const wf: APIWorkflow = {};
  wf['UNET']       = { class_type: 'UNETLoader', inputs: { unet_name: CLOUD_UNET, weight_dtype: 'default' } };
  wf['LORA_MA']    = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: CLOUD_MULTI_ANGLE, strength_model: 0.9, model: ['UNET', 0] } };
  wf['LORA_LIGHT'] = { class_type: 'LoraLoaderModelOnly', inputs: { lora_name: CLOUD_LIGHTNING_LORA, strength_model: 1.0, model: ['LORA_MA', 0] } };
  wf['MSAF']       = { class_type: 'ModelSamplingAuraFlow', inputs: { shift: 3.1, model: ['LORA_LIGHT', 0] } };
  wf['CFGN']       = { class_type: 'CFGNorm', inputs: { strength: 1.0, model: ['MSAF', 0] } };
  wf['CLIP']       = { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', type: 'qwen_image', device: 'default' } };
  wf['VAE']        = { class_type: 'VAELoader', inputs: { vae_name: 'qwen_image_vae.safetensors' } };
  wf['LI']         = { class_type: 'LoadImage', inputs: { image: opts.baseImageName } };
  wf['SCALE']      = { class_type: 'FluxKontextImageScale', inputs: { image: ['LI', 0] } };
  wf['ENC']        = { class_type: 'VAEEncode', inputs: { pixels: ['SCALE', 0], vae: ['VAE', 0] } };
  const refIds: string[] = [];
  opts.refNames.slice(0, 2).forEach((n, i) => {
    const id = `REF_${i + 1}`;
    wf[id] = { class_type: 'LoadImage', inputs: { image: n } };
    refIds.push(id);
  });
  const posInputs: Record<string, unknown> = { prompt: opts.prompt, clip: ['CLIP', 0], vae: ['VAE', 0], image1: ['SCALE', 0] };
  if (refIds[0]) posInputs['image2'] = [refIds[0], 0];
  if (refIds[1]) posInputs['image3'] = [refIds[1], 0];
  wf['POS']     = { class_type: 'TextEncodeQwenImageEditPlus', inputs: posInputs };
  wf['NEG']     = { class_type: 'TextEncodeQwenImageEditPlus', inputs: { prompt: '', clip: ['CLIP', 0], vae: ['VAE', 0], image1: ['SCALE', 0] } };
  wf['REF_POS'] = { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { reference_latents_method: 'index_timestep_zero', conditioning: ['POS', 0] } };
  wf['REF_NEG'] = { class_type: 'FluxKontextMultiReferenceLatentMethod', inputs: { reference_latents_method: 'index_timestep_zero', conditioning: ['NEG', 0] } };
  wf['KS']      = { class_type: 'KSampler', inputs: { seed: Math.floor(Math.random() * 0x7fffffff), steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1, model: ['CFGN', 0], positive: ['REF_POS', 0], negative: ['REF_NEG', 0], latent_image: ['ENC', 0] } };
  wf['DEC']     = { class_type: 'VAEDecode', inputs: { samples: ['KS', 0], vae: ['VAE', 0] } };
  wf['SAVE']    = { class_type: 'SaveImage', inputs: { images: ['DEC', 0], filename_prefix: 'ruby_chain' } };
  return wf;
}

async function main() {
  const sceneArg = arg('scene', '');
  const dryRun = flag('dry-run');
  const scenes = sceneArg ? [parseInt(sceneArg, 10)] : listScenes();

  const cloudUrl = process.env['ENDPOINT_public_cloud'];
  if (!cloudUrl) { console.error('ENDPOINT_public_cloud not set'); process.exit(1); }

  // Set up LLM router (DeepSeek per env).
  const router = new LLMRouter(getLLMConfig(), loadRoutingFromEnv(), isRoutingEnabledFromEnv());
  const llm = router.getClient('content.story');

  const imageOutDir = join(PROJ, 'assets/images/qwen_chain');
  const promptOutDir = join(PROJ, 'prompts/qwen_chain');
  mkdirSync(imageOutDir, { recursive: true });
  mkdirSync(promptOutDir, { recursive: true });

  const client = new ComfyUIClient({ outputDir: imageOutDir, baseUrl: cloudUrl });

  // Build the character list mapping shotPlan.json doesn't carry — we just always pass ruby+angel
  // and surface in logs when other chars are mentioned in the description.
  const rubyRef = findCharRef('ruby');
  const angelRef = findCharRef('angel');
  if (!rubyRef || !angelRef) { console.error('missing ruby or angel char ref'); process.exit(1); }
  const refUploads: Record<string, string> = {};

  // Upload character refs once per session.
  if (!dryRun) {
    for (const [key, p] of [['ruby', rubyRef], ['angel', angelRef]] as const) {
      const u = await client.uploadImage(p, 'input', true);
      refUploads[key] = u.name;
      console.log(`  ref ${key}: ${u.name}`);
    }
  }

  for (const sceneN of scenes) {
    const shots = listShots(sceneN);
    console.log(`\n══ Scene ${sceneN} (${shots.length} shots) ══`);

    // Set base = Klein's shot 1.
    const klein1 = findKleinShot1(sceneN);
    if (!klein1) { console.error(`no klein shot 1 for scene ${sceneN}`); continue; }
    const baseOut = join(imageOutDir, `s${sceneN}_shot1_first.png`);
    if (!existsSync(baseOut)) copyFileSync(klein1, baseOut);
    console.log(`  shot 1: ← ${basename(klein1)} (chain base)`);

    let prevPath = baseOut;
    let prevPlan = loadShotPlan(sceneN, 1);

    for (const shotN of shots.slice(1)) {
      const curr = loadShotPlan(sceneN, shotN);

      // ── Generate delta prompt via LLM ──
      const userMsg = buildLLMUserMessage(prevPlan, curr, ['ruby', 'angel']);
      let deltaPrompt = '';
      try {
        const llmStart = Date.now();
        const resp = await llm.generate({
          messages: [
            { role: 'system', content: DELTA_PROMPT_INSTRUCTIONS },
            { role: 'user', content: userMsg },
          ],
          temperature: 0.4,
        });
        deltaPrompt = (resp.content ?? '').trim();
        const llmMs = Date.now() - llmStart;
        console.log(`  shot ${shotN}: LLM (${llmMs}ms) → ${deltaPrompt.slice(0, 140)}${deltaPrompt.length > 140 ? '…' : ''}`);
      } catch (e) {
        console.error(`  shot ${shotN}: LLM failed: ${(e as Error).message}`);
        continue;
      }
      writeFileSync(join(promptOutDir, `scene_${sceneN}_shot_${shotN}.json`), JSON.stringify({ shotNumber: shotN, deltaPrompt, prevShot: prevPlan, thisShot: curr }, null, 2));

      // ── Edge-case surface: flag unfamiliar character mentions ──
      const desc = (curr.description ?? '').toLowerCase();
      for (const c of ['driver', 'owner']) if (desc.includes(c)) console.log(`     ⚠ shot ${shotN} mentions "${c}" — not in char refs (passing ruby+angel only)`);

      if (dryRun) { prevPlan = curr; continue; }

      // ── Upload base + run Qwen Edit ──
      const baseUp = await client.uploadImage(prevPath, 'input', true);
      const refNames = [refUploads['ruby']!, refUploads['angel']!];
      const wf = buildQwenWorkflow({ baseImageName: baseUp.name, prompt: deltaPrompt, refNames });

      const t0 = Date.now();
      const { promptId, outputs } = await client.queueAndWaitWS(wf, () => undefined);
      const hist = await client.getOutputImages(promptId);
      const all = [...outputs, ...hist].filter((o) => /\.png$/i.test(o.filename));
      if (all.length === 0) { console.error(`     ✗ no output`); break; }
      const item = all[0]!;
      const targetName = `s${sceneN}_shot${shotN}_first.png`;
      const saved = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', targetName);
      const dt = Math.floor((Date.now() - t0) / 1000);
      console.log(`     ✓ ${dt}s → ${basename(saved)}`);
      prevPath = saved;
      prevPlan = curr;
    }
  }

  console.log('\nFull chain pass complete.');
}

main().catch((e) => { console.error(e); process.exit(1); });
