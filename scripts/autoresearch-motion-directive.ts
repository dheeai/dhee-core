#!/usr/bin/env tsx
/**
 * Autoresearch: optimize motion_directive_guide.md
 *
 * Generates motion directives for individual shots, evaluates them against
 * a binary rubric focused on AI video generation quality (character anchoring,
 * concrete textures, sound-to-visual translation, entry/exit states, etc.),
 * then proposes guide improvements.
 *
 * Usage:
 *   pnpm tsx scripts/autoresearch-motion-directive.ts [iterations] [project-dir]
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { LLMClient } from '../src/core/llm/index.js';

const MAX_ITERATIONS = parseInt(process.argv[2] || '3', 10);
const PROJECT_DIR = process.argv[3] || 'lazarus_drive.dhee';
const GUIDE_PATH = 'prompts/skills/defaults/motion_directive_guide.md';
const RUBRIC_PATH = 'tests/autoresearch/rubrics/motion-directive-binary.json';
const OUTPUT_DIR = 'test-output/autoresearch-motion-directive';

if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });

const rubric = JSON.parse(readFileSync(RUBRIC_PATH, 'utf-8'));

// Load world style
const worldStylePath = join(PROJECT_DIR, 'plans/world_style.md');
const worldStyle = existsSync(worldStylePath) ? readFileSync(worldStylePath, 'utf-8') : '';

// Load character profiles
const characters: Record<string, string> = {};
const charDir = join(PROJECT_DIR, 'characters');
if (existsSync(charDir)) {
  for (const f of readdirSync(charDir)) {
    if (f.endsWith('.md')) {
      characters[f.replace('.md', '')] = readFileSync(join(charDir, f), 'utf-8');
    }
  }
}

// Load setting profiles
const settings: Record<string, string> = {};
const setDir = join(PROJECT_DIR, 'settings');
if (existsSync(setDir)) {
  for (const f of readdirSync(setDir)) {
    if (f.endsWith('.md')) {
      settings[f.replace('.md', '')] = readFileSync(join(setDir, f), 'utf-8');
    }
  }
}

// Load scene_video_prompt JSONs
interface Shot {
  shotNumber: number;
  shotType: string;
  duration: number;
  firstFrame?: { description?: string; characters?: string[]; setting?: string };
  lastFrame?: { description?: string; characters?: string[] };
  description?: string;
  cameraWork?: string;
  soundCue?: string;
  characters?: string[];
  setting?: string;
  generationStrategy?: string;
}

interface SceneVideoPrompt {
  sceneNumber: number;
  sceneTitle: string;
  shots: Shot[];
}

const scenePrompts: SceneVideoPrompt[] = [];
const svpDir = join(PROJECT_DIR, 'prompts/videos/scenes');
if (existsSync(svpDir)) {
  for (const f of readdirSync(svpDir).sort()) {
    if (f.endsWith('.json')) {
      try {
        const data = JSON.parse(readFileSync(join(svpDir, f), 'utf-8'));
        scenePrompts.push(data);
      } catch { /* skip bad JSON */ }
    }
  }
}

// Select test shots: pick 2-3 shots per scene that have characters (most interesting for evaluation)
interface TestShot {
  sceneNum: number;
  shot: Shot;
  svp: SceneVideoPrompt;
}

const testShots: TestShot[] = [];
for (const svp of scenePrompts) {
  const shotsWithChars = svp.shots.filter(s =>
    (s.characters && s.characters.length > 0) ||
    (s.firstFrame?.characters && s.firstFrame.characters.length > 0)
  );
  // Take up to 2 character shots + 1 non-character shot per scene
  const selected = shotsWithChars.slice(0, 2);
  const noCharShot = svp.shots.find(s =>
    (!s.characters || s.characters.length === 0) &&
    (!s.firstFrame?.characters || s.firstFrame.characters.length === 0)
  );
  if (noCharShot) selected.push(noCharShot);
  for (const shot of selected) {
    testShots.push({ sceneNum: svp.sceneNumber, shot, svp });
  }
}

const llm = new LLMClient({
  baseUrl: process.env['LLM_BASE_URL'],
  apiKey: process.env['LLM_API_KEY'],
  model: process.env['LLM_MODEL'],
});

