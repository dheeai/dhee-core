#!/usr/bin/env tsx
/**
 * FLUX 2 Klein seed-variance experiment — measure how often each prose
 * variant produces a correct character-role assignment when seed is the
 * only changing variable.
 *
 * Why: the single-seed descriptor probe (`probe-klein-descriptors.ts`)
 * showed v0 (baseline) and v3 (contrast clause) both produced correct
 * output at ONE seed. Baseline is known to fail in production at OTHER
 * seeds. This script tells us whether v3's prose genuinely reduces the
 * failure rate or was just lucky once.
 *
 * Design:
 *   - Two prose variants per shot: v0_baseline, v3_contrast
 *   - 6 deterministic seeds, same across variants
 *   - Same upload order, same references, same workflow
 *   - Side-by-side grid naming: `..._v0_seed{N}.png` / `..._v3_seed{N}.png`
 *
 * Verdict procedure (manual): open the folder, for each seed number
 * compare v0 vs v3. Tally {correct, swapped, blended} per variant.
 * If v3's failure count is meaningfully lower across seeds, the
 * contrast pattern is a real win.
 *
 * Usage:
 *   pnpm tsx scripts/probe-klein-seed-variance.ts <project> <scene> <shot>
 *
 * Example:
 *   pnpm tsx scripts/probe-klein-seed-variance.ts sun_hadnt_yet_cleared-2 1 6
 */
import 'dotenv/config';
import { readFileSync, existsSync, mkdirSync, writeFileSync, copyFileSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';
import { extractPhysicalDescription } from '../src/core/planner/characterVisualTags.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-klein-seed-variance.ts <project> <scene> <shot>');
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

// ── Fixed seeds so anyone re-running this gets the same sample population ──
const SEEDS = [13, 2027, 441, 98765, 1234567, 88888];
const FRAME: 'first_frame' = 'first_frame';

// ── Load shot prompt ──
const shotPromptPath = join(projectRoot, `prompts/images/shots/scene-${scene}-shot-${shot}.json`);
const shotPrompt = JSON.parse(readFileSync(shotPromptPath, 'utf-8'));
const frame = shotPrompt?.frames?.[FRAME];
if (!frame) {
  console.error(`Frame '${FRAME}' missing in ${shotPromptPath}`);
  process.exit(1);
}

interface RefEntry { imageNumber: number; type: string; refId: string }
const refs = (frame.references ?? []) as RefEntry[];
const baselinePrompt: string = frame.imagePrompt ?? '';
const negative: string = shotPrompt.negativePrompt ?? '';

// ── Resolve refs to disk paths ──
const projectJson = JSON.parse(readFileSync(join(projectRoot, 'project.json'), 'utf-8'));
const nodes = projectJson?.executorState?.nodes ?? {};
const resolveRefPath = (refId: string): string => {
  const n = nodes[refId];
  if (!n?.outputPath) throw new Error(`No outputPath for ${refId}`);
  return join(projectRoot, n.outputPath);
};
const baseRef = refs.find(r => r.type === 'setting');
const charRefs = refs.filter(r => r.type === 'character');
if (!baseRef) {
  console.error('Experiment requires a setting ref (base image). None on this shot.');
  process.exit(1);
}
if (charRefs.length < 2) {
  console.error('Seed-variance experiment targets multi-character shots. Only 1 char ref here.');
  process.exit(1);
}
const orderedRefs = [baseRef, ...charRefs, ...refs.filter(r => r.type !== 'setting' && r.type !== 'character')];

// ── Build v3 prompt (contrast clause) ──
// We do NOT rebuild v0 — that's literally `baselinePrompt` as-is.
const charLabel = (refId: string) => refId.replace(/^character_image:/, '');
const shortDescForChar = (refId: string): string => {
  const label = charLabel(refId);
  for (const c of [`${label}.md`, `${label.replace(/\./g, '')}.md`, `${label.replace(/\s/g, '_')}.md`]) {
    const p = join(projectRoot, 'characters', c);
    if (existsSync(p)) {
      const d = extractPhysicalDescription(readFileSync(p, 'utf-8'), 180);
      if (d) return d;
    }
  }
  return '';
};
const distill = (raw: string): string => {
  let s = raw
    .replace(/^(In vibrant anime aesthetics,? )?/i, '')
    .replace(/^[A-Z][a-z]+ is depicted as /i, '')
    .replace(/^[A-Z][a-z]+ is /i, '');
  const p = s.indexOf('.');
  if (p > 0 && p < 160) s = s.slice(0, p);
  if (s.length > 140) s = s.slice(0, 140).replace(/[,.;]?\s*\S*$/, '');
  return s.trim();
};
const descriptors = new Map<string, string>();
for (const r of charRefs) descriptors.set(r.refId, distill(shortDescForChar(r.refId)));

/**
 * Build v3 prose: `[descriptor], Name from image N (distinctly not [other_desc])`
 * for each character in turn. The "distinctly not" clause names the OTHER
 * character's descriptor — this is the partitioning signal Klein seems to
 * respect (per the single-seed probe's result).
 */
