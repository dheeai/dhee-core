#!/usr/bin/env tsx
/**
 * Autoresearch: optimize setting_image_guide.md
 *
 * 1. Generate setting image prompts from setting profiles + world style
 * 2. Evaluate with binary rubric (14 questions) via claude -p
 * 3. Propose guide improvements via claude -p
 * 4. Save new guide, repeat
 *
 * Usage:
 *   pnpm tsx scripts/autoresearch-setting-image.ts [iterations]
 *
 * Default: 3 iterations
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { LLMClient } from '../src/core/llm/index.js';

const MAX_ITERATIONS = parseInt(process.argv[2] || '3', 10);
const GUIDE_PATH = 'prompts/skills/defaults/setting_image_guide.md';
const RUBRIC_PATH = 'tests/autoresearch/rubrics/setting-image-binary.json';
const OUTPUT_DIR = 'test-output/autoresearch-setting-image';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf-8'));

// Test cases: projects with setting profiles + world style bibles
interface TestCase {
  projectName: string;
  settingFile: string;  // relative to project dir
  worldStyleFile?: string;
}

function findTestCases(): Array<TestCase & { settingContent: string; worldStyle: string }> {
  const projects = [
    'noir_detective_story_setup-2',
    'air_already_thick_promise',
    'lazarus_drive',
    'sun_hadnt_yet_cleared',
    'centuries_ago_continent_elarion',
    'earth_dead_five_ships-2',
  ];

  const cases: Array<TestCase & { settingContent: string; worldStyle: string }> = [];

  for (const proj of projects) {
    const projDir = `${proj}.dhee`;
    if (!existsSync(projDir)) continue;

    // Find setting content
    const charFile = join(projDir, 'settings', '.md');
    if (!existsSync(charFile)) continue;
    const charContent = readFileSync(charFile, 'utf-8');
    if (charContent.length < 100) continue;

    // Find world style
    const wsFile = join(projDir, 'plans', 'world_style.md');
    const worldStyle = existsSync(wsFile) ? readFileSync(wsFile, 'utf-8') : '';

    cases.push({
      projectName: proj,
      settingFile: charFile,
      worldStyleFile: wsFile,
      settingContent: charContent,
      worldStyle,
    });
  }

  return cases;
}

const testCases = findTestCases();
console.log(`Found ${testCases.length} test cases: ${testCases.map(t => t.projectName).join(', ')}`);

if (testCases.length === 0) {
  console.error('No test cases found — need projects with settings/.md files');
  process.exit(1);
}

const llm = new LLMClient({
  baseUrl: process.env['LLM_BASE_URL'],
  apiKey: process.env['LLM_API_KEY'],
  model: process.env['LLM_MODEL'],
});

function claudeP(prompt: string, jsonSchema?: Record<string, unknown>): string {
  const tmpFile = `/tmp/ar-si-${Date.now()}.txt`;
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

async function generateSettingImagePrompt(
  guide: string,
  settingContent: string,
  worldStyle: string,
): Promise<string> {
  const systemPrompt = `You are writing an image generation prompt for a setting reference image.

<guide>
${guide}
</guide>`;

  const userContent = worldStyle
    ? `Write an image prompt for this setting/location using the world style below.\n\n## Setting Profile\n${settingContent}\n\n## World Style Bible\n${worldStyle}`
    : `Write an image prompt for this setting/location.\n\n## Setting Profile\n${settingContent}`;

  const response = await llm.generate({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    temperature: 0.7,
  });
  return response.content || '';
}

function evaluate(
  imagePrompt: string,
  settingContent: string,
  worldStyle: string,
  projectName: string,
): { score: number; total: number; failures: string[] } {
  const questions = rubric.questions
    .map((q: { id: string; question: string }, i: number) => `${i + 1}. [${q.id}] ${q.question}`)
    .join('\n');

  const prompt = `Be strict. Evaluate this setting image prompt.

## Setting Profile (source material)
${settingContent.substring(0, 3000)}

${worldStyle ? `## World Style Bible\n${worldStyle.substring(0, 2000)}` : '(No world style provided)'}

## Image Prompt Being Evaluated
${imagePrompt}

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
  evalResults: Array<{ project: string; score: number; total: number; failures: string[] }>,
): string {
  const summary = evalResults.map(r =>
    `${r.project}: ${r.score}/${r.total} — Failed: ${r.failures.join(', ') || 'none'}`
  ).join('\n');
  const allFailures = [...new Set(evalResults.flatMap(r => r.failures))];
  const failureDescs = allFailures.map(f => {
    const q = rubric.questions.find((rq: { id: string }) => rq.id === f);
    return q ? `- **${f}**: ${q.question}` : `- ${f}`;
  }).join('\n');

  const prompt = `You are optimizing a setting image prompt guide for AI video production.

The guide teaches an LLM to write image prompts for setting reference images. These images are used as visual references when generating shot images for video production. The prompts go to a text-to-image model (Stable Diffusion / FLUX).

Key constraint: the image model has NO context about the story, period, or style. EVERYTHING must be in the prompt text — period-specific clothing terms, materials, footwear styles, skin details. Generic terms like "sandals" produce modern items.

## Current Guide
${guide}

## Evaluation Results
${summary}

## Common Failures
${allFailures.map(f => `- ${f}`).join('\n')}

## Failure Descriptions
${failureDescs}

Rewrite the guide to fix failures while keeping what works. Focus on:
1. Period accuracy — use period-specific terms the image model understands (not modern equivalents)
2. World style integration — color palette, material choices, "Avoid" list flowing into prompts
3. Visual identity — unique distinguishing features, not generic descriptions
4. Format compliance — JSON output, studio background, simple lighting

Output ONLY the improved guide. Start with **PURPOSE**:
Do NOT include any preamble, explanation, or commentary.`;

  let result = claudeP(prompt);
  const purposeIdx = result.indexOf('**PURPOSE**');
  if (purposeIdx > 0) {
    result = result.substring(purposeIdx);
  }
  return result;
}

async function main() {
  let guide = readFileSync(GUIDE_PATH, 'utf-8');
  console.log(`\n=== Starting autoresearch for setting image guide ===`);
  console.log(`Iterations: ${MAX_ITERATIONS}, Test cases: ${testCases.length}`);

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n--- Iteration ${iter}/${MAX_ITERATIONS} ---`);
    const evalResults: Array<{ project: string; score: number; total: number; failures: string[] }> = [];

    for (const tc of testCases) {
      console.log(`  Generating for ${tc.projectName}...`);
      const imagePrompt = await generateSettingImagePrompt(guide, tc.settingContent, tc.worldStyle);
      writeFileSync(join(OUTPUT_DIR, `iter-${iter}-${tc.projectName}.txt`), imagePrompt);

      console.log(`  Evaluating ${tc.projectName}...`);
      const result = evaluate(imagePrompt, tc.settingContent, tc.worldStyle, tc.projectName);
      evalResults.push({ project: tc.projectName, ...result });
      console.log(`  ${tc.projectName}: ${result.score}/${result.total} (failed: ${result.failures.join(', ') || 'none'})`);
    }

    const avgScore = evalResults.reduce((s, r) => s + r.score, 0) / evalResults.length;
    const avgTotal = evalResults.reduce((s, r) => s + r.total, 0) / evalResults.length;
    console.log(`\n  Average: ${avgScore.toFixed(1)}/${avgTotal.toFixed(0)} (${((avgScore / avgTotal) * 100).toFixed(1)}%)`);

    writeFileSync(join(OUTPUT_DIR, `iter-${iter}-results.json`), JSON.stringify(evalResults, null, 2));

    // If perfect score, stop early
    if (evalResults.every(r => r.failures.length === 0)) {
      console.log(`\n  Perfect score! Stopping early.`);
      break;
    }

    // Propose improvement
    if (iter < MAX_ITERATIONS) {
      console.log(`  Proposing improvement...`);
      const improved = proposeImprovement(guide, evalResults);
      guide = improved;
      writeFileSync(join(OUTPUT_DIR, `iter-${iter}-guide.md`), improved);
      writeFileSync(GUIDE_PATH, improved);
      console.log(`  Guide updated (${improved.length} chars)`);
    }
  }

  console.log(`\n=== Autoresearch complete ===`);
  console.log(`Results saved to ${OUTPUT_DIR}/`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
