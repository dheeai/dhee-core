/**
 * Phase 5 backfill: read an existing project's manifest + executorState
 * and write the equivalent scenes/shots/frames tree into project.json.
 *
 * Idempotent: existing scenes entries aren't overwritten unless the
 * source has newer createdAt info. Safe to run multiple times.
 *
 * Pure-ish: reads/writes project.json + manifest.json under `basePath`,
 * uses no async-local session context.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFileSync } from "../../utils/atomicWrite.js";
import {
  ensureScene,
  ensureShot,
  setShotFrame,
  setShotVideo,
  setFinalVideo,
  type ImageRef,
  type VideoRef,
} from "./projectSchema.js";

interface ManifestEntry {
  id: string;
  type: string;
  path: string;
  scene_number?: number;
  version?: number;
  createdAt: number;
  nodeId?: string;
  frame?: "first_frame" | "last_frame" | "mid_frame";
  metadata?: Record<string, unknown>;
}

interface ExecutorNode {
  id: string;
  typeId: string;
  itemId?: string;
  status?: string;
  outputPath?: string;
  outputPaths?: Record<string, string>;
}

export interface BackfillResult {
  scenesAdded: number;
  shotsAdded: number;
  framesAdded: number;
  videosAdded: number;
  finalVideoSet: boolean;
}

const SHOT_NODE_RE = /^shot_image:scene_(\d+)_shot_(\d+)$/;
const VIDEO_NODE_RE = /^shot_video:scene_(\d+)_shot_(\d+)$/;

const FRAME_FROM_KEY: Record<string, "firstFrame" | "lastFrame" | "midFrame"> = {
  first_frame: "firstFrame",
  last_frame: "lastFrame",
  mid_frame: "midFrame",
};

const FRAME_FROM_ID_RE = /_(first_frame|last_frame|mid_frame)_/;

function frameOf(asset: ManifestEntry): "first_frame" | "last_frame" | "mid_frame" | null {
  if (asset.frame === "first_frame" || asset.frame === "last_frame" || asset.frame === "mid_frame") {
    return asset.frame;
  }
  const m = FRAME_FROM_ID_RE.exec(asset.id);
  return m ? (m[1] as "first_frame" | "last_frame" | "mid_frame") : null;
}

export function backfillProjectSchema(basePath: string): BackfillResult {
  const projectPath = join(basePath, "project.json");
  const manifestPath = join(basePath, "assets", "manifest.json");

  if (!existsSync(projectPath)) {
    throw new Error(`No project.json at ${projectPath}`);
  }

  const project = JSON.parse(readFileSync(projectPath, "utf8")) as Record<string, unknown>;
  const manifest = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, "utf8")) as { assets?: ManifestEntry[] })
    : { assets: [] };

  const before = sceneShotCount(project);
  const result: BackfillResult = {
    scenesAdded: 0,
    shotsAdded: 0,
    framesAdded: 0,
    videosAdded: 0,
    finalVideoSet: false,
  };

  // 1. Pair untagged scene_image entries (legacy: only last_frame got nodeId+frame)
  //    with the next tagged last_frame so the predecessor becomes that shot's first_frame.
  const sceneImages = (manifest.assets ?? [])
    .filter((a) => a.type === "scene_image")
    .slice()
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const inferredFirstFrame = new Map<string, { nodeId: string }>();
  let pendingUntagged: ManifestEntry | null = null;
  for (const a of sceneImages) {
    const frame = frameOf(a);
    if (a.nodeId && frame === "last_frame" && pendingUntagged) {
      inferredFirstFrame.set(pendingUntagged.id, { nodeId: a.nodeId });
      pendingUntagged = null;
    } else if (!a.nodeId && !frame) {
      pendingUntagged = a;
    } else {
      pendingUntagged = null;
    }
  }

  // 2. Walk every manifest entry and apply.
  for (const a of manifest.assets ?? []) {
    if (a.type === "scene_image") {
      const inferred = inferredFirstFrame.get(a.id);
      const nodeId = a.nodeId ?? inferred?.nodeId;
      if (!nodeId) continue;
      const m = SHOT_NODE_RE.exec(nodeId);
      if (!m) continue;
      const sceneNum = parseInt(m[1]!, 10);
      const shotNum = parseInt(m[2]!, 10);
      const explicitFrame = frameOf(a);
      const frameKey = explicitFrame
        ? FRAME_FROM_KEY[explicitFrame]
        : inferred
          ? "firstFrame"
          : undefined;
      if (!frameKey) continue;
      const ref: ImageRef = {
        path: a.path,
        createdAt: a.createdAt,
        ...(a.metadata ? { metadata: a.metadata } : {}),
      };
      setShotFrame(project, sceneNum, shotNum, frameKey, ref);
      result.framesAdded += 1;
    } else if (a.type === "scene_video") {
      const m = a.nodeId ? VIDEO_NODE_RE.exec(a.nodeId) : null;
      if (!m) continue;
      const sceneNum = parseInt(m[1]!, 10);
      const shotNum = parseInt(m[2]!, 10);
      const ref: VideoRef = {
        path: a.path,
        createdAt: a.createdAt,
        ...(a.metadata ? { metadata: a.metadata } : {}),
      };
      setShotVideo(project, sceneNum, shotNum, ref);
      result.videosAdded += 1;
    } else if (a.type === "final_video") {
      setFinalVideo(project, {
        path: a.path,
        createdAt: a.createdAt,
        ...(a.metadata ? { metadata: a.metadata } : {}),
      });
      result.finalVideoSet = true;
    }
  }

  // 3. Backfill from executorState's outputPaths/outputPath for shots that
  //    weren't in the manifest (or to fill in frames that the manifest missed).
  const nodes = (project["executorState"] as { nodes?: Record<string, ExecutorNode> } | undefined)?.nodes ?? {};
  for (const node of Object.values(nodes)) {
    const shotMatch = SHOT_NODE_RE.exec(node.id);
    if (shotMatch) {
      const sceneNum = parseInt(shotMatch[1]!, 10);
      const shotNum = parseInt(shotMatch[2]!, 10);
      ensureShot(project, sceneNum, shotNum);
      const outputs = node.outputPaths ?? {};
      for (const [frame, p] of Object.entries(outputs)) {
        const frameKey = FRAME_FROM_KEY[frame];
        if (!frameKey || !p) continue;
        setShotFrame(project, sceneNum, shotNum, frameKey, {
          path: p,
          createdAt: Date.now(),
        });
        result.framesAdded += 1;
      }
      continue;
    }
    const videoMatch = VIDEO_NODE_RE.exec(node.id);
    if (videoMatch && node.outputPath) {
      const sceneNum = parseInt(videoMatch[1]!, 10);
      const shotNum = parseInt(videoMatch[2]!, 10);
      setShotVideo(project, sceneNum, shotNum, { path: node.outputPath, createdAt: Date.now() });
      result.videosAdded += 1;
    }
  }

  // ensureScene/Shot may have been called above without producing frames —
  // count those too so callers can report empty-shot pre-allocations.
  const after = sceneShotCount(project);
  result.scenesAdded = after.scenes - before.scenes;
  result.shotsAdded = after.shots - before.shots;

  atomicWriteFileSync(projectPath, JSON.stringify(project, null, 2) + "\n", "utf8");
  return result;
}

function sceneShotCount(project: Record<string, unknown>): { scenes: number; shots: number } {
  const scenes = Array.isArray(project["scenes"])
    ? (project["scenes"] as Array<{ shots?: unknown[] }>)
    : [];
  let shotCount = 0;
  for (const s of scenes) shotCount += Array.isArray(s.shots) ? s.shots.length : 0;
  return { scenes: scenes.length, shots: shotCount };
}

// Suppress unused-import warning if the helper isn't needed in a future refactor.
void ensureScene;
