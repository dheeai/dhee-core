#!/usr/bin/env tsx
/**
 * One-off: render Ruby V3 Scene 1 as a continuous LTX Director relay video,
 * using the Qwen-chain-generated first-frames at qwen_scene1/.
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

const PROJ = '/Users/ganaraj/dhee-studios/Ruby V3';
const SCENE = 1;
const FPS = 24;
const WORKFLOW = '/Users/ganaraj/Projects/dhee-core/src/dag/bundles/narrative_prompt_relay/workflows/ltx_director_local.json';

function alignToLTX(rawFrames: number[]): number[] {
  const rounded = rawFrames.map((f) => Math.max(8, Math.round(f / 8) * 8));
  rounded[0] = rounded[0]! + 1;
  return rounded;
}

async function main() {
  const localUrl = process.env['ENDPOINT_self_local'];
  if (!localUrl) { console.error('ENDPOINT_self_local not set'); process.exit(1); }

  // Load scene plan for durations.
  const plan = JSON.parse(readFileSync(join(PROJ, `prompts/videos/scenes/scene_${SCENE}.plan.json`), 'utf-8')) as {
    sceneTitle: string;
    shotPlan: Array<{ shotNumber: number; duration: number; oneLineSummary: string }>;
  };
  console.log(`Scene: ${plan.sceneTitle}`);
  console.log(`Shots:`);

  const firstFrames: string[] = [];
  const shots: Array<{ shotNumber: number; duration: number; description: string; cameraWork?: string; audio?: string }> = [];

  for (const sp of plan.shotPlan) {
    const ff = join(PROJ, `assets/images/qwen_scene1/s${SCENE}_shot${sp.shotNumber}_first.png`);
    if (!existsSync(ff)) { console.error(`missing first-frame: ${ff}`); process.exit(1); }
    firstFrames.push(ff);

    const motionPath = join(PROJ, `prompts/motion/scene_${SCENE}_shot_${sp.shotNumber}.json`);
    const motion = JSON.parse(readFileSync(motionPath, 'utf-8')) as { motionDirective?: string; description?: string; cameraWork?: string; audio?: string };
    const desc = motion.motionDirective ?? motion.description ?? sp.oneLineSummary;

    shots.push({
      shotNumber: sp.shotNumber,
      duration: Math.round(sp.duration),
      description: desc,
      ...(motion.cameraWork ? { cameraWork: motion.cameraWork } : {}),
      ...(motion.audio ? { audio: motion.audio } : {}),
    });
    console.log(`  ${sp.shotNumber}: ${sp.duration}s → ${basename(ff)}`);
  }

  const totalRawFrames = shots.reduce((acc, s) => acc + s.duration * FPS, 0);
  console.log(`Total raw frames: ${totalRawFrames} (${(totalRawFrames / FPS).toFixed(1)}s)`);

  // Align frames per LTX (×8, first +1).
  const segmentFrames = alignToLTX(shots.map((s) => s.duration * FPS));
  const totalFrames = segmentFrames.reduce((a, b) => a + b, 0);
  console.log(`LTX-aligned segments: [${segmentFrames.join(', ')}] = ${totalFrames} frames`);
  if (totalFrames > 1000) { console.error('exceeds 1000-frame cap'); process.exit(1); }

  const segmentStarts: number[] = [];
  { let acc = 0; for (const f of segmentFrames) { segmentStarts.push(acc); acc += f; } }

  // Build local prompts (description + cameraWork + audio).
  const localPrompts = shots.map((s) => {
    const parts: string[] = [];
    if (s.description) parts.push(s.description.trim());
    if (s.cameraWork) parts.push(s.cameraWork.trim());
    if (s.audio) parts.push(`Audio: ${s.audio.trim()}`);
    return parts.join(' ');
  });
  const globalPrompt = `${plan.sceneTitle}. Cinematic realism, warm rose and gold palette.`;

  // Upload first frames + build workflow.
  const outDir = join(PROJ, 'assets/videos/qwen_chain');
  mkdirSync(outDir, { recursive: true });
  const client = new ComfyUIClient({ outputDir: outDir, baseUrl: localUrl });

  console.log(`Uploading ${firstFrames.length} first frames to local Comfy...`);
  const uploadedNames: string[] = [];
  for (let i = 0; i < firstFrames.length; i++) {
    const u = await client.uploadImage(firstFrames[i]!, 'input', true);
    console.log(`  shot ${shots[i]!.shotNumber}: ${basename(firstFrames[i]!)} → ${u.name}`);
    uploadedNames.push(u.name);
  }

  const timelineData = {
    segments: shots.map((_, i) => ({ type: 'image', imageFile: uploadedNames[i]!, start: segmentStarts[i]! })),
    audioSegments: [] as unknown[],
  };

  const baseWorkflow = JSON.parse(readFileSync(WORKFLOW, 'utf-8')) as Record<string, { inputs: Record<string, unknown>; class_type: string }>;
  const workflow: Record<string, { inputs: Record<string, unknown>; class_type: string }> = JSON.parse(JSON.stringify(baseWorkflow));

  const director = workflow['46'];
  if (!director || director.class_type !== 'LTXDirector') { console.error('workflow missing LTXDirector @ 46'); process.exit(1); }
  director.inputs['global_prompt'] = globalPrompt;
  director.inputs['duration_frames'] = totalFrames;
  director.inputs['duration_seconds'] = totalFrames / FPS;
  director.inputs['timeline_data'] = JSON.stringify(timelineData);
  director.inputs['local_prompts'] = localPrompts.join(' | ');
  director.inputs['segment_lengths'] = segmentFrames.join(', ');
  director.inputs['frame_rate'] = FPS;
  director.inputs['epsilon'] = 0.001;
  director.inputs['guide_strength'] = shots.map(() => '1.0').join(', ');
  director.inputs['use_custom_audio'] = false;
  director.inputs['custom_width'] = 854;
  director.inputs['custom_height'] = 480;
  director.inputs['divisible_by'] = 32;
  director.inputs['img_compression'] = 18;

  const seed = Math.floor(Math.random() * 0x7fffffff);
  if (workflow['28']) workflow['28']!.inputs['noise_seed'] = seed;
  if (workflow['30']) workflow['30']!.inputs['filename_prefix'] = `ruby_scene1_qwen_chain/${Date.now()}`;

  console.log(`Submitting (${shots.length} shots, ${totalFrames} frames = ${(totalFrames / FPS).toFixed(1)}s @ ${FPS}fps, seed=${seed})...`);
  const start = Date.now();
  const { promptId, outputs } = await client.queueAndWaitWS(workflow, (p) => {
    if (p.percentage !== undefined && p.message) {
      process.stdout.write(`\r  [${p.percentage.toFixed(0)}%] ${p.message}              `);
    }
  });
  console.log(`\n  done in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

  const hist = await client.getOutputImages(promptId);
  const all = [...outputs, ...hist].filter((o) => /\.(mp4|webm|mov)$/i.test(o.filename));
  if (all.length === 0) { console.error('no video output'); process.exit(1); }
  const item = all[0]!;
  const target = `scene_1_qwen_chain_${Date.now()}.mp4`;
  const saved = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);

  // Meta sidecar.
  writeFileSync(saved.replace(/\.[^.]+$/, '.meta.json'), JSON.stringify({ globalPrompt, localPrompts, segmentFrames, totalFrames, fps: FPS, seed, promptId, firstFrames }, null, 2));
  console.log(`Saved: ${saved}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
