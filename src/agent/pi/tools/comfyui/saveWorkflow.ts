import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { saveWorkflow, WorkflowIntegrationError } from "../../../../services/comfyui/workflowIntegration.js";
import type { WorkflowManifest } from "../../../../services/providers/types.js";

// The full WorkflowManifest is too deeply nested for an ergonomic
// typebox schema. The pi-agent constructs the manifest object from
// the analyze tool's output + user feedback, so we accept it as
// `unknown`-typed JSON and validate the shape at runtime via the
// shared helper.
const Params = Type.Object({
  source_path: Type.String({
    description: "Absolute path to the ComfyUI workflow JSON file the user attached. The file is copied into the user workflows directory.",
  }),
  manifest: Type.Object({
    id: Type.String({ description: "Stable identifier (lowercase letters, digits, underscores). Used in registry routing." }),
    displayName: Type.String({ description: "Human-readable name shown in UI." }),
    pipeline: Type.String({ description: "One of: image_generation, image_editing, image_processing, video_generation." }),
    llmDescription: Type.String({ description: "2-3 sentence description for LLM prompt injection." }),
    selectionCriteria: Type.String({ description: "When the LLM should choose this workflow." }),
    outputType: Type.String({ description: "Either 'image' or 'video'." }),
    priority: Type.Number({ description: "Lower numbers are preferred when multiple workflows match." }),
    inputRequirements: Type.Array(Type.Object({
      id: Type.String(),
      type: Type.String(),
      source: Type.String(),
      description: Type.String(),
      required: Type.Boolean(),
    })),
    workflowFile: Type.String({ description: "Will be normalized to '{id}.json'." }),
    format: Type.String({ description: "'litegraph' or 'api'." }),
    parameterMappings: Type.Array(Type.Object({
      input: Type.String(),
      nodeId: Type.String(),
      field: Type.String(),
      defaultValue: Type.Optional(Type.Any()),
    })),
    promptKeywords: Type.Optional(Type.Object({
      prepend: Type.Optional(Type.String()),
      append: Type.Optional(Type.String()),
      negativeAppend: Type.Optional(Type.String()),
    })),
    strategies: Type.Optional(Type.Array(Type.String())),
  }),
  on_conflict: Type.Optional(Type.String({
    description: "What to do if a workflow with the same id already exists: 'fail' (default), 'overwrite', or 'rename' (appends timestamp).",
  })),
});

export interface Details {
  status: string;
  log: string;
  finalId?: string;
  manifestPath?: string;
  workflowPath?: string;
}

function failure(message: string): { content: { type: "text"; text: string }[]; details: Details } {
  return {
    content: [{ type: "text", text: message }],
    details: { status: "failed", log: message },
  };
}

export const dheeSaveComfyWorkflow = defineTool({
  name: "dhee_save_comfy_workflow",
  label: "dhee save-comfy-workflow",
  description:
    "Persist a user-confirmed ComfyUI workflow + manifest under the user workflows directory and refresh the registry. Run only AFTER the user has explicitly confirmed the proposed mappings, name, and defaults. Returns the final id (which may differ from the requested id if on_conflict='rename' was used).",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>) {
    let result;
    try {
      result = saveWorkflow({
        sourcePath: params.source_path,
        manifest: params.manifest as unknown as WorkflowManifest,
        onConflict: (params.on_conflict as 'fail' | 'overwrite' | 'rename' | undefined) ?? 'fail',
      });
    } catch (err) {
      if (err instanceof WorkflowIntegrationError) return failure(err.message);
      throw err;
    }

    const text = `Saved workflow '${result.finalId}'.\n  Manifest: ${result.manifestPath}\n  Workflow: ${result.workflowPath}`;
    return {
      content: [{ type: "text", text }],
      details: {
        status: "completed",
        log: text,
        finalId: result.finalId,
        manifestPath: result.manifestPath,
        workflowPath: result.workflowPath,
      },
    };
  },
});
