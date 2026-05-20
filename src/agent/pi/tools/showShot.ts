import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getProjectsDir } from "../paths.js";
import { findShot } from "../../../core/project/projectSchema.js";
import type { MediaCallback } from "./runTo.js";
import { resolveProjectDir } from "./resolveProjectDir.js";

const Params = Type.Object({
  project: Type.String({ description: "Project name" }),
  scene: Type.Number({ description: "Scene number, e.g. 1" }),
  shot: Type.Number({ description: "Shot number within the scene, e.g. 2" }),
});

interface ShownDetails {
  shown: { firstFrame?: string; lastFrame?: string; midFrame?: string; video?: string };
  count: number;
}

async function loadProject(projectName: string): Promise<Record<string, unknown> | null> {
  try {
    const projectDir = resolveProjectDir({
      name: projectName,
      basePath: getProjectsDir(),
    });
    const raw = await readFile(join(projectDir, "project.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function createShowShotTool(opts: { onMedia?: MediaCallback }): ToolDefinition {
  return defineTool({
    name: "dhee_show_shot",
    label: "dhee show shot",
    description:
      "Show all generated media for a specific shot — first frame, last frame, and rendered video — in one call. Each piece appears as its own media card in chat. Use this when the user says 'show me s1 shot 1', 'let me see scene 2 shot 4', or anything that doesn't specify which frame they want. Prefer dhee_show_first_frame / dhee_show_last_frame / dhee_show_shot_video when the user asks for a specific piece.",
    parameters: Params,
    async execute(_id, params: Static<typeof Params>): Promise<AgentToolResult<ShownDetails | { found: false }>> {
      // Same defense-in-depth as showAsset's frame tools — reject calls
      // missing scene/shot so the agent gets a real error instead of a
      // silent "no shot found" fall-through.
      if (typeof params.scene !== "number" || !Number.isFinite(params.scene) || params.scene < 1) {
        throw new Error(
          `kshana_show_shot: 'scene' is required and must be a positive number (got ${JSON.stringify(params.scene)}).`,
        );
      }
      if (typeof params.shot !== "number" || !Number.isFinite(params.shot) || params.shot < 1) {
        throw new Error(
          `kshana_show_shot: 'shot' is required and must be a positive number (got ${JSON.stringify(params.shot)}). If you don't know the shot, call kshana_list_items to enumerate them first.`,
        );
      }
      const project = await loadProject(params.project);
      const shot = project ? findShot(project, params.scene, params.shot) : undefined;
      if (!shot) {
        return {
          content: [{
            type: "text",
            text: `No shot found at scene ${params.scene} shot ${params.shot} in '${params.project}'.`,
          }],
          details: { found: false },
        };
      }

      const shown: ShownDetails["shown"] = {};
      const emit = (kind: "image" | "video", path: string) =>
        opts.onMedia?.({ kind, project: params.project, path, source: "dhee_show_shot" });

      if (shot.firstFrame?.path) {
        emit("image", shot.firstFrame.path);
        shown.firstFrame = shot.firstFrame.path;
      }
      if (shot.lastFrame?.path) {
        emit("image", shot.lastFrame.path);
        shown.lastFrame = shot.lastFrame.path;
      }
      if (shot.midFrame?.path) {
        emit("image", shot.midFrame.path);
        shown.midFrame = shot.midFrame.path;
      }
      if (shot.video?.path) {
        emit("video", shot.video.path);
        shown.video = shot.video.path;
      }

      const parts: string[] = [];
      if (shown.firstFrame) parts.push("first frame");
      if (shown.lastFrame) parts.push("last frame");
      if (shown.midFrame) parts.push("mid frame");
      if (shown.video) parts.push("video");
      const summary = parts.length === 0
        ? `Shot exists at scene ${params.scene} shot ${params.shot} but has no generated media yet.`
        : `Showing ${parts.join(", ")} for scene ${params.scene} shot ${params.shot}.`;

      return {
        content: [{ type: "text", text: summary }],
        details: { shown, count: parts.length },
      };
    },
  });
}
