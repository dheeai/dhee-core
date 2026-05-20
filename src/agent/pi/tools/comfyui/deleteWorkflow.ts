import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { deleteWorkflow, WorkflowIntegrationError } from "../../../../services/comfyui/workflowIntegration.js";

const Params = Type.Object({
  id: Type.String({ description: "Workflow id to delete (must be a user workflow — built-ins cannot be deleted)." }),
});

export interface Details {
  status: string;
  log: string;
  id?: string;
}

function failure(message: string): { content: { type: "text"; text: string }[]; details: Details } {
  return {
    content: [{ type: "text", text: message }],
    details: { status: "failed", log: message },
  };
}

export const dheeDeleteComfyWorkflow = defineTool({
  name: "dhee_delete_comfy_workflow",
  label: "dhee delete-comfy-workflow",
  description:
    "Permanently delete a user-uploaded workflow's manifest and JSON. Refuses to delete built-ins. Always confirm with the user before calling — there's no undo.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>) {
    try {
      deleteWorkflow(params.id);
    } catch (err) {
      if (err instanceof WorkflowIntegrationError) return failure(err.message);
      throw err;
    }

    const text = `Deleted workflow '${params.id}'.`;
    return {
      content: [{ type: "text", text }],
      details: { status: "completed", log: text, id: params.id } satisfies Details,
    };
  },
});
