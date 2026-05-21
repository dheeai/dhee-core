#!/usr/bin/env tsx
/**
 * Smoke test: confirm the integrated scene_breakdown_plan_guide.md (now
 * Bharata-enabled in-place) drives DeepSeek to emit rasa/narrativeMode/
 * sthayi + optional shot tags WITHOUT the manual injection we used in the
 * earlier A/B test. If this works, the prompt integration is live.
 *
 * Usage: pnpm tsx scripts/bharata-smoke-stageA.ts <project_dir> [scene_num]
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { LLMClient } from '../src/core/llm/index.js';

const PROJECT = process.argv[2] || 'chhaya_60s_anime.kshana';
const SCENE_NUM = parseInt(process.argv[3] || '1', 10);
const OUT_DIR = `test-output/bharata-smoke/${basename(PROJECT)}`;
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });

const sceneMd = readFileSync(`${PROJECT}/chapters/chapter_1/scenes/scene_${SCENE_NUM}.md`, 'utf-8');
const guide = readFileSync('prompts/skills/defaults/scene_breakdown_plan_guide.md', 'utf-8');

const llm = new LLMClient({
  baseUrl: process.env['LLM_TIER_HEAVY_BASE_URL'] || 'https://openrouter.ai/api/v1',
  apiKey: process.env['LLM_TIER_HEAVY_API_KEY'],
  model: process.env['LLM_TIER_HEAVY_MODEL'] || 'deepseek/deepseek-v4-flash',
});

console.log(`project: ${PROJECT}, scene: ${SCENE_NUM}, model: ${process.env['LLM_TIER_HEAVY_MODEL']}`);
console.log(`guide length: ${guide.length} chars (integrated Bharata)`);

const sys = `You are a cinematic shot planner. Output ONLY valid JSON conforming to scene_shot_plan schema.\n\n<guide>\n${guide}\n</guide>`;
const user = `Break this scene into shots. Output the scene_shot_plan JSON object only — no prose, no commentary.\n\n<scene>\n${sceneMd}\n</scene>`;

const t0 = Date.now();
const res = await llm.generate({
  messages: [{ role: 'system', content: sys }, { role: 'user', content: user }],
  temperature: 0.7,
  maxTokens: 16000,
  responseFormat: { type: 'json_object' },
});
const ms = Date.now() - t0;
const content = res.content || '';
const outPath = join(OUT_DIR, `scene${SCENE_NUM}_integrated.json`);
writeFileSync(outPath, content);
console.log(`done in ${(ms / 1000).toFixed(1)}s → ${outPath}`);

const parsed = JSON.parse(content);
console.log(`\nrasa: ${parsed.rasa}`);
console.log(`narrativeMode: ${parsed.narrativeMode}`);
console.log(`sthayi: ${parsed.sthayi}`);
console.log(`shots: ${parsed.shotPlan?.length ?? 0}`);
console.log(`tagged shots: ${(parsed.shotPlan ?? []).filter((s: { sattvika?: string; drishti?: string; vyabhichariBhava?: string }) => s.sattvika || s.drishti || s.vyabhichariBhava).length}`);
