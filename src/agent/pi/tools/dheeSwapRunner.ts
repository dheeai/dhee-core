/**
 * dhee_swap_runner — change which runner produces a node instance.
 *
 * Per-instance: a swap on `shot_image:shot_3` does NOT affect
 * `shot_image:shot_4`. The walker's `resolveRunnerForInstance` reads
 * the latest `runner.swapped` event for the (nodeId, itemId) pair on
 * dispatch.
 *
 * Use case: a VLM judge runs on a generated image, finds the prompt's
 * style doesn't match the rest of the project, suggests swapping to
 * an alternative runner with different conditioning. The agent
 * confirms via this tool and the next walk uses the alt runner.
 */
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';

import { openProjectionEngine } from '../../../dag/eventLog/ProjectionEngine.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the project directory.' }),
  nodeId: Type.String({ description: 'Bundle node id to swap the runner on.' }),
  toTool: Type.String({ description: 'New runner tool name (e.g. "comfy.qwen_edit_chain").' }),
  reason: Type.String({ description: 'Why the swap (will be recorded on the event for audit).' }),
  itemId: Type.Optional(
    Type.String({ description: 'For collection nodes, the specific item id. Omit to apply to the bare node.' }),
  ),
  branchId: Type.Optional(
    Type.String({ description: 'Branch to record the swap on. Defaults to "main".' }),
  ),
  configOverride: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: "Per-swap config overrides merged on top of the node's runner.config.",
    }),
  ),
  fromTool: Type.Optional(
    Type.String({ description: 'Current runner tool. Optional but recorded for audit clarity.' }),
  ),
});

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeSwapRunnerTool() {
  return defineTool({
    name: 'dhee_swap_runner',
    label: 'Swap runner',
    description:
      'Swap the runner used for a specific node (or one item of a collection node). The next walk will dispatch the new runner. Per-instance scope; recorded as a `runner.swapped` event for audit. Use after dhee_critique_node or VLM judges flag the current runner as a bad fit.',
    parameters: Params,
    async execute(_id, params) {
      const eng = openProjectionEngine(params.projectDir);
      const event = eng.appendAndProject({
        branchId: params.branchId ?? 'main',
        actor: 'agent',
        kind: 'runner.swapped',
        payload: {
          nodeId: params.nodeId,
          ...(params.itemId ? { itemId: params.itemId } : {}),
          fromTool: params.fromTool ?? '(unspecified)',
          toTool: params.toTool,
          reason: params.reason,
          ...(params.configOverride ? { configOverride: params.configOverride } : {}),
        },
      });
      return textResult(
        `Recorded runner swap for ${params.nodeId}${params.itemId ? `:${params.itemId}` : ''} → '${params.toTool}' on branch '${event.branchId}'. seq=${event.seq}.\n\nReason: ${params.reason}\n\nNext walk will dispatch the new runner. (Hint: dhee_regenerate_node ${params.nodeId} to re-render immediately.)`,
      );
    },
  });
}

export const dheeSwapRunnerTool = makeSwapRunnerTool();
