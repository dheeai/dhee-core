#!/usr/bin/env tsx
/**
 * Download all 6 outputs from the Grok probe job dd3eece3 so we can
 * inspect whether AILab_ImageToList → GrokImageEditNode is doing:
 *   - batch mode (1 edit per list entry, 6 separate outputs, each with
 *     a different image-in-list as the "base"), or
 *   - multi-ref mode (1 edit with all 6 images as context, and the
 *     apparent 6 outputs are variants/samples).
 */
import 'dotenv/config';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { mkdirSync } from 'fs';
import { join } from 'path';

const OUT_DIR = '/Users/ganaraj/Projects/dhee-core/noir_detective_story_setup-3.dhee/assets/videos/compare_grok_vs_klein';
mkdirSync(OUT_DIR, { recursive: true });

const FILES = [
  '620e519aa4a5b4b6ae7a3ea41ace8e773a097f2ad6dd6825142d47ef993c41e3.png',
  'f9f59b3f40afd5b4ce1c918b133994d77fda05a6876df1827bfaaadf504db997.png',
  'cd6ddc0540177073c0da90ca05af004ddc3baea56e8bc0a33c2a1dde0541bd2f.png',
  '4dde75b766512a7c44f0d73ec5419608946c7442c7a2aaf772c04e6c80362bac.png',
  '678bc0e681c83427ecb422c02551d5143d4f9d69b5da9807cd460654a5827645.png',
  '62604ab0ab5aeb480424f278e1a5d1771e9f0f2140d13ee7f24e8e91ca3017b0.png',
];

async function main() {
  const client = new ComfyUIClient({ outputDir: OUT_DIR });
  for (let i = 0; i < FILES.length; i++) {
    const localName = `s2s5_grok_output_${i + 1}.png`;
    console.log(`Downloading ${i + 1}/${FILES.length} → ${localName}`);
    await client.downloadImage(FILES[i]!, '', 'output', localName);
  }
  console.log('Done. Inspect:');
  for (let i = 0; i < FILES.length; i++) {
    console.log(`  ${join(OUT_DIR, `s2s5_grok_output_${i + 1}.png`)}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
