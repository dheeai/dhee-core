/**
 * Duration-first scene extractor.
 *
 * Old model: target duration → derives scene count → forces story into
 * that count. Beats get silently dropped or duplicated when the count
 * doesn't fit the story.
 *
 * New model: story → identify every beat → ground durations in word
 * count and beat-type bands → cluster into the natural number of scenes
 * → validate the total falls inside a sanity band relative to target.
 * Time is guidance, not a hard cap. Scene count is an output.
 */
import type { LLMClient } from '../llm/index.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type BeatKind = 'dialogue' | 'action' | 'atmosphere' | 'reaction' | 'transition';
export type BeatType = 'dramatic' | 'connective';

export interface Beat {
  /** Stable id like "b1", "b2"; assigned by the extractor */
  id: string;
  /** 1-line description of what happens */
  description: string;
  /** Whether this is a load-bearing dramatic beat or connective tissue */
  type: BeatType;
  /** Beat kind drives duration band */
  kind: BeatKind;
  /** Exact dialogue if kind === 'dialogue', otherwise empty */
  dialogue: string;
  /** Speaker name if kind === 'dialogue', otherwise empty */
  speaker: string;
  /** Characters present */
  characters: string[];
  /** Location */
  setting: string;
}

export interface BeatExtraction {
  beats: Beat[];
  characters: string[];
  settings: string[];
  objects: string[];
}

export interface SceneAssignment {
  sceneNumber: number;
  title: string;
  summary: string;
  /** Beats that get their own shot in this scene — sum drives scene duration */
  beatIds: string[];
  /** Connective beats embedded as prose subtext within this scene — referenced
   * in the summary but NOT given their own shot or duration. The cluster
   * step uses this to compress sprawling stories without dropping coverage. */
  embeddedBeatIds?: string[];
}

export interface DurationFirstResult {
  beats: Beat[];
  beatDurations: Map<string, number>;
  scenes: Array<{
    sceneNumber: number;
    title: string;
    summary: string;
    /** Beats that get their own shot — sum of their durations = scene runtime. */
    beatIds: string[];
    /** Beats compressed into the scene summary as subtext — referenced
     * by name in the prose summary but produce NO separate shot and
     * contribute ZERO seconds. Set by the post-stitch compression pass
     * when total runtime exceeds `target + 20s`. */
    embeddedBeatIds?: string[];
    estimatedDuration: number;
  }>;
  characters: string[];
  settings: string[];
  objects: string[];
  totalEstimatedDuration: number;
}

const WARNING_DEDUPE_MS = 30_000;
const recentWarnings = new Map<string, number>();

