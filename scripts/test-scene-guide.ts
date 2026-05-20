#!/usr/bin/env tsx
/**
 * Test the scene guide by calling the LLM with the same inputs
 * the executor would use. Outputs scene text for review.
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join } from 'path';
import { LLMClient } from '../src/core/llm/index.js';
import { resolveGuide } from '../src/core/prompts/loader.js';


const PROJECT_DIR = process.argv[2] || 'story_begins_girl_sprinting-2.dhee';
const SCENE_NUM = parseInt(process.argv[3] || '1', 10);
const OUTPUT_DIR = 'test-output/scene-guide-test';

async function main() {
  // Load the same inputs the executor would use
  const story = readFileSync(join(PROJECT_DIR, 'chapters/chapter_1/plans/story.md'), 'utf-8');
  const characters: string[] = [];
  const charDir = join(PROJECT_DIR, 'characters');
  if (existsSync(charDir)) {
    for (const f of readdirSync(charDir)) {
      if (f.endsWith('.md')) characters.push(readFileSync(join(charDir, f), 'utf-8'));
    }
  }
  const settings: string[] = [];
  const setDir = join(PROJECT_DIR, 'settings');
  if (existsSync(setDir)) {
    for (const f of readdirSync(setDir)) {
      if (f.endsWith('.md')) settings.push(readFileSync(join(setDir, f), 'utf-8'));
    }
  }

  // Load the scene guide
  const guide = resolveGuide('scene_guide', 'scene');
  console.log(`Scene guide: ${guide.source} (${guide.content?.length} chars)`);

  // Build system prompt (same as executor)
  const systemPrompt = `You create detailed scene descriptions for cinematic video production.
Output rich, engaging prose with dialogue, description, and pacing.

<model_skills>
${guide.content}
</model_skills>`;

  // Build user prompt (same context block as executor)
  const userPrompt = `Create Scenes for "scene_${SCENE_NUM}"

<context>
All required inputs for this generation have been pre-loaded below.
Generate content using ONLY the provided context.

### Task
**Creating:** Scenes
**Type:** scene
**Item:** scene_${SCENE_NUM}

---

### Full Story
**File:** chapters/chapter_1/plans/story.md

${story}

---

### Characters
${characters.map((c, i) => `**Character ${i + 1}:**\n${c}`).join('\n\n---\n\n')}

---

### Settings
${settings.map((s, i) => `**Setting ${i + 1}:**\n${s}`).join('\n\n---\n\n')}
</context>`;

  console.log(`\nSystem prompt: ${systemPrompt.length} chars`);
  console.log(`User prompt: ${userPrompt.length} chars`);
  console.log(`\nCalling LLM for scene ${SCENE_NUM}...\n`);

  const llm = new LLMClient({
    baseUrl: process.env['OPENAI_BASE_URL'] || process.env['LLM_BASE_URL'],
    apiKey: process.env['OPENAI_API_KEY'] || process.env['LLM_API_KEY'],
    model: process.env['OPENAI_MODEL'] || process.env['LLM_MODEL'],
  });

  const response = await llm.generate({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
  });

  const output = response.content || '';
  console.log('='.repeat(60));
  console.log(`SCENE ${SCENE_NUM} OUTPUT (${output.length} chars):`);
  console.log('='.repeat(60));
  console.log(output);

  // Save output
  if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
  const outFile = join(OUTPUT_DIR, `scene_${SCENE_NUM}_before.md`);
  writeFileSync(outFile, output);
  console.log(`\nSaved to ${outFile}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
