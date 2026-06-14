/**
 * probe-wan-bernini — standalone reference-injection probe.
 *
 * Bypasses the dhee runner / executor / alias step / CAS entirely. Uploads
 * the three reference images, injects them into the RAW workflow JSON
 * (nodes 139=image0, 119=image1, 138=image2), submits to Comfy, and saves
 * both the submitted workflow and the resulting video. Ground truth for
 * "do the references actually drive the WAN render when wired correctly?"
 *
 * Env knobs (to isolate variables):
 *   PROBE_FROM_SCENE=scene_1  → use that bundle scene's exact videoPrompt
 *   PROBE_PROMPT="..."        → use this literal prompt
 *   PROBE_SEED=123456789      → noise seed (default 123456789)
 *   PROBE_OUT=/tmp/x.mp4      → output path (default /tmp/wan_probe/probe.mp4)
 */
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { resolveEndpointUrl } from '../src/dag/runners/endpointResolver.js';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const baseUrl = resolveEndpointUrl('self.local') || process.env['COMFYUI_BASE_URL'] || 'http://100.93.149.119:8188';
const proj = '/Users/ganaraj/dhee-studios/wan_action';
const outDir = '/tmp/wan_probe';
const outMp4 = process.env['PROBE_OUT'] ?? `${outDir}/probe.mp4`;
mkdirSync(outDir, { recursive: true });

const wf = JSON.parse(
  readFileSync('src/dag/bundles/wan_bernini_relay/workflows/wan_bernini_r2v.json', 'utf8'),
) as Record<string, { inputs: Record<string, unknown> }>;

const client = new ComfyUIClient({ baseUrl, outputDir: outDir });

// node -> reference image, matching BatchImagesNode 136: image0/image1/image2
const refs: Record<string, string> = {
  '139': `${proj}/assets/images/characters/hooded_fighter.png`, // image0
  '119': `${proj}/assets/images/characters/red_jacket_fighter.png`, // image1
  '138': `${proj}/assets/images/backgrounds/neon_back_alley.png`, // image2
};

console.log('[probe] baseUrl =', baseUrl);
for (const [node, p] of Object.entries(refs)) {
  const u = await client.uploadImage(p, 'input', true);
  wf[node]!.inputs['image'] = u.name;
  console.log(`[probe] uploaded ${p.split('/').pop()} -> "${u.name}" ; set node ${node}.image`);
}

// Prompt: bundle scene file, or literal override, or the default concise probe prompt.
let promptText =
  'You are a helpful assistant specialized in subject-to-video generation. The lean hooded fighter from image0 and the broad red-jacket fighter from image1 trade a fast flurry of punches in the neon-lit back alley in image2, rain misting through the colored light.';
if (process.env['PROBE_FROM_SCENE']) {
  const sp = JSON.parse(readFileSync(`${proj}/prompts/videos/${process.env['PROBE_FROM_SCENE']}.json`, 'utf8')) as {
    videoPrompt: string;
  };
  promptText = sp.videoPrompt;
  console.log('[probe] PROMPT SOURCE = bundle', process.env['PROBE_FROM_SCENE']);
} else if (process.env['PROBE_PROMPT']) {
  promptText = process.env['PROBE_PROMPT'];
  console.log('[probe] PROMPT SOURCE = PROBE_PROMPT env');
} else {
  console.log('[probe] PROMPT SOURCE = default concise probe prompt');
}
const seed = process.env['PROBE_SEED'] ? Number(process.env['PROBE_SEED']) : 123456789;

wf['6']!.inputs['text'] = promptText;
wf['112']!.inputs['value'] = 832;
wf['114']!.inputs['value'] = 480;
wf['128']!.inputs['value'] = 121;
wf['57']!.inputs['noise_seed'] = seed;

console.log('[probe] seed =', seed);
console.log('[probe] prompt =', promptText);
writeFileSync(`${outMp4}.submitted.json`, JSON.stringify(wf, null, 2));
console.log(
  '[probe] LoadImage filenames: 139=%s | 119=%s | 138=%s',
  wf['139']!.inputs['image'],
  wf['119']!.inputs['image'],
  wf['138']!.inputs['image'],
);

const res = await client.queueAndWaitWS(wf as never, undefined, {});
let outs = res.outputs as Array<{ filename: string; subfolder?: string }>;
console.log('[probe] promptId', res.promptId, 'ws outputs', JSON.stringify(outs));
if ((!outs || outs.length === 0) && res.promptId) {
  outs = (await client.getOutputImages(res.promptId)) as never;
}
if (!outs || outs.length === 0) {
  console.error('[probe] NO OUTPUTS');
  process.exit(1);
}
const o = outs.find((x) => /\.(mp4|webm|mov|gif)$/i.test(x.filename)) ?? outs[0]!;
const dl = await client.downloadOutput(o.filename, o.subfolder ?? '', 'output');
writeFileSync(outMp4, dl.buffer);
console.log(`[probe] SAVED ${outMp4} (${dl.buffer.length} bytes); comfy file ${o.filename}`);
