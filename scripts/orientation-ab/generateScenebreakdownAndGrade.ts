/**
 * Upstream test: run the scene_breakdown LLM call with the PATCHED
 * scene_breakdown_shot_guide.md against the SAME scene-plan inputs
 * production sent for our 5 test shots. Grade the output `description`
 * field — does it emit back-to-camera-friendly prose for approach beats?
 *
 * This closes the gap left by generateAndGrade.ts (which simulates Tier 1
 * with pre-baked descriptions). If THIS test passes, the full chain holds:
 *   scene_breakdown (patched) → image-prompt (patched) → Klein
 *
 * Inputs are reconstructed from /Users/ganaraj/dhee-studios/Ruby V3:
 *   - scene plan: prompts/videos/scenes/scene_N.plan.json
 *   - available refs: project.executorState.nodes (character_image/setting_image)
 *
 * Same model + temperature as production's shot_breakdown call:
 *   - DeepSeek v4-flash (LLM_TIER_HEAVY_*)
 *   - temperature 0.3 (matches ExecutorAgent for content nodes)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildRouterFromEnv } from '../../src/core/llm/router.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = '/Users/ganaraj/dhee-studios/Ruby V3';
const GUIDE_PATH = path.join(
  SCRIPT_DIR, '..', '..', 'prompts', 'skills', 'defaults', 'scene_breakdown_shot_guide.md',
);
const OUT_DIR = path.join(SCRIPT_DIR, 'results', 'scenebreakdown_prompts');

interface TestShot {
  shotId: string;
  sceneNumber: number;
  shotNumber: number;
  /** Whether to apply approach-beat checks. */
  isApproachBeat: boolean;
}

const TEST_SHOTS: TestShot[] = [
  { shotId: 'scene-2-shot-1', sceneNumber: 2, shotNumber: 1, isApproachBeat: true },   // meet_character
  { shotId: 'scene-2-shot-9', sceneNumber: 2, shotNumber: 9, isApproachBeat: true },   // OTS-of-robbers; cameraWork triggers it
  { shotId: 'scene-4-shot-5', sceneNumber: 4, shotNumber: 5, isApproachBeat: false },  // show_tension (Ruby in car)
  { shotId: 'scene-4-shot-6', sceneNumber: 4, shotNumber: 6, isApproachBeat: false },  // show_action (impact)
  { shotId: 'scene-4-shot-11', sceneNumber: 4, shotNumber: 11, isApproachBeat: false }, // show_dialogue (close-up POV)
];

/** Get the available_refs list from the project's executorState. */
function buildAvailableRefsBlock(): string {
  const project = JSON.parse(readFileSync(path.join(PROJECT_DIR, 'project.json'), 'utf-8'));
  const nodes = project.executorState?.nodes ?? {};
  const lines: string[] = [];
  let n = 1;
  for (const node of Object.values(nodes) as any[]) {
    if (node.typeId === 'character_image' || node.typeId === 'setting_image') {
      const typeLabel = node.typeId === 'character_image' ? 'character' : 'setting';
      lines.push(`- image ${n++}: ${typeLabel} "${node.itemId}" (ref_id: "${node.id}")`);
    }
  }
  return `<available_refs>\nAvailable canonical references for this project:\n${lines.join('\n')}\n</available_refs>`;
}

/** Reconstruct the <scene_plan> + <this_shot> block exactly as ExecutorAgent does. */
function buildScenePlanBlock(sceneNumber: number, shotNumber: number): string {
  const planPath = path.join(PROJECT_DIR, 'prompts', 'videos', 'scenes', `scene_${sceneNumber}.plan.json`);
  const planContent = readFileSync(planPath, 'utf-8').trim();
  const planJson = JSON.parse(planContent);
  const thisEntry = (planJson.shotPlan ?? []).find((p: { shotNumber?: number }) => p.shotNumber === shotNumber);
  if (!thisEntry) throw new Error(`No shot ${shotNumber} in scene ${sceneNumber} plan`);
  const thisEntryStr = JSON.stringify(thisEntry, null, 2);
  return `<scene_plan>\n${planContent}\n</scene_plan>\n\n<this_shot>\n${thisEntryStr}\n</this_shot>\n\nExpand THIS shot only. Copy shotNumber, purpose, and duration verbatim from <this_shot>. Use <scene_plan> for continuity context (what comes before / after).`;
}

function buildSystemPrompt(guide: string): string {
  // Match ExecutorAgent.ts:3710 exactly for shot_breakdown.
  return `You are a cinematographer expanding a single shot from a pre-approved scene plan. Output ONLY valid JSON for ONE shot object.\n\n<model_skills>\n${guide}\n</model_skills>`;
}

function buildUserMessage(sceneNumber: number, shotNumber: number): string {
  // Minimal but contract-matching: task + available_refs + scene_plan/this_shot.
  // We skip world_style, character tags, sceneStateContext etc. — none of those
  // bear on the orientation-rewrite question we're testing.
  const refsBlock = buildAvailableRefsBlock();
  const planBlock = buildScenePlanBlock(sceneNumber, shotNumber);
  return `Expand shot ${shotNumber} of scene ${sceneNumber} per the rules in your system prompt.\n\n${refsBlock}\n\n${planBlock}\n\nOutput ONLY valid JSON for ONE shot object matching the required schema.`;
}

async function callLLM(llm: any, system: string, user: string): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of llm.generateStream({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.3,
    responseFormat: { type: 'json_object' },
  })) {
    if (chunk.content) chunks.push(chunk.content);
  }
  return chunks.join('');
}

