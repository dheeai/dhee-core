#!/usr/bin/env tsx
/**
 * FLUX 2 Klein descriptor experiment — test whether prepending visual
 * tags to `from image N` references helps Klein disambiguate
 * similar-looking characters.
 *
 * Background: on shots like s1-shot-6 (Parvati + Isha — mother/daughter,
 * both tan-skinned black-haired) Klein routinely swaps or blends
 * character identities in OTS compositions. On shots with visually
 * distinct pairs (e.g. Parvati + Mrs. Singh — different age, clothing,
 * posture), Klein gets it right. Hypothesis: Klein's character
 * disambiguation is feature-based, and when two refs share features
 * the "from image N" slot tag isn't enough. Extra visual descriptors
 * in the prose text should give Klein's cross-attention more to grip.
 *
 * This probe renders the SAME shot through multiple prompt variants,
 * using the SAME reference images uploaded in the SAME order. The only
 * variable is the prose. Outputs land side-by-side so you can eyeball
 * whether descriptors fix the swap/blend.
 *
 * Usage:
 *   pnpm tsx scripts/probe-klein-descriptors.ts <project> <scene> <shot> [--frame first|last]
 *
 * Example:
 *   pnpm tsx scripts/probe-klein-descriptors.ts sun_hadnt_yet_cleared-2 1 6
 *
 * Output:
 *   <project>/assets/images/probe_klein_descriptors/
 *     s{N}shot{M}_v0_baseline.png         # current shot prompt, unchanged
 *     s{N}shot{M}_v1_prepend_desc.png     # descriptor BEFORE name
 *     s{N}shot{M}_v2_desc_only.png        # descriptor replaces name entirely
 *     s{N}shot{M}_v3_contrast.png         # descriptor plus NOT-THE-OTHER disambiguation
 *     s{N}shot{M}_prompts.txt             # the 4 prompt strings for reference
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';
import { extractPhysicalDescription } from '../src/core/planner/characterVisualTags.js';

// ── CLI ──
const positional = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags = Object.fromEntries(
  process.argv.slice(2).filter(a => a.startsWith('--')).map(a => {
    const [k, ...v] = a.slice(2).split('=');
    return [k, v.join('=') || 'true'];
  }),
);
const [projectArg, sceneArg, shotArg] = positional;
const frameKey = (flags['frame'] === 'last' ? 'last_frame' : 'first_frame') as 'first_frame' | 'last_frame';
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-klein-descriptors.ts <project> <scene> <shot> [--frame first|last]');
  process.exit(1);
}
const scene = parseInt(sceneArg, 10);
const shot = parseInt(shotArg, 10);
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.dhee') ? projectArg : `${projectArg}.dhee`,
);
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

// ── Load the real shot_image_prompt ──
const shotPromptPath = join(projectRoot, `prompts/images/shots/scene-${scene}-shot-${shot}.json`);
if (!existsSync(shotPromptPath)) {
  console.error(`Shot prompt not found: ${shotPromptPath}`);
  process.exit(1);
}
const shotPrompt = JSON.parse(readFileSync(shotPromptPath, 'utf-8'));
const frame = shotPrompt?.frames?.[frameKey];
if (!frame) {
  console.error(`Frame '${frameKey}' missing in ${shotPromptPath}`);
  process.exit(1);
}

interface RefEntry {
  imageNumber: number;
  type: 'character' | 'setting' | 'object' | string;
  refId: string;
}
const refs = (frame.references ?? []) as RefEntry[];
const prompt: string = frame.imagePrompt ?? '';
const negative: string = shotPrompt.negativePrompt ?? '';
console.log(`shot:          scene ${scene} shot ${shot} / ${frameKey}`);
console.log(`refs:          ${refs.map(r => `${r.imageNumber}=${r.refId.split(':').at(-1)}`).join(', ')}`);
console.log(`baseline prompt (first 200c): ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}`);

// ── Resolve refId → disk path for each ref, via project.json executorState ──
const projectJson = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8'));
const nodes = projectJson?.executorState?.nodes ?? {};
function resolveRefPath(refId: string): string {
  const n = nodes[refId];
  if (!n?.outputPath) {
    throw new Error(`No outputPath for ${refId} in project.json`);
  }
  return join(projectRoot, n.outputPath);
}

// Klein workflow has 4 image slots: base + ref1 + ref2 + ref3. We follow
// the same upload order the production normalizer uses: settings at
// slot 0 (base), then characters, then objects.
const baseRef = refs.find(r => r.type === 'setting');
const charRefs = refs.filter(r => r.type === 'character');
const otherRefs = refs.filter(r => r.type !== 'setting' && r.type !== 'character');
if (!baseRef) {
  console.error('This experiment requires a setting reference (base image). Shot has none.');
  process.exit(1);
}
const orderedRefs = [baseRef, ...charRefs, ...otherRefs];
console.log(`Upload order: ${orderedRefs.map(r => r.refId.split(':').at(-1)).join(' → ')}`);

// ── Build visual descriptors for each character from their .md profile ──
function charLabel(refId: string): string {
  return refId.replace(/^character_image:/, '');
}
function shortDescriptorForChar(refId: string): string {
  const label = charLabel(refId);
  // Character profiles live at <project>/characters/<label>.md.
  // Try several variants because label may have dots or underscores
  // (e.g. "mrs._singh").
  const candidates = [
    `${label}.md`,
    `${label.replace(/\./g, '')}.md`,
    `${label.replace(/\s/g, '_')}.md`,
  ];
  for (const c of candidates) {
    const p = join(projectRoot, 'characters', c);
    if (existsSync(p)) {
      const md = readFileSync(p, 'utf-8');
      const desc = extractPhysicalDescription(md, 180);
      if (desc) return desc;
    }
  }
  return '';
}

// Shrink the raw physical-description paragraph into a focused clause
// usable inline. Drops fluff prefixes and keeps the first ~15 words.
function distillDescriptor(rawDesc: string): string {
  let s = rawDesc;
  // Drop common scaffolding prefixes the profile writer tends to use.
  s = s.replace(/^(In vibrant anime aesthetics,? )?/i, '');
  s = s.replace(/^[A-Z][a-z]+ is depicted as /i, '');
  s = s.replace(/^[A-Z][a-z]+ is /i, '');
  // Cut to first sentence or first ~120 chars.
  const firstPeriod = s.indexOf('.');
  if (firstPeriod > 0 && firstPeriod < 160) s = s.slice(0, firstPeriod);
  if (s.length > 140) s = s.slice(0, 140).replace(/[,.;]?\s*\S*$/, '');
  return s.trim();
}

const descriptors = new Map<string, string>();
for (const r of charRefs) {
  const full = shortDescriptorForChar(r.refId);
  descriptors.set(r.refId, distillDescriptor(full));
}
console.log(`Character descriptors:`);
for (const [rid, d] of descriptors) {
  console.log(`  ${charLabel(rid)}: "${d}"`);
}

// ── Build the four prompt variants ──

/**
 * Given the baseline prompt and a descriptor map, produce each variant by
 * rewriting every `<Name> from image N` occurrence per the variant's rule.
 *
 * We look for `NAME` tokens by matching each character label (case
 * insensitive) followed by `from image N`. The character label itself is
 * derived from the refId (strip `character_image:` prefix and normalize
 * underscores/dots to spaces).
 */
