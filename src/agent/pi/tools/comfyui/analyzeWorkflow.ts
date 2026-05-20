import { Type, type Static } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { analyzeWorkflowFile, WorkflowIntegrationError } from "../../../../services/comfyui/workflowIntegration.js";
import { buildRouterFromEnv, LLMClient } from "../../../../core/llm/index.js";

const Params = Type.Object({
  path: Type.String({
    description: "Absolute path to the ComfyUI workflow JSON file the user attached.",
  }),
});

export interface Details {
  status: string;
  log: string;
  ok?: boolean;
  llmFailed?: boolean;
  llmError?: string;
  suggestedDisplayName?: string;
  suggestedPipeline?: string;
  inputNodeCount?: number;
}

function failure(message: string): { content: { type: "text"; text: string }[]; details: Details } {
  return {
    content: [{ type: "text", text: message }],
    details: { status: "failed", log: message, ok: false },
  };
}

export const dheeAnalyzeComfyWorkflow = defineTool({
  name: "dhee_analyze_comfy_workflow",
  label: "dhee analyze-comfy-workflow",
  description:
    "LLM-analyze a validated ComfyUI workflow. Returns a suggested display name, pipeline type, parameter mappings (nodeId → standard input), and LoRA trigger keywords. Run AFTER dhee_validate_comfy_workflow succeeds. If the LLM is unavailable (offline / no API key), returns parsed nodes with `llmFailed=true` so you can fall back to asking the user to map nodes manually.",
  parameters: Params,
  async execute(_id, params: Static<typeof Params>) {
    // Build a router. If env doesn't enable structured purposes, use a
    // bare LLMClient as a fallback so tests / dev environments still work.
    let llm: LLMClient;
    try {
      const router = buildRouterFromEnv(process.cwd());
      llm = router.isEnabled()
        ? router.getClient('structured.workflow_analysis')
        : new LLMClient();
    } catch (err) {
      return failure(`Could not initialize LLM router: ${(err as Error).message}`);
    }

    let result;
    try {
      result = await analyzeWorkflowFile(params.path, llm);
    } catch (err) {
      if (err instanceof WorkflowIntegrationError) return failure(err.message);
      throw err;
    }

    const { parsed, analysis, llmFailed, llmError } = result;
    const lines: string[] = [];

    if (analysis) {
      lines.push(`Suggested name: ${analysis.displayName}`);
      lines.push(`Pipeline: ${analysis.pipeline}`);
      lines.push(`Description: ${analysis.llmDescription}`);
      lines.push(`When to use: ${analysis.selectionCriteria}`);
      lines.push('');
      lines.push('Suggested variable mappings:');
      const mappings = analysis.suggestedMappings ?? [];
      for (const m of mappings) {
        lines.push(`  - Node ${m.nodeId} (${m.classType}) → "${m.suggestedInput}" — ${m.reason}`);
      }
      if (analysis.suggestedKeywords?.prepend || analysis.suggestedKeywords?.append) {
        lines.push('');
        lines.push('LoRA / style keywords:');
        if (analysis.suggestedKeywords.prepend) lines.push(`  prepend: ${analysis.suggestedKeywords.prepend}`);
        if (analysis.suggestedKeywords.append) lines.push(`  append: ${analysis.suggestedKeywords.append}`);
        if (analysis.suggestedKeywords.negativeAppend) lines.push(`  negative append: ${analysis.suggestedKeywords.negativeAppend}`);
      }
    } else {
      lines.push(`LLM analysis unavailable${llmError ? ` (${llmError})` : ''}.`);
      lines.push(`Falling back to heuristic node detection. ${parsed.inputNodes.length} configurable input nodes:`);
      for (const n of parsed.inputNodes) {
        lines.push(`  - Node ${n.nodeId} (${n.classType}) "${n.title}" — type ${n.inputType}${n.suggestedInput ? ` → "${n.suggestedInput}"` : ''}`);
      }
      lines.push('');
      lines.push('Ask the user to confirm or adjust each mapping before saving.');
    }

    const text = lines.join('\n');
    return {
      content: [{ type: "text", text }],
      details: {
        status: "completed",
        log: text,
        ok: true,
        llmFailed,
        llmError,
        suggestedDisplayName: analysis?.displayName,
        suggestedPipeline: analysis?.pipeline ?? parsed.detectedPipeline,
        inputNodeCount: parsed.inputNodes.length,
      },
    };
  },
});
