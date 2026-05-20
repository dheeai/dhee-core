/**
 * Phase 1 of the project.json refactor (see todos / chat history).
 *
 * Goal: project.json is the single source of truth for a project's
 * scenes → shots → frames / videos. Today the same data is split across
 * `executorState.nodes[*].outputPath(s)` (mutable graph state) and
 * `assets/manifest.json` (append-only ledger). Both have failure modes:
 *
 *   - executorState is missing in pi-era projects → Storyboard empty
 *   - manifest writers are inconsistent (last_frame tagged, first_frame not)
 *
 * The new shape lives at `project.scenes[]` and is denormalized for
 * read access: every consumer (Storyboard, dhee_show_*, reset) walks
 * one tree instead of cross-referencing two stores.
 *
 * Phase 1 (this file): types + pure helpers. No writer or reader is
 * wired yet — that's phases 2/3. Existing projects continue to work
 * unchanged because `scenes` is optional.
 */

/**
 * A single generated file (image or video) on disk.
 *
 * `path` is relative to `<project>.dhee/`, identical to what the
 * manifest stores today, so the same `/api/v1/assets/<project>/<path>`
 * URL keeps working.
 */
export interface AssetRef {
  path: string;
  createdAt: number;
  jobId?: string;
  provider?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface ImageRef extends AssetRef {
  width?: number;
  height?: number;
}

export interface VideoRef extends AssetRef {
  durationSec?: number;
  width?: number;
  height?: number;
}

/**
 * A single shot. Holds the *current* artifact for each slot —
 * earlier generations are pushed onto `history` in retirement order.
 */
export interface Shot {
  /** 1-based shot number within its scene. */
  shotNumber: number;
  description?: string;
  /** The shot_image_prompt the current frames were rendered from. */
  prompt?: string;
  /** The motion directive the current video was rendered from. */
  motionDirective?: string;
  firstFrame?: ImageRef;
  lastFrame?: ImageRef;
  midFrame?: ImageRef;
  video?: VideoRef;
  /** Earlier generations of any of the above, oldest → newest. */
  history?: ShotHistoryEntry[];
}

export interface ShotHistoryEntry {
  /** When this slot was replaced or cleared. */
  retiredAt: number;
  /**
   * - `regenerated`: a fresh generation overwrote it
   * - `reset`: a stage reset cleared it
   */
  reason: "regenerated" | "reset";
  /** Whichever fields were retired in this transition. */
  prompt?: string;
  motionDirective?: string;
  firstFrame?: ImageRef;
  lastFrame?: ImageRef;
  midFrame?: ImageRef;
  video?: VideoRef;
}

export interface Scene {
  /** 1-based scene number. */
  sceneNumber: number;
  title?: string;
  description?: string;
  /** Optional reference into project.settings[].id. */
  settingId?: string;
  /** Shots in playback order. */
  shots: Shot[];
}

export interface CharacterEntry {
  id: string;
  name: string;
  description?: string;
  referenceImage?: ImageRef;
}

export interface SettingEntry {
  id: string;
  name: string;
  description?: string;
  referenceImage?: ImageRef;
}

/**
 * The slice this module owns inside `project.json`.
 *
 * It's added as optional fields to whatever existing project shape the
 * codebase passes around — the helpers below treat it as a union and
 * never overwrite unrelated keys.
 */
export interface ProjectSchemaV3 {
  schemaVersion?: 3;
  scenes?: Scene[];
  characters?: CharacterEntry[];
  settings?: SettingEntry[];
  /** Final assembled video. Same shape as a shot's video field. */
  finalVideo?: VideoRef;
}

// =============================================================================
// Pure helpers — read first, then mutators. Everything operates on a
// project object treated as opaque except for these fields.
// =============================================================================

type ProjectLike = Record<string, unknown> & ProjectSchemaV3;

/** Snapshot of the scenes array — empty array if not yet populated. */
export function getScenes(project: ProjectLike): Scene[] {
  return Array.isArray(project.scenes) ? project.scenes : [];
}

export function findScene(project: ProjectLike, sceneNumber: number): Scene | undefined {
  return getScenes(project).find((s) => s.sceneNumber === sceneNumber);
}

export function findShot(
  project: ProjectLike,
  sceneNumber: number,
  shotNumber: number,
): Shot | undefined {
  return findScene(project, sceneNumber)?.shots.find((sh) => sh.shotNumber === shotNumber);
}

/**
 * Get the scene if it exists, or insert a new one in sorted position.
 * Caller mutates the returned reference.
 */
export function ensureScene(project: ProjectLike, sceneNumber: number): Scene {
  if (!Array.isArray(project.scenes)) project.scenes = [];
  let scene = project.scenes.find((s) => s.sceneNumber === sceneNumber);
  if (!scene) {
    scene = { sceneNumber, shots: [] };
    project.scenes.push(scene);
    project.scenes.sort((a, b) => a.sceneNumber - b.sceneNumber);
  }
  return scene;
}

export function ensureShot(
  project: ProjectLike,
  sceneNumber: number,
  shotNumber: number,
): Shot {
  const scene = ensureScene(project, sceneNumber);
  let shot = scene.shots.find((sh) => sh.shotNumber === shotNumber);
  if (!shot) {
    shot = { shotNumber };
    scene.shots.push(shot);
    scene.shots.sort((a, b) => a.shotNumber - b.shotNumber);
  }
  return shot;
}

/**
 * Push the current value of one of the regenerable shot slots onto
 * the shot's history before overwriting it. Pass only the fields you're
 * about to replace; whichever existing values are present get retired.
 *
 * Returns true if anything was pushed (i.e. there was something to retire).
 */
export function retireShotSlots(
  shot: Shot,
  fields: Array<"prompt" | "motionDirective" | "firstFrame" | "lastFrame" | "midFrame" | "video">,
  reason: "regenerated" | "reset",
  retiredAt: number = Date.now(),
): boolean {
  const entry: ShotHistoryEntry = { retiredAt, reason };
  let any = false;
  for (const field of fields) {
    const current = shot[field];
    if (current !== undefined) {
      // Type-narrowed assignment via index signature.
      (entry as unknown as Record<string, unknown>)[field] = current;
      any = true;
    }
  }
  if (!any) return false;
  if (!shot.history) shot.history = [];
  shot.history.push(entry);
  return true;
}

/**
 * Update a shot's first/last/mid-frame, archiving the previous value if any.
 * Reason is "regenerated" — use clearShotSlots for "reset".
 */
export function setShotFrame(
  project: ProjectLike,
  sceneNumber: number,
  shotNumber: number,
  frame: "firstFrame" | "lastFrame" | "midFrame",
  ref: ImageRef,
): void {
  const shot = ensureShot(project, sceneNumber, shotNumber);
  retireShotSlots(shot, [frame], "regenerated");
  shot[frame] = ref;
}

export function setShotVideo(
  project: ProjectLike,
  sceneNumber: number,
  shotNumber: number,
  ref: VideoRef,
): void {
  const shot = ensureShot(project, sceneNumber, shotNumber);
  retireShotSlots(shot, ["video"], "regenerated");
  shot.video = ref;
}

export function setShotPrompt(
  project: ProjectLike,
  sceneNumber: number,
  shotNumber: number,
  prompt: string,
): void {
  const shot = ensureShot(project, sceneNumber, shotNumber);
  retireShotSlots(shot, ["prompt"], "regenerated");
  shot.prompt = prompt;
}

export function setShotMotionDirective(
  project: ProjectLike,
  sceneNumber: number,
  shotNumber: number,
  motionDirective: string,
): void {
  const shot = ensureShot(project, sceneNumber, shotNumber);
  retireShotSlots(shot, ["motionDirective"], "regenerated");
  shot.motionDirective = motionDirective;
}

/**
 * Clear the named slots on a shot, archiving them as "reset". Used by
 * the surgical reset path in phase 4 — e.g. resetting `shot_image`
 * clears firstFrame/lastFrame/midFrame on every affected shot.
 */
export function clearShotSlots(
  shot: Shot,
  fields: Array<"prompt" | "motionDirective" | "firstFrame" | "lastFrame" | "midFrame" | "video">,
): boolean {
  const retired = retireShotSlots(shot, fields, "reset");
  for (const field of fields) {
    delete shot[field];
  }
  return retired;
}

export function setFinalVideo(project: ProjectLike, video: VideoRef | undefined): void {
  if (video === undefined) {
    delete project.finalVideo;
  } else {
    project.finalVideo = video;
  }
}

/** Idempotent — sets schemaVersion: 3 if not already set. */
export function ensureSchemaVersion(project: ProjectLike): void {
  if (project.schemaVersion === undefined) project.schemaVersion = 3;
}
