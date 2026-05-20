import { describe, it, expect } from "vitest";
import { inferShotFromPath } from "../lib/inferShotFromPath";

describe("inferShotFromPath", () => {
  it("parses scene/shot + frame from a dhee-style image filename", () => {
    expect(inferShotFromPath("assets/images/s1shot1_first_frame_klein_aaa.png")).toEqual({
      scene: 1,
      shot: 1,
      frame: "first_frame",
      isVideo: false,
    });
    expect(inferShotFromPath("assets/images/s12shot7_last_frame_zimage_xxx.jpg")).toEqual({
      scene: 12,
      shot: 7,
      frame: "last_frame",
      isVideo: false,
    });
    expect(inferShotFromPath("assets/images/s2shot4_mid_frame_grok_qq.webp")).toEqual({
      scene: 2,
      shot: 4,
      frame: "mid_frame",
      isVideo: false,
    });
  });

  it("parses scene/shot from a shot-video filename and flags isVideo", () => {
    expect(inferShotFromPath("assets/videos/shots/s1shot2_ltx23_xyz.mp4")).toEqual({
      scene: 1,
      shot: 2,
      frame: null,
      isVideo: true,
    });
    expect(inferShotFromPath("assets/videos/shots/s3shot5_seedance_a.webm")).toEqual({
      scene: 3,
      shot: 5,
      frame: null,
      isVideo: true,
    });
    expect(inferShotFromPath("assets/videos/shots/s9shot9_x.mov")).toEqual({
      scene: 9,
      shot: 9,
      frame: null,
      isVideo: true,
    });
  });

  it("returns null for files that don't match the dhee grammar", () => {
    expect(inferShotFromPath("assets/images/CharRef_kai_xyz.png")).toBeNull();
    expect(inferShotFromPath("assets/images/SettingRef_alley_abc.png")).toBeNull();
    expect(inferShotFromPath("assets/videos/final/final_video.mp4")).toBeNull();
    expect(inferShotFromPath("assets/images/abc123_garbage.png")).toBeNull();
    expect(inferShotFromPath("")).toBeNull();
  });

  it("ignores extensions that don't match image/video for shot grammar", () => {
    // .json files aren't media; the shot parser still reads scene/shot/frame
    // because the *filename* matches the frame grammar — but the caller's
    // outer dispatch (image vs video element) handles the rendering. We
    // only flag isVideo when the extension is mp4/webm/mov.
    expect(inferShotFromPath("assets/images/s1shot1.json")).toBeNull();
  });

  it("uses just the basename — directory prefix doesn't matter", () => {
    expect(inferShotFromPath("/abs/anything/s2shot3_first_frame_klein_a.png")?.shot).toBe(3);
    expect(inferShotFromPath("s2shot3_first_frame_klein_a.png")?.shot).toBe(3);
  });
});
