#!/usr/bin/env tsx
/**
 * Autoresearch: optimize shot_composition_guide.md
 *
 * Usage:
 *   pnpm tsx scripts/autoresearch-shot-composition.ts [iterations] [project-dir]
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { LLMClient } from '../src/core/llm/index.js';

const MAX_ITERATIONS = parseInt(process.argv[2] || '3', 10);
const PROJECT_DIR = process.argv[3] || 'noir_detective_story_setup-3.dhee';
const GUIDE_PATH = 'prompts/skills/defaults/shot_composition_guide.md';
const RUBRIC_PATH = 'tests/autoresearch/rubrics/shot-composition-binary.json';
const OUTPUT_DIR = 'test-output/autoresearch-shot-comp';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf-8'));
const story = existsSync(join(PROJECT_DIR, 'chapters/chapter_1/plans/story.md'))
  ? readFileSync(join(PROJECT_DIR, 'chapters/chapter_1/plans/story.md'), 'utf-8') : '';

// Load scene breakdowns (scene_video_prompt JSONs)
interface ShotBreakdown {
  sceneNumber: number;
  shots: Array<{
    shotNumber: number;
    description: string;
    cameraWork: string;
    duration: number;
    audio: string;
    transition: string;
  }>;
}

function loadSceneBreakdowns(): ShotBreakdown[] {
  const breakdowns: ShotBreakdown[] = [];
  const promptDir = join(PROJECT_DIR, 'prompts/videos/scenes');
  if (!existsSync(promptDir)) return breakdowns;

  for (const f of readdirSync(promptDir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const content = readFileSync(join(promptDir, f), 'utf-8').trim()
        .replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      const parsed = JSON.parse(content);
      if (parsed.shots) breakdowns.push(parsed);
    } catch { /* skip */ }
  }
  return breakdowns;
}

// Build mock available references from project
function buildMockAvailableRefs(): string {
  const refs: string[] = [];
  let imageNum = 1;

  const charDir = join(PROJECT_DIR, 'characters');
  if (existsSync(charDir)) {
    for (const f of readdirSync(charDir)) {
      if (f.endsWith('.md')) {
        const id = f.replace('.md', '');
        refs.push(`- image ${imageNum}: character "${id}" (ref_id: "character_image:${id}")`);
        imageNum++;
      }
    }
  }

  const setDir = join(PROJECT_DIR, 'settings');
  if (existsSync(setDir)) {
    for (const f of readdirSync(setDir)) {
      if (f.endsWith('.md')) {
        const id = f.replace('.md', '');
        refs.push(`- image ${imageNum}: setting "${id}" (ref_id: "setting_image:${id}")`);
        imageNum++;
      }
    }
  }

  if (refs.length === 0) {
    return '<available_references>\nNo reference images available. Set generationMode to "text_to_image" and references to [].\n</available_references>';
  }

  return `<available_references>\nAvailable reference images for this shot:\n${refs.join('\n')}\n\nUse "from image N" in your imagePrompt. Include each used reference in the "references" array with its ref_id.\n</available_references>`;
}

const llm = new LLMClient({
  baseUrl: process.env['LLM_BASE_URL'],
  apiKey: process.env['LLM_API_KEY'],
  model: process.env['LLM_MODEL'],
});

function claudeP(prompt: string, jsonSchema?: Record<string, unknown>): string {
  const tmpFile = `/tmp/ar-sc-${Date.now()}.txt`;
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
    if (envelope.structured_output) {
      return JSON.stringify(envelope.structured_output);
    }
    return envelope.result || raw;
  } finally {
    try { unlinkSync(tmpFile); } catch { /* */ }
  }
}

async function generateShotComposition(
  guide: string,
  shot: ShotBreakdown['shots'][0],
  sceneNum: number,
  availableRefs: string,
  shotContext: string,
): Promise<string> {
  const systemPrompt = `You are an expert image prompt engineer. Output ONLY valid JSON.

<guide>
${guide}
</guide>`;

  const userPrompt = `Generate a shot_image_prompt for the following shot:

Scene ${sceneNum}, Shot ${shot.shotNumber}
Description: ${shot.description}
Camera: ${shot.cameraWork}
Duration: ${shot.duration}s
Audio: ${shot.audio}

${availableRefs}

${shotContext}`;

  const response = await llm.generate({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
  });
  return response.content || '';
}

