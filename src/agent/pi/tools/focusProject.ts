import { Type, type Static } from "typebox";
import { defineTool, type ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

export interface FocusProjectResult {
  projectName: string;
  title?: string;
  style?: string;
  phase?: string;
  templateId: string;
}

export type FocusProjectCallback = (projectName: string) => Promise<FocusProjectResult>;

const Params = Type.Object({
  project: Type.String({
    description:
      "Project name (no .dhee suffix) to focus on. The frontend will treat this as the active project, populating the storyboard / phase / timeline panels.",
  }),
});

export function createFocusProjectTool(callback: FocusProjectCallback): ToolDefinition {
  return defineTool({
    name: "dhee_focus_project",
    label: "dhee focus-project",
    description:
      "Focus a project as the active project for this session. Tells the UI to populate the storyboard, phase, and timeline panels for the named project. Use this when the user says things like 'let's work on X', 'open project Y', 'switch to Z'. After focusing, prefer this project as the default for subsequent dhee_* tool calls when the user doesn't name one explicitly.",
    parameters: Params,
    async execute(_id, params: Static<typeof Params>): Promise<AgentToolResult<FocusProjectResult | { error: string }>> {
      try {
        const r = await callback(params.project);
        const lines = [
          `Focused on project: ${r.projectName}`,
          r.title ? `  title: ${r.title}` : null,
          r.style ? `  style: ${r.style}` : null,
          r.phase ? `  phase: ${r.phase}` : null,
          r.templateId ? `  template: ${r.templateId}` : null,
        ].filter(Boolean);
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: r,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Failed to focus project: ${message}` }],
          details: { error: message },
        };
      }
    },
  });
}
