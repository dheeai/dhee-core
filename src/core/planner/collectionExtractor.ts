/**
 * Collection Extractor
 *
 * Makes focused LLM calls to extract collection items from generated content.
 * For example, after generating a story, this extracts character names,
 * setting names, and scene breakdowns — enabling the executor to expand
 * collection nodes into per-item nodes.
 *
 * These are NOT agent calls — they are simple structured-output completions.
 */

import type { LLMClient } from '../llm/index.js';
import type { CollectionItems, ExecutionNode } from './types.js';
import { runDurationFirstExtraction, checkDurationBand } from './durationFirstExtractor.js';
import type { StoryEssence } from './storyEssenceExtractor.js';

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

/**
 * Extract collection items from generated content based on the node type.
 *
 * Returns null if this node type doesn't produce collection items.
 *
 * `essence` (optional) is the editorial intent loaded from
 * `prompts/story_essence.json` — when provided, the duration-first
 * cascade threads it into the hierarchical extractor so Stage A and
 * Stage B both tune their output to the story's genre / throughline.
 * Caller is responsible for loading it; absence is harmless.
 */
export async function extractCollectionItems(
  node: ExecutionNode,
  content: string,
  llm: LLMClient,
  durationSeconds?: number,
  essence?: StoryEssence,
): Promise<CollectionItems | null> {
  switch (node.typeId) {
    case 'story':
      return extractFromStory(content, llm, durationSeconds, essence);
    case 'outline':
      return extractFromOutline(content, llm);
    case 'scene_video_prompt':
      // Parse structured JSON output — no LLM call, no regex needed
      return extractShotsFromJson(content);
    default:
      return null;
  }
}

/**
 * Extract characters, settings, and scene breakdown from a story.
 *
 * 2026-04-26 (duration-first): primary path runs the duration-first
 * extractor (`durationFirstExtractor.ts`) — beats with grounded
 * durations, story-driven scene count, time as guidance.
 *
 * Fallback: if the duration-first path produces zero beats or zero
 * scenes (LLM failure), falls back to the legacy structural extractor
 * with the P0 coverage gate.
 */
async function extractFromStory(
  storyContent: string,
  llm: LLMClient,
  durationSeconds?: number,
  essence?: StoryEssence,
): Promise<CollectionItems> {
  const dur = durationSeconds || 60;

  // Duration-first path.
  try {
    const result = await runDurationFirstExtraction(storyContent, dur, llm, essence);
    if (result.beats.length > 0 && result.scenes.length > 0) {
      const band = checkDurationBand(result.totalEstimatedDuration, dur);
      // Log the band status — telemetry only, we don't block on it since
      // the user explicitly chose time-as-guidance over time-as-cap.
       
      console.log(
        `[duration-first] ${result.beats.length} beats → ${result.scenes.length} scenes, ` +
        `total ~${result.totalEstimatedDuration.toFixed(0)}s (target ${dur}s, ratio ${band.ratio.toFixed(2)}, ${band.status})`,
      );
      return {
        characters: result.characters,
        settings: result.settings,
        objects: result.objects,
        scenes: result.scenes.map(s => ({
          sceneNumber: s.sceneNumber,
          title: s.title,
          summary: s.summary,
          estimatedDuration: s.estimatedDuration,
        })),
      };
    }
    // Fall through to legacy path.
    warnOnce(
      `duration-first-empty:${getLlmLabel(llm)}`,
      `[duration-first] empty beats or scenes; using structural extractor ` +
      `(${getLlmLabel(llm)})`,
    );
  } catch (err) {
    const message = errorMessage(err);
    warnOnce(
      `duration-first:${getLlmLabel(llm)}:${message}`,
      `[duration-first] cascade failed; using structural extractor ` +
      `(${getLlmLabel(llm)}, error=${message})`,
    );
  }

  // Legacy fallback: structural extractor + P0 coverage gate.
  const maxChars = dur <= 30 ? 2 : dur <= 60 ? 3 : dur <= 120 ? 5 : dur <= 180 ? 6 : dur <= 300 ? 8 : 10;
  const maxSettings = dur <= 30 ? 1 : dur <= 60 ? 2 : dur <= 120 ? 3 : dur <= 180 ? 4 : dur <= 300 ? 5 : 7;
  const maxScenes = dur <= 30 ? 2 : dur <= 60 ? 4 : dur <= 120 ? 6 : dur <= 180 ? 8 : dur <= 300 ? 10 : 12;

  const initial = await runStoryExtraction(storyContent, llm, { dur, maxChars, maxSettings, maxScenes });

  if (!initial.scenes || initial.scenes.length === 0 || dur <= 30) {
    return initial;
  }

  const issues = await validateSceneCoverage(storyContent, initial.scenes, llm);
  if (issues.dropped.length === 0 && issues.duplicated.length === 0) {
    return initial;
  }

  const repaired = await runStoryExtraction(storyContent, llm, {
    dur, maxChars, maxSettings, maxScenes,
    coverageFeedback: issues,
    originalScenes: initial.scenes,
  });
  return repaired;
}