function getLlmLabel(llm: LLMClient): string {
  const info = (llm as LLMClient & {
    getConnectionInfo?: () => { baseUrl: string; model: string };
  }).getConnectionInfo?.();
  if (!info) return 'llm=unknown';
  return `model=${info.model}, baseUrl=${info.baseUrl}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function warnOnce(key: string, message: string): void {
  const now = Date.now();
  const last = recentWarnings.get(key) ?? 0;
  if (now - last < WARNING_DEDUPE_MS) return;
  recentWarnings.set(key, now);
   
  console.warn(message);
}

// ── Stage B: compute durations (pure, no LLM) ─────────────────────────────────

/**
 * Words-per-second for spoken dialogue. Calibrated empirically and used
 * by the dialogue-fit pass (referenced in scene_breakdown_plan_guide.md).
 */
const WORDS_PER_SECOND = 2.5;
/** Lead-in/tail buffer to avoid cutting off mid-sentence */
const DIALOGUE_BUFFER_SECONDS = 1;
/** LTX 2.3 minimum reliable shot duration */
const MIN_SHOT_DURATION = 3;
/** LTX 2.3 hard ceiling on shot duration */
const MAX_SHOT_DURATION = 15;

/**
 * Default duration (seconds) for non-dialogue beats by kind.
 * Picked from the typed bands proposed in the design discussion:
 *   atmosphere 3–5, action 4–8, reaction 2–4, transition 0–0.5.
 * Using midpoints gives the LLM no room to underestimate.
 */
const NON_DIALOGUE_DURATION: Record<Exclude<BeatKind, 'dialogue'>, number> = {
  atmosphere: 4,
  action: 6,
  reaction: 3,
  transition: 0.5,
};

/**
 * Compute the on-screen duration (seconds) for a single beat.
 *
 * Dialogue: ceil(words/2.5) + 1 buffer, clamped to [3, 15].
 * Non-dialogue: typed-band default for the kind.
 *
 * Pure — no LLM. The LLM is good at identifying what kind a beat is
 * but bad at estimating concrete seconds; we ground duration on
 * deterministic facts (word count) and conservative defaults.
 */
export function computeBeatDuration(beat: Beat): number {
  if (beat.kind === 'dialogue') {
    const words = countWords(beat.dialogue);
    if (words === 0) {
      // Dialogue beat with no words → treat as a short reaction.
      return NON_DIALOGUE_DURATION.reaction;
    }
    const raw = Math.ceil(words / WORDS_PER_SECOND) + DIALOGUE_BUFFER_SECONDS;
    return Math.max(MIN_SHOT_DURATION, Math.min(MAX_SHOT_DURATION, raw));
  }
  return NON_DIALOGUE_DURATION[beat.kind];
}

/**
 * Compute durations for a beat list. Returns a Map from beatId to seconds.
 */
export function computeAllBeatDurations(beats: Beat[]): Map<string, number> {
  const durations = new Map<string, number>();
  for (const beat of beats) {
    durations.set(beat.id, computeBeatDuration(beat));
  }
  return durations;
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(w => w.length > 0).length;
}

// ── Stage D: validation (pure) ────────────────────────────────────────────────

export interface CoverageReport {
  /** beatIds that don't appear in any scene */
  unassigned: string[];
  /** beatIds that appear in 2+ scenes */
  duplicated: string[];
}

/**
 * Verify every beat lands in exactly one scene (counted across `beatIds`
 * and `embeddedBeatIds`). Embedded beats count as covered — they're
 * compressed-as-subtext, not dropped. Pure set arithmetic, no LLM.
 */
export function validateBeatCoverage(
  beats: Beat[],
  scenes: SceneAssignment[],
): CoverageReport {
  const seen = new Map<string, number>();
  for (const scene of scenes) {
    for (const id of scene.beatIds) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    for (const id of scene.embeddedBeatIds ?? []) {
      seen.set(id, (seen.get(id) ?? 0) + 1);
    }
  }
  const allBeatIds = new Set(beats.map(b => b.id));
  const unassigned: string[] = [];
  const duplicated: string[] = [];
  for (const id of allBeatIds) {
    const count = seen.get(id) ?? 0;
    if (count === 0) unassigned.push(id);
    else if (count > 1) duplicated.push(id);
  }
  return { unassigned, duplicated };
}

/**
 * Sanity-band check on total estimated duration vs target.
 *
 * Cap rule: total ≤ target + ABSOLUTE_OVERSHOOT_SECONDS (20 s). The user's
 * stated tolerance: a 60-second target may run 80 s but never 90+; a 120-
 * second target may run 140 s but never 150+. Additive — not ratio.
 *
 * Below target is allowed down to 0.5× — a story that genuinely tells in
 * 30 s for a 60-s target is acceptable; padding it would mean inventing
 * beats which we explicitly forbade.
 *
 * Returns:
 *   - status='ok' when totalEstimated ∈ [0.5×target, target + 20]
 *   - status='thin' when totalEstimated < 0.5×target
 *   - status='sprawling' when totalEstimated > target + 20 by ≤10 s extra (i.e. up to target+30)
 *   - status='off' when totalEstimated > target + 30
 *
 * The 'sprawling' band exists so the repair pass has a clear target
 * (compress to ≤ target + 20 s); 'off' is the hard out-of-bounds beyond
 * which the LLM will likely need a more aggressive instruction.
 */
export type DurationBandStatus = 'ok' | 'thin' | 'sprawling' | 'off';

export interface DurationBandResult {
  status: DurationBandStatus;
  ratio: number;
  totalEstimated: number;
  target: number;
  /** Absolute upper bound: target + 20 s. */
  hardCeiling: number;
}

const ABSOLUTE_OVERSHOOT_SECONDS = 20;

export function checkDurationBand(
  totalEstimated: number,
  target: number,
): DurationBandResult {
  const ratio = target > 0 ? totalEstimated / target : 0;
  const hardCeiling = target + ABSOLUTE_OVERSHOOT_SECONDS;
  let status: DurationBandStatus;
  if (ratio < 0.5) status = 'thin';
  else if (totalEstimated <= hardCeiling) status = 'ok';
  else if (totalEstimated <= hardCeiling + 10) status = 'sprawling';
  else status = 'off';
  return { status, ratio, totalEstimated, target, hardCeiling };
}

// ── Stage A: extract beats from story (LLM call) ──────────────────────────────

export async function extractBeats(
  storyContent: string,
  llm: LLMClient,
): Promise<BeatExtraction> {
  const response = await llm.generate({
    messages: [
      {
        role: 'system',
        content: `You extract a complete beat list from a source story for downstream cinematic adaptation.

A "beat" is one indivisible narrative unit: a single dialogue exchange, one physical action, one location-establishing shot, one reaction, one transition. Every action, decision, reveal, location-change, character-introduction, time-jump, and emotional turn in the source is a beat. Do not skip beats; do not merge two beats into one. Connective beats (a character travels, time passes, mood shifts) get their own beat object — they will be compressed downstream as subtext, not dropped here.

For each beat, output:

- "id": "b1", "b2", ... (sequential)
- "description": one sentence describing what happens
- "type": "dramatic" (load-bearing — confrontation, decision, reveal) or "connective" (transition, travel, time-pass, mood)
- "kind": one of:
    "dialogue" — characters speak with on-screen audio
    "action" — physical action without dialogue (running, fighting, fleeing)
    "atmosphere" — establishing/setting/mood, no character action
    "reaction" — silent emotional response on a face
    "transition" — time-pass / location-change / fade / cut
- "dialogue": exact spoken words verbatim from source if kind="dialogue", otherwise ""
- "speaker": name of the speaker if kind="dialogue", otherwise ""
- "characters": list of character names physically present in this beat (use proper names from the source)
- "setting": short location label ("kitchen", "town square", "wilderness hut") — consistent across beats in the same place

Also emit:
- "characters": deduplicated list of all named characters across beats (only those who appear on screen)
- "settings": deduplicated list of distinct locations
- "objects": plot-critical props that need consistent appearance across shots (weapons, documents, distinctive artifacts; NEVER generic items like "cup", "chair")

Rules:
- Capture EVERY beat. The downstream stage will compress connective beats into subtext, not drop them.
- For dialogue beats, dialogue must be the exact source words. If the source paraphrases ("She refused him"), emit kind="reaction" with dialogue="" — do NOT invent words.
- Setting names must be consistent: same location → same label across beats.
- characters[] in each beat is who's on screen for THAT beat, not who's mentioned.

Return ONLY valid JSON, no markdown fences.

<json_schema>
{
  "beats": [
    {
      "id": "b1",
      "description": "Elara refuses the betrothal at the family table.",
      "type": "dramatic",
      "kind": "dialogue",
      "dialogue": "I will not be sold like livestock.",
      "speaker": "Elara",
      "characters": ["Elara", "Father"],
      "setting": "family cottage"
    }
  ],
  "characters": ["Elara", "Father"],
  "settings": ["family cottage"],
  "objects": []
}
</json_schema>`,
      },
      { role: 'user', content: storyContent },
    ],
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
  });

  return parseBeatExtraction(response.content ?? '');
}

export function parseBeatExtraction(rawJson: string): BeatExtraction {
  try {
    const parsed = JSON.parse(rawJson) as Partial<BeatExtraction>;
    const beats = Array.isArray(parsed.beats) ? parsed.beats.filter(isValidBeat) : [];
    return {
      beats,
      characters: Array.isArray(parsed.characters)
        ? parsed.characters.filter((c): c is string => typeof c === 'string')
        : [],
      settings: Array.isArray(parsed.settings)
        ? parsed.settings.filter((s): s is string => typeof s === 'string')
        : [],
      objects: Array.isArray(parsed.objects)
        ? parsed.objects.filter((o): o is string => typeof o === 'string')
        : [],
    };
  } catch {
    return { beats: [], characters: [], settings: [], objects: [] };
  }
}

function isValidBeat(b: unknown): b is Beat {
  if (!b || typeof b !== 'object') return false;
  const x = b as Record<string, unknown>;
  return (
    typeof x['id'] === 'string' &&
    typeof x['description'] === 'string' &&
    (x['type'] === 'dramatic' || x['type'] === 'connective') &&
    (x['kind'] === 'dialogue' || x['kind'] === 'action' || x['kind'] === 'atmosphere' || x['kind'] === 'reaction' || x['kind'] === 'transition') &&
    typeof x['dialogue'] === 'string' &&
    typeof x['speaker'] === 'string' &&
    Array.isArray(x['characters']) &&
    typeof x['setting'] === 'string'
  );
}

// ── Stage C: cluster beats into scenes (LLM call) ─────────────────────────────

export async function clusterBeatsIntoScenes(
  storyContent: string,
  beats: Beat[],
  beatDurations: Map<string, number>,
  targetDuration: number,
  llm: LLMClient,
  options?: { maxScenes?: number; feedback?: string },
): Promise<SceneAssignment[]> {
  const maxScenes = options?.maxScenes ?? 12;
  const beatTable = beats
    .map(b => {
      const dur = beatDurations.get(b.id) ?? 0;
      const dialogueNote = b.kind === 'dialogue' ? ` "${b.dialogue.slice(0, 60)}..."` : '';
      return `  ${b.id} [${dur}s, ${b.type}/${b.kind}, @${b.setting}]: ${b.description}${dialogueNote}`;
    })
    .join('\n');

  const totalEstimated = [...beatDurations.values()].reduce((s, d) => s + d, 0);

  const feedbackBlock = options?.feedback
    ? `\n\nADJUSTMENT FEEDBACK FROM PREVIOUS PASS:\n${options.feedback}\n`
    : '';

  const response = await llm.generate({
    messages: [
      {
        role: 'system',
        content: `You group narrative beats into scenes for a cinematic short.

You are given:
- A target duration as GUIDANCE (not a strict cap): ${targetDuration} seconds.
- A list of beats with their grounded on-screen durations.
- Total beat duration: ${totalEstimated.toFixed(1)} seconds.

Your job: group these beats into scenes. Decide how many scenes — driven by the story's natural breaks, not the target duration. Minimum 1, maximum ${maxScenes}.

Rules:
1. Every beat must land in EXACTLY one scene — either as a full beat (shows up as its own shot) OR as an embedded beat (mentioned in the scene's prose but NOT given its own shot). No beat dropped, no beat duplicated.
2. Use \`beatIds\` for full beats (each gets its own shot, contributes its duration to the scene). Use \`embeddedBeatIds\` for connective beats compressed as subtext — they appear as a prop, glance, or one-line reference inside the scene's prose with NO separate duration.
3. Dramatic beats (type='dramatic') should generally be full beats. Connective beats (type='connective') are good candidates to embed when you need to compress — but embed only when the beat genuinely fits as subtext inside its parent scene.
4. Beats in one scene should share a contiguous narrative unit: same location and/or contiguous in time. A scene change = location change OR time jump OR major dramatic shift.
5. Order beats within a scene as they appear in the source.
6. Each scene's duration is the sum of its full-beat durations — you don't choose, you inherit.
7. Time is GUIDANCE: if the story naturally tells in 80s for a 60s target, output 80s. If it tells in 45s for a 60s target, output 45s. Don't pad and don't truncate.
8. Scene summaries must be 80–150 words and contain:
   - Location
   - Characters present and their state-change in this scene
   - The central dramatic action
   - Any embedded beats named explicitly so the downstream writer knows to include them as subtext (a glance, a prop, one-line reference)
   - What's set up for the next scene

Anti-patterns to avoid:
- ❌ Two adjacent scenes with the same location and similar action (you've split a single scene into two — merge)
- ❌ A scene with only connective beats (connective beats compress INTO dramatic scenes, never their own scene)
- ❌ A scene whose summary doesn't reference its connective beats (downstream writer won't include them)

Return JSON. Use the exact beatId strings from the input. Do not invent IDs.

<json_schema>
{
  "scenes": [
    {
      "sceneNumber": 1,
      "title": "Refusal and Flight",
      "summary": "80–150 word summary covering location, characters + state-change, central action, embedded beats by name, setup for next scene",
      "beatIds": ["b1", "b2", "b3"],
      "embeddedBeatIds": ["b4"]
    }
  ]
}
</json_schema>${feedbackBlock}`,
      },
      {
        role: 'user',
        content: `SOURCE STORY (for context):\n${storyContent}\n\n---\n\nBEATS WITH DURATIONS:\n${beatTable}`,
      },
    ],
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
  });

  return parseSceneAssignments(response.content ?? '');
}

