import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { validateWorkflowFile } from "../../../../services/comfyui/workflowIntegration.js";

const Params = Type.Object({
  path: Type.String({
    description: "Absolute path to the ComfyUI workflow JSON file the user attached.",
  }),
});

export interface Details {
  status: string;
  log: string;
  ok?: boolean;
  totalNodes?: number;
  detectedPipeline?: string;
  inputNodeCount?: number;
  loraCount?: number;
}

function failure(message: string, log?: string): { content: { type: "text"; text: string }[]; details: Details } {
  return {
    content: [{ type: "text", text: message }],
    details: { status: "failed", log: log ?? message, ok: false },
  };
}

export const dheeValidateComfyWorkflow = defineTool({
  name: "dhee_validate_comfy_workflow",
  label: "dhee validate-comfy-workflow",
  description:
    "Check whether a JSON file at `path` is a valid ComfyUI workflow. Cheap structural sniff — no LLM, no network. Run this first when a user attaches a workflow file before doing analysis.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>) {
    const result = validateWorkflowFile(params.path);
    if (!result.ok) {
      return failure(`Not a ComfyUI workflow: ${result.reason}`, result.reason);
    }

    const { parsed } = result;
    const summary = [
      `✓ Valid ComfyUI workflow.`,
      `  Total nodes: ${parsed.totalNodes}`,
      `  Detected pipeline: ${parsed.detectedPipeline}`,
      `  Configurable input nodes: ${parsed.inputNodes.length}`,
      parsed.loraNodes.length > 0
        ? `  LoRA nodes: ${parsed.loraNodes.length} (${parsed.loraNodes.map(l => l.loraName ?? l.classType).join(', ')})`
        : `  LoRA nodes: 0`,
    ].join('\n');

    return {
      content: [{ type: "text", text: summary }],
      details: {
        status: "completed",
        log: summary,
        ok: true,
        totalNodes: parsed.totalNodes,
        detectedPipeline: parsed.detectedPipeline,
        inputNodeCount: parsed.inputNodes.length,
        loraCount: parsed.loraNodes.length,
      },
    };
  },
});
