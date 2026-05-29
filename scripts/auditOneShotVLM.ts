/**
 * Audit ONE rendered shot-image via the configured OpenRouter VLM.
 *
 * Usage:
 *   npx tsx scripts/auditOneShotVLM.ts <projectDir> <shotId>
 *
 * Example:
 *   npx tsx scripts/auditOneShotVLM.ts \
 *     "/Users/ganaraj/dhee-studios/Ruby V4" scene_1_shot_3
 *
 * The script reads:
 *   - <projectDir>/prompts/shot_image/<shotId>.json   (the prompt)
 *   - <projectDir>/assets/images/shots/<shotId>_first.png  (the render)
 *
 * Sends the image + structured prompt to the VLM (env: VLM_PROVIDER /
 * VLM_API_KEY / VLM_MODEL / VLM_BASE_URL), parses the trailing
 * `VERDICT: …` line, and prints a single-line JSON envelope:
 *
 *   {"shot":"scene_1_shot_3","verdict":"REGEN","notes":"<prose>"}
 *
 * Designed to be spawned in parallel by sub-agents — single-shot
 * invocation, no state, one envelope per call.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { loadDevEnv } from '../src/server/loadDevEnv.ts';
import { getVLMConfig } from '../src/core/llm/getVLMConfig.ts';
import {
  AUDIT_SYSTEM_PROMPT,
  buildShotUserMessage,
} from './auditShotsVLMPrompt.ts';

interface ShotPrompt {
  view: string;
  elevation: string;
  distance: string;
  deltaText: string;
}

type Verdict = 'OK' | 'OK_WITH_NOTES' | 'REGEN' | 'REGEN_PROMPT_EDIT' | 'PARSE_FAIL';

function extractVerdict(text: string): { verdict: Verdict; notes: string } {
  // The system prompt mandates the LAST LINE be exactly `VERDICT: <X>`,
  // but models drift: reka likes `**VERDICT:**`, claude likes
  // `\nVERDICT: REGEN.`, etc. Strip markdown bold + accept whatever
  // whitespace / punctuation sits between the marker and the token.
  const stripped = text.replace(/\*\*/g, '');
  const m = stripped.match(/VERDICT[:\s]*?(OK_WITH_NOTES|OK|REGEN_PROMPT_EDIT|REGEN)\b/i);
  if (!m) {
    return { verdict: 'PARSE_FAIL', notes: text.trim() };
  }
  const verdict = m[1]!.toUpperCase() as Verdict;
  // Notes = everything up to the verdict marker in the ORIGINAL text
  // (not the stripped one) so users see the asterisks if reka emits
  // them — preserves what the model actually said.
  const origMarker = text.search(/VERDICT/i);
  const notes = origMarker >= 0 ? text.slice(0, origMarker).trim() : text.trim();
  return { verdict, notes };
}

async function main(): Promise<void> {
  loadDevEnv();

  const [, , projectDir, shotId] = process.argv;
  if (!projectDir || !shotId) {
    console.error('Usage: tsx auditOneShotVLM.ts <projectDir> <shotId>');
    process.exit(2);
  }

  const promptPath = join(projectDir, 'prompts', 'shot_image', `${shotId}.json`);
  const imagePath = join(projectDir, 'assets', 'images', 'shots', `${shotId}_first.png`);
  if (!existsSync(promptPath)) {
    console.error(JSON.stringify({ shot: shotId, error: `missing prompt: ${promptPath}` }));
    process.exit(3);
  }
  if (!existsSync(imagePath)) {
    console.error(JSON.stringify({ shot: shotId, error: `missing image: ${imagePath}` }));
    process.exit(3);
  }

  const prompt = JSON.parse(readFileSync(promptPath, 'utf8')) as ShotPrompt;
  const config = getVLMConfig();
  if (!config) {
    console.error(JSON.stringify({ shot: shotId, error: 'VLM config missing (VLM_PROVIDER/VLM_API_KEY/VLM_MODEL)' }));
    process.exit(4);
  }

  // Direct OpenAI-compatible call — we deliberately do NOT use
  // LLMClient.chatWithImage because it stamps `reasoning.exclude:
  // true` on every request, which on some reasoning-VLM models
  // (mimo-v2.5, etc.) suppresses the `content` field too. The audit
  // needs the model's final answer; if it reasons in the process,
  // we just give it enough max_tokens to fit both.
  const client = new OpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey });
  const imgB64 = readFileSync(imagePath).toString('base64');
  const ext = imagePath.endsWith('.jpg') || imagePath.endsWith('.jpeg') ? 'jpeg' : 'png';
  const dataUrl = `data:image/${ext};base64,${imgB64}`;
  const userMsg = buildShotUserMessage({
    shotId,
    view: prompt.view,
    elevation: prompt.elevation,
    distance: prompt.distance,
    deltaText: prompt.deltaText,
  });
  const completion = await client.chat.completions.create({
    model: config.model,
    temperature: 0.1,
    max_tokens: 4000,
    messages: [
      { role: 'system', content: AUDIT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: userMsg },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  } as never);
  const raw = completion.choices[0]?.message?.content ?? '';
  // Capture usage + cost so the orchestrator can sum them up. OpenRouter
  // includes `cost` in USD on the usage object when `usage.include`
  // isn't disabled. Falls back to 0 on providers that omit it.
  const usage = (completion as unknown as {
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;
    };
  }).usage ?? {};

  const { verdict, notes } = extractVerdict(raw);
  process.stdout.write(JSON.stringify({
    shot: shotId,
    verdict,
    notes,
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      cost_usd: usage.cost ?? 0,
    },
  }) + '\n');
}

main().catch((e: unknown) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(JSON.stringify({ shot: process.argv[3] ?? '?', error: msg }));
  process.exit(1);
});
