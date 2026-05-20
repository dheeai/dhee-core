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
