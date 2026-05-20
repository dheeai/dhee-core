/**
 * Story essence extractor.
 *
 * One small focused LLM call that reads the source story and emits the
 * editorial intent — genre, throughline, tonal notes, dramatic emphasis,
 * and narration mode. This is the judgment layer that lets every
 * downstream prompt (scene prose, motion directives, shot framings)
 * tune itself to the kind of story we're rendering instead of treating
 * every story like the same generic beat list.
 *
 * Output is small (~300-500 tokens), input is the source story plus
 * the target duration. Wrapped in `withTimeout` so it can never hang
 * the executor.
 */
import type { LLMClient } from '../llm/index.js';
import { withTimeout } from '../llm/withTimeout.js';

export type NarrationMode = 'none' | 'minimal' | 'pervasive';

export interface NarrationConfig {
  /**
   * - `none` — pure scene-and-dialogue suffices.
   * - `minimal` — narration only at scene transitions or for one or two
   *   key exposition beats.
   * - `pervasive` — narrator is a load-bearing voice through much of
   *   the video.
   *
   * The model decides this based on TWO factors:
   *   1. Source structure — does the source carry meaning through
   *      interior thought / didactic narration / retrospective voice
   *      that camera and dialogue can't show?
   *   2. Duration pressure — given the target duration, is the story
   *      too dense to convey through scene-and-dialogue alone? If yes,
   *      narration becomes a compression tool.
   */
  mode: NarrationMode;
  /**
   * One-line description of WHOSE voice and in WHAT register.
   * Examples: "third-person omniscient, somber, parental",
   *           "first-person, retrospective", "the protagonist's interior".
   * Empty string only when `mode === 'none'`.
   */
  voice: string;
}

export interface StoryEssence {
  /** What kind of story this is (e.g. "emotional drama", "sci-fi action",
   * "romance", "erotica", "horror", "comedy"). Free-form so the model can
   * pick the most apt label, but downstream code may match common values
   * for genre-tuned guidance lookups. */
  genre: string;

  /** One-sentence statement of what the viewer should be left feeling
   * after watching. The "why this story matters" — the editorial north
   * star that downstream prose generation aims at. */
  throughline: string;

  /** How the story wants to be told (pacing, register).
   * Examples: "Linger on quiet moments. Let silence carry weight."
   * vs. "Tight cuts, kinetic camera, no breathing room." */
  tonalNotes: string;

  /** What carries the dramatic weight. Examples: "internal conflict,
   * mother-daughter bond" vs. "external survival, escalating threat". */
  dramaticEmphasis: string;

  /** Whether (and how) a narrator's voice carries content the camera
   * and dialogue can't. See NarrationConfig for mode semantics. */
  narration: NarrationConfig;
}

const DEFAULT_TIMEOUT_MS = 90_000;

const NARRATION_MODES: readonly NarrationMode[] = ['none', 'minimal', 'pervasive'];

function buildSystemPrompt(targetDurationSec?: number): string {
  const durationLine = typeof targetDurationSec === 'number' && targetDurationSec > 0
    ? `Target video duration: ${targetDurationSec} seconds. Use this as a key input when picking narration.mode (see below).`
    : 'Target video duration: not specified — pick narration.mode primarily on source structure.';

  return `You read a source story and identify the editorial intent that should guide every downstream cinematic decision.

Stories don't all want to be told the same way. An emotional drama wants quiet moments to breathe. An action thriller wants tight cuts and kinetic camera. An erotica piece wants slow build and sensory specificity. A sci-fi survival story wants escalation and threat.

${durationLine}

Read the source story and emit a focused JSON object capturing the five fields below. Be specific and prescriptive — these notes flow directly into prompts that write scene prose, design camera moves, and pick image framings. Vague essence produces generic video.

Output schema (return ONLY this JSON, no markdown fences):

{
  "genre": "short label like 'emotional drama', 'sci-fi action', 'romance', 'erotica', 'horror', 'comedy', 'literary fiction', etc.",
  "throughline": "one sentence — what should the viewer be LEFT FEELING after the video ends?",
  "tonalNotes": "1-2 sentences on how the story wants to be told — pacing, register, what the camera should do, what the prose should emphasize",
  "dramaticEmphasis": "one sentence on what carries the dramatic weight (internal conflict / external action / character study / atmosphere / sensory texture / etc.)",
  "narration": {
    "mode": "none" | "minimal" | "pervasive",
    "voice": "whose voice and in what register, e.g. 'third-person omniscient, somber, parental' or 'first-person retrospective' — empty string only when mode is 'none'"
  }
}

All five fields are required.

NARRATION DECISION — weigh TWO factors:

1. SOURCE STRUCTURE — does the source carry meaning through interior thought, didactic third-person narration, or retrospective voice that camera and dialogue cannot show? Phrases like "she didn't know that...", "he often thought...", "years later, looking back..." are strong signals for narration.

2. DURATION PRESSURE — given the target duration above, is the story too dense to convey through scene-and-dialogue alone? Narration is a compression tool — it can carry a paragraph of exposition in 4 seconds where a wordless scene would need 30s. A long story compressed to a short video often needs narration to stay legible.

Pick narration.mode:
- "none" — pure scene-and-dialogue suffices: no significant interior content AND duration is generous.
- "minimal" — narration only at scene transitions or for one or two key exposition beats: some interior content OR moderate duration pressure.
- "pervasive" — narrator is a load-bearing voice through much of the video: heavy interior content AND/OR severe duration compression.

When mode is not "none", voice MUST be specific and non-empty — it tells downstream prose generation whose voice to write. When mode is "none", voice should be the empty string.`;
}

