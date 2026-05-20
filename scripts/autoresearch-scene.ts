#!/usr/bin/env tsx
/**
 * Autoresearch: optimize scene_guide.md
 *
 * Key difference from other autoresearch scripts: generates ALL scenes
 * and evaluates them TOGETHER to catch cross-scene repetition.
 *
 * Each scene gets its summary (which beats to cover) plus summaries of
 * all other scenes (to avoid repetition).
 *
 * Usage:
 *   pnpm tsx scripts/autoresearch-scene.ts [iterations] [project-dir]
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { LLMClient } from '../src/core/llm/index.js';

const MAX_ITERATIONS = parseInt(process.argv[2] || '3', 10);
const PROJECT_DIR = process.argv[3] || 'story_begins_girl_sprinting-2.dhee';
const GUIDE_PATH = 'prompts/skills/defaults/scene_guide.md';
const RUBRIC_PATH = 'tests/autoresearch/rubrics/scene-binary.json';
const OUTPUT_DIR = 'test-output/autoresearch-scene';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf-8'));
const story = existsSync(join(PROJECT_DIR, 'chapters/chapter_1/plans/story.md'))
  ? readFileSync(join(PROJECT_DIR, 'chapters/chapter_1/plans/story.md'), 'utf-8') : '';

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

// Scene summaries — these define the BOUNDARY for each scene
const sceneSummaries = [
  { sceneNumber: 1, title: 'The Path of Phantoms', summary: 'The Girl sprints through the apocalyptic city, following phantom versions of herself. Phantoms die from debris, monsters, and collisions — she veers to avoid their fates. The number of safe paths dwindles as more phantoms are killed.' },
  { sceneNumber: 2, title: 'The Final Stand', summary: 'The last phantom dies. The Girl changes direction to flee a monster. She jumps obstacles and rounds corners until she hits a dead end. The monster approaches. She whispers "Damn it..." then screams "DON\'T COME THIS WAY!!!" The monster kills her.' },
  { sceneNumber: 3, title: 'Temporal Reset', summary: 'The apocalypse continues around her death. Time passes — days, weeks. A bright light explodes over the horizon and floods the world. The light fades and the scenery reverts to the original apocalyptic scene.' },
  { sceneNumber: 4, title: 'Breaking the Loop', summary: 'A phantom of the Girl runs into the dead end and shouts the warning "DON\'T COME THIS WAY!!!". The real Girl, some distance away, hears the phantom\'s warning and chooses a different direction to keep running.' },
];

const llm = new LLMClient({
  baseUrl: process.env['OPENAI_BASE_URL'] || process.env['LLM_BASE_URL'],
  apiKey: process.env['OPENAI_API_KEY'] || process.env['LLM_API_KEY'],
  model: process.env['OPENAI_MODEL'] || process.env['LLM_MODEL'],
});

function claudeP(prompt: string, jsonSchema?: Record<string, unknown>): string {
  const tmpFile = `/tmp/ar-scene-${Date.now()}.txt`;
  writeFileSync(tmpFile, prompt);
  try {
    let cmd = `cat "${tmpFile}" | claude -p --output-format json`;
    if (jsonSchema) {
      cmd += ` --json-schema '${JSON.stringify(jsonSchema)}'`;
    }
    const raw = execSync(cmd, {
      encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 300000,
    });
    const envelope = JSON.parse(raw);
    if (envelope.structured_output) return JSON.stringify(envelope.structured_output);
    return envelope.result || raw;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* */ }
  }
}

async function generateScene(guide: string, sceneNum: number): Promise<string> {
  const scene = sceneSummaries[sceneNum - 1];
  if (!scene) return '';

  const allSummaries = sceneSummaries.map(s =>
    `Scene ${s.sceneNumber}: "${s.title}" — ${s.summary}`
  ).join('\n');

  const systemPrompt = `You create detailed scene descriptions for cinematic video production.
Output rich, engaging prose with dialogue, description, and pacing.

<model_skills>
${guide}
</model_skills>`;

  const userPrompt = `Create Scene ${sceneNum}: "${scene.title}"

<scene_assignment>
YOUR SCENE: Scene ${sceneNum} — "${scene.title}"
SUMMARY: ${scene.summary}

You must ONLY write shots for the beats described in YOUR SUMMARY above.
Do NOT include events, dialogue, or climactic moments from other scenes.

ALL SCENES IN THIS VIDEO (for context only — write ONLY yours):
${allSummaries}
</scene_assignment>

<context>
### Full Story
${story}

### Characters
${characters.join('\n\n---\n\n')}

### Settings
${settings.join('\n\n---\n\n')}
</context>`;

  const response = await llm.generate({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
  });
  return response.content || '';
}

