/**
 * `dhee_set_render_method` — change a project's rendering method.
 *
 * The render method is a first-class project property (peer to style /
 * templateId / targetDuration) that determines which pipeline path
 * drives the project end-to-end. See `dhee_get_render_methods` for the
 * available options and `src/server/runners/runProjectInProcess.ts`
 * for how the dispatcher consumes the field.
 *
 * Use when the user says things like:
 *   - "Switch this project to prompt relay"
 *   - "Use shot-by-shot rendering for this one"
 *   - "Change the rendering method to seedance" (when seedance lands)
 *
 * Does NOT trigger rendering. Just edits project.json. The user has
 * to invoke a render afterward (via dhee_run_to or the desktop UI)
 * for the new method to take effect.
 *
 * Validates the method against the canonical registry; refuses
 * unknown values with a helpful list of what's available.
 */
import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { getProjectsDir } from "../paths.js";
import { resolveProjectDir, ProjectDirNotFoundError } from "./resolveProjectDir.js";
import {
  RENDER_METHODS,
  RENDER_METHOD_IDS,
  resolveRenderMethod,
  type RenderMethod,
} from "../../../core/project/renderMethods.js";

const Params = Type.Object({
  project: Type.String({
    description: "Project name (folder is <project>.dhee).",
  }),
  method: Type.String({
    description:
      "Render method id. Valid: 'shot_by_shot', 'prompt_relay'. Case-insensitive; underscores or hyphens both accepted ('prompt-relay' resolves to 'prompt_relay'). Use dhee_get_render_methods to see descriptions and tradeoffs.",
  }),
  projectDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to the project folder. Pass when the host (dhee-desktop) created the project at a workspace path that doesn't follow the default `<name>.dhee` convention.",
    }),
  ),
});

export interface SetRenderMethodDetails {
  status: "updated" | "noop" | "failed";
  projectDir: string;
  previousMethod: string;
  newMethod: RenderMethod;
  /** True iff the on-disk file was actually rewritten (false on noop). */
  rewrote: boolean;
}

function failure(message: string, projectDir: string): {
  content: { type: "text"; text: string }[];
  details: SetRenderMethodDetails;
} {
  return {
    content: [{ type: "text", text: message }],
    details: {
      status: "failed",
      projectDir,
      previousMethod: "",
      newMethod: "shot_by_shot",
      rewrote: false,
    },
  };
}

export const dheeSetRenderMethod = defineTool({
  name: "dhee_set_render_method",
  label: "dhee set render-method",
  description:
    "Change a project's render method (the field in project.json that determines which pipeline path runs). Use when the user wants to switch a project between shot-by-shot and prompt relay. Does NOT trigger a render — just edits the project's configuration. After this, the user must invoke a render (dhee_run_to or the desktop UI button) for the new method to take effect.",
  parameters: Params,
  async execute(
    _id,
    params: Static<typeof Params>,
  ): Promise<AgentToolResult<SetRenderMethodDetails>> {
    // Resolve project dir.
    let projectDir: string;
    try {
      projectDir = resolveProjectDir({
        name: params.project,
        basePath: getProjectsDir(),
        ...(params.projectDir ? { projectDir: params.projectDir } : {}),
      });
    } catch (err) {
      if (err instanceof ProjectDirNotFoundError) {
        return failure(`Project not found: ${params.project}`, "");
      }
      throw err;
    }

    const projectJsonPath = join(projectDir, "project.json");
    if (!existsSync(projectJsonPath)) {
      return failure(
        `project.json not found at ${projectJsonPath}`,
        projectDir,
      );
    }

    // Validate the method against the registry.
    const newMethod = resolveRenderMethod(params.method);
    if (!newMethod) {
      const valid = RENDER_METHOD_IDS.join(", ");
      const lines = [`Unknown render method '${params.method}'. Valid options:`, ""];
      for (const id of RENDER_METHOD_IDS) {
        lines.push(`  • ${id} — ${RENDER_METHODS[id].shortDescription}`);
      }
      lines.push("");
      lines.push(`Pass one of: ${valid}.`);
      return failure(lines.join("\n"), projectDir);
    }

    // Read + check current method.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(readFileSync(projectJsonPath, "utf-8")) as Record<
        string,
        unknown
      >;
    } catch (err) {
      return failure(
        `Failed to parse project.json: ${(err as Error).message}`,
        projectDir,
      );
    }
    const previousMethod =
      typeof parsed["renderMethod"] === "string"
        ? (parsed["renderMethod"] as string)
        : "shot_by_shot (default — field absent)";

    if (typeof parsed["renderMethod"] === "string" && parsed["renderMethod"] === newMethod) {
      const msg = `Project '${params.project}' is already using render method '${newMethod}'. No change.`;
      return {
        content: [{ type: "text", text: msg }],
        details: {
          status: "noop",
          projectDir,
          previousMethod,
          newMethod,
          rewrote: false,
        },
      };
    }

    // Persist.
    parsed["renderMethod"] = newMethod;
    try {
      writeFileSync(projectJsonPath, JSON.stringify(parsed, null, 2));
    } catch (err) {
      return failure(
        `Failed to write project.json: ${(err as Error).message}`,
        projectDir,
      );
    }

    const info = RENDER_METHODS[newMethod];
    const lines = [
      `Render method changed: ${previousMethod} → ${newMethod}`,
      "",
      `Project '${params.project}' will now render via: ${info.displayName}`,
      info.shortDescription,
      "",
      "The next render will use this method automatically. No further action needed to apply the change.",
    ];
    return {
      content: [{ type: "text", text: lines.join("\n") }],
      details: {
        status: "updated",
        projectDir,
        previousMethod,
        newMethod,
        rewrote: true,
      },
    };
  },
});
