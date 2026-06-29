#!/usr/bin/env tsx
/**
 * Generate Side B of a setting image via Gemini image-output models
 * (Nano Banana 2 / Pro) on OpenRouter.
 *
 * Unlike Klein, these models are conditioned on the chat-completions
 * style input — we POST one source image + a text prompt; the model
 * returns one or more image outputs in the response.
 *
 * Args:
 *   --image <path>     required, source image
 *   --prompt "<text>"  required, edit instruction
 *   --model <id>       OpenRouter model id (default: NB2 = 3.1 Flash Image Preview)
 *   --out <name>       output filename (in same dir as input)
 *
 * Models to try:
 *   - google/gemini-3.1-flash-image-preview   (NB2, cheaper, "3.1 preview")
 *   - google/gemini-3-pro-image-preview       (NBP, most capable)
 *   - google/gemini-2.5-flash-image           (NB1, oldest)
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, basename, join } from 'node:path';

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
}

async function main() {
  const imagePath = arg('image', '');
  const prompt = arg('prompt', '');
  const model = arg('model', 'google/gemini-3.1-flash-image-preview');
  const outName = arg('out', '');
  if (!imagePath || !prompt) {
    console.error('Usage: nb-side-b --image <path> --prompt "<text>" [--model <id>] [--out <name>]');
    process.exit(1);
  }
  if (!existsSync(imagePath)) {
    console.error(`Source image not found: ${imagePath}`);
    process.exit(1);
  }

  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    console.error('OPENAI_API_KEY not set');
    process.exit(1);
  }

  // Load + base64-encode the source image.
  const imageBytes = readFileSync(imagePath);
  const imageB64 = imageBytes.toString('base64');
  const mime = imagePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  const dataUrl = `data:${mime};base64,${imageB64}`;

  console.log(`Model:  ${model}`);
  console.log(`Source: ${basename(imagePath)} (${(imageBytes.length / 1024).toFixed(1)} KB)`);
  console.log(`Prompt: ${prompt.slice(0, 160)}${prompt.length > 160 ? '…' : ''}`);

  const body = {
    model,
    // OpenRouter Flex tier: ~50% off Default rate for Gemini image models.
    // Opt-in per request; not visible in /endpoints listing.
    service_tier: 'flex',
    messages: [
      {
        role: 'user' as const,
        content: [
          { type: 'image_url' as const, image_url: { url: dataUrl } },
          { type: 'text' as const, text: prompt },
        ],
      },
    ],
    // OpenRouter requires this to flag we want image output back.
    modalities: ['image', 'text'],
  };

  const start = Date.now();
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://dhee.local',
      'X-Title': 'dhee-core side-b experiment',
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text();
    console.error(`OpenRouter error (${resp.status}): ${t}`);
    process.exit(1);
  }
  const data = await resp.json() as {
    choices?: Array<{
      message?: {
        content?: string;
        images?: Array<{ image_url?: { url: string }; type?: string }>;
      };
    }>;
    usage?: { cost?: number; cost_details?: Record<string, unknown> };
    error?: { message?: string };
  };
  console.log(`  done in ${Math.floor((Date.now() - start) / 1000)}s`);

  if (data.error) {
    console.error(`API error: ${data.error.message}`);
    process.exit(1);
  }
  if (data.usage) {
    console.log(`  cost: $${data.usage.cost ?? '?'} | details:`, data.usage.cost_details ?? {});
  }

  const choice = data.choices?.[0];
  const images = choice?.message?.images;
  if (!images || images.length === 0) {
    console.error('No image returned. Full message:');
    console.error(JSON.stringify(choice?.message ?? data, null, 2).slice(0, 2000));
    process.exit(1);
  }

  const target = outName || `${basename(imagePath, '.png')}_nb_${Date.now()}.png`;
  const outAbs = join(dirname(imagePath), target);
  const img0 = images[0]!;
  const url = img0.image_url?.url ?? '';
  if (url.startsWith('data:')) {
    const b64 = url.split(',', 2)[1] ?? '';
    writeFileSync(outAbs, Buffer.from(b64, 'base64'));
  } else if (url.startsWith('http')) {
    const r = await fetch(url);
    writeFileSync(outAbs, Buffer.from(await r.arrayBuffer()));
  } else {
    console.error('Unexpected image_url format:', url.slice(0, 100));
    process.exit(1);
  }
  console.log(`Saved: ${outAbs}`);
  if (choice?.message?.content) {
    console.log(`Text response: ${choice.message.content.slice(0, 300)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
