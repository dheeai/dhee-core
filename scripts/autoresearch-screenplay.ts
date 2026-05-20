#!/usr/bin/env tsx
/**
 * Autoresearch: optimize screenplay_guide.md
 *
 * 1. Generate screenplays from plot treatments using current guide
 * 2. Evaluate with binary rubric (22 questions) via claude -p
 * 3. Propose guide improvements via claude -p
 * 4. Save new guide, repeat
 *
 * Usage:
 *   pnpm tsx scripts/autoresearch-screenplay.ts [iterations] [duration]
 *
 * Default: 3 iterations, 60s duration
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { LLMClient } from '../src/core/llm/index.js';

const MAX_ITERATIONS = parseInt(process.argv[2] || '3', 10);
const GUIDE_PATH = 'prompts/skills/defaults/screenplay_guide.md';
const RUBRIC_PATH = 'tests/autoresearch/rubrics/screenplay-binary.json';
const OUTPUT_DIR = 'test-output/autoresearch-screenplay';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf-8'));

// Test plots with varied durations to validate the guide scales
const TEST_CASES: Array<{ project: string; duration: number }> = [
  { project: 'noir_detective_story_setup', duration: 30 },   // Very short
  { project: 'air_already_thick_promise', duration: 60 },    // Standard short
  { project: 'lazarus_drive', duration: 120 },                // Medium
  { project: 'sun_hadnt_yet_cleared', duration: 180 },        // Longer
  { project: 'centuries_ago_continent_elarion', duration: 300 }, // Long
  { project: 'earth_dead_five_ships-2', duration: 60 },       // Another 60s for variance
];

interface PlotData {
  projectName: string;
  plot: string;
  duration: number;
}

const plots: PlotData[] = [];
for (const tc of TEST_CASES) {
  const plotPath = join(`${tc.project}.dhee`, 'chapters', 'chapter_1', 'plans', 'plot.md');
  if (existsSync(plotPath)) {
    plots.push({
      projectName: tc.project,
      plot: readFileSync(plotPath, 'utf-8'),
      duration: tc.duration,
    });
  }
}

const llm = new LLMClient({
  baseUrl: process.env['LLM_BASE_URL'],
  apiKey: process.env['LLM_API_KEY'],
  model: process.env['LLM_MODEL'],
});

function claudeP(prompt: string, jsonSchema?: Record<string, unknown>): string {
  const tmpFile = `/tmp/ar-sp-${Date.now()}.txt`;
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

async function generateScreenplay(guide: string, plotData: PlotData): Promise<string> {
  const dur = plotData.duration;
  const systemPrompt = `You are a screenwriter. Write a screenplay based on the provided plot treatment.

<guide>
${guide}
</guide>

**Target video duration:** ${dur} seconds (${Math.floor(dur / 60)}m ${dur % 60}s)
**Visual style:** cinematic_realism

Follow the guide's format and constraints precisely. The screenplay MUST fit within ${dur} seconds of screen time.`;

  const response = await llm.generate({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Write a screenplay based on this plot treatment:\n\n${plotData.plot}` },
    ],
    temperature: 0.7,
  });
  return response.content || '';
}

function evaluateScreenplay(screenplay: string, plotData: PlotData, duration: number): { score: number; total: number; failures: string[] } {
  const questions = rubric.questions
    .map((q: { id: string; question: string }, i: number) => `${i + 1}. [${q.id}] ${q.question}`)
    .join('\n');

  const prompt = `Be strict. Evaluate this screenplay for a ${duration}-second AI-generated video.

## Plot Treatment (source material)
${plotData.plot}

## Screenplay Being Evaluated
${screenplay}

## Target Duration
${duration} seconds

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

function proposeImprovement(guide: string, evalResults: Array<{ project: string; duration: number; score: number; total: number; failures: string[] }>): string {
  const summary = evalResults.map(r =>
    `${r.project} (${r.duration}s): ${r.score}/${r.total} — Failed: ${r.failures.join(', ') || 'none'}`
  ).join('\n');
  const allFailures = [...new Set(evalResults.flatMap(r => r.failures))];

  // Get failure descriptions
  const failureDescs = allFailures.map(f => {
    const q = rubric.questions.find((rq: { id: string }) => rq.id === f);
    return q ? `- **${f}**: ${q.question}` : `- ${f}`;
  }).join('\n');

  const prompt = `You are optimizing a screenplay guide for AI video production.

The guide teaches an LLM to write screenplays that will be automatically broken into scenes, characters extracted, reference images generated, and videos produced. Every character and location in the screenplay costs generation time and compute.

## Current Guide
${guide}

## Evaluation Results (varied durations: 30s, 60s, 120s, 180s, 300s)
${summary}

## Common Failures
${allFailures.map(f => `- ${f}`).join('\n')}

## Failure Descriptions
${failureDescs}

Rewrite the guide to fix failures while keeping what works. Focus on:
1. Story quality (coherence, emotion, hook, ending) — these matter most for viewer engagement
2. Duration discipline (character/location/scene counts) — these control production cost
3. Format compliance (screenplay format, cast/locations lists) — these enable automation

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
  console.log(`Autoresearch: Screenplay Guide`);
  console.log(`Durations: ${plots.map(p => p.duration + 's').join(', ')} | Plots: ${plots.length} | Iterations: ${MAX_ITERATIONS}`);
  console.log(`Projects: ${plots.map(p => p.projectName).join(', ')}\n`);

  if (plots.length === 0) {
    console.error('No plot files found!');
    process.exit(1);
  }

  let guide = readFileSync(GUIDE_PATH, 'utf-8');

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`ITERATION ${iter}/${MAX_ITERATIONS}`);
    console.log(`${'='.repeat(50)}`);

    const evalResults: Array<{ project: string; duration: number; score: number; total: number; failures: string[] }> = [];
    let totalScore = 0, totalQ = 0;

    // Test against 4 plots per iteration — varied durations (30s, 60s, 120s, 180s)
    const testPlots = plots.slice(0, 4);

    for (const plotData of testPlots) {
      console.log(`  Generating screenplay: ${plotData.projectName} (${plotData.duration}s)...`);
      const screenplay = await generateScreenplay(guide, plotData);
      writeFileSync(join(OUTPUT_DIR, `iter-${iter}-${plotData.projectName}.txt`), screenplay);

      // Count words and characters for logging
      const words = screenplay.split(/\s+/).length;
      const charMatches = screenplay.match(/^[A-Z]{2,}[A-Z ]*(?:\s*\()/gm) || [];
      console.log(`    ${words} words, ~${charMatches.length} characters detected`);

      console.log(`  Evaluating: ${plotData.projectName}...`);
      try {
        const result = evaluateScreenplay(screenplay, plotData, plotData.duration);
        evalResults.push({ project: plotData.projectName, duration: plotData.duration, ...result });
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
    writeFileSync(join(OUTPUT_DIR, `iter-${iter}-results.json`), JSON.stringify({ totalScore, totalQ, pct, evalResults, durations: testPlots.map(p => p.duration) }, null, 2));

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
