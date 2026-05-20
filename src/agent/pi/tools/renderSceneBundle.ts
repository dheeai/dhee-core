import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

const Params = Type.Object({
  project: Type.String({ description: "Project name" }),
  scene: Type.String({ description: "Scene id, e.g. scene_1" }),
});

export const dheeRenderSceneBundle = defineTool({
  name: "dhee_render_scene_bundle",
  label: "dhee render-scene-bundle",
  description: "Trigger a prompt-relay render of an entire scene's shots in one batch. NOT YET IMPLEMENTED — returns a placeholder. Use dhee_run_to with a scene-scoped node id for now.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>): Promise<AgentToolResult<{ stub: true }>> {
    return {
      content: [
        {
          type: "text",
          text:
            `dhee_render_scene_bundle is not yet wired. ` +
            `For now, run scenes via dhee_run_to with a stage like 'shot_video' to ` +
            `drive shots through the pipeline.\n\n` +
            `Requested: project=${params.project} scene=${params.scene}`,
        },
      ],
      details: { stub: true },
    };
  },
});