function evaluateScene(
  sceneText: string,
  sceneNum: number,
  allSceneTexts: string[],
): { score: number; total: number; failures: string[] } {
  const scene = sceneSummaries[sceneNum - 1];
  if (!scene) return { score: 0, total: 0, failures: [] };

  const allSummaries = sceneSummaries.map(s =>
    `Scene ${s.sceneNumber}: "${s.title}" — ${s.summary}`
  ).join('\n');

  const otherScenes = allSceneTexts
    .map((t, i) => i !== sceneNum - 1 ? `Scene ${i + 1} excerpt: ${t.substring(0, 500)}...` : '')
    .filter(Boolean)
    .join('\n\n');

  const questions = rubric.questions
    .map((q: { id: string; question: string }, i: number) => `${i + 1}. [${q.id}] ${q.question}`)
    .join('\n');

  const prompt = `Be strict. Evaluate this scene description.

## Story
${story}

## This Scene's Assignment
Scene ${sceneNum}: "${scene.title}" — ${scene.summary}

## All Scene Summaries
${allSummaries}

## Generated Scene ${sceneNum} (BEING EVALUATED)
${sceneText}

## Other Scenes (for repetition check)
${otherScenes}

## Questions
${questions}

Answer each question YES or NO with a brief reason.`;

  const answerProps: Record<string, unknown> = {};
  for (const q of rubric.questions) {
    answerProps[q.id] = {
      type: 'object',
      properties: {
        answer: { type: 'string', enum: ['YES', 'NO'] },
        reason: { type: 'string' },
      },
      required: ['answer', 'reason'],
    };
  }
  const evalSchema = {
    type: 'object',
    properties: {
      answers: { type: 'object', properties: answerProps, required: rubric.questions.map((q: { id: string }) => q.id) },
      score: { type: 'number' },
      total: { type: 'number' },
    },
    required: ['answers', 'score', 'total'],
  };

  const result = claudeP(prompt, evalSchema);
  const parsed = JSON.parse(result);
  const failures = Object.entries(parsed.answers)
    .filter(([, v]: [string, any]) => v.answer === 'NO')
    .map(([k]) => k);
  return { score: parsed.score, total: parsed.total, failures };
}

function proposeImprovement(
  guide: string,
  evalResults: Array<{ sceneNum: number; score: number; total: number; failures: string[] }>,
): string {
  const summary = evalResults.map(r =>
    `Scene ${r.sceneNum}: ${r.score}/${r.total} — Failed: ${r.failures.join(', ') || 'none'}`
  ).join('\n');
  const allFailures = [...new Set(evalResults.flatMap(r => r.failures))];

  const prompt = `You are rewriting a prompt guide. You must output the COMPLETE rewritten guide — every section, every rule, every example. Do NOT output a summary of changes, do NOT describe what you would change, do NOT ask for permission. Output the FULL guide text ready to be saved to a file.

## Current Guide (rewrite this entirely)
${guide}

## Evaluation Results
${summary}

## Failures To Fix
${allFailures.map(f => `- ${f}`).join('\n')}

INSTRUCTIONS:
1. Keep ALL sections that are working (dialogue inventory, character actions, etc.)
2. ADD or STRENGTHEN rules to fix the failures listed above
3. Do NOT add shot types, durations, camera directions — this guide is for NARRATIVE PROSE only
4. The output must be a COMPLETE, STANDALONE guide — not a diff, not a summary of changes
5. Start the output with: **PURPOSE**:
6. Do NOT include any preamble like "Here's the improved guide" or "I need permission"

OUTPUT THE COMPLETE GUIDE NOW:`;

  let result = claudeP(prompt);
  const purposeIdx = result.indexOf('**PURPOSE**');
  if (purposeIdx > 0) result = result.substring(purposeIdx);

  // Validate: if the result is too short or doesn't contain guide-like content, keep the original
  if (result.length < 500 || !result.includes('## ')) {
    console.log(`  WARNING: Improver output looks like meta-commentary (${result.length} chars), keeping original guide`);
    return guide;
  }
  return result;
}

async function main() {
  console.log(`Autoresearch: Scene Guide`);
  console.log(`Project: ${PROJECT_DIR} (${sceneSummaries.length} scenes)`);
  console.log('');

  let guide = readFileSync(GUIDE_PATH, 'utf-8');

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`ITERATION ${iter}/${MAX_ITERATIONS}`);
    console.log(`${'='.repeat(50)}`);

    // Generate ALL scenes
    const sceneTexts: string[] = [];
    for (let s = 1; s <= sceneSummaries.length; s++) {
      console.log(`  Generating scene ${s}...`);
      const text = await generateScene(guide, s);
      sceneTexts.push(text);
      writeFileSync(join(OUTPUT_DIR, `iter-${iter}-scene-${s}.md`), text);
      console.log(`    ${text.length} chars`);
    }

    // Evaluate each with cross-scene context
    const evalResults: Array<{ sceneNum: number; score: number; total: number; failures: string[] }> = [];
    let totalScore = 0, totalQ = 0;

    for (let s = 1; s <= sceneSummaries.length; s++) {
      console.log(`  Evaluating scene ${s}...`);
      try {
        const result = evaluateScene(sceneTexts[s - 1]!, s, sceneTexts);
        evalResults.push({ sceneNum: s, ...result });
        totalScore += result.score;
        totalQ += result.total;
        console.log(`    Score: ${result.score}/${result.total}`);
        if (result.failures.length > 0) console.log(`    Failed: ${result.failures.join(', ')}`);
      } catch (e) {
        console.error(`    Eval error: ${e}`);
      }
    }

    const pct = totalQ > 0 ? (totalScore / totalQ * 100).toFixed(1) : '0';
    console.log(`\n  >> Iteration ${iter}: ${totalScore}/${totalQ} (${pct}%)`);

    writeFileSync(join(OUTPUT_DIR, `iter-${iter}-guide.md`), guide);
    writeFileSync(join(OUTPUT_DIR, `iter-${iter}-results.json`), JSON.stringify({ totalScore, totalQ, pct, evalResults }, null, 2));

    if (totalScore === totalQ) { console.log(`  PERFECT — stopping.`); break; }

    if (iter < MAX_ITERATIONS) {
      console.log(`  Proposing improvement...`);
      guide = proposeImprovement(guide, evalResults);
      writeFileSync(GUIDE_PATH, guide);
      console.log(`  Guide updated (${guide.length} chars)`);
    }
  }
  console.log(`\nDone. Results in ${OUTPUT_DIR}/`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