interface ExtractionParams {
  dur: number;
  maxChars: number;
  maxSettings: number;
  maxScenes: number;
  coverageFeedback?: SceneCoverageIssues;
  originalScenes?: Array<{ sceneNumber: number; title: string; summary: string }>;
}

async function runStoryExtraction(
  storyContent: string,
  llm: LLMClient,
  params: ExtractionParams,
): Promise<CollectionItems> {
  const { dur, maxChars, maxSettings, maxScenes, coverageFeedback, originalScenes } = params;

  let repairBlock = '';
  if (coverageFeedback && originalScenes) {
    const dropped = coverageFeedback.dropped.length > 0
      ? `\nBEATS DROPPED (must appear somewhere — compress as subtext if needed):\n${coverageFeedback.dropped.map(b => `- ${b}`).join('\n')}`
      : '';
    const duplicated = coverageFeedback.duplicated.length > 0
      ? `\nBEATS DUPLICATED (must appear in ONE scene only):\n${coverageFeedback.duplicated.map(d => `- "${d.beat}" appears in scenes ${d.scenes.join(', ')}`).join('\n')}`
      : '';
    repairBlock = `

REPAIR PASS — PREVIOUS ATTEMPT HAD COVERAGE ISSUES:
${dropped}${duplicated}

PREVIOUS SCENES (regenerate, fixing the issues above):
${originalScenes.map(s => `Scene ${s.sceneNumber}: "${s.title}" — ${s.summary}`).join('\n')}
`;
  }

  const response = await llm.generate({
    messages: [
      {
        role: 'system',
        content: `You are a story-aware scene extraction tool for a ${dur}-second video.

## Step 1 — Beat list (think before you extract)

Internally, list every distinct narrative beat in the source: every action, decision, reveal, location-change, character-introduction, time-jump, and emotional turn. Number them. Do not output this list, but DO use it as the basis for scene assignment.

## Step 2 — Compress every beat into ${maxScenes} scenes

You have a HARD CAP of ${maxScenes} scene slots. The source likely has more beats than slots. Your job is COMPRESSION, not selection:

- **Every beat lands in exactly ONE scene.** No beat may be dropped. No beat may appear in two scenes.
- **Connective beats compress as subtext inside dramatic scenes.** A "secret sponsorship" arc can be one wordless image (a coin pouch on a windowsill) inside the next dramatic scene — not its own scene.
- **Dramatic beats — confrontations, decisions, reveals — get their own scene.** Connective beats — travel, time-pass, mood-shift — do NOT.
- **Dropping = the audience can't follow the next scene.** If a character's later behavior depends on a beat, that beat must be visible (even briefly) earlier.

## Step 3 — Dual-arc threading

For every character who appears in 2+ scenes, their state must change visibly between appearances. If a character was an antagonist in scene 1 and an ally in scene 3, scene 2 must contain at least one image showing their shift — even if the scene is "about" someone else.

## Output

Return a JSON object:
- "characters": unique character names the camera SEES on screen (MAX ${maxChars})
- "settings": distinct locations (MAX ${maxSettings} — consolidate variations of the same place)
- "objects": plot-critical props that need consistent appearance across shots (MAX 5; weapons, documents, distinctive artifacts only — NEVER generic items)
- "scenes": MAX ${maxScenes} scene objects, each a logical dramatic unit covering its assigned beats

## Scene summary requirements (each scene)

Each summary must be 80–150 words and contain ALL of:
1. **Location** — where this scene takes place
2. **Characters present** — and each one's state at scene start vs. scene end (what changes)
3. **Central action** — the dramatic beat this scene exists to deliver
4. **Connective beats compressed inside** — any source beats not dramatic enough for their own scene, named explicitly so downstream writers know to include them as subtext
5. **Setup for next scene** — what state-change carries forward

A summary that just narrates plot ("She does X. Then Y happens.") is wrong. The summary must encode dramatic intent and character state.

## Anti-patterns to avoid

- ❌ Two adjacent scene summaries describing the same location with the same characters doing similar things
- ❌ Summaries shorter than 80 words (too thin to encode character state)
- ❌ "If the story has more than the maximum, select the most important ones" — this is COMPRESSION, never selection. Every source beat must land somewhere.
- ❌ A character state-change between scenes that has no visual setup in the prior scene

Return ONLY valid JSON, no markdown fences, no commentary.

<json_schema>
{
  "characters": ["Character Name"],
  "settings": ["Location Name"],
  "objects": ["Object Name"],
  "scenes": [{ "sceneNumber": 1, "title": "Scene Title", "summary": "80-150 word summary covering all 5 required elements" }]
}
</json_schema>${repairBlock}`,
      },
      {
        role: 'user',
        content: storyContent,
      },
    ],
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.content ?? '{}') as CollectionItems;
    return {
      characters: parsed.characters ?? [],
      settings: parsed.settings ?? [],
      objects: parsed.objects ?? [],
      scenes: parsed.scenes ?? [],
    };
  } catch {
    return { characters: [], settings: [], objects: [], scenes: [] };
  }
}

