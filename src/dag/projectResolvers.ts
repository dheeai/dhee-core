/**
 * Project artifact resolvers — translates dhee project conventions
 * (scene_N.json layout, s{N}shot{M}_first_frame_*.png naming) into the
 * pure data that runners consume.
 *
 * Keeps the runners themselves project-layout-agnostic. If the project
 * layout changes, only this module updates.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface ShotPlan {
  shotNumber: number;
  duration: number;
  purpose?: string;
  description?: string;
  cameraWork?: string;
  audio?: string;
}

export interface ScenePlan {
  sceneNumber?: number;
  sceneTitle?: string;
  totalDuration?: number;
  shots: ShotPlan[];
}

export interface ResolvedRelayInputs {
  shots: ShotPlan[];
  firstFrames: string[];
  globalPrompt: string;
  sceneTitle?: string;
}

interface ManifestAsset {
  type?: string;
  path: string;
  createdAt?: number;
}

interface ProjectManifest {
  assets?: ManifestAsset[];
}

interface ProjectJson {
  style?: string;
  title?: string;
}

/** Read the project's style from project.json, falling back to 'cinematic'. */
export function readProjectStyle(projectDir: string): string {
  try {
    const pj = JSON.parse(readFileSync(join(projectDir, 'project.json'), 'utf-8')) as ProjectJson;
    return pj.style ?? 'cinematic';
  } catch {
    return 'cinematic';
  }
}

/** Load a scene's plan JSON. */
export function loadScenePlan(projectDir: string, sceneNumber: number): ScenePlan {
  const scenePath = join(projectDir, `prompts/videos/scenes/scene_${sceneNumber}.json`);
  if (!existsSync(scenePath)) {
    throw new Error(`Scene plan not found: ${scenePath}`);
  }
  return JSON.parse(readFileSync(scenePath, 'utf-8')) as ScenePlan;
}

/**
 * Pick the most recent first-frame image for a specific scene + shot.
 * Prefers the project manifest (typed `scene_image`) but falls back to
 * the assets/images/ directory sorted by mtime.
 */
