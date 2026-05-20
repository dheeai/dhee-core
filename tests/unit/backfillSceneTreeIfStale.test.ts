/**
 * Auto-backfill on project open. Existing projects whose
 * `executorState.nodes` was populated by the executor but whose
 * `project.scenes[]` mirror was never written (the
 * applyAssetToProjectSchema bail described in
 * tests/unit/addAssetDualWrite.test.ts) need a one-time fill so
 * readers can trust scenes[] as the source of truth.
 *
 * `backfillSceneTreeIfStale(basePath)` is the gate:
 *   - executorState empty → no-op (project hasn't run yet)
 *   - scenes already populated → no-op (already healthy or
 *     hand-written by the CLI flow)
 *   - executorState populated AND scenes empty → run
 *     `backfillFromDisk` (walks assets/{images,videos}/ via
 *     filename grammar, populates scenes via projectSchema setters,
 *     writes project.json)
 *
 * Idempotent in the no-op cases — safe to call on every project
 * load. Tested against tmpdirs so disk side effects are contained.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backfillSceneTreeIfStale } from "../../src/core/project/backfillSceneTreeIfStale.js";

let basePath: string;

function writeProject(project: object): void {
  writeFileSync(
    join(basePath, "project.json"),
    JSON.stringify(project, null, 2),
    "utf8",
  );
}

function readProject(): { scenes?: Array<{ sceneNumber: number; shots: Array<{ shotNumber: number; firstFrame?: { path: string } }> }> } {
  return JSON.parse(readFileSync(join(basePath, "project.json"), "utf8"));
}

beforeEach(() => {
  basePath = mkdtempSync(join(tmpdir(), "dhee-backfill-stale-"));
  mkdirSync(join(basePath, "assets", "images"), { recursive: true });
});

afterEach(() => {
  rmSync(basePath, { recursive: true, force: true });
});

describe("backfillSceneTreeIfStale", () => {
  it("no-op when project.json doesn't exist (returns ran=false, no throw)", () => {
    const r = backfillSceneTreeIfStale(basePath);
    expect(r.ran).toBe(false);
  });

  it("no-op when executorState is empty (project hasn't run yet)", () => {
    writeProject({ scenes: [] });
    const r = backfillSceneTreeIfStale(basePath);
    expect(r.ran).toBe(false);
  });

  it("no-op when scenes is already populated (don't clobber)", () => {
    writeProject({
      executorState: {
        nodes: {
          "shot_image:scene_1_shot_1": { outputPath: "assets/images/x.png" },
        },
      },
      scenes: [{ sceneNumber: 1, shots: [{ shotNumber: 1 }] }],
    });
    const r = backfillSceneTreeIfStale(basePath);
    expect(r.ran).toBe(false);
    // scenes preserved, not overwritten
    expect(readProject().scenes).toEqual([
      { sceneNumber: 1, shots: [{ shotNumber: 1 }] },
    ]);
  });

  it("runs backfill when executorState is populated AND scenes is empty", () => {
    // Drop a shot-aware filename so backfillFromDisk can pick it up.
    writeFileSync(
      join(basePath, "assets", "images", "s1shot1_first_frame_klein_xxx.png"),
      "fake",
      "utf8",
    );
    writeProject({
      executorState: {
        nodes: {
          "shot_image:scene_1_shot_1": {
            outputPath: "assets/images/s1shot1_first_frame_klein_xxx.png",
          },
        },
      },
      scenes: [],
    });
    const r = backfillSceneTreeIfStale(basePath);
    expect(r.ran).toBe(true);
    expect(r.framesAdded).toBeGreaterThan(0);
    const proj = readProject();
    expect(proj.scenes?.[0]?.sceneNumber).toBe(1);
    expect(proj.scenes?.[0]?.shots[0]?.shotNumber).toBe(1);
    expect(proj.scenes?.[0]?.shots[0]?.firstFrame?.path).toBe(
      "assets/images/s1shot1_first_frame_klein_xxx.png",
    );
  });

  it("runs backfill even when scenes is missing entirely (not just empty array)", () => {
    writeFileSync(
      join(basePath, "assets", "images", "s1shot1_first_frame_klein_yyy.png"),
      "fake",
      "utf8",
    );
    writeProject({
      executorState: {
        nodes: {
          "shot_image:scene_1_shot_1": {
            outputPath: "assets/images/s1shot1_first_frame_klein_yyy.png",
          },
        },
      },
      // no scenes field at all
    });
    const r = backfillSceneTreeIfStale(basePath);
    expect(r.ran).toBe(true);
  });
});
