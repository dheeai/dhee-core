/**
 * Re-runs Ruby V3 scene-4 shot-5 first_frame through local Flux Klein to check
 * whether the prior Klein failure (Ruby on sidewalk instead of in car, Angel
 * missing entirely) is reproducible or was a one-off seed glitch.
 *
 * Uses the 3 available reference images (Ruby V3 has no Lambo/crystal object
 * refs — those are described in text in the original prompt). Klein workflow
 * has 4 LoadImage slots so the 4th is padded with the setting ref.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { finddheeCoreRoot } from '../src/agent/pi/paths.js';

const RUBY_ASSETS = '/Users/ganaraj/dhee-studios/Ruby V3/assets/images';
const REFS = [
  'SettingRef_street_zimage_f1-iEv.png', // image 1 — street
  'CharRef_ruby_zimage_HBKPPQ.png',       // image 2 — Ruby
  'CharRef_angel_zimage_CRjELc.png',      // image 3 — Angel
];

const PROMPT =
  'Street (setting) from image 1. Ruby from image 2. Angel from image 3. ' +
  '\n\nPhotorealistic cinematic still, 85mm lens, sharp focus, natural skin texture and pores, film-grade color grade — ' +
  'Observer medium shot from a side angle, the camera pulled back to a wider neutral view, showing a green Lamborghini from the side. ' +
  'Ruby (blurred) is visible inside the driver\'s seat of the green Lamborghini, her hands beginning to jerk the steering wheel as she spots Angel on the sidewalk. ' +
  'Angel (razor-sharp) sprints forward along the sun-baked sidewalk, a small red crystal clutched in his right hand, his expression one of alarm. ' +
  'The car is still on the road, just starting to veer toward the curb. Harsh midday sun creates deep shadows, raking side light. ' +
  'Color palette of deep crimson and ember red, hot oranges against cold steel. High contrast, heat haze. Cinematic realism.';

async function main() {
  const root = finddheeCoreRoot(import.meta.url);

  // Pad to 4 images: street, ruby, angel, street (slot 4 unused-ish)
  const pick = [...REFS, REFS[0]];
  for (const r of pick) {
    const p = join(RUBY_ASSETS, r);
    if (!existsSync(p)) {
      console.error(`Missing: ${p}`);
      process.exit(1);
    }
  }
  console.log('[probe] References:');
  pick.forEach((f, i) => console.log(`  image ${i + 1}: ${f}`));

  const COMFY_URL = process.env['COMFYUI_BASE_URL'] || 'http://127.0.0.1:8188';
  console.log(`\n[probe] ComfyUI: ${COMFY_URL}`);
  const outDir = join(root, 'logs/probe-klein-ruby-s4s5');
  mkdirSync(outDir, { recursive: true });

  const isLocal = COMFY_URL.includes('zrok.io') || COMFY_URL.includes('127.0.0.1') || COMFY_URL.includes('localhost');
  const client = new ComfyUIClient({
    baseUrl: COMFY_URL,
    apiKey: isLocal ? undefined : process.env['COMFY_CLOUD_API_KEY'],
    outputDir: outDir,
  });

  // Upload
  const uploaded: string[] = [];
  for (const f of pick) {
    const r = await client.uploadImage(join(RUBY_ASSETS, f));
    uploaded.push(r.name);
    console.log(`[probe] uploaded ${f} → ${r.name}`);
  }

  // Load Klein workflow
  const workflow = JSON.parse(
    readFileSync(join(root, 'workflows/flux2_klein_edit.json'), 'utf-8'),
  ) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;

  const slotNodes = ['76', '81', '82', '83'];
  for (let i = 0; i < slotNodes.length; i += 1) {
    const node = workflow[slotNodes[i]];
    if (node) node.inputs['image'] = uploaded[i] ?? uploaded[0];
  }
  if (workflow['109']) workflow['109'].inputs['text'] = PROMPT;
  // Local box has fp8 variant, not the base unsuffixed one
  for (const [, node] of Object.entries(workflow)) {
    if (node.class_type === 'UNETLoader' && node.inputs.unet_name === 'flux-2-klein-9b.safetensors') {
      node.inputs.unet_name = 'flux-2-klein-9b-fp8.safetensors';
    }
  }
  if (workflow['92:73']) workflow['92:73'].inputs['noise_seed'] = Math.floor(Math.random() * 1_000_000);
  if (workflow['94']) workflow['94'].inputs['filename_prefix'] = 'KleinRubyS4S5';

  const outName = `klein-ruby-s4s5-${Date.now()}.png`;
  console.log('\n[probe] submitting…');
  const saved = await client.generateAndDownload(workflow, outName, (pct, msg) => {
    process.stdout.write(`\r[probe] ${pct.toFixed(0)}% ${msg}      `);
  });
  console.log(`\n[probe] saved: ${saved}`);
  console.log(`[probe] open: open "${saved}"`);
}

main().catch((e) => { console.error('[probe] fatal:', e); process.exit(1); });
