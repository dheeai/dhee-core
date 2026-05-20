#!/usr/bin/env tsx
/**
 * Walk a project's rendered shot videos, judge each first+last keyframe
 * against the prompt that produced it, and write a markdown report.
 *
 * The judge is the calibrated VLM (see `scripts/calibrate-vlm.ts`).
 * Per-shot we score:
 *   - first frame vs. shot prompt's `frames.first_frame.imagePrompt`
 *   - last frame vs. shot prompt's `frames.last_frame.imagePrompt` if
 *     present (otherwise re-uses first-frame prompt)
 *   - per-shot fidelity = average of the two keyframe scores
 *
 * Output:
 *   - per-shot table (id, score, top issue, ltxAchievability)
 *   - per-scene aggregates
 *   - project-level average + distribution
 *   - bottom-quartile callout — the shots most worth attention
 *
 * Report path: `test-output/fidelity/<project>-<timestamp>.md`
 *
 * Usage:
 *   pnpm audit-fidelity <project-name>
 *
 * Limitations:
 *   - Skips shots with no rendered video.
 *   - Skips shots whose prompt JSON is missing.
 *   - Image-only assets (without scene/shot metadata) are not audited
 *     here — the manifest's `scene_image` entries don't carry shot
 *     identifiers in this project layout, so we audit via the video
 *     keyframes which DO have `sceneNumber/shotNumber` metadata.
 */

import 'dotenv/config';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { LLMClient } from '../src/core/llm/index.js';
import { buildRouterFromEnv } from '../src/core/llm/index.js';
import { judgeImage, loadRubric, type JudgeResult, type Rubric } from '../src/core/eval/vlmJudge.js';
import { extractKeyframes } from '../src/core/timeline/keyframeExtractor.js';

interface AssetEntry {
  id: string;
  type: string;
  path: string;
  metadata?: { sceneNumber?: number; shotNumber?: number; duration?: number };
}

interface ShotPromptFile {
  shotNumber: number;
  generationStrategy?: string;
  frames?: {
    first_frame?: { imagePrompt: string };
    last_frame?: { imagePrompt: string };
  };
  // single-frame fallback shape
  imagePrompt?: string;
}

interface KeyframeJudgment {
  frameLabel: 'first' | 'last';
  framePath: string;
  result: JudgeResult;
}

interface ShotAudit {
  sceneNumber: number;
  shotNumber: number;
  shotId: string;
  videoPath: string;
  promptPath: string;
  keyframes: KeyframeJudgment[];
  /** Average score across keyframes. */
  shotScore: number;
  /** Worst-case top issue across keyframes. */
  topIssue: string;
  ltxAchievability: 'high' | 'medium' | 'low';
}

// ── Helpers ─────────────────────────────────────────────────────────────

