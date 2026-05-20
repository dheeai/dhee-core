/**
 * End-to-end: PiSessionAgent constructed with onMedia → registers a
 * media-aware show_shot tool → tool execution fires onMedia events all
 * the way to the constructor callback. This catches the wiring slip
 * where the tool was registered without the closure.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PiSessionAgent } from "../../src/agent/pi/PiSessionAgent.js";

let projectsDir: string;
let originalProjectsDir: string | undefined;

beforeEach(() => {
  projectsDir = mkdtempSync(join(tmpdir(), "dhee-show-e2e-"));
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
              firstFrame: { path: "assets/images/x.png", createdAt: 1 },
              video: { path: "assets/videos/shots/x.mp4", createdAt: 2 },
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

describe("PiSessionAgent registers a media-aware show_shot when constructed with onMedia", () => {
  it("show_shot calls the agent's onMedia for each populated slot", async () => {
    const events: unknown[] = [];
    const agent = new PiSessionAgent({
      systemPrompt: "test",
      onMedia: (e) => events.push(e),
    });
    const showShot = agent.getToolNames().includes("dhee_show_shot")
      ? (agent as unknown as { tools: Array<{ name: string; execute: Function }> }).tools.find((t) => t.name === "dhee_show_shot")
      : null;
    expect(showShot).toBeTruthy();
    await showShot!.execute("test", { project: "demo", scene: 1, shot: 1 }, undefined, undefined, {});
    expect(events).toHaveLength(2);
    expect(events.map((e) => (e as { kind: string }).kind).sort()).toEqual(["image", "video"]);
  });

  it("show_shot is registered even when no onMedia is provided (text-only)", () => {
    const agent = new PiSessionAgent({ systemPrompt: "test" });
    expect(agent.getToolNames()).toContain("dhee_show_shot");
  });
});
