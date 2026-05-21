#!/usr/bin/env tsx
/**
 * Test a SCALIST / Prompt-Engineering-Engine system prompt as a replacement
 * for shot_first_frame_guide.md, with the deterministic slot manifest from
 * probe-deterministic-manifest.ts handling reference binding.
 *
 * Goal: see if a single-coherent-paragraph "Creative Director's Brief"
 * style produces visibly better Flux Klein output than the current
 * structured-rules guide.
 *
 * Pipeline:
 *   1. Take an existing shot's structured context (description, cameraWork,
 *      characters, setting, rasa) and build a "raw user request" for the
 *      Prompt Engineering Engine.
 *   2. Call DeepSeek with the SCALIST system prompt, get JSON back with
 *      {prompt, reasoning, resolved_knowledge}.
 *   3. Prepend the deterministic slot manifest to the SCALIST prompt.
 *   4. Render via Flux Klein cloud, same seed as the inline baseline.
 *   5. Save alongside the existing render for visual comparison.
 *
 * Usage:
 *   pnpm tsx scripts/probe-scalist-prompt.ts <project> <scene> <shot>
 */
import 'dotenv/config';
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, resolve } from 'path';
import { ComfyUIClient } from '../src/services/comfyui/ComfyUIClient.js';
import { parameterizeGeneric } from '../src/services/comfyui/WorkflowLoader.js';
import { LLMClient } from '../src/core/llm/index.js';
import { RASA_MODIFIERS } from '../src/core/planner/rasaModifiers.js';

const [projectArg, sceneArg, shotArg] = process.argv.slice(2);
if (!projectArg || !sceneArg || !shotArg) {
  console.error('Usage: pnpm tsx scripts/probe-scalist-prompt.ts <project> <scene> <shot>');
  process.exit(1);
}

const scene = parseInt(sceneArg, 10);
const shot = parseInt(shotArg, 10);
const projectRoot = resolve(
  process.cwd(),
  projectArg.endsWith('.kshana') ? projectArg : `${projectArg}.kshana`,
);

// ── SCALIST / Prompt Engineering Engine system prompt ──
const SCALIST_SYSTEM_PROMPT = `You are a Prompt Engineering Engine — an AI image-generation Prompt Engineer who is also a creative director with encyclopedic knowledge and visual-direction skill. Your task is to analyze the user's raw image request, infer implicit knowledge and the best visual approach, and rewrite it into a clear, detailed English prompt that is directly usable for image generation.

## Core Goal

Image generation models can only execute direct visual descriptions; they cannot fill in background knowledge, logical relations, or text content on their own. Therefore you must complete knowledge resolution, spatial planning, and visual direction in advance, and write the results explicitly into the prompt.

Use the SCALIST framework to expand every scene:
- **Subject**: identity, appearance, color, material, texture, action, expression, clothing.
- **Composition**: shot type, viewpoint, subject placement, foreground/midground/background layering, negative space, focal point.
- **Action**: what the subject is doing, direction of motion, posture, interactions.
- **Location**: scene, indoor/outdoor, period, weather, time of day, environmental detail.
- **Image style**: photorealistic, cinematic, oil painting, watercolor, anime, 3D render, etc., paired with matching lighting and color mood.
- **Specs**: photographic/render parameters, e.g. 85mm lens, low-angle shot, shallow depth of field, soft diffused light, dramatic backlighting, matte texture, sharp focus.
- **Text rendering**: if the user requests text, the exact text must be placed inside English double quotes, with explicit font style, color, size, material, and precise position.

**Knowledge resolution and explicitization.** Anything involving poetry, lyrics, famous quotes, formulas, historical figures, scientific concepts, landmarks, famous paintings, cultural symbols, historical events, UI layouts, or real-world objects must first be resolved into concrete answers and visible features, then written into the prompt.

**Spatial and logical anchoring.** Rewrite vague relationships into explicit layout, e.g. "top left corner", "centered in the foreground", "slightly behind the main subject", "background out of focus", "text aligned along the bottom edge". Avoid vague phrases like "next to", "some", "nice-looking".

**Real-world grounding.** If the user requests factually accurate content, use your internal knowledge to fill in accurate visual detail.

**Concretizing abstract concepts.** Turn abstract words like "freedom, loneliness, futurism, healing" into visible scenes, symbols, and atmospheres.

## Output prompt requirements

- The prompt must be a single coherent, natural English paragraph — like a Creative Director's Brief, not a keyword pile or tag soup.
- Length is typically 80–220 words.
- Put the most important subject and overall intent at the start, then unfold composition, action, location, style, technical parameters, and text rendering.
- Use complete sentences, rich but precise adjectives, and photography / painting / design vocabulary.
- Do not include any expression that requires the image model to do further reasoning.
- The prompt must be self-contained.

## Execution steps

1. **Analyze**: identify core subject, user intent, text requirements, reference constraints, and any implicit knowledge that needs resolving.
2. **Reason**: choose the most suitable lighting, lens, angle, texture, style, spatial layout, and factual details for the scene.
3. **Rewrite**: output the final, enhanced English single-paragraph prompt.

Output JSON only, with no other text:

\`\`\`json
{
  "prompt": "the English single-paragraph prompt",
  "reasoning": "your reasoning and knowledge-resolution process (in English)",
  "resolved_knowledge": "what implicit knowledge you resolved (in English; if none, write 'none')"
}
\`\`\``;

