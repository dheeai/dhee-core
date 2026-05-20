/**
 * probe-klein-multi.ts
 *
 * A/B counterpart to `probe-qwen-multi.ts`. Runs the SAME 4 reference
 * images and the SAME prompt through FLUX2 Klein so we can compare
 * fusion / composition quality side-by-side.
 *
 * Klein's existing workflow `workflows/flux2_klein_edit.json` already
 * has 4 LoadImage slots and full Flux2 ReferenceLatent wiring, so this
 * just substitutes the 4 uploaded image names + prompt + seed.
 *
 * Usage:
 *   tsx scripts/probe-klein-multi.ts <project-name>
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { finddheeCoreRoot } from '../src/agent/pi/paths.js';

async function main() {
  const projectName = process.argv[2] ?? 'chhaya_60s_anime';
  const root = finddheeCoreRoot(import.meta.url);
  const projectDir = join(root, `${projectName}.dhee`);
  const imagesDir = join(projectDir, 'assets/images');

  if (!existsSync(imagesDir)) {
    console.error(`No assets/images dir: ${imagesDir}`);
    process.exit(1);
  }

  // Pick the SAME 4 images as the qwen probe so the A/B is fair.
  const candidates = readdirSync(imagesDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  const charRefs = candidates.filter((f) => /^CharRef_/i.test(f));
  const sceneFrames = candidates.filter((f) => /first_frame|last_frame/i.test(f));

  const pick: string[] = [];
  if (charRefs[0]) pick.push(charRefs[0]);
  for (const f of sceneFrames) {
    if (pick.length >= 4) break;
    if (!pick.includes(f)) pick.push(f);
  }
  for (const f of candidates) {
    if (pick.length >= 4) break;
    if (!pick.includes(f)) pick.push(f);
  }
  if (pick.length < 2) {
    console.error(`Need ≥2 images in ${imagesDir}; found ${pick.length}`);
    process.exit(1);
  }
  // Klein workflow has exactly 4 image slots — pad if fewer.
  while (pick.length < 4) pick.push(pick[0]);

  console.log('[probe] Using images:');
  pick.forEach((p, i) => console.log(`  image${i + 1}: ${p}`));

  const COMFY_URL = process.env['COMFYUI_BASE_URL'] || 'http://127.0.0.1:8188';
  console.log(`[probe] ComfyUI: ${COMFY_URL}`);

  const outDir = join(root, 'logs/probe-klein-multi');
  mkdirSync(outDir, { recursive: true });

  const client = new ComfyUIClient({
    baseUrl: COMFY_URL,
    apiKey: process.env['COMFY_CLOUD_API_KEY'],
    outputDir: outDir,
  });

  // Upload images
  const uploaded: string[] = [];
  for (const filename of pick) {
    const filePath = join(imagesDir, filename);
    const result = await client.uploadImage(filePath);
    uploaded.push(result.name);
    console.log(`[probe] uploaded ${filename} → ${result.name}`);
  }

  // Same prompt as qwen probe so the A/B holds.
  const prompt = pick.length >= 4
    ? 'Combine these reference images into a single cohesive scene: place the character (image 1) in the setting (image 2), with the same composition style as image 3 and the lighting/mood of image 4. Maintain anime aesthetic.'
    : 'Combine these reference images into a single cohesive scene with anime aesthetic.';

  // Load the existing Klein workflow JSON (already in API/prompt format,
  // not LiteGraph) and substitute images + prompt + seed.
  const workflow = JSON.parse(
    readFileSync(join(root, 'workflows/flux2_klein_edit.json'), 'utf-8'),
  ) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;

  // Map image slots: nodes 76, 81, 82, 83 are the 4 LoadImage refs.
  const slotNodes = ['76', '81', '82', '83'];
  for (let i = 0; i < slotNodes.length; i += 1) {
    const node = workflow[slotNodes[i]];
    if (node) node.inputs['image'] = uploaded[i] ?? uploaded[0];
  }
  // Prompt → Text Multiline (node 109)
  if (workflow['109']) workflow['109'].inputs['text'] = prompt;
  // Seed → RandomNoise (node 92:73). Same seed as qwen probe.
  if (workflow['92:73']) workflow['92:73'].inputs['noise_seed'] = 12345;
  // Filename prefix → SaveImage (node 94)
  if (workflow['94']) workflow['94'].inputs['filename_prefix'] = 'KleinMulti';

  const outputName = `klein-multi-${pick.length}refs-${Date.now()}.png`;
  console.log('[probe] submitting…');
  const savedPath = await client.generateAndDownload(
    workflow,
    outputName,
    (percentage, message) => {
      process.stdout.write(`\r[probe] ${percentage.toFixed(0)}% ${message}      `);
    },
  );
  console.log();
  console.log(`[probe] saved: ${savedPath}`);
  console.log(`[probe] open: open "${savedPath}"`);
}

main().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});
