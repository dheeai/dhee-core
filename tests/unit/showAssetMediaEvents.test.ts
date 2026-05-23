/**
 * Two combined regressions in `showAsset.ts`:
 *
 *  1. `loadProject` hardcoded `<projectsDir>/<name>.dhee`. Bare-name
 *     project folders (dhee-desktop's NewProjectDialog default —
 *     `<workspace>/<name>` with no suffix) returned null from
 *     loadProject and the tools fell through to the manifest-only
 *     path. Same family of bug as status / listItems / showShot,
 *     fixed there but missed here.
 *
 *  2. The four show-asset tools (`dhee_show_first_frame`,
 *     `dhee_show_last_frame`, `dhee_show_shot_video`,
 *     `dhee_show_final_video`) had NO `onMedia` plumbing. They
 *     returned `{ details: { file_path } }` and nothing in the
 *     pipeline converted that to a `media_generated` chat event. So
 *     pi-agent calls returned a checkmark + path text but no inline
 *     image bubble — the symptom the user reported as "show me s1
 *     shot 1 doesn't show me the image".
 *
 * Fix surface: each tool gets a `createShow*Tool({ onMedia? })`
 * factory (mirroring the existing `createShowShotTool` for the
 * all-in-one show_shot tool); PiSessionAgent wires `opts.onMedia`
 * into all four when building the toolset.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createShowFirstFrameTool,
  createShowImageTool,
  createShowLastFrameTool,
  createShowShotVideoTool,
  createShowFinalVideoTool,
} from "../../src/agent/pi/tools/showAsset.js";

interface MediaCall {
  kind: "image" | "video";
  path: string;
  project: string;
  source: string;
}

let projectsDir: string;
let originalEnv: string | undefined;
let mediaCalls: MediaCall[];

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), "dhee-show-media-"));
  // Bare-name folder (no .dhee suffix) — mirrors dhee-desktop's
  // NewProjectDialog default.
  const proj = join(projectsDir, "TheVillage");
  mkdirSync(join(proj, "assets"), { recursive: true });
  writeFileSync(
    join(proj, "assets", "manifest.json"),
    JSON.stringify({ assets: [] }, null, 2),
    "utf8",
  );
  writeFileSync(
    join(proj, "project.json"),
    JSON.stringify(
      {
        version: "3.0",
        id: "TheVillage",
        title: "The Village",
        templateId: "narrative",
        scenes: [
          {
            sceneNumber: 1,
            shots: [
              {
                shotNumber: 1,
                firstFrame: { path: "assets/images/s1shot1_first.png", createdAt: 100 },
                lastFrame: { path: "assets/images/s1shot1_last.png", createdAt: 200 },
                video: { path: "assets/videos/shots/s1shot1.mp4", createdAt: 300 },
              },
            ],
          },
        ],
        finalVideo: {
          path: "assets/videos/final/final.mp4",
          createdAt: 999,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  originalEnv = process.env["dhee_PROJECTS_DIR"];
  process.env["dhee_PROJECTS_DIR"] = projectsDir;
  mediaCalls = [];
});

afterEach(() => {
  if (originalEnv === undefined) delete process.env["dhee_PROJECTS_DIR"];
  else process.env["dhee_PROJECTS_DIR"] = originalEnv;
  rmSync(projectsDir, { recursive: true, force: true });
});

const onMedia = (event: MediaCall) => {
  mediaCalls.push(event);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function exec(tool: any, params: unknown): Promise<{ details: Record<string, unknown> }> {
  const r = await tool.execute("test-call", params, undefined, undefined, {});
  return { details: r.details as Record<string, unknown> };
}

describe("showAsset tools resolve bare-name folders + emit onMedia", () => {
  it("dhee_show_first_frame finds the file under a bare-name folder AND emits an image media event", async () => {
    const tool = createShowFirstFrameTool({ onMedia });
    const r = await exec(tool, { project: "TheVillage", scene: 1, shot: 1 });
    expect(r.details["file_path"]).toBe("assets/images/s1shot1_first.png");
    expect(mediaCalls).toEqual([
      {
        kind: "image",
        path: "assets/images/s1shot1_first.png",
        project: "TheVillage",
        source: "dhee_show_first_frame",
      },
    ]);
  });

  it("dhee_show_last_frame emits an image media event", async () => {
    const tool = createShowLastFrameTool({ onMedia });
    const r = await exec(tool, { project: "TheVillage", scene: 1, shot: 1 });
    expect(r.details["file_path"]).toBe("assets/images/s1shot1_last.png");
    expect(mediaCalls).toEqual([
      {
        kind: "image",
        path: "assets/images/s1shot1_last.png",
        project: "TheVillage",
        source: "dhee_show_last_frame",
      },
    ]);
  });

  it("dhee_show_shot_video emits a video media event", async () => {
    const tool = createShowShotVideoTool({ onMedia });
    const r = await exec(tool, { project: "TheVillage", scene: 1, shot: 1 });
    expect(r.details["file_path"]).toBe("assets/videos/shots/s1shot1.mp4");
    expect(mediaCalls).toEqual([
      {
        kind: "video",
        path: "assets/videos/shots/s1shot1.mp4",
        project: "TheVillage",
        source: "dhee_show_shot_video",
      },
    ]);
  });

  it("dhee_show_final_video emits a video media event", async () => {
    const tool = createShowFinalVideoTool({ onMedia });
    const r = await exec(tool, { project: "TheVillage" });
    expect(r.details["file_path"]).toBe("assets/videos/final/final.mp4");
    expect(mediaCalls).toEqual([
      {
        kind: "video",
        path: "assets/videos/final/final.mp4",
        project: "TheVillage",
        source: "dhee_show_final_video",
      },
    ]);
  });

  it("does NOT emit onMedia when the asset is not found (no false positives)", async () => {
    const tool = createShowFirstFrameTool({ onMedia });
    await exec(tool, { project: "TheVillage", scene: 9, shot: 9 });
    expect(mediaCalls).toEqual([]);
  });

  it("works with no onMedia callback (CLI / legacy callers)", async () => {
    const tool = createShowFirstFrameTool({});
    const r = await exec(tool, { project: "TheVillage", scene: 1, shot: 1 });
    expect(r.details["file_path"]).toBe("assets/images/s1shot1_first.png");
    // No media calls — and no crash.
    expect(mediaCalls).toEqual([]);
  });
});

describe("dhee_show_image — generic image-by-path tool", () => {
  /**
   * Why this tool exists: when the agent wants to surface a setting
   * reference, character reference, or any other on-disk image to
   * the user, it used to fall back to `read path=*.png` which returns
   * text only — the chat never showed the image. This tool exists
   * as the explicit "display an image in the chat" channel that fires
   * onMedia.
   */
  it("relative path under project dir: resolves, fires onMedia with kind=image, source=dhee_show_image", async () => {
    // Drop a setting ref under the existing test project so the path
    // resolves cleanly.
    const projDir = join(projectsDir, "TheVillage");
    mkdirSync(join(projDir, "assets", "images"), { recursive: true });
    const relPath = "assets/images/SettingRef_observationdeckexit_zimage_JKeqBh.png";
    writeFileSync(join(projDir, relPath), "fake-png", "utf8");

    const tool = createShowImageTool({ onMedia });
    const r = await exec(tool, { project: "TheVillage", path: relPath });

    expect(r.details["file_path"]).toBe(relPath);
    expect(mediaCalls).toEqual([
      {
        kind: "image",
        path: relPath,
        project: "TheVillage",
        source: "dhee_show_image",
      },
    ]);
  });

  it("absolute path under project dir: emits the relative form (renderer resolves against project)", async () => {
    const projDir = join(projectsDir, "TheVillage");
    mkdirSync(join(projDir, "assets", "images"), { recursive: true });
    const relPath = "assets/images/abs_test.png";
    const absPath = join(projDir, relPath);
    writeFileSync(absPath, "fake-png", "utf8");

    const tool = createShowImageTool({ onMedia });
    await exec(tool, { project: "TheVillage", path: absPath });

    // Emitted path is project-relative so the chat's relative→absolute
    // resolver does the right thing on the renderer side.
    expect(mediaCalls[0]?.path).toBe(relPath);
  });

  it("non-image extension is rejected — no onMedia emitted", async () => {
    const projDir = join(projectsDir, "TheVillage");
    mkdirSync(join(projDir, "logs"), { recursive: true });
    const relPath = "logs/debug.log";
    writeFileSync(join(projDir, relPath), "logline", "utf8");

    const tool = createShowImageTool({ onMedia });
    const r = await exec(tool, { project: "TheVillage", path: relPath });

    expect(mediaCalls).toEqual([]);
    expect(String(r.details["asset_type"])).toBe("image"); // returned for diagnostics
  });

  it("missing file: no onMedia emitted (no false positive thumbnail)", async () => {
    const tool = createShowImageTool({ onMedia });
    const r = await exec(tool, {
      project: "TheVillage",
      path: "assets/images/does_not_exist.png",
    });
    expect(mediaCalls).toEqual([]);
    expect(String(r.details["asset_type"])).toBe("image");
  });

  it("works with no onMedia callback (CLI / smoke tests)", async () => {
    const projDir = join(projectsDir, "TheVillage");
    mkdirSync(join(projDir, "assets", "images"), { recursive: true });
    const relPath = "assets/images/noemit.png";
    writeFileSync(join(projDir, relPath), "fake-png", "utf8");

    const tool = createShowImageTool({});
    const r = await exec(tool, { project: "TheVillage", path: relPath });
    expect(r.details["file_path"]).toBe(relPath);
    expect(mediaCalls).toEqual([]);
  });
});
