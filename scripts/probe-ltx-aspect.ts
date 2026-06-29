#!/usr/bin/env tsx
/**
 * Aspect-ratio probe for comfy.ltx_director: confirms that pre-normalizing
 * first-frame images to a uniform target aspect ratio makes the LTXDirector
 * node emit the correct output dimensions (instead of collapsing to 512×512).
 *
 * Takes N first-frame images, crops each (center) to the target W×H via
 * ffmpeg, uploads them, and submits the director workflow with matching
 * custom_width/custom_height. Reports the resulting mp4 dimensions.
 *
 * Usage:
 *   pnpm tsx scripts/probe-ltx-aspect.ts <img1> <img2> ... [--w 768] [--h 432]
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

process.env['COMFY_MODE'] = 'local';
process.env['COMFYUI_BASE_URL'] = process.env['COMFY_LOCAL_URL'] ?? 'http://100.93.149.119:8188/';

const args = process.argv.slice(2);
const imgs: string[] = [];
let W = 768;
let H = 432;
for (const a of args) {
  if (a.startsWith('--w=')) W = parseInt(a.slice(4), 10);
  else if (a.startsWith('--h=')) H = parseInt(a.slice(4), 10);
  else imgs.push(a);
}
if (imgs.length === 0) {
  console.error('Pass at least one image path');
  process.exit(1);
}

// Snap target to divisible-by-32 (LTX requirement).
W = Math.round(W / 32) * 32;
H = Math.round(H / 32) * 32;
console.log(`Target output: ${W}×${H} (16:9 = ${(W / H).toFixed(3)})`);

const outDir = join(tmpdir(), 'ltx-aspect-probe');
mkdirSync(outDir, { recursive: true });

// Center-crop each image to the exact target W×H with ffmpeg.
const normalized: string[] = [];
for (const img of imgs) {
  if (!existsSync(img)) {
    console.error(`Not found: ${img}`);
    process.exit(1);
  }
  const dst = join(outDir, `norm_${W}x${H}_${basename(img)}`);
  execFileSync('ffmpeg', ['-y', '-i', img, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, dst], { stdio: 'ignore' });
  normalized.push(dst);
  console.log(`  normalized ${basename(img)} → ${W}×${H}`);
}

const workflowPath = resolve('workflows/built-in/ltx23_director_local.json');
const base = JSON.parse(readFileSync(workflowPath, 'utf-8')) as Record<
  string,
  { inputs: Record<string, unknown>; class_type: string }
>;
const workflow = JSON.parse(JSON.stringify(base));

const FPS = 24;
const segFrames = (() => {
  const raw = normalized.map(() => 3 * FPS); // 3s each
  raw[0] = raw[0]! + 1;
  return raw;
})();
const totalFrames = segFrames.reduce((a, b) => a + b, 0);
const segStarts: number[] = [];
{
  let acc = 0;
  for (const f of segFrames) {
    segStarts.push(acc);
    acc += f;
  }
}

const client = new ComfyUIClient({ outputDir: outDir });
console.log('\nUploading normalized first frames...');
const uploaded: string[] = [];
for (let i = 0; i < normalized.length; i++) {
  const u = await client.uploadImage(normalized[i]!, 'input', true);
  console.log(`  ${basename(normalized[i]!)} → ${u.name}`);
  uploaded.push(u.name);
}

const timelineData = {
  segments: uploaded.map((name, i) => ({ type: 'image', imageFile: name, start: segStarts[i] })),
  audioSegments: [],
};

const director = workflow['46']!;
director.inputs['global_prompt'] = 'cinematic_realism, 16:9 widescreen composition';
director.inputs['duration_frames'] = totalFrames;
director.inputs['duration_seconds'] = totalFrames / FPS;
director.inputs['timeline_data'] = JSON.stringify(timelineData);
director.inputs['local_prompts'] = normalized.map((_, i) => `shot ${i + 1} motion`).join(' | ');
director.inputs['segment_lengths'] = segFrames.join(', ');
director.inputs['frame_rate'] = FPS;
director.inputs['epsilon'] = 0.001;
director.inputs['guide_strength'] = normalized.map(() => '1.0').join(', ');
director.inputs['use_custom_audio'] = false;
director.inputs['custom_width'] = W;
director.inputs['custom_height'] = H;
director.inputs['resize_method'] = 'crop';
director.inputs['divisible_by'] = 32;
director.inputs['img_compression'] = 18;

const seed = Math.floor(Math.random() * 0x7fffffff);
const noise = workflow['28'];
if (noise) noise.inputs['noise_seed'] = seed;
const save = workflow['30'];
if (save) save.inputs['filename_prefix'] = `aspect_probe/${Date.now()}`;

console.log(`\nSubmitting (${totalFrames} frames, ${normalized.length} segments)...`);
const t0 = Date.now();
const { promptId, outputs } = await client.queueAndWaitWS(workflow, (p) => {
  if (p.percentage !== undefined && p.message) console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
});
console.log(`  done in ${Math.floor((Date.now() - t0) / 1000)}s (id=${promptId})`);

const hist = await client.getOutputImages(promptId);
const seen = new Set<string>();
const vids = [...outputs, ...hist]
  .filter((i) => /\.(mp4|webm|mov)$/i.test(i.filename))
  .filter((i) => !seen.has(i.filename) && seen.add(i.filename));
if (vids.length === 0) {
  console.error('No video output');
  process.exit(1);
}

const dl = await client.downloadImage(vids[0]!.filename, vids[0]!.subfolder ?? '', vids[0]!.type ?? 'output', `aspect_${Date.now()}.mp4`);
console.log(`\nVideo: ${dl}`);

// ffprobe the result dimensions.
try {
  const dims = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height',
    '-of', 'csv=p=0', dl,
  ], { encoding: 'utf-8' }).trim();
  const [w, h] = dims.split(',').map((n) => parseInt(n, 10));
  console.log(`Output dims: ${w}×${h} (ratio ${(w! / h!).toFixed(3)})`);
  const ok = Math.abs(w! / h! - W / H) < 0.05;
  console.log(ok ? '✓ ASPECT RATIO CORRECT' : '✗ ASPECT RATIO WRONG');
} catch (e) {
  console.log('(ffprobe unavailable)');
}
