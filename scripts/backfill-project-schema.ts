#!/usr/bin/env tsx
/**
 * Phase 5 backfill CLI: reads existing manifest + executorState in a
 * project's <name>.dhee folder and writes the equivalent
 * scenes/shots/frames tree into project.json.
 *
 * Usage:
 *   pnpm backfill-schema <project-name>
 *   pnpm backfill-schema --all     # walk every *.dhee folder in cwd
 */
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { backfillProjectSchema } from "../src/core/project/backfillProjectSchema.js";
import { backfillFromDisk } from "../src/core/project/backfillFromDisk.js";
import { verifyShotPaths } from "../src/core/project/verifyShotPaths.js";

function backfillOne(projectName: string): void {
  const dirName = projectName.endsWith(".dhee") ? projectName : `${projectName}.dhee`;
  const dir = resolve(dirName);
  // Phase A: walk manifest + executorState (cheap, gives history-aware
  // metadata when present).
  const m = backfillProjectSchema(dir);
  // Phase B: disk authoritative scan — overwrites stale paths the manifest
  // carried over from rename/cleanup runs and recovers shots whose only
  // manifest entries point at content-hash files that no longer exist.
  const d = backfillFromDisk(dir);
  // Phase C: drop slots whose paths point at missing files (legacy
  // hash-only entries the disk scan can't recover, etc.). Archived to
  // shot.history with reason: 'missing_file'.
  const v = verifyShotPaths(dir);
  console.log(
    `[${projectName}] manifest: scenes+${m.scenesAdded}, shots+${m.shotsAdded}, frames+${m.framesAdded}, videos+${m.videosAdded}, finalVideo=${m.finalVideoSet}`,
  );
  console.log(
    `[${projectName}] disk:     frames+${d.framesAdded}, videos+${d.videosAdded}, finalVideo=${d.finalVideoSet}`,
  );
  console.log(
    `[${projectName}] verify:   dropped=${v.dropped}`,
  );
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log("Usage: pnpm backfill-schema <project-name>");
    console.log("       pnpm backfill-schema --all");
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  if (args.includes("--all")) {
    const cwd = process.cwd();
    const projects = readdirSync(cwd).filter((name) => {
      if (!name.endsWith(".dhee")) return false;
      try {
        return statSync(join(cwd, name)).isDirectory();
      } catch {
        return false;
      }
    });
    for (const dir of projects) {
      try {
        backfillOne(dir);
      } catch (err) {
        console.error(`  ERROR: ${(err as Error).message}`);
      }
    }
    return;
  }

  for (const arg of args) {
    try {
      backfillOne(arg);
    } catch (err) {
      console.error(`Failed to backfill ${arg}: ${(err as Error).message}`);
      process.exit(1);
    }
  }
}

main();
