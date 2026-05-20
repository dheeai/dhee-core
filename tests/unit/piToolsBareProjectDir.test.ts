/**
 * Bug: pi-agent tools that take a `project` param hardcoded
 * `<projectsDir>/<name>.dhee` instead of using `resolveProjectDir`,
 * so a workspace folder created by dhee-desktop (no `.dhee`
 * suffix, only a `project.json` inside) is rejected with "Project not
 * found" — even when the host has correctly pinned dhee_PROJECTS_DIR
 * to the parent and the agent has been told the active project name
 * via the focus announcement.
 *
 * Symptom from the field: opening "The Village" (a bare-name folder
 * with `project.json`) and asking "show me s1 shot 1" fired
 * `dhee_show_shot`, `dhee_status`, and `dhee_list_items` —
 * every one returned "doesn't seem to exist" because the suffix probe
 * was the only path tried. `dhee_list_projects` then enumerated
 * `*.dhee` folders only, listed BurgerEating, and the agent
 * confidently picked the wrong project.
 *
 * Each test creates a bare-name workspace folder, drops a minimal
 * `project.json` inside, points dhee_PROJECTS_DIR at the parent,
 * and asserts the tool succeeds. Failing means the tool is still on
 * the legacy hardcoded-suffix path.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { dheeStatus } from "../../src/agent/pi/tools/status.js";
import { dheeListItems } from "../../src/agent/pi/tools/listItems.js";
import { dheeListProjects } from "../../src/agent/pi/tools/listProjects.js";
import { createShowShotTool } from "../../src/agent/pi/tools/showShot.js";

const PROJECT_NAME = "TheVillage";

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

function textOf(result: ToolResult): string {
  return result.content
    .map((c) => (c.type === "text" ? c.text ?? "" : ""))
    .join("\n");
}

describe("pi-agent tools resolve bare-name project folders (no .dhee suffix)", () => {
  let projectsDir: string;
  let projectDir: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    projectsDir = mkdtempSync(join(tmpdir(), "dhee-bare-"));
    projectDir = join(projectsDir, PROJECT_NAME);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "project.json"),
      JSON.stringify({
        version: "3.0",
        name: PROJECT_NAME,
        templateId: "narrative",
        style: "noir",
        targetDuration: 60,
        scenes: [
          {
            sceneNumber: 1,
            shots: [{ shotNumber: 1 }],
          },
        ],
        executorState: {
          nodes: {
            scene_1_shot_1: {
              id: "scene_1_shot_1",
              typeId: "shot_image",
              displayName: "Scene 1 Shot 1",
              status: "completed",
              dependencies: [],
            },
          },
        },
      }),
    );
    originalEnv = process.env["dhee_PROJECTS_DIR"];
    process.env["dhee_PROJECTS_DIR"] = projectsDir;
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env["dhee_PROJECTS_DIR"];
    else process.env["dhee_PROJECTS_DIR"] = originalEnv;
    rmSync(projectsDir, { recursive: true, force: true });
  });

  it("dhee_status accepts a bare-name folder with project.json", async () => {
    const result = (await dheeStatus.execute(
      "tc-1",
      { project: PROJECT_NAME } as never,
      undefined as never,
      undefined as never,
    )) as ToolResult;
    const text = textOf(result);
    expect(text.toLowerCase()).not.toContain("project not found");
    expect(text.toLowerCase()).not.toContain("project.json not found");
  });

  it("dhee_list_items accepts a bare-name folder with project.json", async () => {
    const result = (await dheeListItems.execute(
      "tc-2",
      { project: PROJECT_NAME } as never,
      undefined as never,
      undefined as never,
    )) as ToolResult;
    const text = textOf(result);
    expect(text.toLowerCase()).not.toContain("project not found");
    expect(text.toLowerCase()).not.toContain("project.json not found");
  });

  it("dhee_list_projects enumerates bare-name folders that contain a project.json", async () => {
    // Drop a sibling `.dhee` project too — both should appear in the
    // listing. Pre-fix, only the suffixed one shows up because the
    // filter is `.endsWith('.dhee')`.
    mkdirSync(join(projectsDir, "OtherProj.dhee"), { recursive: true });
    writeFileSync(
      join(projectsDir, "OtherProj.dhee", "project.json"),
      JSON.stringify({ version: "3.0", name: "OtherProj", templateId: "narrative" }),
    );

    const result = (await dheeListProjects.execute(
      "tc-3",
      {} as never,
      undefined as never,
      undefined as never,
    )) as ToolResult & { details?: { projects?: Array<{ name: string }> } };
    const names = (result.details?.projects ?? []).map((p) => p.name).sort();
    expect(names).toContain(PROJECT_NAME);
    expect(names).toContain("OtherProj");
  });

  it("dhee_show_shot finds a shot in a bare-name folder with project.json", async () => {
    // showShot's existence check is `loadProject(name)` returning null
    // when the suffixed path doesn't exist. We don't care about the
    // shot data here — only that we don't get the bare "no shot
    // found" path that follows from a null project load.
    const tool = createShowShotTool({});
    const result = (await tool.execute(
      "tc-4",
      { project: PROJECT_NAME, scene: 1, shot: 1 } as never,
      undefined as never,
      undefined as never,
    )) as ToolResult & { details?: { found?: boolean } };
    // The fixture's executorState describes scene_1_shot_1 but
    // doesn't populate firstFrame/lastFrame/video paths — a real
    // run would. The contract we pin: tool MUST find the project,
    // i.e. response is NOT the "no shot found" failure shape that
    // pi-agent shows when loadProject returned null.
    expect(result.details).not.toEqual({ found: false });
  });
});