// ── Load shot context ──
const sceneVpPath = join(projectRoot, `prompts/videos/scenes/scene_${scene}.json`);
const svp = JSON.parse(readFileSync(sceneVpPath, 'utf-8'));
const shotData = (svp.shots ?? []).find((s: { shotNumber?: number }) => s.shotNumber === shot);
if (!shotData) {
  console.error(`Shot ${shot} not in scene ${scene}`);
  process.exit(1);
}

const promptPath = join(projectRoot, `prompts/images/shots/scene-${scene}-shot-${shot}.json`);
const promptJson = JSON.parse(readFileSync(promptPath, 'utf-8'));
const inlinePrompt: string = promptJson.frames?.first_frame?.imagePrompt ?? '';
const negativePrompt: string = promptJson.negativePrompt ?? '';

// ── Resolve character / setting descriptions (so SCALIST can use them) ──
const charactersDir = join(projectRoot, 'characters');
const settingsDir = join(projectRoot, 'settings');
const characterProfiles: Record<string, string> = {};
for (const f of readdirSync(charactersDir).filter(f => f.endsWith('.md'))) {
  const id = f.replace('.md', '');
  const profile = readFileSync(join(charactersDir, f), 'utf-8');
  // Take first ~10 lines of each profile — enough for visual grounding.
  characterProfiles[id] = profile.split('\n').slice(0, 12).join('\n');
}
const settingProfiles: Record<string, string> = {};
for (const f of readdirSync(settingsDir).filter(f => f.endsWith('.md'))) {
  const id = f.replace('.md', '');
  settingProfiles[id] = readFileSync(join(settingsDir, f), 'utf-8').slice(0, 800);
}

// ── Translate Bharata rasa to plain visual language ──
const rasa = svp.rasa as keyof typeof RASA_MODIFIERS | undefined;
const rasaMod = rasa ? RASA_MODIFIERS[rasa] : null;
const moodLine = rasaMod
  ? `Emotional palette: ${rasaMod.paletteTokens}. Lighting: ${rasaMod.lightingKey}.`
  : '';

// ── Build the "raw user request" for SCALIST ──
const mainSubject = svp.mainSubject as string | null;
const secondarySubject = svp.secondarySubject as string | null;
const focusPrimary = shotData.focus?.primary as string | null;

// Characters actually in THIS shot — based on focus.primary / background /
// lurking, NOT scene-level mainSubject / secondarySubject. A scene's
// secondarySubject who walks off-screen for a beat must not appear in the
// per-shot context, or the LLM will substitute them for the actual focal
// character (s2shot3: Angel substituted for owner because Angel's profile
// was there and owner's wasn't — the LLM picked who it had data for).
const involvedCharacters = new Set<string>();
const _primary = shotData.focus?.primary;
const _bg = Array.isArray(shotData.focus?.background) ? shotData.focus.background : [];
const _lurking = shotData.focus?.lurking;
for (const c of [_primary, ..._bg, _lurking]) {
  if (typeof c === 'string' && characterProfiles[c]) involvedCharacters.add(c);
}
// Fallback: if focus didn't name anyone resolvable, fall back to the scene's
// mainSubject (this avoids zero-character context on minimal shots).
if (involvedCharacters.size === 0 && mainSubject && characterProfiles[mainSubject]) {
  involvedCharacters.add(mainSubject);
}

