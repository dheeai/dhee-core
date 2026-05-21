#!/usr/bin/env tsx
/**
 * Test the user's architecture proposal: build the reference manifest
 * DETERMINISTICALLY from the project's known structure (scene setting +
 * scene-level mainSubject + per-shot focus refs), prepend it as the
 * static slot manifest at the top of the prompt, and strip every inline
 * "from image N" from the LLM-written prose.
 *
 * This guarantees the setting is always present (no more "LLM forgot to
 * mention inside_pawn_shop"), and the slot binding is enforced by code
 * rather than by the LLM remembering. Reference: probe-slot-manifest.ts
 * (the earlier test) only swapped formats — this one ALSO fills in
 * missing refs that the LLM omitted.
 *
 * Renders the SAME shot with TWO variants from the same seed:
 *   variant A: ORIGINAL — what the executor actually sent today
 *               (LLM's references array, inline "from image N" prose)
 *   variant B: DETERMINISTIC — manifest computed from scene structure,
 *               setting INCLUDED whether or not the LLM mentioned it,
 *               prose stripped of inline refs
 *
 * Usage:
 *   pnpm tsx scripts/probe-deterministic-manifest.ts <project> <scene> <shot>
 */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-deterministic-manifest.ts <project> <scene> <shot>');
  process.exit(1);
}

const scene = parseInt(sceneArg, 10);
const shot = parseInt(shotArg, 10);
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.kshana') ? projectArg : `${projectArg}.kshana`,
);
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

// ── Load shot's existing prompt + scene context ──
const promptPath = join(projectRoot, `prompts/images/shots/scene-${scene}-shot-${shot}.json`);
const promptJson = JSON.parse(readFileSync(promptPath, 'utf-8'));
const originalPrompt: string = promptJson.frames?.first_frame?.imagePrompt ?? '';
const negativePrompt: string = promptJson.negativePrompt ?? '';
const originalRefs: Array<{ imageNumber: number; type: string; refId: string }> =
  promptJson.frames?.first_frame?.references ?? [];

const sceneVpPath = join(projectRoot, `prompts/videos/scenes/scene_${scene}.json`);
const sceneVp = JSON.parse(readFileSync(sceneVpPath, 'utf-8'));
const thisShot = (sceneVp.shots ?? []).find((s: { shotNumber?: number }) => s.shotNumber === shot);
if (!thisShot) {
  console.error(`Shot ${shot} not in scene_${scene}.json`);
  process.exit(1);
}

// ── Deterministic resolver ──
// Compute the canonical slot manifest for this shot, regardless of what
// the LLM emitted. Algorithm:
//   slot 1: SETTING (scene-canonical)
//   slot 2: scene.mainSubject (always)
//   slot 3: scene.secondarySubject (when present)
//   slot 4: shot.focus.primary if it's a NEW character not already in 1-3
//
// We resolve the canonical setting by looking at every shot in the scene
// and picking the most common setting refId in focus.background and
// shot.setting. For Ruby scene 2 that's `inside_pawn_shop`.

function canonicalSceneSetting(svp: any): string | null {
  const counts = new Map<string, number>();
  for (const sh of svp.shots ?? []) {
    if (typeof sh.setting === 'string' && sh.setting) {
      counts.set(sh.setting, (counts.get(sh.setting) ?? 0) + 1);
    }
    for (const bg of sh.focus?.background ?? []) {
      // Filter to setting-like refIds (skip character names by heuristic —
      // settings are typically multi-word with underscores, characters are
      // simple single-word lowercase names. We check against the on-disk
      // settings dir.)
      if (typeof bg === 'string') counts.set(bg, (counts.get(bg) ?? 0) + 1);
    }
  }
  // Filter against actual setting files on disk.
  const settingsDir = join(projectRoot, 'settings');
  const validSettings = new Set(
    readdirSync(settingsDir).filter(f => f.endsWith('.md')).map(f => f.replace('.md', '')),
  );
  let best: string | null = null;
  let bestN = 0;
  for (const [refId, n] of counts.entries()) {
    if (validSettings.has(refId) && n > bestN) {
      best = refId;
      bestN = n;
    }
  }
  return best;
}

const canonicalSetting = canonicalSceneSetting(sceneVp);
const mainSubject = sceneVp.mainSubject as string | null;
const secondarySubject = sceneVp.secondarySubject as string | null;
const shotFocalChar: string | null =
  typeof thisShot.focus?.primary === 'string' &&
  thisShot.focus.primary !== mainSubject &&
  thisShot.focus.primary !== secondarySubject
    ? thisShot.focus.primary
    : null;

const deterministicSlots: Array<{ slot: number; refType: 'setting' | 'character'; name: string }> = [];
if (canonicalSetting) deterministicSlots.push({ slot: 1, refType: 'setting', name: canonicalSetting });
if (mainSubject) deterministicSlots.push({ slot: deterministicSlots.length + 1, refType: 'character', name: mainSubject });
if (secondarySubject) deterministicSlots.push({ slot: deterministicSlots.length + 1, refType: 'character', name: secondarySubject });
if (shotFocalChar && deterministicSlots.length < 4) {
  deterministicSlots.push({ slot: deterministicSlots.length + 1, refType: 'character', name: shotFocalChar });
}
// Cap at 4 (Flux Klein slot limit)
deterministicSlots.splice(4);

console.log('=== DETERMINISTIC SLOT RESOLUTION ===');
for (const s of deterministicSlots) console.log(`  slot ${s.slot}: ${s.refType}:${s.name}`);
console.log(`\n=== LLM'S ACTUAL refs array ===`);
for (const r of originalRefs.sort((a, b) => a.imageNumber - b.imageNumber)) {
  console.log(`  image ${r.imageNumber}: ${r.refId}`);
}

