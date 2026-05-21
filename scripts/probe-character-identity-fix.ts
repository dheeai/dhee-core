#!/usr/bin/env tsx
/**
 * Smoke-test the character-identity preservation patch in
 * scene_breakdown_shot_guide.md. Re-runs Stage B's shot_breakdown LLM
 * for a single shot with the patched guide and verifies pronouns match
 * the character profile.
 *
 * Usage:
 *   pnpm tsx scripts/probe-character-identity-fix.ts <project> <scene> <shot>
 *
 * Example:
 *   pnpm tsx scripts/probe-character-identity-fix.ts Ruby 2 1
 *   (scene 2 shot 1 was the canonical bug: Angel rendered as "she storms in"
 *    despite the character profile being unambiguously male)
 */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { LLMClient } from '../src/core/llm/index.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-character-identity-fix.ts <project> <scene> <shot>');
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

const outDir = resolve(process.cwd(), 'test-output/character-identity-fix');
mkdirSync(outDir, { recursive: true });

const shotGuide = readFileSync(
  'prompts/skills/defaults/scene_breakdown_shot_guide.md',
  'utf-8',
);
const scenePlanPath = join(projectRoot, `prompts/videos/scenes/scene_${scene}.plan.json`);
const sceneVpPath = join(projectRoot, `prompts/videos/scenes/scene_${scene}.json`);
const sceneScript = readFileSync(
  join(projectRoot, `chapters/chapter_1/scenes/scene_${scene}.md`),
  'utf-8',
);
const plan = JSON.parse(readFileSync(scenePlanPath, 'utf-8'));
const oldSvp = existsSync(sceneVpPath) ? JSON.parse(readFileSync(sceneVpPath, 'utf-8')) : null;
const oldShot = (oldSvp?.shots ?? []).find((s: { shotNumber?: number }) => s.shotNumber === shot);
const thisEntry = (plan.shotPlan ?? []).find((p: { shotNumber?: number }) => p.shotNumber === shot);
if (!thisEntry) {
  console.error(`Shot ${shot} not in plan for scene ${scene}`);
  process.exit(1);
}

// Load all character profiles for context (so the LLM has the gender info).
const charactersDir = join(projectRoot, 'characters');
const characterProfiles: Record<string, string> = {};
if (existsSync(charactersDir)) {
  for (const f of readFileSync(charactersDir).toString().split('\n')) {
    /* not iterable */
  }
}
const fs = await import('fs');
for (const f of fs.readdirSync(charactersDir).filter(f => f.endsWith('.md'))) {
  characterProfiles[f.replace('.md', '')] = fs.readFileSync(join(charactersDir, f), 'utf-8');
}

const availableRefs = Object.keys(characterProfiles).join(', ');
const profilesBlock = Object.entries(characterProfiles)
  .map(([id, profile]) => `### ${id}\n${profile.slice(0, 800)}${profile.length > 800 ? '\n...' : ''}`)
  .join('\n\n');

const userMsg = `<scene_script>
${sceneScript}
</scene_script>

<available_refs>
${availableRefs}
</available_refs>

<character_profiles>
${profilesBlock}
</character_profiles>

<scene_plan>
${JSON.stringify(plan, null, 2)}
</scene_plan>

<this_shot>
${JSON.stringify(thisEntry, null, 2)}
</this_shot>

Expand THIS shot only. Copy shotNumber, purpose, and duration verbatim from <this_shot>. Output ONLY the expanded shot JSON.`;

const llm = new LLMClient({
  baseUrl: process.env['LLM_TIER_HEAVY_BASE_URL'] || 'https://openrouter.ai/api/v1',
  apiKey: process.env['LLM_TIER_HEAVY_API_KEY'],
  model: process.env['LLM_TIER_HEAVY_MODEL'] || 'deepseek/deepseek-v4-flash',
});

console.log(`project=${projectArg}, scene=${scene}, shot=${shot}`);
console.log(`old description: ${oldShot?.description?.slice(0, 150) ?? '(none)'}...`);

const sys = `You are a cinematic shot planner. Output ONLY valid JSON.\n\n<guide>\n${shotGuide}\n</guide>`;
const t0 = Date.now();
const res = await llm.generate({
  messages: [
    { role: 'system', content: sys },
    { role: 'user', content: userMsg },
  ],
  temperature: 0.7,
  maxTokens: 4000,
  responseFormat: { type: 'json_object' },
});
const ms = Date.now() - t0;
const newJson = (res.content || '').trim();
let newShot: any;
try {
  newShot = JSON.parse(newJson);
} catch (err) {
  console.error('Failed to parse new shot JSON:', err);
  console.error('Raw:', newJson);
  process.exit(1);
}

writeFileSync(join(outDir, `s${scene}shot${shot}_old.json`), JSON.stringify(oldShot, null, 2));
writeFileSync(join(outDir, `s${scene}shot${shot}_new.json`), JSON.stringify(newShot, null, 2));

const compare = `# s${scene}shot${shot} — character-identity-fix comparison

## OLD (pre-fix) description
${oldShot?.description ?? '(no old description)'}

## OLD (pre-fix) cameraWork
${oldShot?.cameraWork ?? '(no old cameraWork)'}

## NEW description
${newShot.description}

## NEW cameraWork
${newShot.cameraWork}

## NEW audio
${newShot.audio}
`;
writeFileSync(join(outDir, `s${scene}shot${shot}_compare.md`), compare);

console.log(`\ndone in ${(ms / 1000).toFixed(1)}s`);
console.log(`see: ${outDir}/s${scene}shot${shot}_compare.md`);

// Auto-audit: check Angel's gender in the new output.
const fullText = [newShot.description, newShot.cameraWork, newShot.audio].filter(Boolean).join(' ');
const angelFemaleMatches = (fullText.match(/Angel[^.]*?\b(she|her|hers|herself)\b/gi) ?? []);
const angelMaleMatches = (fullText.match(/Angel[^.]*?\b(he|him|his|himself)\b/gi) ?? []);
const bothWomen = /\bboth women\b/i.test(fullText);

console.log(`\n[audit] Angel in new prose:`);
console.log(`  female pronouns: ${angelFemaleMatches.length}`);
console.log(`  male pronouns:   ${angelMaleMatches.length}`);
console.log(`  'both women':    ${bothWomen ? 'YES (BUG)' : 'no'}`);

if (angelFemaleMatches.length > 0 || bothWomen) {
  console.log(`\nFAIL — Angel still misgendered. Matches: ${angelFemaleMatches.join(' | ')}`);
  process.exit(2);
} else {
  console.log(`\nPASS — Angel correctly male in new output.`);
}