function parseJson(raw: string): any {
  let cleaned = raw.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  return JSON.parse(cleaned);
}

// ── Description grading ────────────────────────────────────────────────────

const APPROACH_FACE_CUES = [
  'exchange a look', 'exchange a final look', 'final look', 'shared look',
  'their gazes', 'gazes meet', 'gazes lock', 'locked eyes', 'eyes meet',
  'eyes locked', 'fix on', 'fixed on',
  'her face', 'his face', 'their faces',
  'face set with', 'face frozen', 'expression set',
  'jaw clenched', 'jaw tight', 'brow furrowed', 'lips pressed',
  'determined gaze', 'predatory gaze',
  'facing each other', 'face to face',
];

const APPROACH_PHRASING = [
  'from behind', 'backs to camera', 'their backs',
  'walking toward', 'walks toward', 'walking up to', 'walks up to',
  'approach the', 'approaches the', 'approaching the',
  'enter the', 'enters the', 'walks into', 'step into', 'steps into',
  'walks away', 'departs', 'crosses toward',
  'over the shoulders', 'over the shoulder',
];

function lc(s: string): string { return s.toLowerCase(); }

interface DescGrade {
  required: string[];
  failed: string[];
  passed: number;
  total: number;
}

function gradeDescription(desc: string, isApproachBeat: boolean): DescGrade {
  const failed: string[] = [];
  const required: string[] = [];

  if (isApproachBeat) {
    required.push('no face cues for approach/OTS beat');
    if (APPROACH_FACE_CUES.some(p => lc(desc).includes(lc(p)))) {
      const hit = APPROACH_FACE_CUES.find(p => lc(desc).includes(lc(p)));
      failed.push(`no face cues for approach/OTS beat (found "${hit}")`);
    }

    required.push('uses approach phrasing');
    if (!APPROACH_PHRASING.some(p => lc(desc).includes(lc(p)))) {
      failed.push('uses approach phrasing (none found)');
    }
  }

  required.push('non-empty description');
  if (!desc || desc.trim().length === 0) failed.push('non-empty description');

  required.push('description is 1-3 sentences (guide says 1-2)');
  const sentences = desc.split(/[.!?]+\s/).filter(s => s.trim().length > 0);
  if (sentences.length === 0 || sentences.length > 3) {
    failed.push(`description is 1-3 sentences (got ${sentences.length})`);
  }

  return { required, failed, passed: required.length - failed.length, total: required.length };
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!existsSync(GUIDE_PATH)) throw new Error(`guide missing: ${GUIDE_PATH}`);
  const guide = readFileSync(GUIDE_PATH, 'utf-8');
  console.log(`[harness] guide: ${guide.length} chars from ${path.basename(GUIDE_PATH)}\n`);

  const router = buildRouterFromEnv(process.cwd());
  // shot_breakdown is a MEDIUM tier purpose: 'structured.scene_breakdown'
  const llm = router.getClient('structured.scene_breakdown');
  console.log(`[harness] model: ${router.resolveConfig('structured.scene_breakdown').model}\n`);

  const results: any[] = [];

  for (const shot of TEST_SHOTS) {
    const system = buildSystemPrompt(guide);
    const user = buildUserMessage(shot.sceneNumber, shot.shotNumber);
    console.log(`[llm] ${shot.shotId} (approach=${shot.isApproachBeat}) …`);
    const t0 = Date.now();
    let raw = '';
    let parsed: any = null;
    let parseErr: string | null = null;
    try {
      raw = await callLLM(llm, system, user);
      parsed = parseJson(raw);
    } catch (err: any) {
      parseErr = err.message;
    }
    const elapsed = Date.now() - t0;

    if (parseErr) {
      console.log(`  ✗ ${parseErr}`);
      results.push({ shotId: shot.shotId, error: parseErr, raw });
      continue;
    }

    const desc = parsed?.description ?? '';
    const grade = gradeDescription(desc, shot.isApproachBeat);
    results.push({
      shotId: shot.shotId,
      isApproachBeat: shot.isApproachBeat,
      description: desc,
      cameraWork: parsed?.cameraWork,
      purpose: parsed?.purpose,
      grade,
      elapsedMs: elapsed,
    });

    console.log(`  description: ${desc}`);
    console.log(`  → ${grade.passed}/${grade.total} required checks passed (${elapsed}ms)`);
    if (grade.failed.length > 0) console.log(`  ✗ failed: ${grade.failed.join(', ')}`);
    console.log('');

    writeFileSync(
      path.join(OUT_DIR, `${shot.shotId}.json`),
      JSON.stringify({ shotId: shot.shotId, isApproachBeat: shot.isApproachBeat, description: desc, parsedJson: parsed, grade, raw }, null, 2),
    );
  }

  // Summary
  console.log('━'.repeat(60));
  console.log('SCENE_BREAKDOWN UPSTREAM TEST SUMMARY');
  console.log('━'.repeat(60));
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.shotId.padEnd(20)} ❌ ERROR: ${r.error}`);
      continue;
    }
    const verdict = r.grade.failed.length === 0 ? '✅ APPROVE' : `❌ ${r.grade.failed.length} fail`;
    console.log(`  ${r.shotId.padEnd(20)} ${r.grade.passed}/${r.grade.total}  ${verdict}`);
  }
  const okShots = results.filter(r => !r.error && r.grade.failed.length === 0).length;
  console.log(`\n  Per-shot pass rate: ${okShots}/${results.length}`);

  writeFileSync(path.join(OUT_DIR, 'summary.json'), JSON.stringify(results, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