// ── Build refLabel and resolve to on-disk PNGs ──
function prettyName(name: string): string {
  return name.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}
function findRefPng(refType: 'setting' | 'character', name: string): string | null {
  const imagesDir = join(projectRoot, 'assets/images');
  const prefix = refType === 'setting' ? 'SettingRef_' : 'CharRef_';
  const normalizedName = name.replace(/_/g, '');
  const candidates = readdirSync(imagesDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.png') && f.toLowerCase().includes(normalizedName.toLowerCase()))
    .sort();
  return candidates.length > 0 ? join(imagesDir, candidates.at(-1)!) : null;
}

const slotImage: Record<number, string> = {};
const manifestLines: string[] = [];
for (const s of deterministicSlots) {
  const p = findRefPng(s.refType, s.name);
  if (!p) {
    console.error(`Failed to resolve ${s.refType}:${s.name} → no PNG found`);
    process.exit(1);
  }
  slotImage[s.slot] = p;
  const label = s.refType === 'setting' ? `${prettyName(s.name)} (setting)` : prettyName(s.name);
  manifestLines.push(`${label} from image ${s.slot}.`);
}

// Strip inline "from image N" from the LLM's prose.
const stripPattern = / from image \d+/gi;
const proseClean = originalPrompt.replace(stripPattern, '');
const deterministicPrompt = `${manifestLines.join(' ')}\n\n${proseClean}`;

console.log('\n=== inline prompt (LLM output, as actually used) ===');
console.log(originalPrompt.slice(0, 220) + '...');
console.log('\n=== deterministic-manifest prompt ===');
console.log(deterministicPrompt.slice(0, 220) + '...');

// ── Render both variants on the same seed ──
const workflowPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.json');
const wfManifestPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.manifest.json');
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));
const wfManifest = JSON.parse(readFileSync(wfManifestPath, 'utf-8'));

const outputDir = join(projectRoot, 'assets/images/compare_deterministic_manifest');
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, `s${scene}shot${shot}_prompt_inline.txt`), originalPrompt);
writeFileSync(join(outputDir, `s${scene}shot${shot}_prompt_deterministic.txt`), deterministicPrompt);
writeFileSync(
  join(outputDir, `s${scene}shot${shot}_slot_resolution.txt`),
  `LLM REFS:\n${originalRefs.map(r => `  image ${r.imageNumber}: ${r.refId}`).join('\n')}\n\nDETERMINISTIC SLOTS:\n${deterministicSlots.map(s => `  slot ${s.slot}: ${s.refType}:${s.name}`).join('\n')}`,
);

const client = new ComfyUIClient({ outputDir });

// Upload refs for each variant.
const llmUploaded: Record<number, string> = {};
for (const r of originalRefs) {
  const refType = r.refId.startsWith('setting_image:') ? 'setting' : 'character';
  const name = r.refId.split(':')[1];
  const p = findRefPng(refType, name);
  if (!p) { console.error(`LLM ref ${r.refId} not found`); process.exit(1); }
  console.log(`\n[inline] Uploading slot ${r.imageNumber}: ${p.split('/').pop()}`);
  const up = await client.uploadImage(p, 'input', true);
  llmUploaded[r.imageNumber] = up.name;
}

const detUploaded: Record<number, string> = {};
for (const s of deterministicSlots) {
  console.log(`\n[determ] Uploading slot ${s.slot}: ${slotImage[s.slot].split('/').pop()}`);
  const up = await client.uploadImage(slotImage[s.slot], 'input', true);
  detUploaded[s.slot] = up.name;
}

const seed = Math.floor(Math.random() * 0x7FFFFFFF);
console.log(`\nseed (same for both): ${seed}`);

async function renderVariant(label: string, prompt: string, slots: Record<number, string>) {
  console.log(`\n=== render ${label} (slots: ${Object.keys(slots).sort().join(',')}) ===`);
  const params: Record<string, unknown> = {
    prompt,
    seed,
    filenamePrefix: `compare_deterministic_manifest/s${scene}shot${shot}_${label}`,
    width: 1024,
    height: 576,
  };
  if (negativePrompt) params.negative_prompt = negativePrompt;
  for (const [n, name] of Object.entries(slots)) {
    params[`reference_image_${n}`] = name;
    if (n === '1') params.base_image = name;
  }
  const workflow = parameterizeGeneric(template, wfManifest, params) as Record<string, unknown>;

  const t0 = Date.now();
  const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, p => {
    if (p.percentage !== undefined && p.message) {
      console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
    }
  });
  console.log(`  complete in ${Math.floor((Date.now() - t0) / 1000)}s`);

  const histImages = await client.getOutputImages(promptId);
  const seen = new Set<string>();
  const imageOutputs = [...wsOutputs, ...histImages]
    .filter(i => /\.(png|jpg|jpeg|webp)$/i.test(i.filename))
    .filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));
  if (imageOutputs.length === 0) { console.error('no output'); return; }
  const target = `s${scene}shot${shot}_${label}.png`;
  for (const item of imageOutputs) {
    const dl = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
    console.log(`  → ${dl}`);
    break;
  }
}

await renderVariant('inline', originalPrompt, llmUploaded);
await renderVariant('deterministic', deterministicPrompt, detUploaded);

console.log(`\nOpen ${outputDir} in Finder. seed=${seed}.`);
console.log(`\nKey question: does the DETERMINISTIC render show a more consistent pawn-shop setting`);
console.log(`(because we forced inside_pawn_shop into slot 1) compared to the INLINE version`);
console.log(`where the LLM forgot to include the setting ref entirely?`);
