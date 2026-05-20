#!/usr/bin/env tsx
/**
 * Diagnostic probe: can we call `/v1/images/edits` directly on the
 * ComfyUI Cloud host (bypassing workflow submission) to invoke Grok's
 * image-edit model with multi-reference support?
 *
 * Background:
 *   - Current Grok integration uses a ComfyUI workflow (GrokImageEditNode)
 *     with a single `image` input — no multi-ref slots.
 *   - The underlying Grok Imagine API (`grok-imagine-image-beta`) is
 *     reported to accept multiple reference images.
 *   - If ComfyUI Cloud exposes an OpenAI-style `/v1/images/edits`
 *     endpoint that proxies to Grok, we can skip the workflow layer
 *     and get multi-ref natively.
 *
 * This script verifies:
 *   1. Which URL path actually responds (tries several variants).
 *   2. Which auth header works (X-API-Key vs Authorization: Bearer).
 *   3. Whether the endpoint accepts a single image (minimum viable).
 *   4. If single works, whether multi-image (array) is accepted.
 *
 * Usage:
 *   pnpm tsx scripts/probe-grok-direct-edits.ts
 *   pnpm tsx scripts/probe-grok-direct-edits.ts <image-path>
 *
 * Does NOT save output — just reports status codes + response bodies.
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { basename, resolve, dirname } from 'path';

const REPO_ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

const API_KEY = process.env.COMFY_CLOUD_API_KEY;
if (!API_KEY) {
  console.error('COMFY_CLOUD_API_KEY not set in .env');
  process.exit(1);
}

const TEST_IMAGE = process.argv[2] ?? resolve(
  REPO_ROOT,
  'noir_detective_story_setup-3.dhee/assets/images/3EM5uGKF_4a8e0293e3a8d48aab3b3ff7da43b6792fd9c5b05f45aa595e116657ad4e8068.png',
);
const TEST_REF = resolve(
  REPO_ROOT,
  'noir_detective_story_setup-3.dhee/assets/images/UTQTQQa-_0f8d340be31e85cd5953fac6cc48b84fe592a8699e9b519d37dfb1f5518b8226.png',
);

if (!existsSync(TEST_IMAGE)) {
  console.error(`Test image not found: ${TEST_IMAGE}`);
  process.exit(1);
}

const BASE_URLS = [
  'https://cloud.comfy.org/api',
  'https://cloud.comfy.org',
];
const PATHS = [
  '/v1/images/edits',
];
const AUTH_HEADERS: Array<{ label: string; headers: Record<string, string> }> = [
  { label: 'X-API-Key', headers: { 'X-API-Key': API_KEY } },
  { label: 'Authorization: Bearer', headers: { Authorization: `Bearer ${API_KEY}` } },
  // "api_key_comfy_org" is the body-field name ComfyUI Cloud uses inside
  // /api/prompt's extra_data — the endpoint may expose it as a matching
  // header. Try the most plausible casings.
  { label: 'X-Api-Key-Comfy-Org', headers: { 'X-Api-Key-Comfy-Org': API_KEY } },
  { label: 'Api-Key-Comfy-Org', headers: { 'Api-Key-Comfy-Org': API_KEY } },
  { label: 'x-comfy-org-api-key', headers: { 'x-comfy-org-api-key': API_KEY } },
  // Also try both header + body field simultaneously, since /api/prompt
  // sends both.
];

const imageBytes = readFileSync(TEST_IMAGE);
const imageB64 = imageBytes.toString('base64');
const imageDataUrl = `data:image/png;base64,${imageB64}`;

const refBytes = existsSync(TEST_REF) ? readFileSync(TEST_REF) : null;
const refB64 = refBytes?.toString('base64');
const refDataUrl = refB64 ? `data:image/png;base64,${refB64}` : null;

const PROMPT =
  'Same scene, minor lighting shift — make the torch light slightly brighter and the rain slightly heavier. Preserve everyone and everything in the frame exactly.';

type ProbeResult = {
  label: string;
  url: string;
  authLabel: string;
  bodyShape: string;
  status: number;
  ok: boolean;
  responseSnippet: string;
};

const results: ProbeResult[] = [];

async function probe(
  url: string,
  authLabel: string,
  headers: Record<string, string>,
  bodyShape: string,
  body: BodyInit | null,
  contentType?: string,
): Promise<ProbeResult> {
  const label = `${bodyShape} | ${url} | ${authLabel}`;
  console.log(`\n→ ${label}`);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...headers,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      },
      body,
    });
    const text = await res.text();
    const snippet = text.length > 500 ? text.slice(0, 500) + '...[truncated]' : text;
    const result = {
      label,
      url,
      authLabel,
      bodyShape,
      status: res.status,
      ok: res.ok,
      responseSnippet: snippet,
    };
    console.log(`  status=${res.status} ok=${res.ok}`);
    console.log(`  response: ${snippet}`);
    return result;
  } catch (e) {
    const result = {
      label,
      url,
      authLabel,
      bodyShape,
      status: 0,
      ok: false,
      responseSnippet: `fetch error: ${String(e)}`,
    };
    console.log(`  ${result.responseSnippet}`);
    return result;
  }
}

async function main() {
  console.log('=== Grok direct-edit probe ===');
  console.log(`Test image: ${basename(TEST_IMAGE)} (${imageBytes.length} bytes)`);
  console.log(`Ref image:  ${refBytes ? basename(TEST_REF) : '(none)'}`);
  console.log(`API key:    ${API_KEY!.slice(0, 16)}...`);
  console.log('');

  const jsonSingle = JSON.stringify({
    model: 'grok-imagine-image-beta',
    prompt: PROMPT,
    image: imageDataUrl,
    resolution: '1K',
    n: 1,
  });

  // Variant: key in body as the same field name used in /api/prompt extra_data
  const jsonSingleKeyInBody = JSON.stringify({
    model: 'grok-imagine-image-beta',
    prompt: PROMPT,
    image: imageDataUrl,
    resolution: '1K',
    n: 1,
    api_key_comfy_org: API_KEY,
  });

  // Variant: nested under extra_data
  const jsonSingleExtraData = JSON.stringify({
    model: 'grok-imagine-image-beta',
    prompt: PROMPT,
    image: imageDataUrl,
    resolution: '1K',
    n: 1,
    extra_data: { api_key_comfy_org: API_KEY },
  });

  const jsonMulti = refDataUrl
    ? JSON.stringify({
        model: 'grok-imagine-image-beta',
        prompt: PROMPT,
        image: [imageDataUrl, refDataUrl],
        resolution: '1K',
        n: 1,
      })
    : null;

  // Multipart (OpenAI /v1/images/edits convention)
  const makeMultipart = () => {
    const form = new FormData();
    form.append('model', 'grok-imagine-image-beta');
    form.append('prompt', PROMPT);
    form.append('resolution', '1K');
    form.append('image', new Blob([new Uint8Array(imageBytes)], { type: 'image/png' }), basename(TEST_IMAGE));
    return form;
  };

  for (const base of BASE_URLS) {
    for (const path of PATHS) {
      const url = `${base}${path}`;
      for (const auth of AUTH_HEADERS) {
        // Shape 1: JSON single image
        results.push(await probe(url, auth.label, auth.headers, 'json-single', jsonSingle, 'application/json'));

        // Shape 2: JSON multi image (only if we have a ref)
        if (jsonMulti) {
          results.push(await probe(url, auth.label, auth.headers, 'json-multi', jsonMulti, 'application/json'));
        }

        // Shape 3: multipart form (OpenAI convention)
        results.push(await probe(url, auth.label, auth.headers, 'multipart', makeMultipart(), undefined));
      }

      // Shape 4 + 5: key in body (no auth header) — matches extra_data convention
      results.push(
        await probe(url, 'body: api_key_comfy_org', {}, 'json-body-key', jsonSingleKeyInBody, 'application/json'),
      );
      results.push(
        await probe(url, 'body: extra_data', {}, 'json-body-extra', jsonSingleExtraData, 'application/json'),
      );
    }
  }

  console.log('\n\n=== Summary ===');
  console.log(
    results
      .map(
        r => `  ${r.ok ? '✅' : '❌'} ${String(r.status).padStart(3)} | ${r.bodyShape.padEnd(12)} | ${r.authLabel.padEnd(22)} | ${r.url}`,
      )
      .join('\n'),
  );

  const oks = results.filter(r => r.ok);
  if (oks.length > 0) {
    console.log(`\nFound ${oks.length} working combination(s). Use any to route directly.`);
  } else {
    console.log('\nNo working combination — endpoint does not exist at these paths, or auth does not match.');
    console.log('Status codes seen:', [...new Set(results.map(r => r.status))].sort().join(', '));
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
