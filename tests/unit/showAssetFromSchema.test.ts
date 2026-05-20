/**
 * Phase 3: dhee_show_* tools should read from project.scenes (the new
 * single-source-of-truth tree) before falling back to the manifest.
 *
 * The fixtures in this test populate ONLY project.json.scenes — the
 * manifest is left empty. A red bar here means the show tool is still
 * manifest-only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  dheeShowFirstFrame,
  dheeShowLastFrame,
  dheeShowShotVideo,
  dheeShowFinalVideo,
} from "../../src/agent/pi/tools/showAsset.js";

let projectsDir: string;
let originalProjectsDir: string | undefined;

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), "dhee-show-schema-"));
  const proj = join(projectsDir, "demo.dhee");
  mkdirSync(join(proj, "assets"), { recursive: true });
  // Empty manifest — readers must fall back to project.json scenes tree.
  writeFileSync(
    join(proj, "assets", "manifest.json"),
    JSON.stringify({ assets: [] }, null, 2),
    "utf8",
  );
  // project.json with scenes/shots/frames populated.
  writeFileSync(
    join(proj, "project.json"),
    JSON.stringify(
      {
        version: "3.0",
        id: "demo",
        title: "Demo",
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
          path: "assets/videos/final/final_video.mp4",
          createdAt: 999,
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  originalProjectsDir = process.env["dhee_PROJECTS_DIR"];
  process.env["dhee_PROJECTS_DIR"] = projectsDir;
});

afterEach(() => {
  if (originalProjectsDir === undefined) delete process.env["dhee_PROJECTS_DIR"];
  else process.env["dhee_PROJECTS_DIR"] = originalProjectsDir;
  rmSync(projectsDir, { recursive: true, force: true });
});

async function exec<T extends { execute: Function }>(tool: T, params: unknown): Promise<{
  details: Record<string, unknown>;
  text: string;
}> {
  const r = await tool.execute("test-call", params, undefined, undefined, {} as never);
  return {
    details: r.details as Record<string, unknown>,
    text: (r.content[0] as { text: string }).text,
  };
}

describe("dhee_show_* reads from project.scenes tree", () => {
  it("dhee_show_first_frame returns shot.firstFrame.path", async () => {
    const r = await exec(dheeShowFirstFrame, { project: "demo", scene: 1, shot: 1 });
    expect(r.details["file_path"]).toBe("assets/images/s1shot1_first.png");
  });

  it("dhee_show_last_frame returns shot.lastFrame.path", async () => {
    const r = await exec(dheeShowLastFrame, { project: "demo", scene: 1, shot: 1 });
    expect(r.details["file_path"]).toBe("assets/images/s1shot1_last.png");
  });

  it("dhee_show_shot_video returns shot.video.path", async () => {
    const r = await exec(dheeShowShotVideo, { project: "demo", scene: 1, shot: 1 });
    expect(r.details["file_path"]).toBe("assets/videos/shots/s1shot1.mp4");
  });

  it("dhee_show_final_video returns project.finalVideo.path", async () => {
    const r = await exec(dheeShowFinalVideo, { project: "demo" });
    expect(r.details["file_path"]).toBe("assets/videos/final/final_video.mp4");
  });

  it("returns not-found cleanly when scene/shot is missing", async () => {
    const r = await exec(dheeShowFirstFrame, { project: "demo", scene: 9, shot: 9 });
    expect(r.details["found"]).toBe(false);
  });
});
