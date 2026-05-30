#!/usr/bin/env tsx
/**
 * Sister script to refineImageViaQwen.ts — same experiment, different
 * model. Submits the current rendered shot back into FLUX 2 Klein
 * Edit (cloud Comfy) with a corrective instruction and the image as
 * its own base. Validates the hypothesis that the review-loop's
 * "3 attempts" can be refinement passes on the same image — Klein
 * variant.
 *
 * Klein is the default image-edit model per memory
 * (feedback_image_gen_escalation): cheap (~$0.014/call on Flex tier),
 * supports up to 4 reference image slots, runs on cloud Comfy by
 * design (no local checkpoint required).
 *
 * Usage:
 *   pnpm tsx scripts/refineImageViaKlein.ts \
 *     --project "/Users/ganaraj/dhee-studios/Ruby V4 refined" \
 *     --shot scene_2_shot_6 \
 *     --instruction "Reverse the gun direction. Ruby's hand grips the revolver pointed AT the owner's forehead." \
 *     [--out scene_2_shot_6_klein_refined.png]
 *     [--width 1024 --height 1024]
 */
import 'dotenv/config';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.ts';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.ts';

interface Args {
  project: string;
  shot: string;
  instruction: string;
  out: string;
  width: number;
  height: number;
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
      `Usage: pnpm tsx scripts/refineImageViaKlein.ts --project <dir> --shot <id> --instruction "<text>" [--out <name>] [--width 1024] [--height 1024]`,
    );
    process.exit(2);
  }
  return {
    project,
    shot,
    instruction,
    out: get('out') ?? `${shot}_klein_refined.png`,
    width: Number(get('width') ?? '1024'),
    height: Number(get('height') ?? '1024'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(`refineImageViaKlein:`);
  console.log(`  project:     ${args.project}`);
  console.log(`  shot:        ${args.shot}`);
  console.log(`  out:         ${args.out}`);
  console.log(`  size:        ${args.width} × ${args.height}`);
  console.log(`  instruction: ${args.instruction}`);
  console.log();

  // ── Endpoint: Klein workflow is cloud-only. Hard-require cloud. ──
  const baseUrl =
    process.env['ENDPOINT_public_cloud'] ?? 'https://cloud.comfy.org/api';
  const apiKey = process.env['COMFY_CLOUD_API_KEY'];
  if (!apiKey) {
    console.error(
      `✗ Klein requires COMFY_CLOUD_API_KEY in env. Cloud endpoint: ${baseUrl}`,
    );
    process.exit(3);
  }
  console.log(`endpoint: ${baseUrl} (cloud)`);

  // ── Load current image ──
  const imageAbs = resolve(args.project, 'assets/images/shots', `${args.shot}_first.png`);
  if (!existsSync(imageAbs)) {
    console.error(`✗ image not found at ${imageAbs}`);
    process.exit(3);
  }
  console.log(`base image: ${imageAbs} (${readFileSync(imageAbs).length} bytes)`);

  // ── Load Klein edit workflow + manifest ──
  // CWD is the kshana-core repo root when invoked via pnpm tsx.
  const repoRoot = process.cwd();
  const wfPath = resolve(repoRoot, 'workflows/cloud/flux2_klein_edit_cloud.json');
  const manifestPath = resolve(repoRoot, 'workflows/cloud/flux2_klein_edit_cloud.manifest.json');
  if (!existsSync(wfPath) || !existsSync(manifestPath)) {
    console.error(`✗ Klein workflow/manifest missing under workflows/cloud/`);
    process.exit(3);
  }
  const template = JSON.parse(readFileSync(wfPath, 'utf-8'));
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  // ── Comfy client + upload base ──
  const outAbs = resolve(args.project, 'assets/images/shots', args.out);
  mkdirSync(dirname(outAbs), { recursive: true });
  const client = new ComfyUIClient({
    baseUrl,
    outputDir: dirname(outAbs),
    apiKey,
    isCloud: true,
  });

  console.log(`uploading base image...`);
  const upBase = await client.uploadImage(imageAbs, 'input', true);
  console.log(`  base → ${upBase.name}`);

  // ── Build params + parameterize workflow ──
  // The Klein workflow has 4 LoadImage slots; all must point at a real
  // uploaded filename or Comfy errors on placeholders. For pure
  // refinement we want NO extra references — fill all ref slots with
  // the base so Klein sees only the image we want to refine.
  const seed = Math.floor(Math.random() * 0x7fffffff);
  const negative = 'cartoon, anime, illustration, mascot, anthropomorphic animal, cel-shaded, sticker art, 3D render, video game, cgi, plastic skin, doll-like, chibi, painterly, watercolor';
  const params: Record<string, unknown> = {
    prompt: args.instruction,
    negative_prompt: negative,
    base_image: upBase.name,
    reference_image_1: upBase.name,
    reference_image_2: upBase.name,
    reference_image_3: upBase.name,
    seed,
    filenamePrefix: `refine/klein/${Date.now()}`,
    width: args.width,
    height: args.height,
  };
  const workflow = parameterizeGeneric(template, manifest, params) as Record<string, unknown>;

  console.log(`submitting (seed=${seed})...`);
  const start = Date.now();
  const { promptId, outputs } = await client.queueAndWaitWS(
    workflow as never,
    (p) => {
      if (p.percentage !== undefined && p.message) {
        console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
      }
    },
  );
  console.log(`  done in ${Math.floor((Date.now() - start) / 1000)}s (prompt_id=${promptId})`);

  // ── Download ──
  const hist = await client.getOutputImages(promptId);
  const all = [...outputs, ...hist].filter((o) => /\.(png|jpg|webp)$/i.test(o.filename));
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

  writeFileSync(
    outAbs.replace(/\.[^.]+$/, '.meta.json'),
    JSON.stringify(
      {
        runner: 'refineImageViaKlein.ts',
        baseImage: imageAbs,
        instruction: args.instruction,
        endpoint: baseUrl,
        seed,
        promptId,
        width: args.width,
        height: args.height,
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
