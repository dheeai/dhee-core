/**
 * Phase 2: Render each generated prompt 3× via the SAME ComfyUIProvider
 * dhee uses in production (Flux Klein cloud workflow). Same Klein seed
 * across current/proposed for each sample index → A/B isolates the
 * prompt difference from Klein's noise.
 *
 * Output: results/renders/<shotId>__<condition>__seed<N>.png
 *         results/renders/<shotId>__<condition>__seed<N>.meta.json
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, renameSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ComfyUIProvider } from '../../src/services/providers/comfyui/ComfyUIProvider.js';
import { SHOTS, SEEDS, refIdToPath, type Reference } from './fixtures.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(SCRIPT_DIR, 'results', 'prompts');
const RENDERS_DIR = path.join(SCRIPT_DIR, 'results', 'renders');

// Same baseline negative the production assembly uses (see
// shotImagePipeline.ts:buildNegativePrompt → BASE_NEGATIVES).
const NEGATIVE_PROMPT =
  'blurry, low quality, deformed, extra limbs, mutated, text, watermark, signature, cartoon, anime, illustration, painting, 3D render';

interface PromptRecord {
  shotId: string;
  condition: string;
  llmResponse: string;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const out: { shot?: string; condition?: string; maxSeeds?: number; conditionPrefix?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--shot' && args[i + 1]) out.shot = args[++i];
    else if (args[i] === '--condition' && args[i + 1]) out.condition = args[++i];
    else if (args[i] === '--condition-prefix' && args[i + 1]) out.conditionPrefix = args[++i];
    else if (args[i] === '--max-seeds' && args[i + 1]) out.maxSeeds = parseInt(args[++i]!, 10);
    else if (args[i]?.startsWith('--max-seeds=')) out.maxSeeds = parseInt(args[i]!.split('=')[1]!, 10);
    else if (args[i]?.startsWith('--condition-prefix=')) out.conditionPrefix = args[i]!.split('=')[1];
  }
  return out;
}

function stripInlineFromImageTokens(prose: string): string {
  return prose.replace(/\s+from image \d+/gi, '').replace(/\s{2,}/g, ' ').trim();
}

function buildManifestLine(references: { imageNumber: number; type: string; refId: string }[]): string {
  // Mirror shotImagePipeline.ts:buildSlotManifestLine — the prefix prepended
  // to every imagePrompt fed to Klein so the LLM's prose anchors against
  // explicit slot bindings.
  const sorted = [...references].sort((a, b) => a.imageNumber - b.imageNumber);
  const labelFor = (r: { imageNumber: number; type: string; refId: string }) => {
    const name = r.refId.split(':')[1] ?? r.refId;
    const cleaned = name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    return r.type === 'setting' ? `${cleaned} (setting)` : cleaned;
  };
  return sorted.map(r => `${labelFor(r)} from image ${r.imageNumber}.`).join(' ');
}

async function main() {
  mkdirSync(RENDERS_DIR, { recursive: true });

  const provider = new ComfyUIProvider();
  if (!provider.isAvailable()) {
    throw new Error('ComfyUIProvider not available — check COMFYUI_BASE_URL');
  }

  const argv = parseArgs();
  const promptFiles = readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.json'));
  console.log(`[harness] ${promptFiles.length} prompt files to render × ${SEEDS.length} seeds each`);

  for (const file of promptFiles.sort()) {
    const record: PromptRecord = JSON.parse(readFileSync(path.join(PROMPTS_DIR, file), 'utf-8'));
    if (argv.shot && record.shotId !== argv.shot) continue;
    if (argv.condition && record.condition !== argv.condition) continue;
    if (argv.conditionPrefix && !record.condition.startsWith(argv.conditionPrefix)) continue;
    const shot = SHOTS.find(s => s.shotId === record.shotId);
    if (!shot) {
      console.warn(`[skip] unknown shotId ${record.shotId}`);
      continue;
    }

    // Production runs stripInlineFromImageTokens on LLM prose before prepending
    // the manifest; replicate so any inline "from image N" the LLM emits is
    // stripped before the manifest is the single source of truth.
    const cleanedProse = stripInlineFromImageTokens(record.llmResponse.trim());
    const manifest = buildManifestLine(shot.references);
    const fullPrompt = manifest ? `${manifest}\n\n${cleanedProse}` : cleanedProse;

    const referenceImages = shot.references
      .sort((a, b) => a.imageNumber - b.imageNumber)
      .map((r: Reference) => ({
        filePath: refIdToPath(r.refId),
        type: r.type === 'object' ? 'setting' : r.type,
        name: r.refId.split(':')[1] ?? r.refId,
      })) as Array<{ filePath: string; type: 'character' | 'setting'; name: string }>;

    const seedsForThisPrompt = argv.maxSeeds ? SEEDS.slice(0, argv.maxSeeds) : SEEDS;
    for (const seed of seedsForThisPrompt) {
      const filenamePrefix = `${record.shotId}__${record.condition}__seed${seed}`;
      const outPng = path.join(RENDERS_DIR, `${filenamePrefix}.png`);
      const outMeta = path.join(RENDERS_DIR, `${filenamePrefix}.meta.json`);
      if (existsSync(outPng) && existsSync(outMeta)) {
        console.log(`[skip] ${filenamePrefix} (exists)`);
        continue;
      }

      console.log(`[klein] ${filenamePrefix} …`);
      const t0 = Date.now();
      try {
        const result = await provider.generateImage(
          {
            prompt: fullPrompt,
            negativePrompt: NEGATIVE_PROMPT,
            aspectRatio: '16:9',
            seed,
            outputDir: RENDERS_DIR,
            filenamePrefix,
            referenceImages,
          },
          progress => {
            if (progress.message && progress.percentage !== undefined) {
              process.stdout.write(`\r  ${progress.percentage}% ${progress.message}    `);
            }
          },
        );
        process.stdout.write('\n');
        const elapsed = Date.now() - t0;
        console.log(`[ok ] ${filenamePrefix} (${elapsed}ms) → ${path.basename(result.filePath)}`);

        // ComfyUIProvider names files itself; rename to our deterministic scheme
        if (result.filePath !== outPng && existsSync(result.filePath)) {
          renameSync(result.filePath, outPng);
        }
        writeFileSync(
          outMeta,
          JSON.stringify(
            {
              shotId: record.shotId,
              condition: record.condition,
              seed,
              fullPromptToKlein: fullPrompt,
              referenceFiles: referenceImages.map(r => ({ name: r.name, path: r.filePath })),
              elapsedMs: elapsed,
            },
            null,
            2,
          ),
        );
      } catch (err: any) {
        process.stdout.write('\n');
        console.error(`[ERR] ${filenamePrefix}: ${err.message}`);
        // Don't abort — let other shots render; we'll report missing renders later.
      }
    }
  }

  console.log(`[done] Renders in ${RENDERS_DIR}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