// ── Coverage gate ─────────────────────────────────────────────────────────────

export interface SceneCoverageIssues {
  /** Source beats not represented in any scene summary */
  dropped: string[];
  /** Beats appearing in two or more scene summaries */
  duplicated: Array<{ beat: string; scenes: number[] }>;
}

/**
 * Audit scene summaries against the source story. Asks the LLM to identify
 * beats that were silently dropped or duplicated across scenes. Caller
 * decides whether to regenerate.
 */
export async function validateSceneCoverage(
  storyContent: string,
  scenes: Array<{ sceneNumber: number; title: string; summary: string }>,
  llm: LLMClient,
): Promise<SceneCoverageIssues> {
  const sceneList = scenes
    .map(s => `Scene ${s.sceneNumber} ("${s.title}"): ${s.summary}`)
    .join('\n\n');

  const response = await llm.generate({
    messages: [
      {
        role: 'system',
        content: `You audit scene summaries against a source story to find coverage gaps.

Return a JSON object with two arrays:
- "dropped": short phrases describing source beats that DO NOT appear (even as compressed subtext) in any scene summary. A beat is "dropped" only if its absence breaks downstream logic — a character's later behavior wouldn't make sense without seeing that beat.
- "duplicated": objects { "beat": "short phrase", "scenes": [N, M] } for beats described in TWO OR MORE scene summaries. Two scenes describing the same physical location with the same characters performing similar actions counts as duplication.

Be strict but pragmatic:
- Connective beats compressed as subtext inside a scene COUNT as covered. Don't flag those.
- "Same beat" means same dramatic unit, not same word — paraphrasing is fine.
- An empty array for either field means no issue of that kind.
- If unsure, prefer to flag — a false positive triggers a regen, a false negative leaves a broken story.

<json_schema>
{
  "dropped": ["short beat description"],
  "duplicated": [{ "beat": "short beat description", "scenes": [3, 4] }]
}
</json_schema>

Return ONLY valid JSON.`,
      },
      {
        role: 'user',
        content: `SOURCE STORY:\n${storyContent}\n\n---\n\nSCENE SUMMARIES:\n${sceneList}`,
      },
    ],
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.content ?? '{}') as Partial<SceneCoverageIssues>;
    return {
      dropped: Array.isArray(parsed.dropped) ? parsed.dropped.filter((b): b is string => typeof b === 'string') : [],
      duplicated: Array.isArray(parsed.duplicated)
        ? parsed.duplicated.filter((d): d is { beat: string; scenes: number[] } =>
            !!d && typeof d.beat === 'string' && Array.isArray(d.scenes) && d.scenes.every(n => typeof n === 'number'))
        : [],
    };
  } catch {
    // If audit itself fails, treat as "no issues" — don't block extraction.
    return { dropped: [], duplicated: [] };
  }
}

