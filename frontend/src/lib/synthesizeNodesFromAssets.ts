/**
 * Pi-era projects don't ship an executorState in project.json — the
 * executor runs as a subprocess and writes back to assets/manifest.json,
 * not into the project graph. The Storyboard reads from `state.nodes`
 * (an executor-shaped projection), so without a synthesized fallback the
 * panel stays empty even when the project has plenty of generated
 * frames and clips.
 *
 * This helper builds a minimal node map from manifest entries so the
 * Storyboard can render the same shape it always has. Only `scene_image`
 * (per-shot frames) and `scene_video` (per-shot clips) are translated;
 * other types are ignored.
 */
import type { ExecutorNodeInfo } from "./store";

export interface ManifestAsset {
  id: string;
  type: string;
  path: string;
  nodeId?: string;
  /** Some entries have an explicit frame field; otherwise we parse it from id. */
  frame?: string;
  createdAt?: number;
}

const SHOT_NODE_RE = /^shot_image:scene_(\d+)_shot_(\d+)$/;
const VIDEO_NODE_RE = /^shot_video:scene_(\d+)_shot_(\d+)$/;
const FRAME_FROM_ID_RE = /_(first_frame|last_frame|mid_frame)_/;

function frameOf(asset: ManifestAsset): "first_frame" | "last_frame" | "mid_frame" | null {
  if (asset.frame === "first_frame" || asset.frame === "last_frame" || asset.frame === "mid_frame") {
    return asset.frame;
  }
  const m = FRAME_FROM_ID_RE.exec(asset.id);
  if (m) return m[1] as "first_frame" | "last_frame" | "mid_frame";
  return null;
}

export function synthesizeNodesFromAssets(
  assets: ManifestAsset[],
): Record<string, ExecutorNodeInfo> {
  type Acc = ExecutorNodeInfo & {
    /** Per-frame createdAt so we keep the newest path when manifest has dups. */
    _frameTimes?: Record<string, number>;
    _videoTime?: number;
  };
  const nodes: Record<string, Acc> = {};

  const upsert = (id: string, init: () => Acc): Acc => {
    if (!nodes[id]) nodes[id] = init();
    return nodes[id];
  };

  for (const a of assets) {
    if (!a.nodeId) continue;

    if (a.type === "scene_image") {
      const m = SHOT_NODE_RE.exec(a.nodeId);
      if (!m) continue;
      const sceneNum = m[1];
      const shotNum = m[2];
      const frame = frameOf(a);
      if (!frame) continue;
      const node = upsert(a.nodeId, () => ({
        id: a.nodeId!,
        typeId: "shot_image",
        itemId: `scene_${sceneNum}_shot_${shotNum}`,
        displayName: `Scene ${sceneNum} · Shot ${shotNum} image`,
        status: "completed",
        outputPaths: {},
        _frameTimes: {},
      }));
      const t = a.createdAt ?? 0;
      const prev = node._frameTimes?.[frame] ?? -Infinity;
      if (t >= prev) {
        node.outputPaths = { ...(node.outputPaths ?? {}), [frame]: a.path };
        node._frameTimes![frame] = t;
      }
    } else if (a.type === "scene_video") {
      const m = VIDEO_NODE_RE.exec(a.nodeId);
      if (!m) continue;
      const sceneNum = m[1];
      const shotNum = m[2];
      const node = upsert(a.nodeId, () => ({
        id: a.nodeId!,
        typeId: "shot_video",
        itemId: `scene_${sceneNum}_shot_${shotNum}`,
        displayName: `Scene ${sceneNum} · Shot ${shotNum} video`,
        status: "completed",
        _videoTime: -Infinity,
      }));
      const t = a.createdAt ?? 0;
      if (t >= (node._videoTime ?? -Infinity)) {
        node.outputPath = a.path;
        node._videoTime = t;
      }
    }
  }

  // Strip the bookkeeping fields before returning.
  const out: Record<string, ExecutorNodeInfo> = {};
  for (const [id, n] of Object.entries(nodes)) {
    const { _frameTimes, _videoTime, ...rest } = n;
    void _frameTimes;
    void _videoTime;
    out[id] = rest;
  }
  return out;
}

export function todosFromNodes(
  nodes: Record<string, ExecutorNodeInfo>,
): Array<{ id: string; text: string; status: "completed" | "failed" | "in_progress" | "pending" }> {
  return Object.values(nodes)
    .filter((n) => n.displayName && n.typeId !== "final_video")
    .map((n) => ({
      id: n.id,
      text: n.displayName!,
      status:
        n.status === "completed"
          ? ("completed" as const)
          : n.status === "failed"
            ? ("failed" as const)
            : n.status === "in_progress"
              ? ("in_progress" as const)
              : ("pending" as const),
    }));
}
