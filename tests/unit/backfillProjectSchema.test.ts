/**
 * Phase 5: backfill existing projects' manifest + executorState into the
 * new project.json scenes/shots tree so the new readers (Storyboard,
 * dhee_show_*) work without re-running the pipeline.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { backfillProjectSchema } from "../../src/core/project/backfillProjectSchema.js";

let dir: string;

function readProject(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, "project.json"), "utf8"));
}

function setup(opts: {
  manifest?: Array<Record<string, unknown>>;
  executorNodes?: Record<string, Record<string, unknown>>;
}): void {
  dir = mkdtempSync(join(tmpdir(), "dhee-backfill-"));
  mkdirSync(join(dir, "assets"), { recursive: true });
  writeFileSync(
    join(dir, "project.json"),
    JSON.stringify(
      {
        version: "3.0",
        id: "demo",
        title: "Demo",
        templateId: "narrative",
        assets: [],
        ...(opts.executorNodes
          ? {
              executorState: { nodes: opts.executorNodes, updatedAt: Date.now() },
            }
          : {}),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(dir, "assets", "manifest.json"),
    JSON.stringify({ assets: opts.manifest ?? [] }, null, 2),
  );
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("backfillProjectSchema", () => {
  it("populates scenes[].shots[] from tagged manifest entries", () => {
    setup({
      manifest: [
        {
          id: "f1",
          type: "scene_image",
          path: "assets/images/x.png",
          nodeId: "shot_image:scene_1_shot_1",
          frame: "first_frame",
          createdAt: 100,
        },
        {
          id: "l1",
          type: "scene_image",
          path: "assets/images/y.png",
          nodeId: "shot_image:scene_1_shot_1",
          frame: "last_frame",
          createdAt: 200,
        },
      ],
    });
    const r = backfillProjectSchema(dir);
    expect(r.scenesAdded).toBe(1);
    expect(r.shotsAdded).toBe(1);
    const project = readProject() as {
      scenes: Array<{ sceneNumber: number; shots: Array<{ shotNumber: number; firstFrame?: { path: string }; lastFrame?: { path: string } }> }>;
    };
    expect(project.scenes[0]!.shots[0]!.firstFrame!.path).toBe("assets/images/x.png");
    expect(project.scenes[0]!.shots[0]!.lastFrame!.path).toBe("assets/images/y.png");
  });

  it("backfills shot_video and final_video", () => {
    setup({
      manifest: [
        {
          id: "v1",
          type: "scene_video",
          path: "assets/videos/shots/s1shot1.mp4",
          nodeId: "shot_video:scene_1_shot_1",
          createdAt: 1,
        },
        {
          id: "fv",
          type: "final_video",
          path: "assets/videos/final/final.mp4",
          createdAt: 999,
        },
      ],
    });
    backfillProjectSchema(dir);
    const project = readProject() as {
      scenes: Array<{ shots: Array<{ video?: { path: string } }> }>;
      finalVideo?: { path: string };
    };
    expect(project.scenes[0]!.shots[0]!.video!.path).toBe("assets/videos/shots/s1shot1.mp4");
    expect(project.finalVideo!.path).toBe("assets/videos/final/final.mp4");
  });

  it("infers first_frame for legacy untagged img_xxx entries via temporal pairing with the next tagged last_frame", () => {
    setup({
      manifest: [
        // Untagged: this is shot 1's first frame.
        {
          id: "img_aaa",
          type: "scene_image",
          path: "assets/images/aaa.png",
          createdAt: 100,
        },
        // Tagged last_frame for shot 1 — pair with img_aaa above.
        {
          id: "frame_scene_1_shot_1_last_frame_200",
          type: "scene_image",
          path: "assets/images/bbb.png",
          nodeId: "shot_image:scene_1_shot_1",
          frame: "last_frame",
          createdAt: 200,
        },
        // Untagged: this is shot 2's first frame.
        {
          id: "img_ccc",
          type: "scene_image",
          path: "assets/images/ccc.png",
          createdAt: 300,
        },
        // Tagged last_frame for shot 2.
        {
          id: "frame_scene_1_shot_2_last_frame_400",
          type: "scene_image",
          path: "assets/images/ddd.png",
          nodeId: "shot_image:scene_1_shot_2",
          frame: "last_frame",
          createdAt: 400,
        },
      ],
    });
    backfillProjectSchema(dir);
    const project = readProject() as {
      scenes: Array<{ shots: Array<{ shotNumber: number; firstFrame?: { path: string }; lastFrame?: { path: string } }> }>;
    };
    const shots = project.scenes[0]!.shots;
    const shot1 = shots.find((s) => s.shotNumber === 1)!;
    const shot2 = shots.find((s) => s.shotNumber === 2)!;
    expect(shot1.firstFrame!.path).toBe("assets/images/aaa.png");
    expect(shot1.lastFrame!.path).toBe("assets/images/bbb.png");
    expect(shot2.firstFrame!.path).toBe("assets/images/ccc.png");
    expect(shot2.lastFrame!.path).toBe("assets/images/ddd.png");
  });

  it("backfills from executorState when manifest is sparse", () => {
    setup({
      executorNodes: {
        "shot_image:scene_2_shot_5": {
          id: "shot_image:scene_2_shot_5",
          typeId: "shot_image",
          itemId: "scene_2_shot_5",
          status: "completed",
          outputPaths: {
            first_frame: "assets/images/exec_first.png",
            last_frame: "assets/images/exec_last.png",
          },
        },
      },
    });
    backfillProjectSchema(dir);
    const project = readProject() as {
      scenes: Array<{ sceneNumber: number; shots: Array<{ shotNumber: number; firstFrame?: { path: string }; lastFrame?: { path: string } }> }>;
    };
    const scene = project.scenes.find((s) => s.sceneNumber === 2)!;
    const shot = scene.shots.find((s) => s.shotNumber === 5)!;
    expect(shot.firstFrame!.path).toBe("assets/images/exec_first.png");
    expect(shot.lastFrame!.path).toBe("assets/images/exec_last.png");
  });

  it("returns counts so the caller can report backfill activity", () => {
    setup({
      manifest: [
        {
          id: "f1",
          type: "scene_image",
          path: "x.png",
          nodeId: "shot_image:scene_1_shot_1",
          frame: "first_frame",
          createdAt: 1,
        },
      ],
    });
    const r = backfillProjectSchema(dir);
    expect(r.scenesAdded).toBe(1);
    expect(r.shotsAdded).toBe(1);
    expect(r.framesAdded).toBe(1);
    expect(r.videosAdded).toBe(0);
    expect(r.finalVideoSet).toBe(false);
  });
});
