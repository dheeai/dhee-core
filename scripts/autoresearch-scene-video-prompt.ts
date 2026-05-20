#!/usr/bin/env tsx
/**
 * Autoresearch: optimize scene_video_prompt_guide.md
 *
 * Usage:
 *   pnpm tsx scripts/autoresearch-scene-video-prompt.ts [iterations] [project-dir]
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { LLMClient } from '../src/core/llm/index.js';

const MAX_ITERATIONS = parseInt(process.argv[2] || '3', 10);
const PROJECT_DIR = process.argv[3] || 'air_already_thick_promise.dhee';
const GUIDE_PATH = 'prompts/skills/defaults/scene_breakdown_guide.md';
const RUBRIC_PATH = 'tests/autoresearch/rubrics/scene-video-prompt-binary.json';
const OUTPUT_DIR = 'test-output/autoresearch-svp';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf-8'));
const story = existsSync(join(PROJECT_DIR, 'chapters/chapter_1/plans/story.md'))
  ? readFileSync(join(PROJECT_DIR, 'chapters/chapter_1/plans/story.md'), 'utf-8') : '';

// Load scenes
const scenes: string[] = [];
for (let i = 1; i <= 10; i++) {
  const p = join(PROJECT_DIR, `chapters/chapter_1/scenes/scene_${i}.md`);
  if (!existsSync(p)) break;
  scenes.push(readFileSync(p, 'utf-8'));
}

// Character/setting IDs no longer needed for scene breakdown (handled downstream)

const llm = new LLMClient({
  baseUrl: process.env['LLM_BASE_URL'],
  apiKey: process.env['LLM_API_KEY'],
  model: process.env['LLM_MODEL'],
});

function claudeP(prompt: string, jsonSchema?: Record<string, unknown>): string {
  const tmpFile = `/tmp/ar-svp-${Date.now()}.txt`;
  writeFileSync(tmpFile, prompt);
  try {
    let cmd = `cat "${tmpFile}" | claude -p --output-format json`;
    if (jsonSchema) {
      const schemaFile = `/tmp/ar-svp-schema-${Date.now()}.json`;
      writeFileSync(schemaFile, JSON.stringify(jsonSchema));
      cmd += ` --json-schema '${JSON.stringify(jsonSchema)}'`;
    }
    const raw = execSync(cmd, {
      encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024, timeout: 300000,
    });
    const envelope = JSON.parse(raw);
    // --json-schema puts result in structured_output, not result
    if (envelope.structured_output) {
      return JSON.stringify(envelope.structured_output);
    }
    return envelope.result || raw;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* */ }
  }
}

async function generateSVP(guide: string, sceneNum: number): Promise<string> {
  const scene = scenes[sceneNum - 1] || '';
  const systemPrompt = `You are a cinematic shot planner. Output ONLY valid JSON.

<guide>
${guide}
</guide>`;

  const response = await llm.generate({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Break this scene into shots:\n\n${scene}` },
    ],
    temperature: 0.7,
  });
  return response.content || '';
}

function evaluateSVP(svpJson: string, sceneNum: number): { score: number; total: number; failures: string[] } {
  const scene = scenes[sceneNum - 1] || '';
  const questions = rubric.questions
    .map((q: { id: string; question: string }, i: number) => `${i + 1}. [${q.id}] ${q.question}`)
    .join('\n');

  const prompt = `Be strict. Evaluate this scene_video_prompt JSON.

## Story
${story}

## Scene Description
${scene}

## Scene Video Prompt JSON
${svpJson}

## Questions
${questions}

Answer each question YES or NO with a brief reason.`;

  // Build JSON schema for structured eval response
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

function proposeImprovement(guide: string, evalResults: Array<{ sceneNum: number; score: number; total: number; failures: string[] }>): string {
  const summary = evalResults.map(r =>
    `Scene ${r.sceneNum}: ${r.score}/${r.total} — Failed: ${r.failures.join(', ') || 'none'}`
  ).join('\n');
  const allFailures = [...new Set(evalResults.flatMap(r => r.failures))];

  const prompt = `You are optimizing a prompt guide for scene_video_prompt generation — breaking scenes into cinematic shots as JSON.

## Current Guide
${guide}

## Evaluation Results
${summary}

## Common Failures
${allFailures.map(f => `- ${f}`).join('\n')}

Rewrite the guide to fix failures while keeping what works. Be specific — add rules, examples, and formatting requirements that directly address each failure.

Output ONLY the improved guide. Start with **PURPOSE**:
Do NOT include any preamble, explanation of changes, commentary, or "Here's the improved guide" text. The very first line of your response must be "**PURPOSE**:".`;

  let result = claudeP(prompt);
  // Strip any preamble before **PURPOSE**
  const purposeIdx = result.indexOf('**PURPOSE**');
  if (purposeIdx > 0) {
    result = result.substring(purposeIdx);
  }
  return result;
}

async function main() {
  console.log(`Autoresearch: Scene Video Prompt Guide`);
  console.log(`Project: ${PROJECT_DIR} (${scenes.length} scenes)`);
  console.log('');

  let guide = readFileSync(GUIDE_PATH, 'utf-8');

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`ITERATION ${iter}/${MAX_ITERATIONS}`);
    console.log(`${'='.repeat(50)}`);

    const evalResults: Array<{ sceneNum: number; score: number; total: number; failures: string[] }> = [];
    let totalScore = 0, totalQ = 0;

    for (let s = 1; s <= Math.min(scenes.length, 3); s++) {
      console.log(`  Generating SVP ${s}...`);
      const svp = await generateSVP(guide, s);
      writeFileSync(join(OUTPUT_DIR, `iter-${iter}-svp-${s}.json`), svp);

      console.log(`  Evaluating SVP ${s}...`);
      try {
        const result = evaluateSVP(svp, s);
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
