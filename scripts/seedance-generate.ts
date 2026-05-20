#!/usr/bin/env tsx
/**
 * Generate a single video via OpenRouter's bytedance/seedance-2.0 using the
 * SAME motion prompt and SAME first-frame image as an existing LTX shot,
 * so the two can be compared side-by-side by eye.
 *
 * Defaults target noir_detective_story_setup-3.dhee scene 1 shot 1, but
 * any prompt/image pair can be passed via --prompt and --image.
 *
 * Usage:
 *   pnpm tsx scripts/seedance-generate.ts
 *   pnpm tsx scripts/seedance-generate.ts --prompt "..." --image path/to.png --out path/to.mp4
 *
 * Env:
 *   OPENROUTER_API_KEY  preferred
 *   LLM_JUDGE_API_KEY   fallback (this repo stores OpenRouter keys here)
 */

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs';
import { dirname, resolve, basename, extname } from 'path';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

const DEFAULTS = {
  prompt:
    'Vikram at table, surges to his feet shoving chair backward scraping across floor, quick upward tilt from low angle, flickering torch atmosphere, cinematic tone, emphasis on rising motion and chair slide',
  image: resolve(
    REPO_ROOT,
    'noir_detective_story_setup-3.dhee/assets/images/UTQTQQa-_0f8d340be31e85cd5953fac6cc48b84fe592a8699e9b519d37dfb1f5518b8226.png',
  ),
  ltxVideo: resolve(
    REPO_ROOT,
    'noir_detective_story_setup-3.dhee/assets/videos/shots/fmhuULCN_963b17a30936a2041a631c2706732d3bb4b8d1c52ea05650c56e91761fa710ea.mp4',
  ),
  outDir: resolve(REPO_ROOT, 'noir_detective_story_setup-3.dhee/assets/videos/compare_seedance_vs_ltx'),
  model: 'bytedance/seedance-2.0',
};

function arg(name: string): string | undefined {
  const idx = process.argv.findIndex(a => a === `--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return undefined;
}

async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY ?? process.env.LLM_JUDGE_API_KEY;
  if (!apiKey) {
    console.error('No OpenRouter API key found (tried OPENROUTER_API_KEY, LLM_JUDGE_API_KEY).');
    process.exit(1);
  }

  const prompt = arg('prompt') ?? DEFAULTS.prompt;
  const imagePath = resolve(arg('image') ?? DEFAULTS.image);
  const outDir = resolve(arg('out-dir') ?? DEFAULTS.outDir);
  const outName = arg('out-name') ?? 'seedance_scene_1_shot_1.mp4';
  const model = arg('model') ?? DEFAULTS.model;

  if (!existsSync(imagePath)) {
    console.error(`Image not found: ${imagePath}`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const ext = extname(imagePath).toLowerCase().replace('.', '') || 'png';
  const mime = ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  const imageBytes = readFileSync(imagePath);
  const dataUrl = `data:${mime};base64,${imageBytes.toString('base64')}`;

  console.log('Model       :', model);
  console.log('Prompt      :', prompt);
  console.log('First frame :', imagePath);
  console.log('  → bytes   :', imageBytes.length);
  console.log('Out         :', resolve(outDir, outName));
  console.log('');

  const submitBody: Record<string, unknown> = {
    model,
    prompt,
    frame_images: [
      {
        image_url: { url: dataUrl },
        type: 'image_url',
        frame_type: 'first_frame',
      },
    ],
    duration: 4,
    aspect_ratio: '16:9',
    resolution: '480p',
  };

  console.log('Submitting to OpenRouter…');
  const submitRes = await fetch('https://openrouter.ai/api/v1/videos', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(submitBody),
  });

  const submitText = await submitRes.text();
  if (!submitRes.ok) {
    console.error(`Submit failed (${submitRes.status}):`);
    console.error(submitText);
    process.exit(1);
  }

  let submitJson: any;
  try {
    submitJson = JSON.parse(submitText);
  } catch {
    console.error('Submit returned non-JSON:', submitText);
    process.exit(1);
  }

  const jobId = submitJson.id;
  const pollingUrl: string | undefined = submitJson.polling_url;
  if (!pollingUrl) {
    console.error('No polling_url in submit response:', submitJson);
    process.exit(1);
  }

  console.log('Job submitted:', jobId);
  console.log('Polling:     ', pollingUrl);
  console.log('');

  const started = Date.now();
  let videoUrl: string | undefined;
  let last = '';

  while (true) {
    const pollRes = await fetch(pollingUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const pollText = await pollRes.text();
    let pollJson: any;
    try {
      pollJson = JSON.parse(pollText);
    } catch {
      console.error('Poll returned non-JSON:', pollText);
      process.exit(1);
    }

    const status = pollJson.status ?? 'unknown';
    const elapsed = Math.round((Date.now() - started) / 1000);
    const line = `[${elapsed}s] status=${status}`;
    if (line !== last) {
      console.log(line);
      last = line;
    }

    if (status === 'completed') {
      const urls: string[] = pollJson.unsigned_urls ?? pollJson.urls ?? [];
      videoUrl = urls[0];
      if (!videoUrl) {
        console.error('No video URL in completed response:', pollJson);
        process.exit(1);
      }
      break;
    }
    if (status === 'failed') {
      console.error('Generation failed:', pollJson.error ?? pollJson);
      process.exit(1);
    }

    await new Promise(r => setTimeout(r, 5000));
  }

  console.log('Video URL:  ', videoUrl);
  console.log('Downloading…');

  const dlRes = await fetch(videoUrl!, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!dlRes.ok) {
    console.error(`Download failed (${dlRes.status})`);
    process.exit(1);
  }
  const videoBytes = Buffer.from(await dlRes.arrayBuffer());
  const outPath = resolve(outDir, outName);
  writeFileSync(outPath, videoBytes);
  console.log('Wrote        :', outPath, `(${videoBytes.length} bytes)`);

  const ltxPath = arg('ltx') ?? DEFAULTS.ltxVideo;
  if (existsSync(ltxPath)) {
    const ltxCopy = resolve(outDir, 'ltx_' + basename(ltxPath));
    copyFileSync(ltxPath, ltxCopy);
    console.log('LTX copy     :', ltxCopy);
  }

  console.log('');
  console.log('Done. Compare:');
  console.log('  Seedance:', outPath);
  console.log('  LTX     :', ltxPath);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
