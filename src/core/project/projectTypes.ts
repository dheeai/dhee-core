/**
 * Shared types and helpers for working with a dhee project's
 * `project.json` and its executor graph. Originally defined in
 * `scripts/cli-helpers.ts`; moved under `src/` so server code can
 * import without violating `rootDir`. The CLI helper module
 * re-exports from here so existing pnpm scripts keep working.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { defaultBasePath } from '../../tasks/video/workflow/projectFileIO.js';

export interface ExecutorState {
  nodes: Record<string, ExecutionNode>;
  completedAt?: number;
  updatedAt?: number;
}

export interface ExecutionNode {
  id: string;
  typeId: string;
  itemId?: string;
  displayName?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  outputPath?: string;
  dependencies: string[];
  dependents?: string[];
  error?: string;
  startedAt?: number;
  completedAt?: number;
  /**
   * Per-node metadata bag. Persisted in project.json. Narrow shape
   * here; the planner's richer `ExecutionNodeMetadata` (see
   * src/core/planner/types.ts) is structurally compatible.
   *
   * `forceUseExistingPrompt` — set by `applyInvalidation` when the
   * caller passes `keepPrompt: true`. Tells the executor's media-node
   * skip-LLM path to read the on-disk prompt file even if upstream
   * deps were re-completed after it (i.e., override `isPromptStale`).
   * Used after the user hand-edits a setting_image / character_image
   * / object_image prompt and only wants the image to regenerate.
   */
  metadata?: Record<string, unknown> & {
    forceUseExistingPrompt?: boolean;
  };
}

/**
 * Per-project opt-in flags. Lives under `project.features` in
 * project.json. New flags should always default to "off" when absent
 * so legacy projects (created before the flag existed) keep their
 * historical behavior. Document each flag in `docs/feature-flags.md`
 * — the central registry — so they're not forgotten.
 */
export interface ProjectFeatures {
  /**
   * Skip-LF for holding-beat shots. When true, the executor strips
   * `frames.last_frame` from shot_image_prompt JSON for shots whose
   * `purpose` is a holding beat (hold_emotion, show_reaction,
   * show_dialogue, show_clue, punctuate, set_the_mood, set_the_world)
   * and whose `cameraWork` lacks any motion verb, then routes the
   * video render to LTX i2v instead of FL2V. Saves one LLM call per
   * matching shot and avoids "mid-action" LF artifacts. Experimental;
   * landed on the skip-lf branch 2026-05-22. Default OFF.
   *
   * Toggle by editing project.json directly or via pi-agent's `edit`
   * tool. Read by `isSkipHoldingBeatLFEnabled` in
   * `src/core/planner/shotImagePipeline.ts`.
   */
  skipHoldingBeatLF?: boolean;
}

export interface ProjectFile {
  version: string;
  id: string;
  title: string;
  originalInputFile?: string;
  style?: string;
  inputType?: string;
  templateId?: string;
  targetDuration?: number;
  currentPhase?: string;
  features?: ProjectFeatures;
  phases?: Record<string, { status: string; completedAt: number | null }>;
  executorState?: ExecutorState;
  [key: string]: unknown;
}

export function projectDirFor(name: string, basePath: string = defaultBasePath()): string {
  const folder = name.endsWith('.dhee') ? name : `${name}.dhee`;
  return join(basePath, folder);
}

/**
 * Pull the target video duration off a project file.
 *
 * Canonical field is `targetDuration` (set by `pnpm new --duration`).
 * Some older code paths read `duration` instead, which silently
 * fell back to the 60s default whenever a project was created with
 * a non-default value (e.g. 120). One shared resolver kills the
 * skew so executor goal preferences match what the user picked.
 *
 * Order of precedence:
 *   1. project.targetDuration  — the canonical, schema-defined field
 *   2. project.duration        — legacy / external callers
 *   3. fallback                — caller's default (60 if omitted)
 *
 * Accepts any object — both `ProjectFile` and `GenericProjectFile`
 * have these fields, but their full types diverge on unrelated
 * fields (`phases.completedAt` shape, etc.) so a structural input
 * keeps both call sites happy.
 */
