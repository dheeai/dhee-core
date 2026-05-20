/**
 * Phase 2 of the project.json single-source-of-truth refactor.
 *
 * `addAsset` is the only writer for assets/manifest.json. We dual-write
 * the same information into project.json's new scenes/shots/frames
 * tree (defined in src/core/project/projectSchema.ts) so the Storyboard,
 * dhee_show_*, and reset paths can read from one place.
 *
 * One red test per case, implementation follows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addAsset } from "../../src/tasks/video/workflow/ProjectManager.js";
import { setActiveProjectDir } from "../../src/tasks/video/workflow/activeProject.js";

let dir: string;
let basePath: string;
const PROJECT_DIR_NAME = "test.dhee";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dhee-add-asset-"));
  basePath = dir;
  setActiveProjectDir(PROJECT_DIR_NAME);
  const projectRoot = join(basePath, PROJECT_DIR_NAME);
  mkdirSync(join(projectRoot, "assets"), { recursive: true });
  // Minimal project file — just enough for loadProject to succeed.
  writeFileSync(
    join(projectRoot, "project.json"),
    JSON.stringify(
      {
        version: "3.0",
        id: "test",
        title: "Test",
        style: "cinematic_realism",
        targetDuration: 60,
        templateId: "narrative",
        assets: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(projectRoot, "assets", "manifest.json"),
    JSON.stringify({ assets: [] }, null, 2),
    "utf8",
  );
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readProject(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(basePath, PROJECT_DIR_NAME, "project.json"), "utf8"));
}

type SceneOut = {
  sceneNumber: number;
  shots: Array<{
    shotNumber: number;
    firstFrame?: { path: string; createdAt: number };
    lastFrame?: { path: string; createdAt: number };
    midFrame?: { path: string; createdAt: number };
    video?: { path: string; createdAt: number };
    history?: Array<Record<string, unknown>>;
  }>;
};

describe("addAsset dual-write to project.json", () => {
  it("scene_image + first_frame → scenes[].shots[].firstFrame", () => {
    addAsset(
      {
        id: "f1",
        type: "scene_image",
        path: "assets/images/s1shot1_first.png",
        nodeId: "shot_image:scene_1_shot_1",
        frame: "first_frame",
        createdAt: 1000,
      },
      basePath,
    );
    const p = readProject() as { scenes?: SceneOut[] };
    const shot = p.scenes![0]!.shots[0]!;
    expect(shot.firstFrame?.path).toBe("assets/images/s1shot1_first.png");
    expect(shot.firstFrame?.createdAt).toBe(1000);
  });

  it("scene_image + last_frame → scenes[].shots[].lastFrame", () => {
    addAsset(
      {
        id: "l1",
        type: "scene_image",
        path: "assets/images/s2shot3_last.png",
        nodeId: "shot_image:scene_2_shot_3",
        frame: "last_frame",
        createdAt: 2000,
      },
      basePath,
    );
    const p = readProject() as { scenes?: SceneOut[] };
    const scene = p.scenes!.find((s) => s.sceneNumber === 2)!;
    const shot = scene.shots.find((s) => s.shotNumber === 3)!;
    expect(shot.lastFrame?.path).toBe("assets/images/s2shot3_last.png");
  });

  it("scene_image + mid_frame → scenes[].shots[].midFrame", () => {
    addAsset(
      {
        id: "m1",
        type: "scene_image",
        path: "assets/images/s1shot1_mid.png",
        nodeId: "shot_image:scene_1_shot_1",
        frame: "mid_frame",
        createdAt: 1500,
      },
      basePath,
    );
    const p = readProject() as { scenes?: SceneOut[] };
    expect(p.scenes![0]!.shots[0]!.midFrame?.path).toBe("assets/images/s1shot1_mid.png");
  });

  it("two adds for the same shot accumulate first+last on one shot", () => {
    addAsset(
      { id: "f1", type: "scene_image", path: "f.png", nodeId: "shot_image:scene_1_shot_1", frame: "first_frame", createdAt: 1 },
      basePath,
    );
    addAsset(
      { id: "l1", type: "scene_image", path: "l.png", nodeId: "shot_image:scene_1_shot_1", frame: "last_frame", createdAt: 2 },
      basePath,
    );
    const p = readProject() as { scenes?: SceneOut[] };
    expect(p.scenes).toHaveLength(1);
    const shot = p.scenes![0]!.shots[0]!;
    expect(shot.firstFrame?.path).toBe("f.png");
    expect(shot.lastFrame?.path).toBe("l.png");
  });

  it("regenerating a frame archives the previous one to history", () => {
    addAsset(
      { id: "f1", type: "scene_image", path: "v1.png", nodeId: "shot_image:scene_1_shot_1", frame: "first_frame", createdAt: 1 },
      basePath,
    );
    addAsset(
      { id: "f2", type: "scene_image", path: "v2.png", nodeId: "shot_image:scene_1_shot_1", frame: "first_frame", createdAt: 2 },
      basePath,
    );
    const p = readProject() as { scenes?: SceneOut[] };
    const shot = p.scenes![0]!.shots[0]!;
    expect(shot.firstFrame?.path).toBe("v2.png");
    expect(shot.history).toHaveLength(1);
    expect(shot.history![0]).toMatchObject({ reason: "regenerated", firstFrame: { path: "v1.png" } });
  });

  it("scene_video → scenes[].shots[].video", () => {
    addAsset(
      {
        id: "v1",
        type: "scene_video",
        path: "assets/videos/shots/s1shot1.mp4",
        nodeId: "shot_video:scene_1_shot_1",
        createdAt: 3000,
      },
      basePath,
    );
    const p = readProject() as { scenes?: SceneOut[] };
    expect(p.scenes![0]!.shots[0]!.video?.path).toBe("assets/videos/shots/s1shot1.mp4");
  });

  it("final_video → project.finalVideo", () => {
    addAsset(
      {
        id: "fv",
        type: "final_video",
        path: "assets/videos/final/final_video.mp4",
        createdAt: 9000,
      },
      basePath,
    );
    const p = readProject() as { finalVideo?: { path: string; createdAt: number } };
    expect(p.finalVideo?.path).toBe("assets/videos/final/final_video.mp4");
    expect(p.finalVideo?.createdAt).toBe(9000);
  });

  it("character_ref → project.characters[].referenceImage", () => {
    addAsset(
      {
        id: "char_kai",
        type: "character_ref",
        path: "assets/images/CharRef_kai.png",
        nodeId: "character_image:kai",
        createdAt: 500,
      },
      basePath,
    );
    const p = readProject() as { characters?: Array<{ id: string; referenceImage?: { path: string } }> };
    const kai = p.characters?.find((c) => c.id === "kai");
    expect(kai?.referenceImage?.path).toBe("assets/images/CharRef_kai.png");
  });

  it("setting_ref → project.settings[].referenceImage", () => {
    addAsset(
      {
        id: "set_alley",
        type: "setting_ref",
        path: "assets/images/SettingRef_alley.png",
        nodeId: "setting_image:alley",
        createdAt: 600,
      },
      basePath,
    );
    const p = readProject() as { settings?: Array<{ id: string; referenceImage?: { path: string } }> };
    const alley = p.settings?.find((s) => s.id === "alley");
    expect(alley?.referenceImage?.path).toBe("assets/images/SettingRef_alley.png");
  });

  it("ignores entries we don't recognize (no scene/shot/frame info)", () => {
    addAsset(
      {
        id: "loose",
        type: "scene_image",
        path: "assets/images/loose.png",
        // no nodeId, no frame
        createdAt: 100,
      },
      basePath,
    );
    const p = readProject() as { scenes?: SceneOut[] };
    expect(p.scenes ?? []).toEqual([]);
  });

  /**
   * Regression: scene_image assets MUST carry a `frame` field for the
   * dual-write to land. ExecutorAgent.executeShotImage was emitting
   * frame outputs without `frame` (only nodeId), so applyAssetToProjectSchema
   * silently bailed and project.scenes stayed empty even after 60+
   * frames were generated. The Village's symptom: "the side-by-side
   * Prompts tab shows nothing" because scenes[] never populated.
   *
   * This pins the contract: nodeId-but-no-frame is a writer bug. The
   * companion fix is at ExecutorAgent.ts where the addAsset call now
   * passes `frame: frameId` alongside nodeId.
   */
  it("scene_image with nodeId but NO frame → scenes stays empty (the executor's previous bug shape)", () => {
    addAsset(
      {
        id: "missing-frame",
        type: "scene_image",
        path: "assets/images/s1shot1_first_frame_xxx.png",
        nodeId: "shot_image:scene_1_shot_1",
        // frame intentionally omitted — the bug shape
        createdAt: 100,
      },
      basePath,
    );
    const p = readProject() as { scenes?: SceneOut[] };
    expect(p.scenes ?? []).toEqual([]);
  });
});
