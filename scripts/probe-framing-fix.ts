#!/usr/bin/env tsx
/**
 * Smoke-test the framing-visibility patch in shot_first_frame_guide.md.
 *
 * Re-runs the shot_image_prompt LLM call for ONE shot using the patched
 * guide. Compares old vs new prompt prose to verify out-of-frame body
 * parts are no longer described.
 *
 * Usage:
 *   pnpm tsx scripts/probe-framing-fix.ts <project> <scene> <shot>
 *
 * Example:
 *   pnpm tsx scripts/probe-framing-fix.ts Ruby 2 15
 *   (scene 2 shot 15 was a close-up that described "feet planted on counter"
 *    in the prior Bharata run — clear framing leak)
 */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { LLMClient } from '../src/core/llm/index.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-framing-fix.ts <project> <scene> <shot>');
  process.exit(1);
}

const scene = parseInt(sceneArg, 10);
const shot = parseInt(shotArg, 10);
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.kshana') ? projectArg : `${projectArg}.kshana`,
);
if (!existsSync(projectRoot)) {
  console.error(`Project not found: ${projectRoot}`);
  process.exit(1);
}

const outDir = resolve(process.cwd(), 'test-output/framing-fix');
mkdirSync(outDir, { recursive: true });

// Load the patched guide + reuse the existing scene/shot context.
const firstFrameGuide = readFileSync(
  'prompts/skills/defaults/shot_first_frame_guide.md',
  'utf-8',
);
const sceneVpPath = join(projectRoot, `prompts/videos/scenes/scene_${scene}.json`);
if (!existsSync(sceneVpPath)) {
  console.error(`Scene video prompt not found: ${sceneVpPath}`);
  process.exit(1);
}
const sceneVp = JSON.parse(readFileSync(sceneVpPath, 'utf-8'));
const shotData = (sceneVp.shots ?? []).find((s: { shotNumber?: number }) => s.shotNumber === shot);
if (!shotData) {
  console.error(`Shot ${shot} not in scene ${scene}`);
  process.exit(1);
}

// Pull the prior buggy prompt for comparison.
const oldPromptPath = join(projectRoot, `prompts/images/shots/scene-${scene}-shot-${shot}.json`);
const oldPrompt = existsSync(oldPromptPath)
  ? JSON.parse(readFileSync(oldPromptPath, 'utf-8'))
  : null;
const oldFirstPrompt = oldPrompt?.frames?.first_frame?.imagePrompt ?? oldPrompt?.imagePrompt ?? '';

// Build the user message — mirror what the executor sends. We use a
// simple "describe this shot's first frame" message; the guide carries
// all the constraints including framing-visibility.
const cameraWork = shotData.cameraWork ?? '';
const description = shotData.description ?? '';
const focus = shotData.focus ?? {};
const rasa = sceneVp.rasa ?? null;

const bharataCues = rasa
  ? `\n\n<bharata_cues>\nscene rasa: ${rasa}\n${shotData.sattvika ? `sattvika: ${shotData.sattvika}\n` : ''}${shotData.drishti ? `drishti: ${shotData.drishti}\n` : ''}${shotData.vyabhichariBhava ? `vyabhichariBhava: ${shotData.vyabhichariBhava}\n` : ''}</bharata_cues>`
  : '';

const userMsg = `<shot_description>
${description}
</shot_description>

<camera_work>
${cameraWork}
</camera_work>

<focus>
primary: ${focus.primary ?? 'n/a'}
background: ${(focus.background ?? []).join(', ') || 'n/a'}
</focus>${bharataCues}

Write the first-frame imagePrompt paragraph following the guide rules. Output ONLY the paragraph — no JSON, no labels.`;

const llm = new LLMClient({
  baseUrl: process.env['LLM_TIER_HEAVY_BASE_URL'] || 'https://openrouter.ai/api/v1',
  apiKey: process.env['LLM_TIER_HEAVY_API_KEY'],
  model: process.env['LLM_TIER_HEAVY_MODEL'] || 'deepseek/deepseek-v4-flash',
});

console.log(`project=${projectArg}, scene=${scene}, shot=${shot}`);
console.log(`cameraWork: ${cameraWork.slice(0, 100)}${cameraWork.length > 100 ? '...' : ''}`);
console.log(`rasa: ${rasa}, sattvika: ${shotData.sattvika ?? '-'}, drishti: ${shotData.drishti ?? '-'}`);

const t0 = Date.now();
const res = await llm.generate({
  messages: [
    { role: 'system', content: firstFrameGuide },
    { role: 'user', content: userMsg },
  ],
  temperature: 0.7,
  maxTokens: 2000,
});
const ms = Date.now() - t0;
const newPrompt = (res.content || '').trim();

writeFileSync(join(outDir, `s${scene}shot${shot}_old.txt`), oldFirstPrompt);
writeFileSync(join(outDir, `s${scene}shot${shot}_new.txt`), newPrompt);
writeFileSync(
  join(outDir, `s${scene}shot${shot}_compare.md`),
  `# s${scene}shot${shot} — framing-fix comparison

cameraWork: \`${cameraWork}\`
rasa: ${rasa}

## OLD (pre-framing-fix)
${oldFirstPrompt}

## NEW (with framing-visibility rule)
${newPrompt}
`,
);

console.log(`\ndone in ${(ms / 1000).toFixed(1)}s`);
console.log(`  old: ${oldFirstPrompt.length} chars`);
console.log(`  new: ${newPrompt.length} chars`);
console.log(`\nsee: ${outDir}/s${scene}shot${shot}_compare.md`);

// Quick auto-audit: scan for telltale leak terms in close-up shots.
const cwLower = cameraWork.toLowerCase();
const isCloseUp = cwLower.includes('close-up') && !cwLower.includes('medium close');
const isOTS = cwLower.includes('ots') || cwLower.includes('over-the-shoulder') || cwLower.includes('over the shoulder');
const leakTerms = ['boot', 'leg', 'feet', 'knee', 'foot planted', 'foot landed'];
const oldLeaks = leakTerms.filter(t => oldFirstPrompt.toLowerCase().includes(t));
const newLeaks = leakTerms.filter(t => newPrompt.toLowerCase().includes(t));

if (isCloseUp) {
  console.log(`\n[audit] close-up shot:`);
  console.log(`  old leak terms: ${oldLeaks.length > 0 ? oldLeaks.join(', ') : '(none)'}`);
  console.log(`  new leak terms: ${newLeaks.length > 0 ? newLeaks.join(', ') : '(none)'}`);
}
if (isOTS) {
  console.log(`\n[audit] OTS shot — check that the foreground character's face is NOT described in the new prompt.`);
}