export function resolveProjectDuration(
  project: object,
  fallback: number = 60,
): number {
  const p = project as Record<string, unknown>;
  const target = p['targetDuration'];
  if (typeof target === 'number' && Number.isFinite(target) && target > 0) return target;
  const legacy = p['duration'];
  if (typeof legacy === 'number' && Number.isFinite(legacy) && legacy > 0) return legacy;
  return fallback;
}

/**
 * Resolve a project name (or full folder name) to its directory and
 * the parsed contents of `project.json`. Returns null when the project
 * doesn't exist; callers decide how to surface that (CLI exits, HTTP
 * returns 404).
 */
export function loadProject(name: string, basePath: string = defaultBasePath()): {
  project: ProjectFile;
  projectDir: string;
} | null {
  const projectDir = projectDirFor(name, basePath);
  const projectJson = join(projectDir, 'project.json');
  if (!existsSync(projectJson)) return null;
  const raw = readFileSync(projectJson, 'utf-8');
  return { project: JSON.parse(raw) as ProjectFile, projectDir };
}

const FRIENDLY_SUFFIX_TO_TYPE: Record<string, string> = {
  '.prompt': 'shot_image_prompt',
  '.shot_image_prompt': 'shot_image_prompt',
  // Order matters: longest suffix first so '.image_last_frame' wins
  // over '.image' before the latter would partial-match.
  '.image_last_frame': 'shot_image_last_frame',
  '.shot_image_last_frame': 'shot_image_last_frame',
  '.image': 'shot_image',
  '.shot_image': 'shot_image',
  '.video': 'shot_video',
  '.shot_video': 'shot_video',
  '.motion': 'shot_motion_directive',
  '.motion_directive': 'shot_motion_directive',
  '.svp': 'scene_video_prompt',
  '.scene_video_prompt': 'scene_video_prompt',
  '.scene': 'scene',
};

/**
 * Resolve a friendly node alias to a full executor node id.
 *
 * Accepts:
 *   "shot_image_prompt:scene_2_shot_3"   verbatim node id
 *   "scene_2_shot_3.prompt"              friendly: aliases ".prompt" → shot_image_prompt
 *   "scene_2_shot_3.image"               friendly: ".image" → shot_image
 *   "scene_2.svp"                        friendly: ".svp" → scene_video_prompt
 *   "elara"                              ambiguous; tries character:elara first
 *
 * Returns null if no matching node is found.
 */
export function resolveNodeId(state: ExecutorState, alias: string): string | null {
  if (state.nodes[alias]) return alias;
  if (alias.includes(':')) return null;

  for (const [suffix, typeId] of Object.entries(FRIENDLY_SUFFIX_TO_TYPE)) {
    if (alias.endsWith(suffix)) {
      const itemId = alias.slice(0, -suffix.length);
      const candidate = `${typeId}:${itemId}`;
      if (state.nodes[candidate]) return candidate;
      return null;
    }
  }

  const fallbackTypes = [
    'character', 'setting', 'object',
    'scene', 'scene_video_prompt',
    'shot_image_prompt', 'shot_motion_directive', 'shot_image', 'shot_video',
  ];
  for (const typeId of fallbackTypes) {
    const candidate = `${typeId}:${alias}`;
    if (state.nodes[candidate]) return candidate;
  }

  return null;
}

/**
 * Find all node ids matching a regex pattern, sorted by typeId then itemId.
 */
export function matchNodes(state: ExecutorState, pattern: RegExp): ExecutionNode[] {
  const matches = Object.values(state.nodes).filter(n => pattern.test(n.id));
  return matches.sort((a, b) => a.id.localeCompare(b.id));
}