export function pickFirstFrame(projectDir: string, sceneNum: number, shotNum: number): string {
  const imagesDir = join(projectDir, 'assets/images');
  const manifestPath = join(projectDir, 'assets/manifest.json');
  const manifest: ProjectManifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as ProjectManifest)
    : { assets: [] };

  const re = new RegExp(`/s${sceneNum}shot${shotNum}_first_frame_[^/]+\\.png$`);
  const fromManifest = (manifest.assets ?? [])
    .filter((a) => a.type === 'scene_image' && re.test(a.path))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  if (fromManifest.length > 0) {
    return join(projectDir, fromManifest[0]!.path);
  }

  if (!existsSync(imagesDir)) {
    throw new Error(`No first-frame found for s${sceneNum}shot${shotNum} (assets/images/ missing)`);
  }
  const onDisk = readdirSync(imagesDir)
    .filter((f) => new RegExp(`^s${sceneNum}shot${shotNum}_first_frame_`).test(f) && f.endsWith('.png'))
    .map((f) => ({ f, mtime: statSync(join(imagesDir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (onDisk.length === 0) {
    throw new Error(`No first_frame on disk for s${sceneNum}shot${shotNum}`);
  }
  return join(imagesDir, onDisk[0]!.f);
}

/**
 * Resolve all inputs needed by the LTX director runner for a contiguous
 * range of shots in a single scene. Reads scene plan + project style
 * from disk and picks first-frame images.
 */
export function resolveRelayInputs(
  projectDir: string,
  sceneNumber: number,
  shotRange: [number, number],
): ResolvedRelayInputs {
  const style = readProjectStyle(projectDir);
  const plan = loadScenePlan(projectDir, sceneNumber);

  const [startShot, endShot] = shotRange;
  const selected = plan.shots.filter((s) => s.shotNumber >= startShot && s.shotNumber <= endShot);
  if (selected.length === 0) {
    throw new Error(`No shots in range ${startShot}..${endShot} for scene ${sceneNumber}`);
  }
  if (selected.length !== endShot - startShot + 1) {
    throw new Error(
      `Expected ${endShot - startShot + 1} contiguous shots in ${startShot}..${endShot}, got ${selected.length}`,
    );
  }

  const firstFrames = selected.map((s) => pickFirstFrame(projectDir, sceneNumber, s.shotNumber));

  const globalPrompt =
    `${style} style. Cinematic continuity across shots, consistent character identity and lighting.` +
    (plan.sceneTitle ? ` Scene: ${plan.sceneTitle}.` : '');

  return {
    shots: selected,
    firstFrames,
    globalPrompt,
    ...(plan.sceneTitle !== undefined && { sceneTitle: plan.sceneTitle }),
  };
}

// ---------------------------------------------------------------------------
// Frame-cap chunking
// ---------------------------------------------------------------------------

export interface ShotChunk {
  startShot: number;
  endShot: number;
  /** Aligned frame count (matches what the LTX runner will compute). */
  frames: number;
}

/** Check whether a shot has a first-frame image available (manifest or disk). */
export function shotHasFirstFrame(projectDir: string, sceneNum: number, shotNum: number): boolean {
  try {
    pickFirstFrame(projectDir, sceneNum, shotNum);
    return true;
  } catch {
    return false;
  }
}

/**
 * Greedily pack a scene's shots into contiguous chunks whose
 * LTX-aligned total frames stay under a per-chunk cap.
 *
 * Two architectural constraints handled here:
 *
 *   1. **Frame cap** — chunks must stay under the runner's hard limit
 *      (e.g. 1000 frames for LTX 2.3). The bundle declares the cap;
 *      this function enforces it.
 *
 *   2. **Upstream gaps** — if a shot is missing its first-frame asset,
 *      the relay can't anchor that segment. Treat it as a chunk
 *      boundary: the chunk ending before the gap closes, and a new
 *      chunk starts after the gap. Missing shots are skipped (their
 *      narrative beat is dropped from the output). This makes the
 *      architecture robust to partially-rendered upstream projects.
 *
 * Alignment rules (matching alignToLTX in comfyLtxDirector.ts):
 *   - Each shot's frames = max(8, round(durationSec * fps / 8) * 8)
 *   - The FIRST shot of each chunk gets +1 frame (so chunk total
 *     satisfies (frames - 1) % 8 === 0)
 *
 * Returns one chunk per render the runner will execute. The bundle's
 * walker creates one NodeInstance per chunk.
 */
export function chunkScene(
  projectDir: string,
  sceneNumber: number,
  cap: number,
  fps: number,
  firstSegmentPlusOne = true,
): ShotChunk[] {
  const plan = loadScenePlan(projectDir, sceneNumber);
  if (plan.shots.length === 0) return [];

  const alignShot = (durSec: number): number =>
    Math.max(8, Math.round((durSec * fps) / 8) * 8);

  const chunks: ShotChunk[] = [];
  let currentStart: number | null = null;
  let currentFrames = 0;
  let currentEnd = 0;
  let firstInChunk = true;

  const flushCurrent = (): void => {
    if (currentStart !== null && currentFrames > 0) {
      chunks.push({ startShot: currentStart, endShot: currentEnd, frames: currentFrames });
    }
    currentStart = null;
    currentFrames = 0;
    firstInChunk = true;
  };

  for (const shot of plan.shots) {
    // Upstream gap → close current chunk, skip this shot.
    if (!shotHasFirstFrame(projectDir, sceneNumber, shot.shotNumber)) {
      flushCurrent();
      continue;
    }

    const shotFrames = alignShot(shot.duration);
    const wouldAdd = shotFrames + (firstInChunk && firstSegmentPlusOne ? 1 : 0);

    if (currentStart === null) {
      // Starting a new chunk.
      currentStart = shot.shotNumber;
      currentEnd = shot.shotNumber;
      currentFrames = wouldAdd;
      firstInChunk = false;
      continue;
    }

    // Non-contiguous shot numbers also break a chunk (e.g. shot 5 → 7
    // because 6 was dropped above). The flushCurrent already happened
    // for the gap, so this branch only triggers when the chunker
    // resets currentStart=null. Defensive check anyway:
    if (shot.shotNumber !== currentEnd + 1) {
      flushCurrent();
      currentStart = shot.shotNumber;
      currentEnd = shot.shotNumber;
      currentFrames = shotFrames + (firstSegmentPlusOne ? 1 : 0);
      firstInChunk = false;
      continue;
    }

    if (currentFrames + wouldAdd > cap) {
      // Frame cap → close and open new chunk.
      flushCurrent();
      currentStart = shot.shotNumber;
      currentEnd = shot.shotNumber;
      currentFrames = shotFrames + (firstSegmentPlusOne ? 1 : 0);
      firstInChunk = false;
    } else {
      currentFrames += wouldAdd;
      currentEnd = shot.shotNumber;
      firstInChunk = false;
    }
  }
  flushCurrent();
  return chunks;
}
