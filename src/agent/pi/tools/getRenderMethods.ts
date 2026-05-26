/**
 * `dhee_get_render_methods` — read-only listing of available render
 * methods that a project can use.
 *
 * Use when the user asks "what rendering methods are available?",
 * "what's the difference between shot-by-shot and prompt relay?",
 * "should I use relay for this project?", or otherwise needs to
 * navigate the choice without committing. Returns each method's
 * id, display name, short + long descriptions, and hardware
 * requirements.
 *
 * Companion to `dhee_set_render_method` (writes the project's
 * `renderMethod` field) and `dhee_status` (which surfaces the
 * currently-selected method). The pi-agent's role with render
 * methods is helping the user navigate the choice — the actual
 * dispatch is automatic, driven by project.json.
 */
import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  RENDER_METHODS,
  RENDER_METHOD_IDS,
  DEFAULT_RENDER_METHOD,
  type RenderMethod,
} from "../../../core/project/renderMethods.js";

const Params = Type.Object({});

export interface RenderMethodRow {
  id: RenderMethod;
  displayName: string;
  shortDescription: string;
  longDescription: string;
  requires: {
    llmEndpoint: boolean;
    kleinComfy: boolean;
    ltxDirectorLocal: boolean;
  };
  isDefault: boolean;
}

export interface GetRenderMethodsDetails {
  methods: RenderMethodRow[];
  defaultMethod: RenderMethod;
}

function formatMethodList(): string {
  const lines: string[] = [];
  lines.push("Available render methods:");
  lines.push("");
  for (const id of RENDER_METHOD_IDS) {
    const info = RENDER_METHODS[id];
    const flags: string[] = [];
    if (id === DEFAULT_RENDER_METHOD) flags.push("default");
    if (info.requires.ltxDirectorLocal) flags.push("requires local Comfy");
    const flagStr = flags.length > 0 ? ` (${flags.join(", ")})` : "";
    lines.push(`• ${info.displayName}${flagStr}`);
    lines.push(`    id: ${info.id}`);
    lines.push(`    ${info.shortDescription}`);
    lines.push("");
  }
  lines.push(
    "Detail for each method available on request. To switch a project's method, use dhee_set_render_method.",
  );
  return lines.join("\n");
}

export const dheeGetRenderMethods = defineTool({
  name: "dhee_get_render_methods",
  label: "dhee render methods",
  description:
    "List the render methods a dhee project can use, with their tradeoffs and hardware requirements. Read-only. Use when the user asks 'what rendering methods are available?', 'shot-by-shot vs prompt relay?', or needs help picking a method.",
  parameters: Params,
  async execute(
    _id,
    _params: Static<typeof Params>,
  ): Promise<AgentToolResult<GetRenderMethodsDetails>> {
    const methods: RenderMethodRow[] = RENDER_METHOD_IDS.map((id) => {
      const info = RENDER_METHODS[id];
      return {
        id,
        displayName: info.displayName,
        shortDescription: info.shortDescription,
        longDescription: info.longDescription,
        requires: { ...info.requires },
        isDefault: id === DEFAULT_RENDER_METHOD,
      };
    });
    return {
      content: [{ type: "text", text: formatMethodList() }],
      details: { methods, defaultMethod: DEFAULT_RENDER_METHOD },
    };
  },
});
