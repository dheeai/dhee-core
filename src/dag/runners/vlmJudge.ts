/**
 * `vlm.judge` — quality-gate runner. Sends an image (or any binary
 * artifact) to a vision LLM, parses a pass/fail verdict, and on fail
 * stamps `pendingCritiques[refineNode:itemId]` so the walker's
 * review-loop wrapper re-runs the upstream refineNode (typically the
 * LLM that wrote the prompt) with the critique applied.
 *
 * The verdict is written as a JSON artifact at the node's outputPath
 * so the Inspector Canvas can show it inline next to the artifact
 * being judged. Re-runs are bounded by `bundle.reviewLoopMax` — the
 * judge itself doesn't need to know about iteration counts.
 *
 * Wiring (bundle author's responsibility):
 *   - inputs[0] (usage='input', scope='matching'): the artifact to
 *     judge. For images, ctx.inputs[upstream] is the absolute path.
 *   - inputs[1+] (usage='context'): everything the judge needs to
 *     evaluate against — the production prompt, characters_plan,
 *     settings_plan, etc.
 *   - config.imageInput: the upstream node id whose output is the
 *     image being judged. Default 'shot_image' for narrative bundles.
 *   - config.refineNode: the upstream node id to invalidate on fail
 *     (typically the prompt-LLM node, NOT the image renderer — image
 *     re-renders happen via BUG-023's cascade once the prompt changes).
 *   - config.passThreshold: 0–1, the minimum score for pass. The
 *     verdict text the judge produces should also include an explicit
 *     pass/fail, but the threshold gives the bundle author a knob
 *     to enforce strictness independent of the model's calibration.
 *   - config.criteria: free-text instructions for what to evaluate
 *     (e.g. "character identity, action subject/object, setting
 *     fidelity, no anatomical artifacts").
 *
 * VLM endpoint resolution:
 *   - config.judgeProvider / config.judgeApiKey / config.judgeModel /
 *     config.judgeBaseUrl override env defaults if set.
 *   - Otherwise: `getVLMConfig()` reads VLM_PROVIDER / VLM_API_KEY /
 *     VLM_MODEL / VLM_BASE_URL — the same scaffold the audit script
 *     uses.
 *   - Errors loudly if no config is reachable. The judge isn't
 *     optional once a bundle declares it.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import OpenAI from 'openai';
import type { Runner, RunnerContext, RunnerDescription, RunnerResult } from '../schema.js';
import { getVLMConfig } from '../../core/llm/getVLMConfig.js';

interface JudgeConfig {
  outputPath: string;
  imageInput?: string;
  refineNode: string;
  passThreshold?: number;
  criteria?: string;
  systemPrompt?: string;
  judgeProvider?: string;
  judgeApiKey?: string;
  judgeModel?: string;
  judgeBaseUrl?: string;
  /** Max tokens for the VLM response. Default 1200. */
  maxTokens?: number;
}

export interface JudgeAttempt {
  n: number;
  pass: boolean;
  score: number;
  notes: string;
  /** Stash path (relative to projectDir) so the runner can copy this
   *  attempt's image back over the canonical path if it later turns
   *  out to be the best of N. */
  stashPath: string;
  rawResponse?: string;
}

export interface JudgeVerdict {
  // Top-level mirrors the best attempt so consumers (tests, Inspector
  // tiles, downstream nodes) can read pass/score/notes without
  // walking the attempts array.
  pass: boolean;
  /** 0..1 confidence/quality, from bestAttempt */
  score: number;
  /** What's wrong and how to fix it, from bestAttempt */
  notes: string;
  /** Raw model output for the LAST attempt (debugging) */
  rawResponse?: string;
  model?: string;
  /** Best-of-N tracking: attempts so far, current attempt #, best of the N. */
  currentAttempt?: number;
  bestAttempt?: number;
  attempts?: JudgeAttempt[];
}

/**
 * Pick the best attempt out of an array. Rule:
 *   1. If ANY attempt has pass=true: pick the FIRST passing attempt
 *      (earliest acceptable = lowest budget).
 *   2. Otherwise: pick the highest-scoring. Ties broken by earliest
 *      (lower n).
 *
 * Pure for unit testing. Asserts attempts.length >= 1.
 */
