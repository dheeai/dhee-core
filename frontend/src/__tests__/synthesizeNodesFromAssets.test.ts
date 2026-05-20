import { describe, it, expect } from "vitest";
import {
  synthesizeNodesFromAssets,
  todosFromNodes,
  type ManifestAsset,
} from "../lib/synthesizeNodesFromAssets";

const baseImage = (
  scene: number,
  shot: number,
  frame: "first_frame" | "last_frame" | "mid_frame",
  path: string,
  createdAt: number,
): ManifestAsset => ({
  id: `frame_scene_${scene}_shot_${shot}_${frame}_${createdAt}`,
  type: "scene_image",
  path,
  nodeId: `shot_image:scene_${scene}_shot_${shot}`,
  createdAt,
});

const baseVideo = (scene: number, shot: number, path: string, createdAt: number): ManifestAsset => ({
  id: `vid_scene_${scene}_shot_${shot}_${createdAt}`,
  type: "scene_video",
  path,
  nodeId: `shot_video:scene_${scene}_shot_${shot}`,
  createdAt,
});

describe("synthesizeNodesFromAssets", () => {
  it("groups frames into a single shot_image node per shot", () => {
    const nodes = synthesizeNodesFromAssets([
      baseImage(1, 1, "first_frame", "assets/images/A.png", 100),
      baseImage(1, 1, "last_frame", "assets/images/B.png", 200),
    ]);
    expect(Object.keys(nodes)).toEqual(["shot_image:scene_1_shot_1"]);
    const n = nodes["shot_image:scene_1_shot_1"];
    expect(n.typeId).toBe("shot_image");
    expect(n.itemId).toBe("scene_1_shot_1");
    expect(n.outputPaths).toEqual({
      first_frame: "assets/images/A.png",
      last_frame: "assets/images/B.png",
    });
    expect(n.status).toBe("completed");
  });

  it("keeps the newer first_frame when multiple are present (latest by createdAt)", () => {
    const nodes = synthesizeNodesFromAssets([
      baseImage(1, 1, "first_frame", "assets/images/old.png", 100),
      baseImage(1, 1, "first_frame", "assets/images/new.png", 500),
    ]);
    expect(nodes["shot_image:scene_1_shot_1"].outputPaths!["first_frame"]).toBe(
      "assets/images/new.png",
    );
  });

  it("creates a separate shot_video node alongside shot_image for the same shot", () => {
    const nodes = synthesizeNodesFromAssets([
      baseImage(2, 3, "first_frame", "assets/images/x.png", 10),
      baseVideo(2, 3, "assets/videos/shots/x.mp4", 20),
    ]);
    expect(nodes["shot_image:scene_2_shot_3"]).toBeDefined();
    expect(nodes["shot_video:scene_2_shot_3"]).toBeDefined();
    expect(nodes["shot_video:scene_2_shot_3"].outputPath).toBe("assets/videos/shots/x.mp4");
  });

  it("ignores entries with no nodeId", () => {
    const nodes = synthesizeNodesFromAssets([
      {
        id: "img_loose",
        type: "scene_image",
        path: "assets/images/loose.png",
        createdAt: 100,
      },
    ]);
    expect(nodes).toEqual({});
  });

  it("ignores types that aren't scene_image or scene_video", () => {
    const nodes = synthesizeNodesFromAssets([
      { id: "ref", type: "character_ref", path: "assets/images/r.png", nodeId: "shot_image:scene_1_shot_1", createdAt: 1 },
      { id: "final", type: "final_video", path: "assets/videos/final/f.mp4", nodeId: "shot_video:scene_1_shot_1", createdAt: 2 },
    ]);
    expect(nodes).toEqual({});
  });

  it("falls back to parsing the frame from id when no frame field is set", () => {
    const nodes = synthesizeNodesFromAssets([
      {
        id: "frame_scene_1_shot_1_first_frame_999",
        type: "scene_image",
        path: "assets/images/p.png",
        nodeId: "shot_image:scene_1_shot_1",
        createdAt: 999,
      },
    ]);
    expect(nodes["shot_image:scene_1_shot_1"].outputPaths!["first_frame"]).toBe("assets/images/p.png");
  });

  it("skips a scene_image with no recognizable frame", () => {
    const nodes = synthesizeNodesFromAssets([
      {
        id: "frame_no_kind",
        type: "scene_image",
        path: "assets/images/p.png",
        nodeId: "shot_image:scene_1_shot_1",
      },
    ]);
    expect(nodes).toEqual({});
  });
});

describe("todosFromNodes", () => {
  it("converts shot_image / shot_video nodes into todos with correct status", () => {
    const nodes = synthesizeNodesFromAssets([
      baseImage(1, 1, "first_frame", "p.png", 1),
      baseVideo(1, 2, "v.mp4", 2),
    ]);
    const todos = todosFromNodes(nodes);
    expect(todos).toHaveLength(2);
    expect(todos.every((t) => t.status === "completed")).toBe(true);
    expect(todos.some((t) => t.text.includes("Scene 1 · Shot 1"))).toBe(true);
    expect(todos.some((t) => t.text.includes("Scene 1 · Shot 2"))).toBe(true);
  });
});
