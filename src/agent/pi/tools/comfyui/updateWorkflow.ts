import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { updateWorkflow, WorkflowIntegrationError } from "../../../../services/comfyui/workflowIntegration.js";
import type { WorkflowUpdate } from "../../../../services/comfyui/workflowIntegration.js";

const Params = Type.Object({
  id: Type.String({ description: "Workflow id to patch (must be a user workflow — built-ins cannot be edited)." }),
  patch: Type.Object({
    displayName: Type.Optional(Type.String()),
    llmDescription: Type.Optional(Type.String()),
    selectionCriteria: Type.Optional(Type.String()),
    priority: Type.Optional(Type.Number()),
    parameterMappings: Type.Optional(Type.Array(Type.Object({
      input: Type.String(),
      nodeId: Type.String(),
      field: Type.String(),
      defaultValue: Type.Optional(Type.Any()),
    }))),
    inputRequirements: Type.Optional(Type.Array(Type.Object({
      id: Type.String(),
      type: Type.String(),
      source: Type.String(),
      description: Type.String(),
      required: Type.Boolean(),
    }))),
    promptKeywords: Type.Optional(Type.Object({
      prepend: Type.Optional(Type.String()),
      append: Type.Optional(Type.String()),
      negativeAppend: Type.Optional(Type.String()),
    })),
    isOverride: Type.Optional(Type.Boolean()),
    active: Type.Optional(Type.Boolean()),
  }, { description: "Fields to patch. Omitted fields are left unchanged." }),
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

export const dheeUpdateComfyWorkflow = defineTool({
  name: "dhee_update_comfy_workflow",
  label: "dhee update-comfy-workflow",
  description:
    "Patch fields on an existing user-uploaded workflow's manifest. Common uses: change displayName, adjust default values in parameterMappings, toggle isOverride to set this workflow as active for its pipeline. Refuses to patch built-in workflows.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>) {
    let updated;
    try {
      updated = updateWorkflow(params.id, params.patch as WorkflowUpdate);
    } catch (err) {
      if (err instanceof WorkflowIntegrationError) return failure(err.message);
      throw err;
    }

    const text = `Updated workflow '${updated.id}': ${Object.keys(params.patch).join(', ')}.`;
    return {
      content: [{ type: "text", text }],
      details: { status: "completed", log: text, id: updated.id } satisfies Details,
    };
  },
});