export function pickBestAttempt(attempts: JudgeAttempt[]): JudgeAttempt {
  if (attempts.length === 0) throw new Error('pickBestAttempt: no attempts to pick from');
  const passing = attempts.filter((a) => a.pass);
  if (passing.length > 0) {
    return passing.reduce((best, a) => (a.n < best.n ? a : best));
  }
  return attempts.reduce((best, a) => {
    if (a.score > best.score) return a;
    if (a.score === best.score && a.n < best.n) return a;
    return best;
  });
}

const DEFAULT_SYSTEM_PROMPT = `You are a vision-language judge auditing a rendered image against a production brief.

You will be shown ONE image plus the brief that asked for it. Your job:
  1. Decide if the image faithfully realizes the brief.
  2. Output a SINGLE JSON object — no preamble, no markdown code fences:
     { "pass": boolean, "score": number (0 to 1), "notes": "..." }
  3. "notes" must be CONCRETE and ACTIONABLE — describe what is wrong
     and how the upstream prompt should be reworded to fix it. If
     pass=true, notes can be a short positive sentence.
  4. "pass" is TRUE only if the image is acceptable for production.
  5. "score" reflects your confidence in the verdict (1.0 = no doubt).

Focus on:
  - Character identity (do faces / clothing / build match the canonical
    descriptions in the brief?)
  - Action subject/object (does the right character do the right thing
    to the right target?)
  - Setting fidelity (does the background match the named location?)
  - Significant artifacts (anatomy, doubled subjects, melted faces)

Ignore pixel-peeping perfection. Flag only issues a viewer would
notice at normal speed.`;

export function pickConfig(
  cfg: JudgeConfig,
  env: NodeJS.ProcessEnv = process.env,
): { provider: string; apiKey: string; model: string; baseUrl: string } | { error: string } {
  if (cfg.judgeProvider && cfg.judgeApiKey && cfg.judgeModel) {
    const baseUrl = cfg.judgeBaseUrl ?? 'https://openrouter.ai/api/v1';
    return { provider: cfg.judgeProvider, apiKey: cfg.judgeApiKey, model: cfg.judgeModel, baseUrl };
  }
  const vlm = getVLMConfig(env);
  if (vlm) return vlm;
  return {
    error:
      'vlm.judge: no VLM endpoint configured. Set VLM_PROVIDER + VLM_API_KEY + VLM_MODEL in env, or supply judgeProvider/judgeApiKey/judgeModel in the runner config.',
  };
}

export function buildJudgePrompt(opts: {
  contextInputs: Record<string, unknown>;
  imageInputId: string;
  criteria?: string;
}): string {
  const parts: string[] = [];
  if (opts.criteria) {
    parts.push(`## Evaluation criteria\n\n${opts.criteria}`);
  }
  parts.push(`## Production brief\n\nThe following upstream artifacts describe what the image is supposed to depict. Use them to judge the rendered output.`);

  for (const [id, value] of Object.entries(opts.contextInputs)) {
    if (id === opts.imageInputId) continue; // image goes in image_url, not text
    if (value === undefined || value === null) continue;
    const body =
      typeof value === 'string'
        ? value
        : JSON.stringify(value, null, 2);
    parts.push(`### \`${id}\`\n\n${body}`);
  }

  parts.push(
    `## Output\n\nReturn ONE JSON object: { "pass": bool, "score": 0..1, "notes": string }. No code fences. No preamble.`,
  );
  return parts.join('\n\n');
}

/**
 * Best-effort verdict parse. Models occasionally wrap in ```json …```
 * fences or add a sentence of preamble; this strips and looks for the
 * outermost JSON object.
 */
