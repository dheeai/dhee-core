#!/usr/bin/env tsx
/**
 * One-shot submitter: patches the user's downloaded workflow JSON to
 * fix the segment_lengths/local_prompts mismatch in the
 * PromptRelayEncodeTimeline node, then submits it as-is.
 *
 * The downloaded JSON had:
 *   - local_prompts: shot1 | shot2 | shot3 with a stray double-pipe
 *     between shot 1 and 2 → parser saw 4 prompts (one empty).
 *   - segment_lengths: "73, 1, 96, 118" — phantom "1" + truncated last.
 *
 * Fix: rejoin local_prompts on single `|`; segment_lengths
 * becomes "73, 96, 120" (sum = 289 = max_frames).
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';

process.env['COMFY_MODE'] = 'local';

const SRC = '/Users/ganaraj/Downloads/custom_3shot_17775662202_api74_00001.json';
const projectRoot = resolve(process.cwd(), 'sun_hadnt_yet_cleared-2.dhee');
const outputDir = join(projectRoot, 'assets/videos/promptrelay_probe');
mkdirSync(outputDir, { recursive: true });

const workflow = JSON.parse(readFileSync(SRC, 'utf-8')) as Record<string, { class_type?: string; inputs?: Record<string, unknown> }>;

// Find the PromptRelayEncodeTimeline node and fix its inputs.
let targetId: string | null = null;
for (const [id, node] of Object.entries(workflow)) {
  if (node.class_type === 'PromptRelayEncodeTimeline') {
    targetId = id;
    break;
  }
}
if (!targetId) {
  console.error('No PromptRelayEncodeTimeline node found.');
  process.exit(1);
}
const inp = workflow[targetId]!.inputs!;

const lp = String(inp['local_prompts'] ?? '');
// Split on pipe, trim, drop empties — gives 3 prompts.
const cleanedPrompts = lp.split('|').map(s => s.trim()).filter(s => s.length > 0);
console.log(`local_prompts: ${cleanedPrompts.length} segment(s) after cleanup`);
inp['local_prompts'] = cleanedPrompts.join(' | ');

const max = Number(inp['max_frames']);
const segments = [73, 96, 120];
const sum = segments.reduce((a, b) => a + b, 0);
if (sum !== max) {
  console.warn(`Warning: segment sum ${sum} != max_frames ${max}`);
}
inp['segment_lengths'] = segments.join(', ');
console.log(`segment_lengths: "${inp['segment_lengths']}" (sum=${sum}, max_frames=${max})`);

// Rebuild timeline_data to match the 3 prompts. The downloaded JSON
// had a phantom 1-frame "gap" segment (orange #e07b3a, empty prompt)
// that the timeline editor inserts. The Timeline node uses
// timeline_data as the primary source — leaving the 4-segment shape
// while patching local_prompts to 3 caused index desync (audio bled
// into the gap, last segment lost its prompt). Rebuild from cleanedPrompts.
const COLORS = ['#4f8edc', '#5cb85c', '#d9534f', '#e07b3a', '#9b59b6'];
const newTimeline = {
  segments: cleanedPrompts.map((p, i) => ({
    prompt: p,
    length: segments[i],
    color: COLORS[i % COLORS.length],
  })),
};
inp['timeline_data'] = JSON.stringify(newTimeline);
inp['max_frames'] = sum;
console.log(`timeline_data: rebuilt to ${cleanedPrompts.length} segments matching local_prompts`);
console.log(`max_frames: ${sum}`);

// Add a PromptRelayAdvancedOptions node. Earlier run with strength=2.0
// + epsilon=0.1 OVER-saturated audio: dialogue from later segments
// compressed into segment 1, Mrs. Singh's line repeated, Parvati's
// whisper got replaced by footsteps. The fix is to NOT push strength
// past 1.0; instead tighten audio_window_scale so the rigid anchor
// zone collapses sooner and the per-segment audio bias engages
// closer to its own segment.
//   - audio_strength: 1.0       (default — keep in 0..1 sweet spot)
//   - audio_window_scale: 0.3   (tighten rigid zone — sharper boundaries)
//   - audio_epsilon: 0.0        (inherit main epsilon for the audio stream)
const advOptId = '__advanced_options__';
(workflow as Record<string, unknown>)[advOptId] = {
  class_type: 'PromptRelayAdvancedOptions',
  inputs: {
    video_strength: 1.0,
    video_window_scale: 1.0,
    audio_epsilon: 0.0,
    audio_strength: 1.0,
    audio_window_scale: 0.3,
  },
};
inp['relay_options'] = [advOptId, 0];
console.log(`Added PromptRelayAdvancedOptions (audio_strength=1.0, audio_window_scale=0.3, audio_epsilon=0.0/inherit)`);

// Randomize all seeds. The downloaded JSON has hardcoded
// RandomNoise/Sampler seeds — running the same workflow repeatedly
// produces identical output regardless of advanced-options changes,
// because the noise pattern dominates. Randomize so each run is a
// genuine new sample of the latent space.
const seedNodeFields = [
  ['seed', /KSampler|Sampler/i],
  ['noise_seed', /RandomNoise/i],
];
let seedsChanged = 0;
for (const [, node] of Object.entries(workflow)) {
  const ct = String(node.class_type ?? '');
  for (const [field, classRe] of seedNodeFields) {
    const fieldKey = field as string;
    const cre = classRe as RegExp;
    if (cre.test(ct) && node.inputs && fieldKey in node.inputs) {
      node.inputs[fieldKey] = Math.floor(Math.random() * 0x7FFFFFFF);
      seedsChanged++;
    }
  }
}
console.log(`Randomized ${seedsChanged} seed(s)`);

// Save patched workflow alongside the probe output for diff comparison.
const ts = Date.now();
const patchedPath = join(outputDir, `patched_${ts}_workflow.json`);
writeFileSync(patchedPath, JSON.stringify(workflow, null, 2));
console.log(`Patched workflow saved → ${patchedPath}`);

// Submit.
const client = new ComfyUIClient({ outputDir });
console.log('\nSubmitting to LOCAL ComfyUI...');
const start = Date.now();
const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow as Record<string, unknown>, (p) => {
  if (p.percentage !== undefined && p.message) {
    console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
  }
});
console.log(`Done in ${Math.floor((Date.now() - start) / 1000)}s. prompt_id=${promptId}`);

const histImages = await client.getOutputImages(promptId);
const seen = new Set<string>();
const allOutputs = [...wsOutputs, ...histImages]
  .filter(i => /\.(mp4|webm|mov)$/i.test(i.filename))
  .filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));
if (allOutputs.length === 0) {
  console.error('No video output');
  process.exit(1);
}
const targetName = `patched_3shot_${ts}.mp4`;
const item = allOutputs[0];
const dl = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', targetName);
console.log(`\nVideo: ${dl}`);