/**
 * Thrown when the LLM's response can't be parsed / validated. Carries
 * the `rawContent` so the executor can persist it to a .failed sidecar
 * for the user to inspect / hand-repair.
 */
export class StoryEssenceParseError extends Error {
  rawContent: string;
  constructor(message: string, rawContent: string) {
    super(message);
    this.name = 'StoryEssenceParseError';
    this.rawContent = rawContent;
  }
}

function parseEssenceResponse(raw: string): StoryEssence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new StoryEssenceParseError(
      `story-essence extractor returned invalid JSON: ${(err as Error).message}`,
      raw,
    );
  }
  const obj = parsed as Record<string, unknown>;
  const stringFields: (keyof StoryEssence)[] = ['genre', 'throughline', 'tonalNotes', 'dramaticEmphasis'];
  for (const f of stringFields) {
    if (typeof obj[f] !== 'string' || (obj[f]).trim().length === 0) {
      throw new StoryEssenceParseError(`story-essence response missing required field: ${f}`, raw);
    }
  }
  // Narration is required in fresh extractions (the LLM must think about
  // it). Disk loaders that read pre-narration essence files should default
  // it to mode='none' before passing to this parser.
  const rawNarration = obj['narration'];
  if (!rawNarration || typeof rawNarration !== 'object') {
    throw new StoryEssenceParseError('story-essence response missing required field: narration', raw);
  }
  const nObj = rawNarration as Record<string, unknown>;
  const mode = nObj['mode'];
  const voice = nObj['voice'];
  if (typeof mode !== 'string' || !(NARRATION_MODES as readonly string[]).includes(mode)) {
    throw new StoryEssenceParseError(`story-essence narration.mode must be one of ${NARRATION_MODES.join('/')}, got: ${String(mode)}`, raw);
  }
  if (typeof voice !== 'string') {
    throw new StoryEssenceParseError('story-essence narration.voice must be a string', raw);
  }
  if (mode !== 'none' && voice.trim().length === 0) {
    throw new StoryEssenceParseError(`story-essence narration.voice must be non-empty when narration.mode is "${mode}"`, raw);
  }
  return {
    genre: (obj['genre'] as string).trim(),
    throughline: (obj['throughline'] as string).trim(),
    tonalNotes: (obj['tonalNotes'] as string).trim(),
    dramaticEmphasis: (obj['dramaticEmphasis'] as string).trim(),
    narration: {
      mode: mode as NarrationMode,
      voice: voice.trim(),
    },
  };
}

export interface ExtractStoryEssenceOptions {
  timeoutMs?: number;
  /**
   * Target video duration in seconds. When provided, the prompt instructs
   * the LLM to weigh duration pressure when picking narration.mode.
   * When omitted, narration.mode is picked from source structure alone.
   */
  targetDurationSec?: number;
}

export async function extractStoryEssence(
  storyContent: string,
  llm: LLMClient,
  options: ExtractStoryEssenceOptions = {},
): Promise<StoryEssence> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const systemPrompt = buildSystemPrompt(options.targetDurationSec);
  const response = await withTimeout(
    llm.generate({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `SOURCE STORY:\n${storyContent}` },
      ],
      temperature: 0.2,
      responseFormat: { type: 'json_object' },
    }),
    timeoutMs,
    'story-essence',
  );
  return parseEssenceResponse(response.content ?? '');
}
