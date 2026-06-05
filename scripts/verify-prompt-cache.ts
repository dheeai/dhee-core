/**
 * Live verification of the collection-node prompt-cache optimisation
 * (issue #102). Sends real calls to the configured OpenRouter model and
 * reports provider-reported cached-token counts.
 *
 * It reproduces the NEW message shape the llm.generate runner now emits
 * for collection nodes: a large INVARIANT `system` prefix (the same for
 * every item) + a tiny per-item `user` suffix.
 *
 *   A  — cold call (prefix carries a per-run nonce so the cache starts
 *        empty); primes the provider's prefix cache.
 *   B  — SAME system prefix, DIFFERENT user suffix (the next shot). This
 *        is the cross-item case: we expect cached_tokens ≈ the prefix.
 *   C  — DIFFERENT system prefix (control); we expect ~0 cached_tokens.
 *
 * Run:  pnpm tsx scripts/verify-prompt-cache.ts
 * Reads OpenRouter creds from .env (LLM_TIER_MEDIUM_* / OPENAI_* /
 * OPENROUTER_*). Makes 3 small real calls (max_tokens=16).
 */
import 'dotenv/config';
import OpenAI from 'openai';

const apiKey =
  process.env['LLM_TIER_MEDIUM_API_KEY'] ||
  process.env['OPENROUTER_API_KEY'] ||
  process.env['OPENAI_API_KEY'];
const baseURL =
  process.env['OPENROUTER_BASE_URL'] ||
  process.env['OPENAI_BASE_URL'] ||
  'https://openrouter.ai/api/v1';
const model =
  process.env['LLM_TIER_MEDIUM_MODEL'] ||
  process.env['OPENAI_MODEL'] ||
  'deepseek/deepseek-v4-flash';

if (!apiKey) {
  console.error('No API key found (LLM_TIER_MEDIUM_API_KEY / OPENROUTER_API_KEY / OPENAI_API_KEY).');
  process.exit(2);
}

const client = new OpenAI({ apiKey, baseURL });

// A realistic, LARGE invariant prefix — the kind of context every shot in
// a collection shares (full scenes_plan + style + instructions). The
// per-run nonce guarantees call A starts with a COLD cache so the A→B
// delta is unambiguous. In production there's no nonce, so the prefix is
// also identical across runs and users (cross-run / cross-user caching).
const nonce = `run-${Date.now()}`;
const scenesPlan = JSON.stringify(
  {
    shots: Array.from({ length: 40 }, (_, i) => ({
      id: `scene_1_shot_${i + 1}`,
      shotNumber: i + 1,
      description:
        `A detailed cinematic description of shot ${i + 1}, establishing the mood, ` +
        `the blocking of the characters, the camera framing and lens choice, the ` +
        `lighting setup and palette, and the narrative beat it carries. `.repeat(4),
      cameraWork: 'medium close-up, slow push-in',
      dialogue: null,
    })),
  },
  null,
  2,
);

const PREFIX =
  `INVARIANT CONTEXT (nonce ${nonce})\n\n` +
  `You are writing a Flux Klein image-edit prompt for the FIRST FRAME of a single shot.\n\n` +
  `Shot data:\n${scenesPlan}\n\n` +
  `World style: luminous cinematic realism, warm desert palette, golden-hour key light, ` +
  `soft volumetric haze, shallow depth of field.\n\n` +
  `Available character references: sela (weathered astronomer, silver-streaked braid).\n` +
  `Available setting references: observatory_interior (brass instruments, domed ceiling).\n\n` +
  `Output a JSON object: {"imagePrompt": "...", "aspectRatio": "16:9", "generationMode": "image_edit"}.\n` +
  `Output ONLY the JSON.`;

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_discount?: number;
}

interface UsageReport {
  prompt: number;
  cached: number;
  completion: number;
  discount: unknown;
  raw: unknown;
}

async function call(system: string, user: string): Promise<UsageReport> {
  const resp = (await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: 16,
    temperature: 0,
    // OpenRouter: surface cost + cached_tokens in usage.
    ...({ usage: { include: true } } as Record<string, unknown>),
  } as OpenAI.ChatCompletionCreateParamsNonStreaming)) as OpenAI.ChatCompletion & {
    usage?: OpenRouterUsage;
  };
  const u: OpenRouterUsage = resp.usage ?? {};
  return {
    prompt: u.prompt_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens ?? 0,
    completion: u.completion_tokens ?? 0,
    discount: u.cache_discount,
    raw: u,
  };
}

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : 'n/a';
}

async function main(): Promise<void> {
  console.log(`model=${model}  baseURL=${baseURL}\n`);

  const a = await call(PREFIX, 'This call is for shot id: scene_1_shot_1 — write the first-frame prompt for ONLY that shot.');
  console.log(`A  cold  prompt=${a.prompt}  cached=${a.cached} (${pct(a.cached, a.prompt)})  discount=${a.discount ?? '-'}`);

  const b = await call(PREFIX, 'This call is for shot id: scene_1_shot_3 — write the first-frame prompt for ONLY that shot.');
  console.log(`B  same prefix, next item  prompt=${b.prompt}  cached=${b.cached} (${pct(b.cached, b.prompt)})  discount=${b.discount ?? '-'}`);

  const c = await call(PREFIX + '\n(a different invariant block — control)', 'This call is for shot id: scene_1_shot_1.');
  console.log(`C  different prefix (control)  prompt=${c.prompt}  cached=${c.cached} (${pct(c.cached, c.prompt)})  discount=${c.discount ?? '-'}`);

  console.log('\n--- verdict ---');
  console.log(`B cached ${b.cached} / ${b.prompt} tokens → ${b.cached > 0 ? 'CACHE HIT ✓ (cross-item prefix reuse works)' : 'NO CACHE ✗'}`);
  console.log(`C cached ${c.cached} / ${c.prompt} tokens → ${c.cached <= a.cached ? 'control behaves as expected (changing the prefix breaks the cache)' : 'unexpected'}`);
  console.log('\nRaw usage objects:');
  console.log('A:', JSON.stringify(a.raw));
  console.log('B:', JSON.stringify(b.raw));
  console.log('C:', JSON.stringify(c.raw));
}

main().catch((err) => {
  console.error('verify-prompt-cache failed:', err?.message ?? err);
  process.exit(1);
});