function evaluateShotComposition(
  shotJson: string,
  shot: ShotBreakdown['shots'][0],
  sceneNum: number,
  availableRefs: string,
): { score: number; total: number; failures: string[] } {
  const questions = rubric.questions
    .map((q: { id: string; question: string }, i: number) => `${i + 1}. [${q.id}] ${q.question}`)
    .join('\n');

  const prompt = `Be strict. Evaluate this shot_image_prompt JSON.

## Story
${story}

## Shot Description (from scene breakdown)
Scene ${sceneNum}, Shot ${shot.shotNumber}: ${shot.description}
Camera: ${shot.cameraWork}
Duration: ${shot.duration}s

## Available References
${availableRefs}

## Generated shot_image_prompt JSON
${shotJson}

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
  evalResults: Array<{ label: string; score: number; total: number; failures: string[] }>,
): string {
  const summary = evalResults.map(r =>
    `${r.label}: ${r.score}/${r.total} — Failed: ${r.failures.join(', ') || 'none'}`,
  ).join('\n');
  const allFailures = [...new Set(evalResults.flatMap(r => r.failures))];

  const prompt = `You are optimizing a prompt guide for shot_image_prompt generation — writing cinematic image prompts with reference image handling.

## Current Guide
${guide}

## Evaluation Results
${summary}

## Common Failures
${allFailures.map(f => `- ${f}`).join('\n')}

Rewrite the guide to fix failures while keeping what works. Be specific — add rules, examples, and formatting requirements that directly address each failure.

IMPORTANT: Do NOT remove or reduce existing sections that are passing. Only ADD or MODIFY content to fix failures.

Output ONLY the improved guide. Start with **PURPOSE**:
Do NOT include any preamble, explanation of changes, commentary, or "Here's the improved guide" text.`;

  let result = claudeP(prompt);
  const purposeIdx = result.indexOf('**PURPOSE**');
  if (purposeIdx > 0) {
    result = result.substring(purposeIdx);
  }
  return result;
}

async function main() {
  console.log(`Autoresearch: Shot Composition Guide`);
  console.log(`Project: ${PROJECT_DIR}`);

  const breakdowns = loadSceneBreakdowns();
  if (breakdowns.length === 0) {
    console.error('No scene breakdowns found. Run the pipeline first to generate scene_video_prompt outputs.');
    process.exit(1);
  }

  const availableRefs = buildMockAvailableRefs();
  console.log(`Scenes with breakdowns: ${breakdowns.length}`);
  console.log(`Available refs:\n${availableRefs}\n`);

  // Pick test shots: first shot of each scene + a shot 2+ for continuity testing
  const testShots: Array<{ scene: number; shot: ShotBreakdown['shots'][0]; isFirst: boolean }> = [];
  for (const bd of breakdowns.slice(0, 3)) {
    if (bd.shots?.[0]) testShots.push({ scene: bd.sceneNumber, shot: bd.shots[0], isFirst: true });
    if (bd.shots?.[1]) testShots.push({ scene: bd.sceneNumber, shot: bd.shots[1], isFirst: false });
  }

  console.log(`Test shots: ${testShots.length}`);

  let guide = readFileSync(GUIDE_PATH, 'utf-8');

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`ITERATION ${iter}/${MAX_ITERATIONS}`);
    console.log(`${'='.repeat(50)}`);

    const evalResults: Array<{ label: string; score: number; total: number; failures: string[] }> = [];
    let totalScore = 0, totalQ = 0;

    for (const ts of testShots) {
      const label = `S${ts.scene}S${ts.shot.shotNumber}`;
      const shotContext = ts.isFirst
        ? '<shot_context>\nShot 1 of this scene. This is the first shot in the scene.\nlast_frame/mid_frame should always use edit_first_frame.\naspectRatio: "16:9"\n</shot_context>'
        : `<shot_context>\nShot ${ts.shot.shotNumber} of this scene. Previous shot is available.\nHint: Consider edit_previous_shot for first_frame if camera angle is similar.\nlast_frame/mid_frame should always use edit_first_frame.\naspectRatio: "16:9"\n</shot_context>`;

      console.log(`  Generating ${label}...`);
      const output = await generateShotComposition(guide, ts.shot, ts.scene, availableRefs, shotContext);
      writeFileSync(join(OUTPUT_DIR, `iter-${iter}-${label}.json`), output);

      console.log(`  Evaluating ${label}...`);
      try {
        const result = evaluateShotComposition(output, ts.shot, ts.scene, availableRefs);
        evalResults.push({ label, ...result });
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
