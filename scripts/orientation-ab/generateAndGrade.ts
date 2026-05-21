/**
 * End-to-end candidate test: feed DeepSeek the production_candidate_guide
 * + Tier-1-corrected shotDescriptions, generate one prompt per shot,
 * grade each against the validated pattern checklist.
 *
 * No Klein render — we already proved Klein is faithful. The only question
 * left is whether DeepSeek can produce prompts that pass the checklist
 * when given the right inputs.
 *
 * Run: npx tsx scripts/orientation-ab/generateAndGrade.ts
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildRouterFromEnv } from '../../src/core/llm/router.js';
import { CORRECTED_SHOTS, CHECKS_BY_SHOT } from './correctedFixtures.js';
import { SHOTS as ORIGINAL_SHOTS } from './fixtures.js';

// Use ORIGINAL (biased) descriptions when --original-descriptions is set.
// This tests whether the guide's essence-vs-composition contract holds up
// even when the upstream brief has face cues for an approach beat.
const USE_ORIGINAL_DESCRIPTIONS = process.argv.includes('--original-descriptions');
const ACTIVE_SHOTS = USE_ORIGINAL_DESCRIPTIONS ? ORIGINAL_SHOTS : CORRECTED_SHOTS;
// --trials N runs each shot N times and reports pass rate. Default 1.
const TRIALS_ARG = process.argv.find(a => a.startsWith('--trials='));
const TRIALS = TRIALS_ARG ? parseInt(TRIALS_ARG.split('=')[1] ?? '1', 10) : 1;

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// Default: production guide (the one ExecutorAgent actually loads).
// Override with --guide candidate to point at production_candidate_guide.md for A/B.
const GUIDE_PATH = process.argv.includes('--guide=candidate')
  ? path.join(SCRIPT_DIR, 'production_candidate_guide.md')
  : path.join(SCRIPT_DIR, '..', '..', 'prompts', 'skills', 'defaults', 'shot_composition_guide.md');
const WORLD_STYLE_PATH = '/Users/ganaraj/dhee-studios/Ruby V3/plans/world_style.md';
const OUT_DIR = path.join(
  SCRIPT_DIR,
  'results',
  process.argv.includes('--guide=candidate') ? 'candidate_prompts' : 'live_guide_prompts',
);

function buildFirstFramePrompt(args: {
  guide: string;
  shotDescription: string;
  cameraWork: string;
  mode: string;
  references: { imageNumber: number; type: string; refId: string }[];
  worldStyle?: string;
}): { system: string; user: string } {
  const { guide, shotDescription, cameraWork, mode, references, worldStyle } = args;
  const system =
    `You write a single image prompt paragraph. Output ONLY the paragraph — no JSON, no labels.\n\n${guide}\n\n---\n\nThis call is for the FIRST FRAME in mode "${mode}". Follow the matching first-frame section above.`;

  const refList =
    references.length > 0
      ? `References available:\n${references.map(r => `- image ${r.imageNumber}: ${r.type} (ref_id: "${r.refId}")`).join('\n')}`
      : 'No references — describe everything from text only.';

  let user = `Shot description: ${shotDescription}\nCamera: ${cameraWork}\nMode: ${mode}\n\n${refList}`;
  if (worldStyle) user += `\n\n<world_style>\n${worldStyle}\n</world_style>`;
  user += `\n\nWrite the image prompt paragraph. Output ONLY the paragraph.`;
  return { system, user };
}

async function callLLM(llm: any, system: string, user: string): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of llm.generateStream({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
  })) {
    if (chunk.content) chunks.push(chunk.content);
  }
  return chunks.join('');
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const guide = readFileSync(GUIDE_PATH, 'utf-8');
  const worldStyle = existsSync(WORLD_STYLE_PATH) ? readFileSync(WORLD_STYLE_PATH, 'utf-8') : undefined;
  console.log(`[harness] candidate guide: ${guide.length} chars  worldStyle: ${worldStyle?.length ?? 0} chars\n`);

  const router = buildRouterFromEnv(process.cwd());
  const llm = router.getClient('content.shot_image_prompt');
  console.log(`[harness] model: ${router.resolveConfig('content.shot_image_prompt').model}\n`);

  const results: Array<{
    shotId: string;
    trials: Array<{ prose: string; passed: number; total: number; failures: string[] }>;
    passRate: number; // fraction of trials that passed all required checks
  }> = [];

  console.log(`[harness] using ${USE_ORIGINAL_DESCRIPTIONS ? 'ORIGINAL (biased)' : 'CORRECTED'} shotDescriptions, ${TRIALS} trial(s) per shot\n`);
  for (const shot of ACTIVE_SHOTS) {
    const { system, user } = buildFirstFramePrompt({
      guide,
      shotDescription: shot.shotDescription,
      cameraWork: shot.cameraWork,
      mode: shot.generationMode,
      references: shot.references,
      worldStyle,
    });
    const trialResults: Array<{ prose: string; passed: number; total: number; failures: string[] }> = [];
    for (let t = 1; t <= TRIALS; t++) {
      console.log(`[llm] ${shot.shotId} trial ${t}/${TRIALS} …`);
      const prose = await callLLM(llm, system, user);
      const checks = CHECKS_BY_SHOT[shot.shotId] ?? [];
      const required = checks.filter(c => c.required);
      const failures: string[] = [];
      let passed = 0;
      for (const c of required) {
        if (c.test(prose)) passed++;
        else failures.push(c.name);
      }
      trialResults.push({ prose, passed, total: required.length, failures });
      console.log(`  → ${passed}/${required.length} ${failures.length === 0 ? '✓' : '✗ ' + failures.join(', ')}`);
    }
    const fullyPassed = trialResults.filter(t => t.failures.length === 0).length;
    const passRate = fullyPassed / TRIALS;
    results.push({ shotId: shot.shotId, trials: trialResults, passRate });
    writeFileSync(
      path.join(OUT_DIR, `${shot.shotId}.json`),
      JSON.stringify({ shotId: shot.shotId, system: system.slice(0, 200) + '…', user, trials: trialResults, passRate }, null, 2),
    );
    console.log(`  pass rate: ${fullyPassed}/${TRIALS}\n`);
  }

  // Summary
  console.log('━'.repeat(60));
  console.log('SUMMARY');
  console.log('━'.repeat(60));
  let allTrialsPassed = 0;
  let allTrialsTotal = 0;
  for (const r of results) {
    const verdict = r.passRate === 1 ? '✅ ALL PASS' : r.passRate >= 0.5 ? '⚠️  SOMETIMES' : '❌ MOSTLY FAILS';
    const trialsPassed = r.trials.filter(t => t.failures.length === 0).length;
    console.log(`  ${r.shotId.padEnd(20)} ${trialsPassed}/${r.trials.length} trials  ${verdict}`);
    allTrialsPassed += trialsPassed;
    allTrialsTotal += r.trials.length;
  }
  console.log(`\n  Overall trial pass rate: ${allTrialsPassed}/${allTrialsTotal}`);
  console.log(`  Per-shot reliability: ${results.filter(r => r.passRate === 1).length}/${results.length} shots pass on every trial`);

  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify({ results, allTrialsPassed, allTrialsTotal }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
