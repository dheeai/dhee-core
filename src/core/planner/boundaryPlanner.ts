/**
 * Shot boundary planner — Stage 2 of the scene pipeline.
 *
 * Sits between scene_breakdown (Stage 1, produces the shot list) and
 * shot image generation (Stage 3). One LLM call per scene reasons about
 * the prose-level shot list and emits a per-boundary classification:
 *
 *   shared_frame | reuse_intent | reframe | cut
 *
 * Plus a separate per-shot `needsLfAnchor` flag for shots whose LF must
 * be generated as a video-drift anchor even when the holding-beat skip
 * would otherwise drop it.
 *
 * Decisions are read by:
 *   - `shouldSkipLastFrame` — gates the existing skipHoldingBeatLF
 *     behavior so LFs with downstream consumers stay generated.
 *   - Stage 3 image generation — `shared_frame` boundaries reuse the
 *     prior LF's ImageRef as the next FF; `reuse_intent` chains via
 *     Klein edit; `reframe` and `cut` flow through the existing pipeline.
 *
 * Gated by `project.features.transitionBoundaryPlanner` — default OFF.
 * When OFF, no shot has `incomingTransition` or `needsLfAnchor`, and
 * every downstream consumer (including `shouldSkipLastFrame`) sees the
 * historical behavior unchanged.
 *
 * **Wiring status (Phase 1).** This module ships the planner runner,
 * parser, applier, prompt guide, and the `shouldSkipLastFrame` bridge
 * that integrates with the existing `skipHoldingBeatLF` flag. The
 * orchestration hook — the line in the executor that CALLS
 * `planSceneBoundaries` after `scene_video_prompt` completes and
 * writes the result into `project.scenes[].shots[]` via
 * `applyBoundaryPlanToScene` — is intentionally left to Phase 2.
 * Until that hook lands, enabling the feature flag is a no-op: no
 * shot gets `incomingTransition` / `needsLfAnchor`, and
 * `shouldSkipLastFrame` collapses to historical behavior.
 *
 * Phase 2 entry point in the executor is around the
 * `scene_video_prompt` parse step in `ExecutorAgent.parseSceneBreakdown`
 * — after the shots are extracted, call `planSceneBoundaries` with
 * the LLM client and apply the result to the matching `Scene` in
 * `project.scenes`.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type {
  Scene,
  TransitionDecision,
  TransitionOperation,
} from '../project/projectSchema.js';

const VALID_OPERATIONS: ReadonlySet<TransitionOperation> = new Set<TransitionOperation>([
  'shared_frame',
  'reuse_intent',
  'reframe',
  'cut',
]);

// ── Types ────────────────────────────────────────────────────────────────────

export interface BoundaryTransition {
  /** Shot at the receiving end of this boundary (predecessor is shotNumber - 1). */
  toShotNumber: number;
  operation: TransitionOperation;
  reason?: string;
}

/**
 * Only stored when `needsLfAnchor: true`. Absence on a shot means
 * false — no anchor needed. Mirrors the convention used by
 * skipHoldingBeatLF (presence-as-true).
 */
export interface BoundaryAnchor {
  shotNumber: number;
  needsLfAnchor: true;
  reason?: string;
}

export interface BoundaryPlan {
  transitions: BoundaryTransition[];
  anchors: BoundaryAnchor[];
}

export interface BoundaryPlannerShotInput {
  shotNumber: number;
  description: string;
  purpose: string;
  cameraWork: string;
  dialogue?: string;
  continuityRole?: string;
}

export interface BoundaryPlannerInput {
  sceneNumber: number;
  rasa?: string;
  characters?: string[];
  shots: BoundaryPlannerShotInput[];
}

// ── Feature flag ─────────────────────────────────────────────────────────────

/**
 * Per-project opt-in for the transition boundary planner.
 *
 * Strict-boolean check (mirrors `isSkipHoldingBeatLFEnabled`): a
 * hand-edited `"transitionBoundaryPlanner": "true"` (string) is treated
 * as OFF — never accidentally enable an experimental feature on
 * truthy non-boolean values. The literal `true` opts in.
 *
 * Documented in `docs/feature-flags.md`.
 */