export function parseSceneAssignments(rawJson: string): SceneAssignment[] {
  try {
    const parsed = JSON.parse(rawJson) as { scenes?: unknown[] };
    if (!Array.isArray(parsed.scenes)) return [];
    return parsed.scenes.filter(isValidSceneAssignment);
  } catch {
    return [];
  }
}

function isValidSceneAssignment(s: unknown): s is SceneAssignment {
  if (!s || typeof s !== 'object') return false;
  const x = s as Record<string, unknown>;
  if (
    typeof x['sceneNumber'] !== 'number' ||
    typeof x['title'] !== 'string' ||
    typeof x['summary'] !== 'string' ||
    !Array.isArray(x['beatIds']) ||
    !x['beatIds'].every(id => typeof id === 'string')
  ) return false;
  // embeddedBeatIds is optional; if present must be string[]
  if (x['embeddedBeatIds'] !== undefined) {
    if (!Array.isArray(x['embeddedBeatIds'])) return false;
    if (!x['embeddedBeatIds'].every(id => typeof id === 'string')) return false;
  }
  return true;
}

// ── Top-level: orchestrate stages A–D ─────────────────────────────────────────

/**
 * End-to-end duration-first scene extraction.
 *
 * Two-tier cascade:
 *   1. Try the **hierarchical extractor** (`runHierarchicalExtraction`).
 *      One small Stage A call produces scene summaries; N parallel
 *      Stage B calls each produce one scene's beats with the full story
 *      as context. Each call has a per-call timeout, so a single hung
 *      response can't stall the executor the way today's giant cluster
 *      call does.
 *   2. If hierarchical throws (timeout, parse failure, retry exhausted),
 *      fall back to the **legacy single-call flow** (extractBeats →
 *      clusterBeatsIntoScenes → coverage/sprawling repair). Same shape
 *      out, so callers don't notice the cascade.
 *
 * If even legacy fails, the error propagates to `extractFromStory`
 * (`collectionExtractor.ts`), which has its own fallback to a third-tier
 * legacy structural extractor.
 */