function loadProjectAssets(projectDir: string): AssetEntry[] {
  const manifestPath = join(projectDir, 'assets', 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No asset manifest at ${manifestPath}`);
  }
  const m = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  return Array.isArray(m.assets) ? m.assets : [];
}

function loadShotPrompt(projectDir: string, sceneNumber: number, shotNumber: number): ShotPromptFile | null {
  const path = join(projectDir, 'prompts', 'images', 'shots', `scene-${sceneNumber}-shot-${shotNumber}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8'));
}

function pickPrompts(file: ShotPromptFile): { first: string; last: string | null } {
  const first =
    file.frames?.first_frame?.imagePrompt ??
    file.imagePrompt ??
    '';
  const last = file.frames?.last_frame?.imagePrompt ?? null;
  return { first, last };
}

/** Pick worst (lowest) achievability across a list of judgments. */
function worstAchievability(arr: KeyframeJudgment[]): 'high' | 'medium' | 'low' {
  const order: Record<string, number> = { high: 2, medium: 1, low: 0 };
  let worst: 'high' | 'medium' | 'low' = 'high';
  for (const k of arr) {
    if ((order[k.result.ltxAchievability] ?? 2) < (order[worst] ?? 2)) {
      worst = k.result.ltxAchievability;
    }
  }
  return worst;
}

function worstTopIssue(arr: KeyframeJudgment[]): string {
  // The top issue from the worst-scoring keyframe.
  const sorted = [...arr].sort((a, b) => a.result.score - b.result.score);
  return sorted[0]?.result.topIssue ?? 'none';
}

// ── Audit one shot ──────────────────────────────────────────────────────

async function auditShot(
  projectDir: string,
  asset: AssetEntry,
  rubric: Rubric,
  llm: LLMClient,
  keyframeWorkDir: string,
): Promise<ShotAudit | null> {
  const { sceneNumber, shotNumber } = asset.metadata ?? {};
  if (sceneNumber == null || shotNumber == null) return null;

  const videoAbs = join(projectDir, asset.path);
  if (!existsSync(videoAbs)) {
    console.error(`  ! skip ${asset.id}: video missing at ${videoAbs}`);
    return null;
  }

  const promptFile = loadShotPrompt(projectDir, sceneNumber, shotNumber);
  if (!promptFile) {
    console.error(`  ! skip scene ${sceneNumber} shot ${shotNumber}: no prompt JSON`);
    return null;
  }
  const { first, last } = pickPrompts(promptFile);
  if (!first) {
    console.error(`  ! skip scene ${sceneNumber} shot ${shotNumber}: empty prompt`);
    return null;
  }

  // Extract keyframes — first + last only (lightweight; the full audit
  // doesn't need every frame).
  const shotWorkDir = join(keyframeWorkDir, `s${sceneNumber}_shot${shotNumber}`);
  mkdirSync(shotWorkDir, { recursive: true });
  let frames: string[];
  try {
    frames = await extractKeyframes(videoAbs, 2, shotWorkDir);
  } catch (err) {
    console.error(`  ! skip ${asset.id}: keyframe extraction failed — ${(err as Error).message}`);
    return null;
  }

  const keyframes: KeyframeJudgment[] = [];
  if (frames[0]) {
    const r = await judgeImage(frames[0], first, rubric, llm);
    keyframes.push({ frameLabel: 'first', framePath: frames[0], result: r });
  }
  if (frames[1]) {
    const lastPrompt = last ?? first;
    const r = await judgeImage(frames[1], lastPrompt, rubric, llm);
    keyframes.push({ frameLabel: 'last', framePath: frames[1], result: r });
  }

  const shotScore = keyframes.length > 0
    ? Math.round(keyframes.reduce((s, k) => s + k.result.score, 0) / keyframes.length)
    : 0;

  return {
    sceneNumber,
    shotNumber,
    shotId: `scene_${sceneNumber}_shot_${shotNumber}`,
    videoPath: asset.path,
    promptPath: `prompts/images/shots/scene-${sceneNumber}-shot-${shotNumber}.json`,
    keyframes,
    shotScore,
    topIssue: worstTopIssue(keyframes),
    ltxAchievability: worstAchievability(keyframes),
  };
}

// ── Report rendering ────────────────────────────────────────────────────

function renderReport(projectName: string, audits: ShotAudit[], reportPath: string): void {
  audits.sort((a, b) => a.sceneNumber - b.sceneNumber || a.shotNumber - b.shotNumber);

  const lines: string[] = [];
  lines.push(`# Fidelity Audit — ${projectName}`);
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Shots audited: ${audits.length}`);
  lines.push('');

  // Per-shot table
  lines.push('## Per-shot scores');
  lines.push('');
  lines.push('| Scene | Shot | Score | LTX | Top issue |');
  lines.push('|------:|-----:|------:|:----|:----------|');
  for (const a of audits) {
    const issue = a.topIssue.replace(/\|/g, '\\|').slice(0, 100);
    lines.push(`| ${a.sceneNumber} | ${a.shotNumber} | ${a.shotScore} | ${a.ltxAchievability} | ${issue} |`);
  }
  lines.push('');

  // Per-scene aggregate
  lines.push('## Per-scene aggregate');
  lines.push('');
  lines.push('| Scene | Shots | Avg score | LTX low / med / high |');
  lines.push('|------:|------:|----------:|:---------------------|');
  const byScene = new Map<number, ShotAudit[]>();
  for (const a of audits) {
    const arr = byScene.get(a.sceneNumber) ?? [];
    arr.push(a);
    byScene.set(a.sceneNumber, arr);
  }
  for (const [sceneNum, arr] of [...byScene.entries()].sort((a, b) => a[0] - b[0])) {
    const avg = Math.round(arr.reduce((s, x) => s + x.shotScore, 0) / arr.length);
    const lo = arr.filter(x => x.ltxAchievability === 'low').length;
    const me = arr.filter(x => x.ltxAchievability === 'medium').length;
    const hi = arr.filter(x => x.ltxAchievability === 'high').length;
    lines.push(`| ${sceneNum} | ${arr.length} | ${avg} | ${lo} / ${me} / ${hi} |`);
  }
  lines.push('');

  // Project total
  const projectAvg = audits.length > 0
    ? Math.round(audits.reduce((s, x) => s + x.shotScore, 0) / audits.length)
    : 0;
  const dist = { low: 0, medium: 0, high: 0 };
  for (const a of audits) dist[a.ltxAchievability]++;
  lines.push('## Project total');
  lines.push('');
  lines.push(`- Average score: **${projectAvg}**`);
  lines.push(`- LTX achievability distribution: high ${dist.high} / medium ${dist.medium} / low ${dist.low}`);
  lines.push('');

  // Bottom quartile
  const sorted = [...audits].sort((a, b) => a.shotScore - b.shotScore);
  const quartileSize = Math.max(1, Math.ceil(audits.length / 4));
  const bottom = sorted.slice(0, quartileSize);
  lines.push('## Bottom-quartile shots — target these first');
  lines.push('');
  lines.push('| Scene | Shot | Score | LTX | Top issue |');
  lines.push('|------:|-----:|------:|:----|:----------|');
  for (const a of bottom) {
    const issue = a.topIssue.replace(/\|/g, '\\|').slice(0, 120);
    lines.push(`| ${a.sceneNumber} | ${a.shotNumber} | ${a.shotScore} | ${a.ltxAchievability} | ${issue} |`);
  }
  lines.push('');

  // Per-shot detail (failed questions)
  lines.push('## Per-shot detail — failed rubric questions');
  lines.push('');
  for (const a of audits) {
    lines.push(`### Scene ${a.sceneNumber}, Shot ${a.shotNumber} — score ${a.shotScore}`);
    lines.push('');
    for (const k of a.keyframes) {
      lines.push(`- **${k.frameLabel} frame** (score ${k.result.score}, LTX ${k.result.ltxAchievability})`);
      const failed = k.result.questions.filter(q => !q.pass);
      if (failed.length === 0) {
        lines.push(`  - All rubric questions passed`);
      } else {
        for (const q of failed) {
          lines.push(`  - ❌ ${q.id}: ${q.reasoning.slice(0, 200)}`);
        }
      }
    }
    lines.push('');
  }

  writeFileSync(reportPath, lines.join('\n'));
}

