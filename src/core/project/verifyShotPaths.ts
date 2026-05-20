/**
 * Walk every shot slot in project.scenes (and project.finalVideo) and
 * drop references to files that no longer exist on disk. Dropped values
 * are archived to shot.history with reason: 'missing_file' so the user
 * can audit what was lost.
 *
 * Used as the third phase of pnpm backfill-schema:
 *   1. backfillProjectSchema — manifest + executorState
 *   2. backfillFromDisk      — disk-authoritative scan
 *   3. verifyShotPaths       — purge stale paths
 *
 * Pure-ish: reads/writes project.json, no async-local context.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  retireShotSlots,
  type Shot,
  type ShotHistoryEntry,
} from "./projectSchema.js";
import { atomicWriteFileSync } from "../../utils/atomicWrite.js";

export interface VerifyResult {
  dropped: number;
}

const SLOTS: Array<"firstFrame" | "lastFrame" | "midFrame" | "video"> = [
  "firstFrame",
  "lastFrame",
  "midFrame",
  "video",
];

export function verifyShotPaths(basePath: string): VerifyResult {
  const projectPath = join(basePath, "project.json");
  if (!existsSync(projectPath)) {
    throw new Error(`No project.json at ${projectPath}`);
  }
  const project = JSON.parse(readFileSync(projectPath, "utf8")) as Record<string, unknown>;
  let dropped = 0;

  const scenes = (project["scenes"] ?? []) as Array<{ shots: Shot[] }>;
  for (const scene of scenes) {
    for (const shot of scene.shots ?? []) {
      const missing: typeof SLOTS = [];
      for (const slot of SLOTS) {
        const ref = shot[slot] as { path?: string } | undefined;
        if (ref?.path && !existsSync(join(basePath, ref.path))) {
          missing.push(slot);
        }
      }
      if (missing.length > 0) {
        // Archive as 'missing_file' — extends the shot.history reason vocab.
        // Reuse retireShotSlots to keep history-shape consistent, then patch the reason.
        retireShotSlots(shot, missing, "regenerated");
        const last = shot.history?.[shot.history.length - 1];
        if (last) (last as unknown as { reason: string }).reason = "missing_file";
        for (const slot of missing) delete shot[slot];
        dropped += missing.length;
      }
    }
  }

  const finalVideo = project["finalVideo"] as { path?: string } | undefined;
  if (finalVideo?.path && !existsSync(join(basePath, finalVideo.path))) {
    delete project["finalVideo"];
    dropped += 1;
  }

  atomicWriteFileSync(projectPath, JSON.stringify(project, null, 2) + "\n", "utf8");
  return { dropped };
}