/**
 * Extract segments/sources/locations from a documentary outline.
 */
/**
 * Structured JSON shot format from scene_video_prompt output.
 */
interface SceneVideoPromptJson {
  sceneNumber?: number;
  sceneTitle?: string;
  totalDuration?: number;
  shots: Array<{
    shotNumber: number;
    shotType: string;
    duration: number;
    generationStrategy?: string;
    // New format: firstFrame/lastFrame
    firstFrame?: {
      description: string;
      characters?: string[];
      setting?: string | null;
    };
    lastFrame?: {
      description: string;
      characters?: string[];
      setting?: string | null;
    };
    // Legacy format (still supported)
    description?: string;
    cameraWork?: string;
    characters?: string[];
    setting?: string | null;
    soundCue?: string;
  }>;
}

/**
 * Extract shots from a scene_video_prompt's structured JSON output.
 * No LLM call, no regex — direct JSON parse.
 */
function extractShotsFromJson(content: string): CollectionItems {
  try {
    // Strip markdown code fences if the LLM wrapped the JSON
    let cleaned = content.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }
    const parsed = JSON.parse(cleaned) as SceneVideoPromptJson;

    if (!parsed.shots || !Array.isArray(parsed.shots) || parsed.shots.length === 0) {
      return { shots: undefined };
    }

    return {
      shots: parsed.shots.map(s => ({
        shotNumber: s.shotNumber,
        shotType: s.shotType ?? `shot_${s.shotNumber}`,
        duration: s.duration ?? 5,
        // Support both new (firstFrame) and legacy (description) formats
        description: s.firstFrame?.description ?? s.description ?? '',
        cameraWork: s.cameraWork,
        characters: s.firstFrame?.characters ?? s.characters,
        setting: s.firstFrame?.setting ?? s.setting,
      })),
    };
  } catch {
    // If JSON parse fails, try the legacy regex approach as fallback
    return extractShotsFromMarkdownFallback(content);
  }
}

/**
 * Fallback: extract shots from markdown if JSON parse fails.
 * Handles legacy motion prompt files that used markdown format.
 */
function extractShotsFromMarkdownFallback(content: string): CollectionItems {
  const shots: CollectionItems['shots'] = [];
  const shotPattern = /\*\*SHOT\s+(\d+)[:\s]*([^*]*)\*\*/gi;
  let match;

  while ((match = shotPattern.exec(content)) !== null) {
    const shotNumber = parseInt(match[1] ?? '0', 10);
    const shotType = (match[2] ?? '').trim().replace(/^[:\s-]+/, '').toLowerCase();
    shots.push({ shotNumber, shotType: shotType || `shot_${shotNumber}`, duration: 5, description: '' });
  }

  return { shots: shots.length > 0 ? shots : undefined };
}

async function extractFromOutline(
  outlineContent: string,
  llm: LLMClient,
): Promise<CollectionItems> {
  const response = await llm.generate({
    messages: [
      {
        role: 'system',
        content: `You are a precise extraction tool. Extract structured data from the provided documentary outline.

Return a JSON object with exactly these fields:
- "characters": array of source/expert/interviewee names (people featured in the documentary)
- "settings": array of location names (places where filming occurs)
- "scenes": array of segment objects with { "sceneNumber": number, "title": string, "summary": string }

Rules:
- Names should be as they appear in the outline
- Each segment is a distinct chapter/section of the documentary
- Keep summaries under 50 words each
- Return ONLY valid JSON, no markdown fences, no commentary

<json_schema>
{
  "characters": ["Person Name"],
  "settings": ["Location Name"],
  "scenes": [{ "sceneNumber": 1, "title": "Segment Title", "summary": "Brief summary under 50 words" }]
}
</json_schema>`,
      },
      {
        role: 'user',
        content: outlineContent,
      },
    ],
    temperature: 0.1,
    responseFormat: { type: 'json_object' },
  });

  try {
    const parsed = JSON.parse(response.content ?? '{}') as CollectionItems;
    return {
      characters: parsed.characters ?? [],
      settings: parsed.settings ?? [],
      scenes: parsed.scenes ?? [],
    };
  } catch {
    return { characters: [], settings: [], scenes: [] };
  }
}
