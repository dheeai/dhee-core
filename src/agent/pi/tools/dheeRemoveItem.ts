/**
 * dhee_remove_item — remove ONE entry from an agentEditable plan node
 * (drop a character / setting / shot) in the bottom-up flow (#147).
 *
 * The ONLY way to change WHICH items exist (alongside dhee_add_item).
 * Item-aware invalidation clears exactly that item's downstream (its
 * image, clips, etc.); untouched siblings + their files survive.
 */
import { Type } from 'typebox';
import { defineTool } from '@mariozechner/pi-coding-agent';
import { applyPlanItemEdit } from '../../../dag/planItems.js';
import type { DagBundle } from '../../../dag/schema.js';

const Params = Type.Object({
  projectDir: Type.String({ description: 'Absolute path to the dhee project directory.' }),
  nodeId: Type.String({
    description:
      "The agentEditable plan node to remove from, e.g. 'characters_plan'. Must be marked agentEditable.",
  }),
  itemId: Type.String({
    description:
      "The id of the item to remove, e.g. 'concept_car'. Matches the item's derived id (its 'id'/'name' lowercased with spaces→underscores).",
  }),
  itemKey: Type.Optional(
    Type.String({
      description:
        "Override which array to remove from (defaults to the node's fan-out key). Omit unless the plan has multiple arrays.",
    }),
  ),
});

export interface RemoveItemDeps {
  loadBundleForProject?: (projectDir: string) => DagBundle;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], details: {}, ...(isError ? { isError: true } : {}) };
}

export function makeRemoveItemTool(deps: RemoveItemDeps = {}) {
  return defineTool({
    name: 'dhee_remove_item',
    label: 'Remove plan item',
    description:
      "Remove ONE item (a character, setting, shot, …) from an agentEditable plan node by its itemId. The ONLY way (with dhee_add_item) to change WHICH items exist. Clears exactly that item's downstream (image, clips, final video re-assembly); untouched siblings + their files survive. After removing, call dhee_start_run to re-assemble. To edit (not drop) an item, use dhee_critique_node or dhee_write_node_content with itemId.",
    parameters: Params,
    async execute(_id, params) {
      const r = applyPlanItemEdit({
        projectDir: params.projectDir,
        nodeId: params.nodeId,
        op: 'remove',
        itemId: params.itemId,
        ...(params.itemKey !== undefined ? { itemKey: params.itemKey } : {}),
        ...(deps.loadBundleForProject ? { loadBundleForProject: deps.loadBundleForProject } : {}),
      });
      if (!r.ok) return textResult(r.error, true);
      return textResult(r.message);
    },
  });
}

export const dheeRemoveItemTool = makeRemoveItemTool();
