import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  createProjectInProcess,
  CreateProjectError,
} from "../../../server/runners/createProjectInProcess.js";
import { getProjectsDir } from "../paths.js";

const Params = Type.Object({
  name: Type.String({ description: "Project name (folder will be <name>.dhee)" }),
  style: Type.Optional(
    Type.String({ description: "Visual style, e.g. cinematic_realism, anime, noir" }),
  ),
  duration: Type.Optional(
    Type.Number({ description: "Target duration in seconds" }),
  ),
  input: Type.Optional(
    Type.String({ description: "Story idea or prompt to seed the project" }),
  ),
  template: Type.Optional(
    Type.String({ description: "Template id, e.g. narrative, infographic" }),
  ),
  existingDir: Type.Optional(
    Type.String({
      description:
        "Absolute path to a pre-created project folder. Use this when the host (e.g. dhee-desktop) has already created the workspace folder and you want to initialize it in place instead of creating a new <name>.dhee sibling. The folder must exist; original_input.md and project.json are written into it.",
    }),
  ),
});

export interface NewProjectDetails {
  status: "completed" | "failed";
  log: string;
  projectDir?: string;
  resolvedStyle?: string;
  inputType?: string;
  initialPhase?: string;
}

function failure(message: string): AgentToolResult<NewProjectDetails> {
  return {
    content: [{ type: "text", text: message }],
    details: { status: "failed", log: message },
  };
}

export const dheeNew = defineTool({
  name: "dhee_new",
  label: "dhee new",
  description:
    "Create a new dhee project from a story or idea. Sets up the project folder and seeds the dependency graph; does not run the pipeline.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>): Promise<AgentToolResult<NewProjectDetails>> {
    // CLI script accepted style/duration/input as optional flags but
    // hard-required them. Mirror that contract here so callers get a
    // structured failure instead of a thrown CreateProjectError.
    if (!params.style) {
      return failure(
        "style is required. Pick one of: live (cinematic_realism), anime (animation), or a canonical name.",
      );
    }
    if (params.duration === undefined) {
      return failure(
        "duration is required (target video length in seconds, e.g. 60).",
      );
    }
    if (!params.input || !params.input.trim()) {
      return failure(
        "input is required — pass a story or idea via the input parameter.",
      );
    }

    try {
      const result = createProjectInProcess({
        name: params.name,
        input: params.input,
        style: params.style,
        duration: params.duration,
        basePath: getProjectsDir(),
        ...(params.template ? { templateId: params.template } : {}),
        ...(params.existingDir ? { existingDir: params.existingDir } : {}),
      });

      const lines = [
        `Created project: ${params.name}.dhee`,
        `  Style:        ${result.resolvedStyle} (from ${params.style})`,
        `  Duration:     ${params.duration}s`,
        `  Template:     ${params.template ?? "narrative"}`,
        `  Input type:   ${result.project.inputType}`,
        `  Initial phase: ${result.project.currentPhase}`,
      ];
      const text = lines.join("\n");
      return {
        content: [{ type: "text", text }],
        details: {
          status: "completed",
          log: text,
          projectDir: result.projectDir,
          resolvedStyle: result.resolvedStyle,
          inputType: result.project.inputType,
          initialPhase: result.project.currentPhase,
        },
      };
    } catch (err) {
      const message =
        err instanceof CreateProjectError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      return failure(`Failed to create project: ${message}`);
    }
  },
});