export function isTransitionBoundaryPlannerEnabled(
  project: { features?: { transitionBoundaryPlanner?: boolean } } | undefined | null,
): boolean {
  if (!project || !project.features) return false;
  return project.features.transitionBoundaryPlanner === true;
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse + normalize + validate the planner's LLM output.
 *
 * Forgiving: drops malformed entries rather than throwing. Strict on
 * the structural rules that matter:
 *
 *   - `transitions[]` may only reference shotNumbers from
 *     `validShotNumbers` AND must not target shotNumber 1 (no
 *     predecessor exists inside the scene).
 *   - `operation` must be one of the four enum values.
 *   - Duplicate `toShotNumber` entries → keep first.
 *   - `anchors[]` only stores entries with `needsLfAnchor === true`
 *     (presence-as-true convention).
 *
 * Returns `{ transitions: [], anchors: [] }` on any total parse
 * failure — callers MUST treat empty plan as "skip the planner, run
 * the pipeline as if the flag were off."
 */
export function parseBoundaryPlannerOutput(
  raw: string,
  validShotNumbers: number[],
): BoundaryPlan {
  const empty: BoundaryPlan = { transitions: [], anchors: [] };
  if (!raw || !raw.trim()) return empty;

  let cleaned = raw.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return empty;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;

  const obj = parsed as { transitions?: unknown; anchors?: unknown };
  const validSet = new Set(validShotNumbers);

  const transitions: BoundaryTransition[] = [];
  const seenTo = new Set<number>();
  if (Array.isArray(obj.transitions)) {
    for (const t of obj.transitions) {
      if (!t || typeof t !== 'object') continue;
      const r = t as Record<string, unknown>;
      const toShotNumber = r['toShotNumber'];
      const operation = r['operation'];
      const reason = r['reason'];
      if (typeof toShotNumber !== 'number' || !Number.isInteger(toShotNumber)) continue;
      if (!validSet.has(toShotNumber)) continue;
      if (toShotNumber === 1) continue;
      if (
        typeof operation !== 'string' ||
        !VALID_OPERATIONS.has(operation as TransitionOperation)
      )
        continue;
      if (seenTo.has(toShotNumber)) continue;
      seenTo.add(toShotNumber);
      const entry: BoundaryTransition = {
        toShotNumber,
        operation: operation as TransitionOperation,
      };
      if (typeof reason === 'string' && reason.trim().length > 0) {
        entry.reason = reason.trim();
      }
      transitions.push(entry);
    }
  }

  const anchors: BoundaryAnchor[] = [];
  const seenAnchor = new Set<number>();
  if (Array.isArray(obj.anchors)) {
    for (const a of obj.anchors) {
      if (!a || typeof a !== 'object') continue;
      const r = a as Record<string, unknown>;
      const shotNumber = r['shotNumber'];
      const needsLfAnchor = r['needsLfAnchor'];
      const reason = r['reason'];
      if (typeof shotNumber !== 'number' || !Number.isInteger(shotNumber)) continue;
      if (!validSet.has(shotNumber)) continue;
      if (needsLfAnchor !== true) continue;
      if (seenAnchor.has(shotNumber)) continue;
      seenAnchor.add(shotNumber);
      const entry: BoundaryAnchor = { shotNumber, needsLfAnchor: true };
      if (typeof reason === 'string' && reason.trim().length > 0) {
        entry.reason = reason.trim();
      }
      anchors.push(entry);
    }
  }

  return { transitions, anchors };
}

// ── Application ──────────────────────────────────────────────────────────────

/**
 * Write a parsed plan onto the scene's shots in-place.
 *
 * Idempotent: shots NOT mentioned in the new plan have any stale
 * `incomingTransition` / `needsLfAnchor` cleared. This lets the
 * planner be safely re-run after a scene edit without leaking
 * leftover decisions onto shots whose role changed.
 */
export function applyBoundaryPlanToScene(scene: Scene, plan: BoundaryPlan): void {
  const txByShot = new Map<number, BoundaryTransition>(
    plan.transitions.map((t) => [t.toShotNumber, t]),
  );
  const anByShot = new Map<number, BoundaryAnchor>(
    plan.anchors.map((a) => [a.shotNumber, a]),
  );
  for (const shot of scene.shots) {
    const tx = txByShot.get(shot.shotNumber);
    if (tx) {
      const decision: TransitionDecision = { operation: tx.operation };
      if (tx.reason) decision.reason = tx.reason;
      shot.incomingTransition = decision;
    } else {
      delete shot.incomingTransition;
    }
    const an = anByShot.get(shot.shotNumber);
    if (an) {
      shot.needsLfAnchor = true;
    } else {
      delete shot.needsLfAnchor;
    }
  }
}

// ── Prompt assembly ──────────────────────────────────────────────────────────

function loadGuide(name: string): string {
  const p = join(process.cwd(), 'prompts', 'skills', 'defaults', `${name}.md`);
  if (existsSync(p)) return readFileSync(p, 'utf-8');
  return '';
}

export function buildBoundaryPlannerPrompt(
  input: BoundaryPlannerInput,
): { system: string; user: string } {
  const guide = loadGuide('boundary_planner_guide');
  const system = `You are the shot boundary planner. Output ONLY a JSON object as described in the guide.\n\n${guide}`;

  const lines: string[] = [];
  lines.push(`Scene ${input.sceneNumber}.`);
  if (input.rasa) lines.push(`Rasa: ${input.rasa}.`);
  if (input.characters && input.characters.length > 0) {
    lines.push(`Characters present: ${input.characters.join(', ')}.`);
  }
  lines.push('');
  lines.push('Shots in playback order:');
  for (const s of input.shots) {
    lines.push('');
    lines.push(`Shot ${s.shotNumber}`);
    lines.push(`  description: ${s.description}`);
    lines.push(`  purpose: ${s.purpose}`);
    lines.push(`  cameraWork: ${s.cameraWork}`);
    if (s.dialogue) lines.push(`  dialogue: ${s.dialogue}`);
    if (s.continuityRole) lines.push(`  continuityRole: ${s.continuityRole}`);
  }
  lines.push('');
  lines.push(
    'Output the boundary plan JSON. transitions[] covers shotNumbers 2..N (no transition INTO shot 1). anchors[] lists only shots that need needsLfAnchor: true. JSON only — no prose around it.',
  );
  return { system, user: lines.join('\n') };
}

// ── Orchestrator ─────────────────────────────────────────────────────────────

interface LLMClient {
  generateStream: (
    opts: Record<string, unknown>,
  ) => AsyncGenerator<{ content?: string }, unknown, unknown>;
}

/**
 * Run the planner against an LLM client. Returns an empty plan for
 * single-shot scenes (no boundaries to classify). Falls back from
 * `responseFormat: json_object` to plain mode if the provider rejects
 * it, mirroring `generateShotImagePromptPipeline`'s 405 handling.
 */
export async function planSceneBoundaries(
  llm: LLMClient,
  input: BoundaryPlannerInput,
): Promise<BoundaryPlan> {
  if (input.shots.length < 2) {
    return { transitions: [], anchors: [] };
  }
  const { system, user } = buildBoundaryPlannerPrompt(input);
  const validShotNumbers = input.shots.map((s) => s.shotNumber);

  const options: Record<string, unknown> = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    temperature: 0.2,
    responseFormat: { type: 'json_object' },
  };

  const runOnce = async (): Promise<string> => {
    const chunks: string[] = [];
    for await (const chunk of llm.generateStream(options)) {
      if (chunk.content) chunks.push(chunk.content);
    }
    return chunks.join('');
  };

  let raw = '';
  try {
    raw = await runOnce();
  } catch (err: unknown) {
    const e = err as { code?: number; status?: number };
    const msg = String(err);
    if (e?.code === 405 || e?.status === 405 || msg.includes('not supported')) {
      delete options['responseFormat'];
      raw = await runOnce();
    } else {
      throw err;
    }
  }

  return parseBoundaryPlannerOutput(raw, validShotNumbers);
}