function rewritePerChar(
  baseline: string,
  rule: (name: string, desc: string, n: number) => string,
): string {
  let out = baseline;
  for (const r of charRefs) {
    const label = charLabel(r.refId).replace(/_/g, ' ').replace(/\./g, '.');
    // Match "Label from image N" in any case, capturing N.
    const re = new RegExp(`\\b${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s+from\\s+image\\s+(\\d+)\\b`, 'gi');
    out = out.replace(re, (_m, nStr: string) => rule(label, descriptors.get(r.refId) ?? '', parseInt(nStr, 10)));
  }
  return out;
}

const v0_baseline = prompt;
const v1_prepend = rewritePerChar(prompt, (name, desc, n) => {
  if (!desc) return `${name} from image ${n}`;
  return `${desc}, ${name} from image ${n}`;
});
const v2_descOnly = rewritePerChar(prompt, (name, desc, n) => {
  if (!desc) return `the ${name} from image ${n}`;
  return `${desc} from image ${n}`;
});
const v3_contrast = rewritePerChar(prompt, (name, desc, n) => {
  if (!desc) return `${name} from image ${n}`;
  // Add a "not the other character" disambiguation
  const otherDescs = [...descriptors.entries()]
    .filter(([k]) => charLabel(k) !== charLabel(refs.find(rr => rr.type === 'character' && charLabel(rr.refId) === name.replace(/\s+/g, '_'))?.refId ?? ''))
    .map(([, d]) => d)
    .filter(Boolean);
  const other = otherDescs[0] ?? '';
  const notClause = other ? ` (distinctly not ${other})` : '';
  return `${desc}, ${name} from image ${n}${notClause}`;
});

const variants: Array<{ name: string; prompt: string }> = [
  { name: 'v0_baseline', prompt: v0_baseline },
  { name: 'v1_prepend_desc', prompt: v1_prepend },
  { name: 'v2_desc_only', prompt: v2_descOnly },
  { name: 'v3_contrast', prompt: v3_contrast },
];

