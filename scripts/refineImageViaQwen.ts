#!/usr/bin/env tsx
/**
 * One-shot Qwen Edit refinement: take an existing rendered image
 * and apply a corrective instruction WITHOUT a prior-shot chain.
 * Tests the hypothesis that the review-loop's "3 attempts" should
 * be 3 refinement passes on the same image — not 3 full re-renders.
 *
 * Usage:
 *   pnpm tsx scripts/refineImageViaQwen.ts \
 *     --project "/Users/ganaraj/dhee-studios/Ruby V4 refined" \
 *     --shot scene_2_shot_6 \
 *     --instruction "Reverse the gun direction. Ruby's hand grips the revolver pointed AT the owner's forehead. The owner is on the right." \
 *     [--out scene_2_shot_6_refined.png]     # optional, defaults to <shot>_refined.png
 *     [--strength 0]                          # multi-angle LoRA strength; 0 = pure refinement, no rotation
 *     [--endpoint cloud|local]                # default cloud (cloud.comfy.org)
 *
 * Outputs into the same assets/images/shots dir as the original so
 * Finder/Preview shows them side-by-side. Does NOT modify the
 * canonical {shot}_first.png — refinement output is suffixed.
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.ts';
import { readAliases, applyAliases } from '../src/dag/workflowAliases.ts';

interface Args {
  project: string;
  shot: string;
  instruction: string;
  out: string;
  strength: number;
  endpoint: 'cloud' | 'local';
}

function parseArgs(argv: string[]): Args {
  const get = (name: string): string | undefined => {
    const i = argv.findIndex((a) => a === `--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const project = get('project');
  const shot = get('shot');
  const instruction = get('instruction');
  if (!project || !shot || !instruction) {
    console.error(
      `Usage: pnpm tsx scripts/refineImageViaQwen.ts --project <dir> --shot <id> --instruction "<text>" [--out <name>] [--strength <0..1>] [--endpoint cloud|local]`,
    );
    process.exit(2);
  }
  return {
    project,
    shot,
    instruction,
    out: get('out') ?? `${shot}_refined.png`,
    strength: Number(get('strength') ?? '0'),
    endpoint: (get('endpoint') as 'cloud' | 'local') ?? 'cloud',
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`refineImageViaQwen:`);
  console.log(`  project:     ${args.project}`);
  console.log(`  shot:        ${args.shot}`);
  console.log(`  out:         ${args.out}`);
  console.log(`  strength:    ${args.strength} (multi-angle LoRA — 0 = no rotation, pure refinement)`);
  console.log(`  endpoint:    ${args.endpoint}`);
  console.log(`  instruction: ${args.instruction}`);
  console.log();

  // ── Resolve endpoint URL + auth ──
  const baseUrl =
    args.endpoint === 'cloud'
      ? process.env['ENDPOINT_public_cloud'] ?? 'https://cloud.comfy.org/api'
      : process.env['ENDPOINT_self_local'] ?? 'https://comfyui.share.zrok.io';
  const isCloud = /cloud\.comfy\.org/.test(baseUrl);
  const apiKey = isCloud ? process.env['COMFY_CLOUD_API_KEY'] : undefined;
  if (isCloud && !apiKey) {
    console.error(`✗ ENDPOINT cloud requires COMFY_CLOUD_API_KEY in env (.env or shell).`);
    process.exit(3);
  }
  console.log(`endpoint resolved → ${baseUrl}${isCloud ? ' (cloud, with API key)' : ' (local)'}`);

  // ── Load current image ──
  const imageAbs = resolve(args.project, 'assets/images/shots', `${args.shot}_first.png`);
  if (!existsSync(imageAbs)) {
    console.error(`✗ image not found at ${imageAbs}`);
    process.exit(3);
  }
  console.log(`base image: ${imageAbs} (${readFileSync(imageAbs).length} bytes)`);

  // ── Load workflow ──
  // CWD is the kshana-core repo root when invoked via pnpm tsx.
  const bundleDir = resolve(
    process.cwd(),
    'src/dag/bundles/narrative_qwen_chain_relay',
  );
  const wfPath = join(bundleDir, 'workflows/qwen_edit_multi.json');
  if (!existsSync(wfPath)) {
    console.error(`✗ workflow not found at ${wfPath}`);
    process.exit(3);
  }
  let workflow = JSON.parse(readFileSync(wfPath, 'utf-8')) as Record<
    string,
    { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }
  >;

  // ── Apply per-endpoint aliases (model-file rename + class swaps) ──
  try {
    const aliasesDir =
      process.env['DHEE_WORKFLOW_ALIASES_DIR'] ??
      resolve(process.env['HOME'] ?? '', '.dhee', 'workflow-aliases');
    const aliases = readAliases(aliasesDir, baseUrl);
    if (
      (aliases.name_aliases && Object.keys(aliases.name_aliases).length > 0) ||
      (aliases.class_swaps && Object.keys(aliases.class_swaps).length > 0)
    ) {
      workflow = applyAliases(workflow as never, {
        workflowKey: 'workflows/qwen_edit_multi.json',
        aliases,
      }) as never;
      console.log(`applied workflow aliases for ${baseUrl}`);
    }
  } catch (e) {
    console.log(`(alias load skipped: ${(e as Error).message})`);
  }

  // ── Build Comfy client + upload base ──
  const outAbs = resolve(args.project, 'assets/images/shots', args.out);
  mkdirSync(dirname(outAbs), { recursive: true });
  const client = new ComfyUIClient({
    baseUrl,
    outputDir: dirname(outAbs),
    ...(apiKey ? { apiKey } : {}),
    ...(isCloud ? { isCloud: true } : {}),
  });

  console.log(`uploading base image...`);
  const upBase = await client.uploadImage(imageAbs, 'input', true);
  console.log(`  base → ${upBase.name}`);

  // ── Patch workflow ──
  // qwen_edit_multi.json convention (proven by comfyQwenEditChain.ts):
  //   LI    = LoadImage node — base image
  //   POS   = positive prompt with image1=SCALE, image2=REF_1, image3=REF_2
  //   REF_1, REF_2 = LoadImage placeholders for extra refs
  //   LORA_MA = multi-angle LoRA strength
  //   KS    = KSampler (seed)
  //   SAVE  = SaveImage (filename_prefix)
  if (!workflow['LI'] || !workflow['POS']) {
    console.error(`✗ workflow missing required nodes LI / POS`);
    process.exit(4);
  }
  const fullPrompt = `<sks> ${args.instruction}`;
  workflow['LI']!.inputs['image'] = upBase.name;
  workflow['POS']!.inputs['prompt'] = fullPrompt;
  // No external refs — cascade both REF slots to the base image so
  // LoadImage validation passes but the model gets no extra identity
  // signal beyond the base. This is the "pure refinement" mode.
  if (workflow['REF_1']) workflow['REF_1']!.inputs['image'] = upBase.name;
  if (workflow['REF_2']) workflow['REF_2']!.inputs['image'] = upBase.name;
  if (workflow['LORA_MA']) workflow['LORA_MA']!.inputs['strength_model'] = args.strength;

  const seed = Math.floor(Math.random() * 0x7fffffff);
  if (workflow['KS']) workflow['KS']!.inputs['seed'] = seed;
  if (workflow['SAVE']) workflow['SAVE']!.inputs['filename_prefix'] = `refine/${Date.now()}`;

  console.log(`submitting (seed=${seed}, strength=${args.strength})...`);
  const start = Date.now();
  const { promptId, outputs } = await client.queueAndWaitWS(workflow, (p) => {
    if (p.percentage !== undefined && p.message) {
      console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
    }
  });
  console.log(`  done in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

  // ── Download ──
  const hist = await client.getOutputImages(promptId);
  const all = [...outputs, ...hist].filter((o) =>
    /\.(png|jpg|webp)$/i.test(o.filename),
  );
  if (all.length === 0) {
    console.error(`✗ no image output from Comfy`);
    process.exit(5);
  }
  const item = all[0]!;
  const downloaded = await client.downloadImage(
    item.filename,
    item.subfolder ?? '',
    item.type ?? 'output',
    args.out,
  );
  console.log();
  console.log(`✓ refined image → ${downloaded}`);
  console.log(`  original:      ${imageAbs}`);
  console.log(`  open both:     open "${imageAbs}" "${downloaded}"`);

  // Sidecar meta with the instruction so we can replay/debug.
  writeFileSync(
    outAbs.replace(/\.[^.]+$/, '.meta.json'),
    JSON.stringify(
      {
        runner: 'refineImageViaQwen.ts',
        baseImage: imageAbs,
        instruction: args.instruction,
        endpoint: baseUrl,
        multiAngleStrength: args.strength,
        seed,
        promptId,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  console.error(`✗ ${(err as Error)?.message ?? String(err)}`);
  process.exit(1);
});