export async function runDurationFirstExtraction(
  storyContent: string,
  targetDuration: number,
  llm: LLMClient,
  essence?: import('./storyEssenceExtractor.js').StoryEssence,
): Promise<DurationFirstResult> {
  try {
    const { runHierarchicalExtraction } = await import('./hierarchicalSceneExtractor.js');
    return await runHierarchicalExtraction(storyContent, targetDuration, llm, { essence });
  } catch (err) {
    const message = errorMessage(err);
    warnOnce(
      `hierarchical:${getLlmLabel(llm)}:${message}`,
      `[duration-first] hierarchical extractor failed; trying legacy duration-first ` +
      `(${getLlmLabel(llm)}, error=${message})`,
    );
    return runLegacyDurationFirst(storyContent, targetDuration, llm);
  }
}

/**
 * Legacy duration-first flow:
 *   A. extractBeats — single LLM call lists every beat (can produce
 *      90+ beats / 12k tokens for long stories)
 *   B. computeAllBeatDurations — pure code
 *   C. clusterBeatsIntoScenes — single LLM call groups beats; this is
 *      the call that hangs on long stories with the heavy-tier model
 *   D. validateBeatCoverage / sprawling repair — up to two more cluster
 *      calls if coverage / runtime is off
 *
 * Kept as the second-tier fallback. Callers should normally hit the
 * hierarchical path in `runDurationFirstExtraction`.
 */