// ── Output dir + transcript file ──
const outputDir = join(projectRoot, 'assets/images/probe_klein_descriptors');
mkdirSync(outputDir, { recursive: true });
const transcriptPath = join(outputDir, `s${scene}shot${shot}_${frameKey}_prompts.txt`);
writeFileSync(
  transcriptPath,
  variants.map(v => `=== ${v.name} ===\n${v.prompt}\n`).join('\n'),
);
console.log(`\nPrompt variants written to: ${transcriptPath}`);
console.log(`  v0 baseline:        ${v0_baseline.slice(0, 140)}...`);
console.log(`  v1 prepend_desc:    ${v1_prepend.slice(0, 140)}...`);
console.log(`  v2 desc_only:       ${v2_descOnly.slice(0, 140)}...`);
console.log(`  v3 contrast:        ${v3_contrast.slice(0, 140)}...`);

// ── Copy reference images into the output dir so the experiment is self-contained ──
for (const r of orderedRefs) {
  const src = resolveRefPath(r.refId);
  const dst = join(outputDir, `ref_${r.type}_${charLabel(r.refId)}.png`);
  copyFileSync(src, dst);
}

// ── Upload refs once (same for all variants) ──
const client = new ComfyUIClient({ outputDir });
const uploaded: Record<string, string> = {};
console.log(`\nUploading reference images...`);
for (const r of orderedRefs) {
  const path = resolveRefPath(r.refId);
  const u = await client.uploadImage(path, 'input', true);
  uploaded[r.refId] = u.name;
  console.log(`  ${r.refId} → ${u.name}`);
}

// ── Load Klein workflow ──
const workflowPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.json');
const manifestPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));

// Seed is fixed across variants so we're isolating PROMPT as the only
// changing variable. If a variant needs a different seed, Klein's
// intrinsic variance dominates the prompt effect and our comparison
// tells us nothing.
const seed = Math.floor(Math.random() * 0x7FFFFFFF);
console.log(`Fixed seed across variants: ${seed}`);

const baseImageName = uploaded[baseRef.refId]!;
const refImageNames = orderedRefs.slice(1, 4).map(r => uploaded[r.refId]!);

// ── Run each variant sequentially (so we can catch errors one at a time) ──
for (const v of variants) {
  console.log(`\n=== Running variant ${v.name} ===`);
  const genericParams: Record<string, unknown> = {
    prompt: v.prompt,
    negative_prompt: negative,
    base_image: baseImageName,
    seed,
    filenamePrefix: `klein/probe/${v.name}`,
    width: 1024,
    height: 576,
  };
  // Klein has 4 LoadImage slots — all must resolve to a real uploaded
  // filename or ComfyUI errors on the missing placeholder. Production
  // fills unused slots with the base_image; mirror that behavior.
  for (let i = 0; i < 3; i++) {
    genericParams[`reference_image_${i + 1}`] = refImageNames[i] ?? baseImageName;
  }

  const workflow = parameterizeGeneric(template, manifest, genericParams) as Record<string, unknown>;

  // Belt-and-suspenders: scrub any remaining LoadImage placeholder that
  // points at a non-uploaded name (e.g. `ref_image_4.png`). This
  // duplicates the safety pass in ComfyUIProvider.editImage.
  for (const wfNode of Object.values(workflow)) {
    const n = wfNode as { class_type?: string; inputs?: Record<string, unknown> };
    if (n.class_type === 'LoadImage' && typeof n.inputs?.['image'] === 'string') {
      const imgName = n.inputs['image'] as string;
      if (imgName.startsWith('ref_image_') || imgName === '') {
        n.inputs['image'] = baseImageName;
      }
    }
  }

  const start = Date.now();
  const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, p => {
    if (p.percentage !== undefined && p.message) {
      console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
    }
  });
  console.log(`  complete in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

  const histImages = await client.getOutputImages(promptId);
  const imgOutputs = [...wsOutputs, ...histImages].filter(i => /\.(png|jpg|jpeg|webp)$/i.test(i.filename));
  const seen = new Set<string>();
  const unique = imgOutputs.filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));

  if (unique.length === 0) {
    console.error(`  NO OUTPUT for ${v.name}`);
    continue;
  }
  for (const item of unique) {
    const target = `s${scene}shot${shot}_${frameKey}_${v.name}.png`;
    const dl = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
    console.log(`  → ${dl}`);
    break;
  }
}

console.log(`\nAll variants saved. Open side-by-side in Finder:`);
console.log(`  ${outputDir}`);