function buildV3(baseline: string): string {
  let out = baseline;
  for (const r of charRefs) {
    const selfDesc = descriptors.get(r.refId) ?? '';
    const otherDesc = [...descriptors.entries()]
      .filter(([rid]) => rid !== r.refId)
      .map(([, d]) => d)
      .filter(Boolean)[0] ?? '';
    const name = charLabel(r.refId).replace(/_/g, ' ');
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\b${escaped}\\s+from\\s+image\\s+(\\d+)\\b`, 'gi');
    out = out.replace(re, (_m, nStr) => {
      const notClause = otherDesc ? ` (distinctly not ${otherDesc})` : '';
      return `${selfDesc ? selfDesc + ', ' : ''}${name} from image ${nStr}${notClause}`;
    });
  }
  return out;
}

const variants: Array<{ name: string; prompt: string }> = [
  { name: 'v0_baseline', prompt: baselinePrompt },
  { name: 'v3_contrast', prompt: buildV3(baselinePrompt) },
];

console.log(`shot:    scene ${scene} shot ${shot} (${FRAME})`);
console.log(`refs:    ${refs.map(r => `${r.imageNumber}=${charLabel(r.refId)}`).join(', ')}`);
console.log(`seeds:   ${SEEDS.join(', ')}`);
console.log(`variants: ${variants.map(v => v.name).join(', ')}`);
console.log();

// ── Output dir + upload refs once ──
const outputDir = join(projectRoot, `assets/images/probe_klein_seed_variance/s${scene}shot${shot}`);
mkdirSync(outputDir, { recursive: true });
writeFileSync(
  join(outputDir, 'prompts.txt'),
  variants.map(v => `=== ${v.name} ===\n${v.prompt}\n`).join('\n'),
);
for (const r of orderedRefs) {
  copyFileSync(resolveRefPath(r.refId), join(outputDir, `ref_${charLabel(r.refId)}.png`));
}

const client = new ComfyUIClient({ outputDir });
console.log('Uploading reference images (once, reused across all runs)...');
const uploaded: Record<string, string> = {};
for (const r of orderedRefs) {
  const u = await client.uploadImage(resolveRefPath(r.refId), 'input', true);
  uploaded[r.refId] = u.name;
  console.log(`  ${r.refId} → ${u.name}`);
}

// ── Klein workflow ──
const workflowPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.json');
const manifestPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));

const baseImageName = uploaded[baseRef.refId]!;
const refImageNames = orderedRefs.slice(1, 4).map(r => uploaded[r.refId]!);

// ── Run the 2 × N grid ──
const totalRuns = variants.length * SEEDS.length;
let done = 0;
for (const v of variants) {
  for (const seed of SEEDS) {
    done++;
    console.log(`\n[${done}/${totalRuns}] ${v.name} / seed=${seed}`);
    const genericParams: Record<string, unknown> = {
      prompt: v.prompt,
      negative_prompt: negative,
      base_image: baseImageName,
      seed,
      filenamePrefix: `klein/variance/${v.name}_${seed}`,
      width: 1024,
      height: 576,
    };
    for (let i = 0; i < 3; i++) {
      genericParams[`reference_image_${i + 1}`] = refImageNames[i] ?? baseImageName;
    }
    const workflow = parameterizeGeneric(template, manifest, genericParams) as Record<string, unknown>;
    // Same safety pass as the production provider — any LoadImage still
    // pointing at `ref_image_*` placeholder gets swapped for the base.
    for (const n of Object.values(workflow)) {
      const node = n as { class_type?: string; inputs?: Record<string, unknown> };
      if (node.class_type === 'LoadImage' && typeof node.inputs?.['image'] === 'string') {
        const img = node.inputs['image'] as string;
        if (img.startsWith('ref_image_') || img === '') node.inputs['image'] = baseImageName;
      }
    }

    const start = Date.now();
    try {
      const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, p => {
        if (p.percentage === 100 && p.message) {
          // Only log final step to keep output readable across 12 runs
          // (intermediate progress is in the debug log).
        }
      });
      const secs = Math.floor((Date.now() - start) / 1000);

      const histImages = await client.getOutputImages(promptId);
      const seen = new Set<string>();
      const images = [...wsOutputs, ...histImages]
        .filter(i => /\.(png|jpg|jpeg|webp)$/i.test(i.filename))
        .filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));
      if (images.length === 0) {
        console.log(`  ❌ NO OUTPUT after ${secs}s`);
        continue;
      }
      const target = `s${scene}shot${shot}_${v.name}_seed${seed}.png`;
      const dl = await client.downloadImage(
        images[0]!.filename,
        images[0]!.subfolder ?? '',
        images[0]!.type ?? 'output',
        target,
      );
      console.log(`  ✓ ${secs}s → ${target}`);
      void dl;
    } catch (e) {
      console.log(`  ❌ ERROR: ${(e as Error).message}`);
    }
  }
}

console.log(`\nAll ${totalRuns} runs complete. Open in Finder:`);
console.log(`  ${outputDir}`);
console.log(`\nComparison grid:`);
for (const s of SEEDS) {
  console.log(`  seed ${s}: v0 vs v3 →  s${scene}shot${shot}_v0_baseline_seed${s}.png  |  s${scene}shot${shot}_v3_contrast_seed${s}.png`);
}