export function parseVerdict(raw: string): JudgeVerdict | { error: string } {
  if (!raw || !raw.trim()) return { error: 'vlm.judge: empty model response' };
  let body = raw.trim();
  // Strip markdown code fences if present.
  body = body.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // If the model added prose before/after, locate the outermost {...}.
  const firstBrace = body.indexOf('{');
  const lastBrace = body.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return { error: `vlm.judge: no JSON object in response: ${raw.slice(0, 200)}` };
  }
  const slice = body.slice(firstBrace, lastBrace + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (e) {
    return { error: `vlm.judge: malformed JSON: ${(e as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') return { error: 'vlm.judge: non-object verdict' };
  const obj = parsed as Record<string, unknown>;
  const pass = obj['pass'];
  const score = obj['score'];
  const notes = obj['notes'];
  if (typeof pass !== 'boolean') return { error: 'vlm.judge: verdict missing/non-boolean `pass`' };
  if (typeof score !== 'number') return { error: 'vlm.judge: verdict missing/non-number `score`' };
  if (typeof notes !== 'string') return { error: 'vlm.judge: verdict missing/non-string `notes`' };
  return { pass, score, notes };
}

/** Stamps pendingCritiques[refineNode:itemId] = notes. Idempotent
 *  per-call (overwrites prior critique for the same key). */
export function stampPendingCritique(
  projectDir: string,
  refineNode: string,
  itemId: string | undefined,
  notes: string,
): void {
  const path = resolve(projectDir, 'project.json');
  let project: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      project = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    } catch {
      project = {};
    }
  }
  const existing = (project['pendingCritiques'] as Record<string, string> | undefined) ?? {};
  const key = itemId ? `${refineNode}:${itemId}` : refineNode;
  existing[key] = notes;
  project['pendingCritiques'] = existing;
  writeFileSync(path, JSON.stringify(project, null, 2), 'utf-8');
}

async function run(ctx: RunnerContext): Promise<RunnerResult> {
  const cfg = (ctx.node.runner.config ?? {}) as unknown as JudgeConfig;
  if (!cfg.outputPath) return { ok: false, error: 'vlm.judge: outputPath not resolved' };
  if (!cfg.refineNode) return { ok: false, error: 'vlm.judge: config.refineNode is required' };

  const imageInputId = cfg.imageInput ?? 'shot_image';
  const imageValue = ctx.inputs[imageInputId];
  if (typeof imageValue !== 'string') {
    return {
      ok: false,
      error: `vlm.judge: ctx.inputs['${imageInputId}'] is not a file path (got ${typeof imageValue}). Confirm the bundle wires a binary upstream (scope='matching') for this id.`,
    };
  }
  if (!existsSync(imageValue)) {
    return { ok: false, error: `vlm.judge: image not found at ${imageValue}` };
  }

  const resolved = pickConfig(cfg);
  if ('error' in resolved) return { ok: false, error: resolved.error };

  // Read prior verdict.json (from previous walk iterations of this
  // review loop) to load prior attempts. On iter 1 this is empty.
  const outAbs = resolve(ctx.projectDir, cfg.outputPath);
  mkdirSync(dirname(outAbs), { recursive: true });
  let priorAttempts: JudgeAttempt[] = [];
  if (existsSync(outAbs)) {
    try {
      const prior = JSON.parse(readFileSync(outAbs, 'utf-8')) as JudgeVerdict;
      if (Array.isArray(prior.attempts)) priorAttempts = prior.attempts;
    } catch {
      // malformed prior verdict — treat as no history
    }
  }
  const currentAttempt = priorAttempts.length + 1;

  // Stash the just-rendered upstream image so we can restore it later
  // if it turns out to be the best of N. Stash lives in a .attempts
  // sibling dir under the verdict's output dir to keep all the
  // review state co-located with the verdict tile.
  const ext = /\.(jpe?g)$/i.test(imageValue) ? 'jpeg' : 'png';
  const stashDir = resolve(dirname(outAbs), '.attempts');
  mkdirSync(stashDir, { recursive: true });
  const stashFileName = `${ctx.itemId ?? 'singleton'}_attempt_${currentAttempt}.${ext === 'jpeg' ? 'jpg' : ext}`;
  const stashAbs = resolve(stashDir, stashFileName);
  const stashRel = `${dirname(cfg.outputPath)}/.attempts/${stashFileName}`;
  copyFileSync(imageValue, stashAbs);

  const userMessage = buildJudgePrompt({
    contextInputs: ctx.inputs,
    imageInputId,
    ...(cfg.criteria ? { criteria: cfg.criteria } : {}),
  });
  const systemPrompt = cfg.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;

  const b64 = readFileSync(imageValue).toString('base64');
  const dataUrl = `data:image/${ext};base64,${b64}`;

  ctx.log(
    `vlm.judge: attempt ${currentAttempt} — judging ${imageValue.split('/').pop()} with ${resolved.model} (threshold=${cfg.passThreshold ?? 0.7})`,
  );

  const client = new OpenAI({ baseURL: resolved.baseUrl, apiKey: resolved.apiKey });
  let raw = '';
  try {
    const completion = await client.chat.completions.create({
      model: resolved.model,
      temperature: 0.1,
      max_tokens: cfg.maxTokens ?? 1200,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userMessage },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    } as never);
    raw = completion.choices[0]?.message?.content ?? '';
  } catch (e) {
    return { ok: false, error: `vlm.judge: VLM call failed: ${(e as Error).message}` };
  }

  const parsed = parseVerdict(raw);
  if ('error' in parsed) {
    return { ok: false, error: `${parsed.error} (raw: ${raw.slice(0, 200)})` };
  }

  const threshold = cfg.passThreshold ?? 0.7;
  const thisAttemptPass = parsed.pass && parsed.score >= threshold;
  const thisAttempt: JudgeAttempt = {
    n: currentAttempt,
    pass: thisAttemptPass,
    score: parsed.score,
    notes: parsed.notes,
    stashPath: stashRel,
    rawResponse: raw,
  };

  const attempts = [...priorAttempts, thisAttempt];
  const best = pickBestAttempt(attempts);

  // If the best is NOT the current attempt, restore the best's
  // stashed image back over the canonical path so downstream nodes
  // (LTX, etc.) consume the best-of-N. If best IS current, canonical
  // already has the right image — no copy needed.
  if (best.n !== currentAttempt) {
    const bestStashAbs = resolve(ctx.projectDir, best.stashPath);
    if (existsSync(bestStashAbs)) {
      copyFileSync(bestStashAbs, imageValue);
      ctx.log(
        `vlm.judge: attempt ${currentAttempt} (score=${parsed.score.toFixed(2)}) scored below best attempt ${best.n} (score=${best.score.toFixed(2)}); restored best image over ${imageValue.split('/').pop()}`,
      );
    } else {
      ctx.log(`vlm.judge: WARNING — best attempt ${best.n} stash missing at ${best.stashPath}; canonical unchanged`);
    }
  }

  const verdict: JudgeVerdict = {
    pass: best.pass,
    score: best.score,
    notes: best.notes,
    rawResponse: raw,
    model: resolved.model,
    currentAttempt,
    bestAttempt: best.n,
    attempts,
  };
  writeFileSync(outAbs, JSON.stringify(verdict, null, 2), 'utf-8');
  ctx.log(
    `vlm.judge: best-of-${attempts.length} → attempt ${best.n} (pass=${best.pass} score=${best.score.toFixed(2)}) ${best.pass ? '✓' : '✗'}`,
  );

  // Stamp critique only when this iteration's attempt failed AND we
  // haven't already found a passing attempt. If best.pass is true,
  // the loop should exit even if this latest attempt was worse —
  // we have a winner, no need to keep retrying.
  const shouldStampCritique = !best.pass;
  if (shouldStampCritique) {
    stampPendingCritique(ctx.projectDir, cfg.refineNode, ctx.itemId, thisAttempt.notes);
    ctx.log(`vlm.judge: stamped pendingCritique[${cfg.refineNode}${ctx.itemId ? `:${ctx.itemId}` : ''}] for review-loop re-walk`);
  }

  return {
    ok: true,
    outputPath: cfg.outputPath,
    metadata: {
      pass: best.pass,
      score: best.score,
      model: resolved.model,
      currentAttempt,
      bestAttempt: best.n,
      totalAttempts: attempts.length,
    },
  };
}

function describe(): RunnerDescription {
  return {
    id: 'vlm.judge',
    displayName: 'VLM judge (review)',
    description:
      'Sends an image artifact to a vision-language model for pass/fail review. On fail, stamps pendingCritiques[refineNode:itemId] so the walker’s review-loop wrapper re-runs the upstream prompt-LLM with the critique. Verdict JSON is written to outputPath for Inspector tile rendering.',
    capabilities: ['review', 'judge', 'quality-gate'],
    modalities: { input: ['image', 'text'], output: ['text'] },
    configSchema: {
      type: 'object',
      required: ['outputPath', 'refineNode'],
      properties: {
        outputPath: { type: 'string' },
        imageInput: { type: 'string', default: 'shot_image' },
        refineNode: { type: 'string' },
        passThreshold: { type: 'number', default: 0.7 },
        criteria: { type: 'string' },
        systemPrompt: { type: 'string' },
        judgeProvider: { type: 'string' },
        judgeApiKey: { type: 'string' },
        judgeModel: { type: 'string' },
        judgeBaseUrl: { type: 'string' },
        maxTokens: { type: 'integer', default: 1200 },
      },
    },
  };
}

export const vlmJudgeRunner: Runner = { run, describe };