// Pick the canonical setting from across the scene (same algorithm as
// probe-deterministic-manifest.ts).
function canonicalSetting(svp: any): string | null {
  const counts = new Map<string, number>();
  for (const sh of svp.shots ?? []) {
    if (typeof sh.setting === 'string' && sh.setting) counts.set(sh.setting, (counts.get(sh.setting) ?? 0) + 1);
    for (const bg of sh.focus?.background ?? []) if (typeof bg === 'string') counts.set(bg, (counts.get(bg) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestN = 0;
  for (const [refId, n] of counts.entries()) {
    if (settingProfiles[refId] && n > bestN) { best = refId; bestN = n; }
  }
  return best;
}
const sceneSetting = canonicalSetting(svp);

const characterBriefs = [...involvedCharacters]
  .map(id => `**${id}**:\n${characterProfiles[id] ?? '(no profile)'}`)
  .join('\n\n');
const settingBrief = sceneSetting
  ? `**${sceneSetting}**:\n${settingProfiles[sceneSetting]}`
  : '(no setting)';

const rawRequest = `Generate a cinematic first-frame still for a video shot.

## Shot brief

${shotData.description}

## Camera and framing

${shotData.cameraWork}

## Characters in this shot

${characterBriefs}

## Setting

${settingBrief}

## Mood and palette (translated from Bharata rasa: ${rasa ?? 'unspecified'})

${moodLine}

## Per-shot physical cues
${shotData.sattvika ? `- sattvika (involuntary body cue): ${shotData.sattvika} — render visibly\n` : ''}${shotData.drishti ? `- drishti (gaze direction): ${shotData.drishti} — render visibly when face is focal\n` : ''}${shotData.vyabhichariBhava ? `- vyabhichari (transient emotion): ${shotData.vyabhichariBhava} — render visibly\n` : ''}

Constraints:
- This is a SINGLE FROZEN FRAME — no -ing motion verbs (running, starting, beginning, slipping, shifting, etc.). Use frozen-pose vocabulary.
- The image describes ONLY what fits the framing keyword. For close-up: no full-body / boots / legs. For OTS: foreground character's face is NOT visible. For POV: the POV character is not in frame.
- Preserve every character's identity (gender, ethnicity) exactly per the profile above. No pattern-matching to genre.

Reference slots will be bound by the executor — DO NOT write "from image N" anywhere in your prompt.`;

const llm = new LLMClient({
  baseUrl: process.env['LLM_TIER_HEAVY_BASE_URL'] || 'https://openrouter.ai/api/v1',
  apiKey: process.env['LLM_TIER_HEAVY_API_KEY'],
  model: process.env['LLM_TIER_HEAVY_MODEL'] || 'deepseek/deepseek-v4-flash',
});

console.log('=== Calling SCALIST engine ===');
const t0 = Date.now();
const res = await llm.generate({
  messages: [
    { role: 'system', content: SCALIST_SYSTEM_PROMPT },
    { role: 'user', content: rawRequest },
  ],
  temperature: 0.7,
  maxTokens: 4000,
  responseFormat: { type: 'json_object' },
});
console.log(`  done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const scalistOut = JSON.parse(res.content ?? '{}') as {
  prompt: string;
  reasoning: string;
  resolved_knowledge: string;
};

if (!scalistOut.prompt) {
  console.error('SCALIST returned no prompt. Raw:', res.content?.slice(0, 500));
  process.exit(1);
}

// ── SHOT-AWARE slot manifest ──
// Earlier (broken) algorithm bound scene.secondarySubject permanently in
// slot 3 even when that character wasn't in the current shot. Result for
// s2shot3: Angel got slot 3 even though Ruby was actually pointing the gun
// at the owner. SCALIST then substituted Angel for owner in the prose.
//
// Fix: slots 2..4 come ONLY from characters who are actually in THIS shot
// (per shot.focus.primary / background / lurking). Order: mainSubject
// first if present, then secondarySubject, then anyone else, capped at 4.
const slots: Array<{ slot: number; refType: 'setting' | 'character'; name: string }> = [];
if (sceneSetting) slots.push({ slot: 1, refType: 'setting', name: sceneSetting });

const inShot = new Set<string>();
const primary = shotData.focus?.primary;
const background = Array.isArray(shotData.focus?.background) ? shotData.focus.background : [];
const lurking = shotData.focus?.lurking;
for (const c of [primary, ...background, lurking]) {
  if (typeof c === 'string' && characterProfiles[c]) inShot.add(c);
}

// Order: mainSubject (if in shot) → secondarySubject (if in shot) → others
const ordered: string[] = [];
if (mainSubject && inShot.has(mainSubject)) ordered.push(mainSubject);
if (secondarySubject && inShot.has(secondarySubject) && !ordered.includes(secondarySubject)) ordered.push(secondarySubject);
for (const c of inShot) if (!ordered.includes(c)) ordered.push(c);

for (const c of ordered) {
  if (slots.length >= 4) break;
  slots.push({ slot: slots.length + 1, refType: 'character', name: c });
}

function prettyName(name: string): string {
  return name.split('_').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}
function findRefPng(refType: 'setting' | 'character', name: string): string | null {
  const imagesDir = join(projectRoot, 'assets/images');
  const prefix = refType === 'setting' ? 'SettingRef_' : 'CharRef_';
  const normalizedName = name.replace(/_/g, '');
  const candidates = readdirSync(imagesDir)
    .filter(f => f.startsWith(prefix) && f.endsWith('.png') && f.toLowerCase().includes(normalizedName.toLowerCase()))
    .sort();
  return candidates.length > 0 ? join(imagesDir, candidates.at(-1)!) : null;
}

const manifestLines = slots.map(s => {
  const label = s.refType === 'setting' ? `${prettyName(s.name)} (setting)` : prettyName(s.name);
  return `${label} from image ${s.slot}.`;
});
const finalPrompt = `${manifestLines.join(' ')}\n\n${scalistOut.prompt}`;

// ── Render ──
const workflowPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.json');
const wfManifestPath = resolve(process.cwd(), 'workflows/cloud/flux2_klein_edit_cloud.manifest.json');
const template = JSON.parse(readFileSync(workflowPath, 'utf-8'));
const wfManifest = JSON.parse(readFileSync(wfManifestPath, 'utf-8'));

const outputDir = join(projectRoot, 'assets/images/compare_scalist');
mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, `s${scene}shot${shot}_scalist_prompt.txt`), finalPrompt);
writeFileSync(join(outputDir, `s${scene}shot${shot}_scalist_reasoning.txt`), scalistOut.reasoning ?? '');
writeFileSync(join(outputDir, `s${scene}shot${shot}_scalist_resolved.txt`), scalistOut.resolved_knowledge ?? '');
writeFileSync(join(outputDir, `s${scene}shot${shot}_current_prompt.txt`), inlinePrompt);

console.log('\n=== SCALIST prompt ===');
console.log(finalPrompt.slice(0, 400) + '...');
console.log('\n=== SCALIST reasoning ===');
console.log((scalistOut.reasoning ?? '').slice(0, 250) + '...');

const client = new ComfyUIClient({ outputDir });
const uploaded: Record<number, string> = {};
for (const s of slots) {
  const p = findRefPng(s.refType, s.name);
  if (!p) { console.error(`Failed to find PNG for slot ${s.slot}`); process.exit(1); }
  console.log(`\nUploading slot ${s.slot}: ${p.split('/').pop()}`);
  const up = await client.uploadImage(p, 'input', true);
  uploaded[s.slot] = up.name;
}

const seed = Math.floor(Math.random() * 0x7FFFFFFF);
console.log(`\nseed: ${seed}`);

const params: Record<string, unknown> = {
  prompt: finalPrompt,
  seed,
  filenamePrefix: `compare_scalist/s${scene}shot${shot}_scalist`,
  width: 1024,
  height: 576,
};
if (negativePrompt) params.negative_prompt = negativePrompt;
for (const [n, name] of Object.entries(uploaded)) {
  params[`reference_image_${n}`] = name;
  if (n === '1') params.base_image = name;
}
const workflow = parameterizeGeneric(template, wfManifest, params) as Record<string, unknown>;

const r0 = Date.now();
const { promptId, outputs: wsOutputs } = await client.queueAndWaitWS(workflow, p => {
  if (p.percentage !== undefined && p.message) {
    console.log(`  [${p.percentage.toFixed(0)}%] ${p.message}`);
  }
});
console.log(`  render complete in ${Math.floor((Date.now() - r0) / 1000)}s`);

const histImages = await client.getOutputImages(promptId);
const seen = new Set<string>();
const imageOutputs = [...wsOutputs, ...histImages]
  .filter(i => /\.(png|jpg|jpeg|webp)$/i.test(i.filename))
  .filter(i => !seen.has(i.filename) && (seen.add(i.filename), true));

if (imageOutputs.length === 0) {
  console.error('No image output.');
  process.exit(1);
}
const target = `s${scene}shot${shot}_scalist.png`;
for (const item of imageOutputs) {
  const dl = await client.downloadImage(item.filename, item.subfolder ?? '', item.type ?? 'output', target);
  console.log(`  → ${dl}`);
  break;
}

console.log(`\nOpen ${outputDir} in Finder. Compare s${scene}shot${shot}_scalist.png against:`);
console.log(`  Ruby.kshana/assets/images/compare_deterministic_manifest/s${scene}shot${shot}_deterministic.png`);
console.log(`  Ruby.kshana/assets/images/compare_deterministic_manifest/s${scene}shot${shot}_inline.png`);
