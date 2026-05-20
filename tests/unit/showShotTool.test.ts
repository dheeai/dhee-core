/**
 * dhee_show_shot — single tool that surfaces a shot's full media set
 * (first frame + last frame + video) so "show me s1 shot 1" returns
 * everything in one call. Each piece appears as its own media chat
 * card via the existing onMedia → media_generated WS event path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createShowShotTool } from "../../src/agent/pi/tools/showShot.js";

let projectsDir: string;
let originalProjectsDir: string | undefined;

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), "dhee-show-shot-"));
  originalProjectsDir = process.env["dhee_PROJECTS_DIR"];
  process.env["dhee_PROJECTS_DIR"] = projectsDir;
  const proj = join(projectsDir, "demo.dhee");
  mkdirSync(join(proj, "assets"), { recursive: true });
  writeFileSync(
    join(proj, "project.json"),
    JSON.stringify({
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
            {
              shotNumber: 2,
              // First frame only — no last_frame, no video.
              firstFrame: { path: "assets/images/s1shot2_first.png", createdAt: 400 },
            },
          ],
        },
      ],
    }, null, 2),
  );
});

afterEach(() => {
  if (originalProjectsDir === undefined) delete process.env["dhee_PROJECTS_DIR"];
  else process.env["dhee_PROJECTS_DIR"] = originalProjectsDir;
  rmSync(projectsDir, { recursive: true, force: true });
});

async function exec(tool: { execute: Function }, params: unknown, onMedia?: (e: unknown) => void) {
  return tool.execute("test-call", params, undefined, undefined, {} as never);
}

describe("createShowShotTool", () => {
  it("emits a media event for first/last/video when all are present", async () => {
    const events: Array<{ kind: string; project: string; path: string; source: string }> = [];
    const tool = createShowShotTool({ onMedia: (e) => events.push(e) });
    await exec(tool, { project: "demo", scene: 1, shot: 1 });
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.kind).sort()).toEqual(["image", "image", "video"]);
    expect(events.map((e) => e.path).sort()).toEqual([
      "assets/images/s1shot1_first.png",
      "assets/images/s1shot1_last.png",
      "assets/videos/shots/s1shot1.mp4",
    ]);
    for (const e of events) {
      expect(e.project).toBe("demo");
      expect(e.source).toBe("dhee_show_shot");
    }
  });

  it("only emits events for the slots that exist on the shot", async () => {
    const events: Array<{ kind: string; path: string }> = [];
    const tool = createShowShotTool({ onMedia: (e) => events.push(e) });
    await exec(tool, { project: "demo", scene: 1, shot: 2 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "image", path: "assets/images/s1shot2_first.png" });
  });

  it("returns a text summary listing what was shown", async () => {
    const tool = createShowShotTool({ onMedia: () => {} });
    const r = await exec(tool, { project: "demo", scene: 1, shot: 1 });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("scene 1");
    expect(text).toContain("shot 1");
    expect(text.toLowerCase()).toContain("first");
    expect(text.toLowerCase()).toContain("last");
    expect(text.toLowerCase()).toContain("video");
  });

  it("returns a not-found result when the shot doesn't exist", async () => {
    const events: unknown[] = [];
    const tool = createShowShotTool({ onMedia: (e) => events.push(e) });
    const r = await exec(tool, { project: "demo", scene: 9, shot: 9 });
    expect(events).toHaveLength(0);
    expect(r.details).toMatchObject({ found: false });
  });

  it("works without an onMedia callback (no-op for emission, still returns text)", async () => {
    const tool = createShowShotTool({});
    const r = await exec(tool, { project: "demo", scene: 1, shot: 1 });
    expect((r.content[0] as { text: string }).text).toContain("scene 1");
  });
});
