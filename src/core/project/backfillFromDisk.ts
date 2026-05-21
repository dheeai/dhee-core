/**
 * Disk-walking backfill — recovers project.scenes paths the manifest
 * either lost (rename script renamed files but didn't update entries)
 * or never had (original generations stored under content-hash names).
 *
 * The shot-aware filename grammar is unambiguous:
 *
 *   assets/images/s<N>shot<M>_first_frame_<provider>_<id>.<ext>
 *   assets/images/s<N>shot<M>_last_frame_<provider>_<id>.<ext>
 *   assets/images/s<N>shot<M>_mid_frame_<provider>_<id>.<ext>
 *   assets/videos/shots/s<N>shot<M>_<provider>_<id>.<ext>
 *   assets/videos/final/<anything>.<videoext>
 *
 * Anything that doesn't match is ignored. For each (scene, shot, frame)
 * triple we keep the file with the latest mtime — this matches the
 * "newest generation wins" rule manifest-driven backfill uses with
 * createdAt.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { setShotFrame, setShotVideo, setFinalVideo } from "./projectSchema.js";
import { atomicWriteFileSync } from "../../utils/atomicWrite.js";

const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp)$/i;
const VIDEO_EXT_RE = /\.(mp4|webm|mov)$/i;

const FRAME_RE = /^s(\d+)shot(\d+)_(first_frame|last_frame|mid_frame)_/i;
const SHOT_VIDEO_RE = /^s(\d+)shot(\d+)_/i;

const FRAME_FROM_KEY = {
  first_frame: "firstFrame",
  last_frame: "lastFrame",
  mid_frame: "midFrame",
} as const;

export interface BackfillFromDiskResult {
  framesAdded: number;
  videosAdded: number;
  finalVideoSet: boolean;
}

export function backfillFromDisk(basePath: string): BackfillFromDiskResult {
  const projectPath = join(basePath, "project.json");
  if (!existsSync(projectPath)) {
    throw new Error(`No project.json at ${projectPath}`);
  }
  const project = JSON.parse(readFileSync(projectPath, "utf8")) as Record<string, unknown>;
  const result: BackfillFromDiskResult = { framesAdded: 0, videosAdded: 0, finalVideoSet: false };

  // 1. Frames: scan assets/images/ for shot-aware names.
  const imagesDir = join(basePath, "assets", "images");
  if (existsSync(imagesDir)) {
    type Best = { path: string; mtimeMs: number };
    const best = new Map<string, Best>(); // key: `${scene}/${shot}/${frame}`
    for (const name of readdirSync(imagesDir)) {
      if (!IMAGE_EXT_RE.test(name)) continue;
      const m = FRAME_RE.exec(name);
      if (!m) continue;
      const scene = parseInt(m[1]!, 10);
      const shot = parseInt(m[2]!, 10);
      const frame = m[3]!.toLowerCase() as keyof typeof FRAME_FROM_KEY;
      const key = `${scene}/${shot}/${frame}`;
      const abs = join(imagesDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        continue;
      }
      const prev = best.get(key);
      if (!prev || mtimeMs > prev.mtimeMs) {
        best.set(key, { path: `assets/images/${name}`, mtimeMs });
      }
    }
    for (const [key, entry] of best) {
      const [sceneStr, shotStr, frame] = key.split("/");
      const scene = parseInt(sceneStr!, 10);
      const shot = parseInt(shotStr!, 10);
      const frameKey = FRAME_FROM_KEY[frame as keyof typeof FRAME_FROM_KEY];
      setShotFrame(project, scene, shot, frameKey, {
        path: entry.path,
        createdAt: Math.round(entry.mtimeMs),
      });
      result.framesAdded += 1;
    }
  }

  // 2. Shot videos: scan assets/videos/shots/.
  const shotsDir = join(basePath, "assets", "videos", "shots");
  if (existsSync(shotsDir)) {
    type Best = { path: string; mtimeMs: number };
    const best = new Map<string, Best>();
    for (const name of readdirSync(shotsDir)) {
      if (!VIDEO_EXT_RE.test(name)) continue;
      const m = SHOT_VIDEO_RE.exec(name);
      if (!m) continue;
      const scene = parseInt(m[1]!, 10);
      const shot = parseInt(m[2]!, 10);
      const key = `${scene}/${shot}`;
      const abs = join(shotsDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        continue;
      }
      const prev = best.get(key);
      if (!prev || mtimeMs > prev.mtimeMs) {
        best.set(key, { path: `assets/videos/shots/${name}`, mtimeMs });
      }
    }
    for (const [key, entry] of best) {
      const [sceneStr, shotStr] = key.split("/");
      const scene = parseInt(sceneStr!, 10);
      const shot = parseInt(shotStr!, 10);
      setShotVideo(project, scene, shot, {
        path: entry.path,
        createdAt: Math.round(entry.mtimeMs),
      });
      result.videosAdded += 1;
    }
  }

  // 3. Final video: scan assets/videos/final/, take the newest.
  const finalDir = join(basePath, "assets", "videos", "final");
  if (existsSync(finalDir)) {
    let best: { path: string; mtimeMs: number } | undefined;
    for (const name of readdirSync(finalDir)) {
      if (!VIDEO_EXT_RE.test(name)) continue;
      const abs = join(finalDir, name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(abs).mtimeMs;
      } catch {
        continue;
      }
      if (!best || mtimeMs > best.mtimeMs) {
        best = { path: `assets/videos/final/${name}`, mtimeMs };
      }
    }
    if (best) {
      setFinalVideo(project, { path: best.path, createdAt: Math.round(best.mtimeMs) });
      result.finalVideoSet = true;
    }
  }

  atomicWriteFileSync(projectPath, JSON.stringify(project, null, 2) + "\n", "utf8");
  return result;
}
