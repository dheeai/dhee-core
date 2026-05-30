#!/usr/bin/env tsx
/**
 * Variant of auditOneShotVLM that judges an arbitrary image PATH
 * against the shot's prompt, instead of the canonical
 * {shot}_first.png. Used for A/B audits of refined / variant
 * renders (qwen_refined, klein_refined, etc.).
 *
 * Usage:
 *   pnpm tsx scripts/auditCustomImage.ts <projectDir> <shotId> <imagePath>
 *
 * Output (single-line JSON):
 *   {"shot": "scene_2_shot_6", "image": "...", "verdict": "OK|REGEN|...", "notes": "..."}
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI from 'openai';
import { loadDevEnv } from '../src/server/loadDevEnv.ts';
import { getVLMConfig } from '../src/core/llm/getVLMConfig.ts';
import { AUDIT_SYSTEM_PROMPT, buildShotUserMessage } from './auditShotsVLMPrompt.ts';

type Verdict = 'OK' | 'OK_WITH_NOTES' | 'REGEN' | 'REGEN_PROMPT_EDIT' | 'PARSE_FAIL';

function extractVerdict(text: string): { verdict: Verdict; notes: string } {
  const stripped = text.replace(/\*\*/g, '');
  const m = stripped.match(/VERDICT[:\s]*?(OK_WITH_NOTES|OK|REGEN_PROMPT_EDIT|REGEN)\b/i);
  if (!m) return { verdict: 'PARSE_FAIL', notes: text.trim() };
  const verdict = m[1]!.toUpperCase() as Verdict;
  const origMarker = text.search(/VERDICT/i);
  const notes = origMarker >= 0 ? text.slice(0, origMarker).trim() : text.trim();
  return { verdict, notes };
}

async function main(): Promise<void> {
  loadDevEnv();
  const [, , projectDir, shotId, imagePath] = process.argv;
  if (!projectDir || !shotId || !imagePath) {
    console.error('Usage: tsx auditCustomImage.ts <projectDir> <shotId> <imagePath>');
    process.exit(2);
  }
  const promptPath = join(projectDir, 'prompts', 'shot_image', `${shotId}.json`);
  if (!existsSync(promptPath)) {
    console.error(JSON.stringify({ shot: shotId, image: imagePath, error: `missing prompt: ${promptPath}` }));
    process.exit(3);
  }
  if (!existsSync(imagePath)) {
    console.error(JSON.stringify({ shot: shotId, image: imagePath, error: `missing image: ${imagePath}` }));
    process.exit(3);
  }
  const prompt = JSON.parse(readFileSync(promptPath, 'utf-8')) as {
    view: string; elevation: string; distance: string; deltaText: string;
  };
  const config = getVLMConfig();
  if (!config) {
    console.error(JSON.stringify({ shot: shotId, image: imagePath, error: 'VLM config missing' }));
    process.exit(4);
  }
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
  const { verdict, notes } = extractVerdict(raw);
  console.log(JSON.stringify({ shot: shotId, image: imagePath, verdict, notes }));
}

main().catch((err) => {
  console.error(JSON.stringify({ error: (err as Error)?.message ?? String(err) }));
  process.exit(1);
});
