import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { listWorkflows } from "../../../../services/comfyui/workflowIntegration.js";

const Params = Type.Object({
  user_only: Type.Optional(Type.Boolean({
    description: "If true, return only user-uploaded workflows (excluding built-ins). Default false.",
  })),
});

export interface Details {
  status: string;
  log: string;
  count: number;
}

export const dheeListComfyWorkflows = defineTool({
  name: "dhee_list_comfy_workflows",
  label: "dhee list-comfy-workflows",
  description:
    "List all ComfyUI workflows the registry knows about. Returns id, display name, pipeline, and built-in/active flags for each. Use to confirm a save succeeded or to show the user what's installed.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>) {
    const workflows = listWorkflows({ userOnly: params.user_only ?? false });
    if (workflows.length === 0) {
      const text = params.user_only
        ? 'No user-uploaded workflows yet.'
        : 'No workflows found.';
      return {
        content: [{ type: "text", text }],
        details: { status: "completed", log: text, count: 0 } satisfies Details,
      };
    }

    const lines = workflows.map(w => {
      const tags: string[] = [];
      if (w.builtIn) tags.push('built-in');
      if (w.isOverride) tags.push('override');
      if (!w.active) tags.push('inactive');
      const tagSuffix = tags.length ? ` [${tags.join(', ')}]` : '';
      return `  ${w.id} (${w.pipeline}) — "${w.displayName}"${tagSuffix}`;
    });
    const text = `${workflows.length} workflow(s):\n${lines.join('\n')}`;

    return {
      content: [{ type: "text", text }],
      details: { status: "completed", log: text, count: workflows.length } satisfies Details,
    };
  },
});
