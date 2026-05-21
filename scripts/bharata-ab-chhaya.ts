#!/usr/bin/env tsx
/**
 * Usage:
 *   pnpm tsx scripts/bharata-ab-chhaya.ts <project_dir> [scene_num]
 * Default: chhaya_60s_anime.kshana scene 1
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { LLMClient } from '../src/core/llm/index.js';

const PROJECT = process.argv[2] || 'chhaya_60s_anime.kshana';
const SCENE_NUM = parseInt(process.argv[3] || '1', 10);
const OUT_DIR = `test-output/bharata-ab/${basename(PROJECT)}`;
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const sceneMd = readFileSync(`${PROJECT}/chapters/chapter_1/scenes/scene_${SCENE_NUM}.md`, 'utf-8');
const baselineGuide = readFileSync('prompts/skills/defaults/scene_breakdown_plan_guide.md', 'utf-8');
const bharataInjection = readFileSync('scripts/bharata-injection.md', 'utf-8');
const treatmentGuide = baselineGuide + '\n\n' + bharataInjection;

const llm = new LLMClient({
  baseUrl: process.env['LLM_TIER_HEAVY_BASE_URL'] || 'https://openrouter.ai/api/v1',
  apiKey: process.env['LLM_TIER_HEAVY_API_KEY'],
  model: process.env['LLM_TIER_HEAVY_MODEL'] || 'deepseek/deepseek-v4-flash',
});

console.log(`project: ${PROJECT}`);
console.log(`scene: ${SCENE_NUM}`);
console.log(`model: ${process.env['LLM_TIER_HEAVY_MODEL']}`);
console.log(`scene length: ${sceneMd.length} chars`);

const userMsg = `Break this scene into shots. Output the scene_shot_plan JSON object only — no prose, no commentary.

<scene>
${sceneMd}
</scene>`;

async function gen(guide: string, label: string) {
  console.log(`\n[${label}] generating...`);
  const t0 = Date.now();
  const sys = `You are a cinematic shot planner. Output ONLY valid JSON conforming to scene_shot_plan schema.\n\n<guide>\n${guide}\n</guide>`;
  const res = await llm.generate({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: userMsg },
    ],
    temperature: 0.7,
    maxTokens: 16000,
    responseFormat: { type: 'json_object' },
  });
  const ms = Date.now() - t0;
  const content = res.content || '';
  const outPath = join(OUT_DIR, `scene${SCENE_NUM}_${label}.json`);
  writeFileSync(outPath, content);
  console.log(`[${label}] done in ${(ms / 1000).toFixed(1)}s → ${outPath}`);
  return content;
}

// Only run treatment — baseline is already on disk in project's prompts/videos/scenes/
await gen(treatmentGuide, 'treatment');
console.log(`\nDone. Baseline already at: ${PROJECT}/prompts/videos/scenes/scene_${SCENE_NUM}.plan.json`);
