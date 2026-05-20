import { describe, it, expect } from "vitest";
import { synthesizeNodesFromScenes } from "../lib/synthesizeNodesFromScenes";

describe("synthesizeNodesFromScenes", () => {
  it("returns an empty map when scenes is missing or empty", () => {
    expect(synthesizeNodesFromScenes(undefined)).toEqual({});
    expect(synthesizeNodesFromScenes([])).toEqual({});
  });

  it("emits one shot_image node per shot with first/last/mid frame paths", () => {
    const nodes = synthesizeNodesFromScenes([
      {
        sceneNumber: 1,
        shots: [
          {
            shotNumber: 1,
            firstFrame: { path: "f.png", createdAt: 1 },
            lastFrame: { path: "l.png", createdAt: 2 },
            midFrame: { path: "m.png", createdAt: 3 },
          },
        ],
      },
    ]);
    const node = nodes["shot_image:scene_1_shot_1"];
    expect(node).toBeDefined();
    expect(node.typeId).toBe("shot_image");
    expect(node.itemId).toBe("scene_1_shot_1");
    expect(node.outputPaths).toEqual({
      first_frame: "f.png",
      last_frame: "l.png",
      mid_frame: "m.png",
    });
    expect(node.status).toBe("completed");
  });

  it("emits a separate shot_video node when video is set", () => {
    const nodes = synthesizeNodesFromScenes([
      {
        sceneNumber: 2,
        shots: [
          {
            shotNumber: 3,
            video: { path: "v.mp4", createdAt: 10 },
          },
        ],
      },
    ]);
    expect(nodes["shot_video:scene_2_shot_3"]).toBeDefined();
    expect(nodes["shot_video:scene_2_shot_3"].outputPath).toBe("v.mp4");
  });

  it("skips shots that have no first/last/mid/video set (nothing to render)", () => {
    const nodes = synthesizeNodesFromScenes([
      {
        sceneNumber: 1,
        shots: [{ shotNumber: 1 }],
      },
    ]);
    expect(nodes).toEqual({});
  });

  it("produces a shot_image node when any frame is present, even just one", () => {
    const nodes = synthesizeNodesFromScenes([
      {
        sceneNumber: 1,
        shots: [{ shotNumber: 1, firstFrame: { path: "f.png", createdAt: 1 } }],
      },
    ]);
    expect(nodes["shot_image:scene_1_shot_1"]).toBeDefined();
    expect(nodes["shot_image:scene_1_shot_1"].outputPaths).toEqual({ first_frame: "f.png" });
  });

  it("groups multiple scenes and shots correctly", () => {
    const nodes = synthesizeNodesFromScenes([
      {
        sceneNumber: 1,
        shots: [
          { shotNumber: 1, firstFrame: { path: "s1s1.png", createdAt: 1 } },
          { shotNumber: 2, firstFrame: { path: "s1s2.png", createdAt: 2 } },
        ],
      },
      {
        sceneNumber: 2,
        shots: [
          { shotNumber: 1, video: { path: "s2s1.mp4", createdAt: 3 } },
        ],
      },
    ]);
    expect(Object.keys(nodes).sort()).toEqual([
      "shot_image:scene_1_shot_1",
      "shot_image:scene_1_shot_2",
      "shot_video:scene_2_shot_1",
    ]);
  });
});