// ── Main ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const projectRoot = resolve(join(__dirname, '..'));

  const args = process.argv.slice(2);
  const projectName = args.find(a => !a.startsWith('--'));
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1] ?? '0', 10) || undefined : undefined;
  if (!projectName) {
    console.error('Usage: pnpm audit-fidelity <project-name> [--limit=N] [--per-scene=N] [--concurrency=N]');
    process.exit(1);
  }
  const projectDir = join(projectRoot, projectName.endsWith('.dhee') ? projectName : `${projectName}.dhee`);
  if (!existsSync(projectDir)) {
    console.error(`Project not found: ${projectDir}`);
    process.exit(1);
  }

  const rubric = loadRubric('shot-image-fidelity-binary');
  const router = buildRouterFromEnv(projectRoot);
  const llm: LLMClient = router.getClient('utility.image_review');
  const llmCfg = router.resolveConfig('utility.image_review');

  const assets = loadProjectAssets(projectDir);
  const videoAssets = assets.filter(a => a.type === 'scene_video' && a.metadata?.sceneNumber != null && a.metadata.shotNumber != null);

  console.log('=== Fidelity Audit ===');
  console.log(`  project:  ${projectName}`);
  console.log(`  rubric:   ${rubric.name} (${rubric.questions.length} questions)`);
  console.log(`  VLM:      ${llmCfg.model} @ ${llmCfg.baseUrl ?? 'default'}`);
  console.log(`  videos:   ${videoAssets.length} (${assets.filter(a => a.type === 'scene_video').length - videoAssets.length} skipped: missing scene/shot metadata)`);
  console.log('');

  const reportRoot = join(projectRoot, 'test-output', 'fidelity');
  mkdirSync(reportRoot, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = join(reportRoot, `${projectName}-${stamp}.md`);
  const keyframeWorkDir = join(tmpdir(), `audit-${projectName}-${Date.now()}`);
  mkdirSync(keyframeWorkDir, { recursive: true });

  // Dedupe — when multiple takes exist, prefer the latest by createdAt.
  const seen = new Set<string>();
  const sortedAssets = [...videoAssets].sort((a, b) => ((b as unknown as { createdAt?: number }).createdAt ?? 0) - ((a as unknown as { createdAt?: number }).createdAt ?? 0));
  const dedupedAll: AssetEntry[] = [];
  for (const v of sortedAssets) {
    const key = `s${v.metadata!.sceneNumber}_${v.metadata!.shotNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedAll.push(v);
  }

  // Stratified sampling: --per-scene=N picks the first N shots of each
  // scene (by shotNumber ascending). Lets us spot-check broad coverage
  // without the ~2hr cost of a full audit on a multi-scene project.
  const perSceneArg = args.find(a => a.startsWith('--per-scene='));
  const perScene = perSceneArg ? Math.max(1, parseInt(perSceneArg.split('=')[1] ?? '0', 10) || 0) : 0;
  let queue: AssetEntry[] = dedupedAll;
  if (perScene > 0) {
    const byScene = new Map<number, AssetEntry[]>();
    for (const v of dedupedAll) {
      const sn = v.metadata!.sceneNumber!;
      const arr = byScene.get(sn) ?? [];
      arr.push(v);
      byScene.set(sn, arr);
    }
    queue = [];
    for (const [, arr] of [...byScene.entries()].sort((a, b) => a[0] - b[0])) {
      arr.sort((a, b) => (a.metadata!.shotNumber! - b.metadata!.shotNumber!));
      queue.push(...arr.slice(0, perScene));
    }
  }
  if (limit) queue = queue.slice(0, limit);

  // Concurrent worker pool — OpenRouter handles parallel requests well
  // and the laptop only does base64 encoding. Concurrency 5 cuts a 2hr
  // sequential run down to ~25min.
  const concurrencyArg = args.find(a => a.startsWith('--concurrency='));
  const concurrency = concurrencyArg
    ? Math.max(1, parseInt(concurrencyArg.split('=')[1] ?? '5', 10) || 5)
    : 5;
  console.log(`  concurrency: ${concurrency}`);
  console.log('');

  const audits: ShotAudit[] = [];
  let nextIndex = 0;
  let done = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = nextIndex++;
      if (idx >= queue.length) return;
      const v = queue[idx]!;
      const t0 = Date.now();
      const a = await auditShot(projectDir, v, rubric, llm, keyframeWorkDir);
      done++;
      if (a) {
        audits.push(a);
        process.stdout.write(`  [${done}/${queue.length}] scene ${v.metadata!.sceneNumber} shot ${v.metadata!.shotNumber} → score=${a.shotScore} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
      } else {
        process.stdout.write(`  [${done}/${queue.length}] scene ${v.metadata!.sceneNumber} shot ${v.metadata!.shotNumber} → SKIPPED\n`);
      }
    }
  });
  await Promise.all(workers);

  if (audits.length === 0) {
    console.error('No shots audited. Nothing to report.');
    process.exit(1);
  }

  renderReport(projectName, audits, reportPath);
  console.log('');
  console.log(`Report: ${reportPath}`);
}

main().catch(err => {
  console.error('Fatal:', (err as Error).message);
  console.error((err as Error).stack);
  process.exit(1);
});