export async function runLegacyDurationFirst(
  storyContent: string,
  targetDuration: number,
  llm: LLMClient,
): Promise<DurationFirstResult> {
  // Stage A
  const extraction = await extractBeats(storyContent, llm);
  const beats = extraction.beats;

  // Early exit if beat extraction produced nothing — caller falls back
  // to the legacy extractor. Saves a wasted cluster LLM call.
  if (beats.length === 0) {
    return {
      beats: [],
      beatDurations: new Map(),
      scenes: [],
      characters: extraction.characters,
      settings: extraction.settings,
      objects: extraction.objects,
      totalEstimatedDuration: 0,
    };
  }

  // Stage B
  const beatDurations = computeAllBeatDurations(beats);

  // Stage C — initial cluster
  let scenes = await clusterBeatsIntoScenes(storyContent, beats, beatDurations, targetDuration, llm);

  // Stage D — coverage validation (covers beatIds + embeddedBeatIds)
  const coverage = validateBeatCoverage(beats, scenes);
  if (coverage.unassigned.length > 0 || coverage.duplicated.length > 0) {
    const feedback = buildCoverageFeedback(coverage, beats);
    scenes = await clusterBeatsIntoScenes(storyContent, beats, beatDurations, targetDuration, llm, {
      feedback,
    });
  }

  // Stage E — sprawling repair. If the total runtime is way over target
  // ('sprawling' = 1.5–2.0×, 'off' = >2.0×), tell the LLM to compress
  // by moving connective beats from beatIds to embeddedBeatIds. We do
  // NOT drop coverage — every beat must still appear in beatIds or
  // embeddedBeatIds across the scenes, just rebalanced.
  const totalAfterCluster = scenes.reduce(
    (sum, s) => sum + s.beatIds.reduce((a, id) => a + (beatDurations.get(id) ?? 0), 0),
    0,
  );
  const initialBand = checkDurationBand(totalAfterCluster, targetDuration);
  // Repair when total exceeds the hard ceiling (target + 20s). Too-thin
  // stories get accepted as-is (the user said time is guidance; padding
  // a thin story would mean inventing beats which we explicitly forbade).
  if (totalAfterCluster > initialBand.hardCeiling) {
    const compressionFeedback =
      `OVERSHOOT — current total ${totalAfterCluster.toFixed(0)}s, ` +
      `target ${targetDuration}s, hard ceiling ${initialBand.hardCeiling}s. ` +
      `You MUST compress the total to ≤ ${initialBand.hardCeiling}s ` +
      `(${ABSOLUTE_OVERSHOOT_SECONDS}s overshoot is the absolute upper limit). ` +
      `Compress by moving connective beats (type='connective') from beatIds to ` +
      `embeddedBeatIds. Embedded beats are referenced in the scene's prose summary ` +
      `but produce no separate shot and contribute ZERO duration to the total. ` +
      `Keep all dramatic beats in beatIds. Every beat must still appear somewhere — ` +
      `beatIds OR embeddedBeatIds — across the scenes. ` +
      `If even moving every connective beat to embeddedBeatIds doesn't fit, also ` +
      `embed dialogue beats whose lines are short reactions (≤5 words) — these can ` +
      `be conveyed as a glance or single-line callout in the scene's prose.`;
    scenes = await clusterBeatsIntoScenes(storyContent, beats, beatDurations, targetDuration, llm, {
      feedback: compressionFeedback,
    });
  }

  // Compute totals (with possibly-repaired scenes)
  const sceneRows = scenes.map(s => {
    const estimatedDuration = s.beatIds.reduce(
      (sum, id) => sum + (beatDurations.get(id) ?? 0),
      0,
    );
    return { ...s, estimatedDuration };
  });
  const totalEstimated = sceneRows.reduce((sum, s) => sum + s.estimatedDuration, 0);

  return {
    beats,
    beatDurations,
    scenes: sceneRows,
    characters: extraction.characters,
    settings: extraction.settings,
    objects: extraction.objects,
    totalEstimatedDuration: totalEstimated,
  };
}

function buildCoverageFeedback(coverage: CoverageReport, beats: Beat[]): string {
  const beatLookup = new Map(beats.map(b => [b.id, b]));
  const lines: string[] = [];
  if (coverage.unassigned.length > 0) {
    lines.push('UNASSIGNED beats (must each land in exactly one scene):');
    for (const id of coverage.unassigned) {
      const b = beatLookup.get(id);
      lines.push(`  - ${id}: ${b?.description ?? '(unknown)'}`);
    }
  }
  if (coverage.duplicated.length > 0) {
    lines.push('DUPLICATED beats (each must appear in EXACTLY one scene, not multiple):');
    for (const id of coverage.duplicated) {
      const b = beatLookup.get(id);
      lines.push(`  - ${id}: ${b?.description ?? '(unknown)'}`);
    }
  }
  return lines.join('\n');
}
