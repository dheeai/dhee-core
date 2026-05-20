/**
 * One-time, idempotent backfill of `project.scenes[]` when the
 * `executorState.nodes` source-of-truth has been populated by the
 * executor but the denormalized scenes-tree mirror is empty.
 *
 * Why we need this: until the companion fix in ExecutorAgent's
 * frame-emission path (passing `frame: frameId` to `addAsset`),
 * `applyAssetToProjectSchema` silently bailed on every shot frame,
 * so projects that ran end-to-end still have empty `scenes[]`.
 * Readers (PromptsView's two-column layout, dhee_show_first_frame's
 * happy path, etc.) all need scenes[] to be populated. This helper
 * runs `backfillFromDisk` once when the gap is detected so existing
 * projects come up correctly without manual intervention.
 *
 * Gating logic:
 *   - No project.json on disk → ran=false (caller's bug if they
 *     pass a non-project dir)
 *   - executorState.nodes empty → ran=false (project hasn't run
 *     yet — nothing to backfill from)
 *   - scenes already populated → ran=false (don't clobber a
 *     correctly-written tree)
 *   - executorState.nodes populated AND scenes empty/missing →
 *     run `backfillFromDisk`
 *
 * Idempotent: subsequent calls hit the "scenes populated" branch
 * and return ran=false. Safe to invoke on every project load.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { backfillFromDisk } from "./backfillFromDisk.js";

export interface BackfillIfStaleResult {
  /** True when backfillFromDisk was invoked. */
  ran: boolean;
  /** Number of frame entries added (only when ran=true). */
  framesAdded?: number;
  /** Number of shot videos added (only when ran=true). */
  videosAdded?: number;
  /** Whether project.finalVideo was set (only when ran=true). */
  finalVideoSet?: boolean;
  /** Diagnostic when ran=false: which gate fired. */
  reason?: string;
}

export function backfillSceneTreeIfStale(
  basePath: string,
): BackfillIfStaleResult {
  const projectPath = join(basePath, "project.json");
  if (!existsSync(projectPath)) {
    return { ran: false, reason: "no project.json at basePath" };
  }
  let project: { executorState?: { nodes?: Record<string, unknown> }; scenes?: unknown[] };
  try {
    project = JSON.parse(readFileSync(projectPath, "utf8"));
  } catch {
    return { ran: false, reason: "project.json unparseable" };
  }
  const nodesPopulated =
    Object.keys(project.executorState?.nodes ?? {}).length > 0;
  const scenesPopulated =
    Array.isArray(project.scenes) && project.scenes.length > 0;
  if (!nodesPopulated) return { ran: false, reason: "executorState empty" };
  if (scenesPopulated) {
    return { ran: false, reason: "scenes already populated" };
  }
  const result = backfillFromDisk(basePath);
  return { ran: true, ...result };
}