function claudeP(prompt: string, jsonSchema?: Record<string, unknown>): string {
  const tmpFile = `/tmp/ar-md-${Date.now()}.txt`;
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

async function generateMotionDirective(guide: string, testShot: TestShot): Promise<string> {
  const { shot, svp } = testShot;

  // Build context similar to what the executor provides
  const charContext = (shot.characters || shot.firstFrame?.characters || [])
    .map(id => characters[id] ? `### Character: ${id}\n${characters[id]}` : '')
    .filter(Boolean)
    .join('\n\n');

  const settingId = shot.setting || shot.firstFrame?.setting;
  const settingContext = settingId && settings[settingId]
    ? `### Setting: ${settingId}\n${settings[settingId]}`
    : '';

  const shotJson = JSON.stringify(shot, null, 2);

  const systemPrompt = `You are a video generation prompt writer. Write a motion directive for a single shot.

<guide>
${guide}
</guide>

<world_style>
${worldStyle}
</world_style>

${charContext ? `<characters>\n${charContext}\n</characters>` : ''}

${settingContext ? `<settings>\n${settingContext}\n</settings>` : ''}

<scene_video_prompt>
Scene: ${svp.sceneTitle} (Scene ${svp.sceneNumber})
</scene_video_prompt>`;

  const userPrompt = `Write a motion directive for this shot:

${shotJson}

**This shot's duration:** ${shot.duration} seconds
**Shot number:** ${shot.shotNumber} of ${svp.shots.length}

Output ONLY the motion directive — a single flowing paragraph.`;

  const response = await llm.generate({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.7,
  });
  return response.content || '';
}

function evaluate(directive: string, testShot: TestShot): { score: number; total: number; failures: string[] } {
  const { shot, svp } = testShot;
  const charIds = shot.characters || shot.firstFrame?.characters || [];
  const charProfiles = charIds.map(id => characters[id] || `(no profile for ${id})`).join('\n\n');
  const settingId = shot.setting || shot.firstFrame?.setting;
  const settingProfile = settingId ? (settings[settingId] || '') : '';

  const questions = rubric.questions
    .map((q: { id: string; question: string }, i: number) => `${i + 1}. [${q.id}] ${q.question}`)
    .join('\n');

  const prompt = `Be strict. Evaluate this motion directive (the text prompt sent to an AI video generator).

## Shot Context
Scene: ${svp.sceneTitle} (Scene ${svp.sceneNumber})
Shot: ${shot.shotNumber} (${shot.shotType}, ${shot.duration}s)
${shot.soundCue ? `Sound cue: ${shot.soundCue}` : ''}
${shot.firstFrame?.description ? `First frame: ${shot.firstFrame.description}` : ''}
${shot.lastFrame?.description ? `Last frame: ${shot.lastFrame.description}` : ''}
${shot.description ? `Description: ${shot.description}` : ''}
Characters in shot: ${charIds.length > 0 ? charIds.join(', ') : 'none'}

## Character Profiles
${charProfiles || 'No characters in this shot.'}

## Setting Profile
${settingProfile || 'No specific setting.'}

## Motion Directive Being Evaluated
${directive}

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

function proposeImprovement(guide: string, evalResults: Array<{ label: string; score: number; total: number; failures: string[]; directive: string }>): string {
  const summary = evalResults.map(r =>
    `${r.label}: ${r.score}/${r.total} — Failed: ${r.failures.join(', ') || 'none'}`
  ).join('\n');
  const allFailures = [...new Set(evalResults.flatMap(r => r.failures))];

  // Include example failed directives for context
  const failedExamples = evalResults
    .filter(r => r.failures.length > 0)
    .slice(0, 3)
    .map(r => `### ${r.label} (failed: ${r.failures.join(', ')})\n${r.directive}`)
    .join('\n\n');

  const prompt = `You are optimizing a prompt guide for AI video generation motion directives.

These directives are the TEXT PROMPTS sent directly to an AI video model (LTX-2). The model cannot read scripts, character names, or narrative context — it only understands literal visual descriptions. The guide must teach the LLM to translate scene descriptions into machine-readable visual prompts.

## Current Guide
${guide}

## Evaluation Results
${summary}

## Common Failures
${allFailures.map(f => `- ${f}`).join('\n')}

## Example Failed Directives
${failedExamples}

## Failure Descriptions
${allFailures.map(f => {
    const q = rubric.questions.find((rq: { id: string }) => rq.id === f);
    return q ? `- **${f}**: ${q.question}` : `- ${f}`;
  }).join('\n')}

Rewrite the guide to fix failures while keeping what works. Be specific — add rules, examples, and constraints that directly address each failure pattern.

Key principles:
- The guide teaches an LLM to write prompts for a VIDEO GENERATION AI, not for human directors
- Character names must be replaced with physical descriptions
- Abstract concepts must be grounded in concrete textures and materials
- Sound effects must be translated into visible physical phenomena
- Every prompt must include camera behavior, lighting, and material descriptions

Output ONLY the improved guide. Start with **PURPOSE**:
Do NOT include any preamble, explanation of changes, commentary, or "Here's the improved guide" text. The very first line of your response must be "**PURPOSE**:".`;

  let result = claudeP(prompt);
  const purposeIdx = result.indexOf('**PURPOSE**');
  if (purposeIdx > 0) {
    result = result.substring(purposeIdx);
  }
  return result;
}

async function main() {
  console.log(`Autoresearch: Motion Directive Guide`);
  console.log(`Project: ${PROJECT_DIR}`);
  console.log(`Test shots: ${testShots.length} (from ${scenePrompts.length} scenes)`);
  console.log(`Characters: ${Object.keys(characters).join(', ')}`);
  console.log(`Settings: ${Object.keys(settings).join(', ')}\n`);

  let guide = readFileSync(GUIDE_PATH, 'utf-8');

  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`ITERATION ${iter}/${MAX_ITERATIONS}`);
    console.log(`${'='.repeat(50)}`);

    const evalResults: Array<{ label: string; score: number; total: number; failures: string[]; directive: string }> = [];
    let totalScore = 0, totalQ = 0;

    // Evaluate a subset of test shots (up to 6 per iteration to keep costs down)
    const shotsToTest = testShots.slice(0, 6);

    for (const testShot of shotsToTest) {
      const label = `Scene ${testShot.sceneNum} Shot ${testShot.shot.shotNumber} (${testShot.shot.shotType})`;
      console.log(`  Generating: ${label}...`);
      const directive = await generateMotionDirective(guide, testShot);
      writeFileSync(
        join(OUTPUT_DIR, `iter-${iter}-s${testShot.sceneNum}-shot${testShot.shot.shotNumber}.txt`),
        directive
      );

      console.log(`  Evaluating: ${label}...`);
      try {
        const result = evaluate(directive, testShot);
        evalResults.push({ label, ...result, directive });
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
    writeFileSync(join(OUTPUT_DIR, `iter-${iter}-results.json`), JSON.stringify({ totalScore, totalQ, pct, evalResults: evalResults.map(r => ({ label: r.label, score: r.score, total: r.total, failures: r.failures })) }, null, 2));

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
