/**
 * Cross-shot chaining utilities.
 *
 * When the LLM chooses `edit_previous_shot` as generationMode for a shot's
 * first frame, the executor uses the previous shot's last frame as the base
 * image for editing, maintaining visual continuity between consecutive shots.
 */

import type { ExecutionNode } from './types.js';

/**
 * Given a shot itemId like "scene_1_shot_3", return the previous shot's
 * itemId ("scene_1_shot_2"). Returns null for the first shot in a scene.
 */
export function getPreviousShotId(itemId: string): string | null {
  const match = itemId.match(/^(scene_\d+_shot_)(\d+)$/);
  if (!match) return null;

  const shotNum = parseInt(match[2]!, 10);
  if (shotNum <= 1) return null;

  return `${match[1]}${shotNum - 1}`;
}

/**
 * Like `getPreviousShotId`, but crosses scene boundaries (Layer C2).
 *
 * For shot 1 of scene N (N>1), returns the highest-numbered completed
 * shot_image itemId in scene N-1 — so the first shot of a new scene can
 * chain its first_frame on the previous scene's last completed shot's
 * last_frame. Pre-Layer-C2 behaviour was to start fresh at every scene
 * boundary, which broke the user's "exits door A → enters door B" rule.
 *
 * Returns null for scene 1 shot 1, or when the prior scene has no
 * completed shot_image nodes.
 */
export function getPreviousShotIdAcrossScenes(
  itemId: string,
  executor: { getAllNodes: () => ExecutionNode[] },
): string | null {
  // Same-scene predecessor first (preserve existing behaviour for shot 2+).
  const sameScene = getPreviousShotId(itemId);
  if (sameScene) return sameScene;

  const sceneMatch = itemId.match(/^scene_(\d+)_shot_1$/);
  if (!sceneMatch) return null;
  const sceneNum = parseInt(sceneMatch[1]!, 10);
  if (sceneNum <= 1) return null;

  const prevSceneId = `scene_${sceneNum - 1}`;
  const candidates = executor.getAllNodes()
    .filter(n => n.typeId === 'shot_image'
      && n.status === 'completed'
      && typeof n.itemId === 'string'
      && n.itemId.startsWith(`${prevSceneId}_shot_`))
    .map(n => ({
      itemId: n.itemId as string,
      shotNum: parseInt((n.itemId as string).match(/shot_(\d+)$/)?.[1] ?? '0', 10),
    }))
    .sort((a, b) => b.shotNum - a.shotNum);

  return candidates[0]?.itemId ?? null;
}

/**
 * Get the last frame image path from a completed shot_image node.
 *
 * Strict rules (Bug 8a / Bug 11 fix):
 * - If `outputPaths` exists at all, only `outputPaths['last_frame']` counts.
 *   When `outputPaths['last_frame']` is missing, returns null — callers must
 *   handle the absent-last-frame case explicitly (e.g. demote
 *   reuse_prior_frame to edit_previous_shot, or fall through to fresh).
 * - Only when `outputPaths` is entirely undefined (true single-frame mode,
 *   the node never tracked multi-frame outputs) do we fall back to
 *   `outputPath`.
 *
 * Returns null if the node isn't completed or has no usable last-frame output.
 */
export function getLastFramePath(node: ExecutionNode): string | null {
  if (node.status !== 'completed') return null;

  // Multi-frame mode: outputPaths is the source of truth. Never silently
  // fall back to outputPath, which would copy the first frame as if it were
  // the last frame (the silent-wrong-frame bug from Ruby V3 / prompt_relay).
  if (node.outputPaths !== undefined) {
    return node.outputPaths['last_frame'] ?? null;
  }

  // Single-frame mode: no outputPaths tracking → outputPath is the only
  // frame this node produced, and treating it as the last frame is correct.
  if (node.outputPath) {
    return node.outputPath;
  }

  return null;
}

/**
 * Filter out shots whose content is already included in a v2v_extend successor.
 *
 * When shot N+1 is v2v_extend, its output video already contains shot N's frames.
 * Including both in assembly would duplicate content. This function walks the
 * segment list and marks predecessors of v2v_extend shots as "subsumed."
 *
 * For chains (S1→S2:v2v→S3:v2v), only S3 survives — it contains all prior frames.
 */
export function filterSubsumedShots<T extends { segmentId: string; strategy?: string }>(
  segments: T[],
): T[] {
  if (segments.length === 0) return [];

  // Walk backwards: if segment[i] is v2v_extend, mark segment[i-1] as subsumed
  const subsumed = new Set<number>();
  for (let i = segments.length - 1; i > 0; i--) {
    if (segments[i]!.strategy === 'v2v_extend') {
      subsumed.add(i - 1);
    }
  }

  return segments.filter((_, i) => !subsumed.has(i));
}

/**
 * Determine video generation strategy for a shot.
 *
 * Per locked scope (Layer B1, /Users/ganaraj/.claude/plans/...): no
 * FRESH_PURPOSES carve-out. Mid-scene shots always extend from the prior
 * shot regardless of purpose — within a scene we only allow camera-angle
 * changes and following the character, never a fresh location image.
 *
 * - Shot 1 of ANY scene → 'flfv' (scene boundary — fresh framing)
 * - Everything else     → 'v2v_extend' (continue from previous shot's video)
 */
export function getVideoStrategy(itemId: string, _purpose: string): 'flfv' | 'v2v_extend' {
  // First shot of any scene → scene boundary, start fresh
  const shotMatch = itemId.match(/^scene_(\d+)_shot_(\d+)$/);
  if (shotMatch && shotMatch[2] === '1') return 'flfv';

  // Everything else: extend from previous video
  return 'v2v_extend';
}

/**
 * Find the previous shot's video output path.
 * Looks within the same scene first, then crosses to the previous scene's last shot.
 * Returns null for shot 1 of scene 1.
 */
export function getPreviousVideoPath(
  itemId: string,
  executor: { getNode: (id: string) => ExecutionNode | undefined; getAllNodes: () => ExecutionNode[] },
): string | null {
  // Try previous shot within same scene
  const prevShotId = getPreviousShotId(itemId);
  if (prevShotId) {
    const prevVideoNode = executor.getNode(`shot_video:${prevShotId}`);
    if (prevVideoNode?.status === 'completed' && prevVideoNode.outputPath) {
      return prevVideoNode.outputPath;
    }
    return null;
  }

  // First shot in scene → look at previous scene's last shot
  const sceneMatch = itemId.match(/^scene_(\d+)_shot_1$/);
  if (!sceneMatch) return null;

  const sceneNum = parseInt(sceneMatch[1]!, 10);
  if (sceneNum <= 1) return null; // Scene 1 shot 1 — no previous

  const prevSceneId = `scene_${sceneNum - 1}`;

  // Find all shot_video nodes for the previous scene, get the highest shot number
  const prevSceneVideos = executor.getAllNodes()
    .filter(n => n.typeId === 'shot_video' && n.itemId?.startsWith(`${prevSceneId}_shot_`) && n.status === 'completed')
    .sort((a, b) => {
      const aNum = parseInt(a.itemId?.match(/shot_(\d+)/)?.[1] ?? '0', 10);
      const bNum = parseInt(b.itemId?.match(/shot_(\d+)/)?.[1] ?? '0', 10);
      return bNum - aNum; // Descending — highest first
    });

  if (prevSceneVideos.length > 0) {
    const lastVideo = prevSceneVideos[0]!;
    const videoNode = executor.getNode(lastVideo.id);
    if (videoNode?.outputPath) return videoNode.outputPath;
  }

  return null;
}
